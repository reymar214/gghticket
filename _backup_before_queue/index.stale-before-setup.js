require('dotenv').config();
const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const { db, getSettings, saveTickets, loadPanels } = require('./lib/store');
const { commands } = require('./lib/commands');
const T = require('./lib/tickets');
const A = require('./lib/admin');

// Privileged intents (enable in the Developer Portal → Bot): Server Members + Message Content.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const slash = {
  help: A.help, panel: A.panel, settings: A.settings, roles: A.roles,
  claim: T.claim, unclaim: T.unclaim, transfer: T.transfer, rename: T.rename, priority: T.priority,
  close: (i) => T.requestClose(i, i.options.getString('reason')),
  add: (i) => T.addRemove(i, true),
  remove: (i) => T.addRemove(i, false),
  createticket: (i) => T.manualCreate(i, i.options.getUser('user'), i.options.getString('type'), i.options.getString('reason')),
};

client.once(Events.ClientReady, async () => {
  if (process.env.GUILD_ID) await (await client.guilds.fetch(process.env.GUILD_ID)).commands.set(commands);
  else await client.application.commands.set(commands);
  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i.guild) return;
    if (i.isAutocomplete()) {
      const q = i.options.getFocused().toLowerCase();
      return i.respond(Object.keys(loadPanels()).filter((k) => k.toLowerCase().includes(q)).slice(0, 25).map((k) => ({ name: k, value: k })));
    }
    if (i.isChatInputCommand()) return slash[i.commandName]?.(i);
    if (i.isMessageContextMenuCommand() && i.commandName === 'Create Ticket') {
      const a = i.targetMessage.author;
      if (a.bot) return i.reply({ content: "Can't open a ticket for a bot.", flags: MessageFlags.Ephemeral });
      return T.manualCreate(i, a, 'Message', null, i.targetMessage.content || '(no text)');
    }
    if (i.isButton()) {
      if (i.customId === 'claim') return T.claim(i);
      if (i.customId === 'close') return T.requestClose(i, null);
      if (i.customId.startsWith('pbtn:')) { const [, p, o] = i.customId.split(':'); return T.openOption(i, p, o); }
    }
    if (i.isStringSelectMenu() && i.customId.startsWith('pselect:')) return T.openOption(i, i.customId.split(':')[1], i.values[0]);
    if (i.isModalSubmit()) {
      if (i.customId.startsWith('tmodal:')) return T.handleTicketModal(i);
      if (i.customId === 'closereason') return T.requestClose(i, i.fields.getTextInputValue('reason'));
    }
  } catch (err) {
    console.error(err);
    const msg = { content: 'Something went wrong. Check the bot permissions and role order, then try again.', flags: MessageFlags.Ephemeral };
    if (i.deferred || i.replied) i.followUp(msg).catch(() => {}); else i.reply?.(msg).catch(() => {});
  }
});

// Activity tracking for inactivity auto-close
let dirty = false;
client.on(Events.MessageCreate, (m) => {
  if (!m.guild || m.author.id === client.user.id) return;
  const t = db.tickets[m.channelId];
  if (t && !t.closedAt) { t.lastActivity = Date.now(); dirty = true; }
});
setInterval(() => { if (dirty) { saveTickets(); dirty = false; } }, 30_000);

setInterval(async () => {
  for (const t of Object.values(db.tickets)) {
    if (t.closedAt) continue;
    const s = getSettings(t.guildId);
    if (!s.autoCloseHours || Date.now() - (t.lastActivity || Date.parse(t.openedAt)) < s.autoCloseHours * 3_600_000) continue;
    const guild = client.guilds.cache.get(t.guildId); if (!guild) continue;
    const channel = await guild.channels.fetch(t.channelId).catch(() => null);
    await T.closeTicketCore({ guild, channel, ticket: t, closedBy: null, reason: `Closed after ${s.autoCloseHours}h of inactivity`, deleted: !channel });
  }
}, 10 * 60_000);

// Close tickets whose author leaves
client.on(Events.GuildMemberRemove, async (m) => {
  if (!getSettings(m.guild.id).autoCloseOnLeave) return;
  for (const t of Object.values(db.tickets)) {
    if (t.guildId !== m.guild.id || t.userId !== m.id || t.closedAt) continue;
    const channel = await m.guild.channels.fetch(t.channelId).catch(() => null);
    await T.closeTicketCore({ guild: m.guild, channel, ticket: t, closedBy: null, reason: 'Ticket author left the server', deleted: !channel });
  }
});

// Channel deleted by hand instead of /close (no transcript possible)
client.on(Events.ChannelDelete, async (ch) => {
  const t = db.tickets[ch.id];
  if (!t || t.closedAt) return;
  await T.closeTicketCore({ guild: ch.guild, channel: null, ticket: t, closedBy: null, reason: 'Ticket channel was manually deleted by an administrator.', deleted: true });
});

client.login(process.env.DISCORD_TOKEN);
