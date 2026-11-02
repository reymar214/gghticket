require('dotenv').config();
const { Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits } = require('discord.js');
let store;
try { store = require('./lib/store'); } catch (e) { console.error(e.userMessage || e); process.exit(1); } // damaged data file: stop instead of wiping it
const { db, getSettings, saveTickets, migratePanels, startBackups } = store;
const { commands } = require('./lib/commands');
const T = require('./lib/tickets');
const A = require('./lib/admin');
const PB = require('./lib/panelbuilder');
const dashboard = require('./lib/dashboard');
const SETUP = require('./lib/setup');

// Privileged intents (enable in the Developer Portal → Bot): Server Members + Message Content.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const slash = {
  help: A.help, setup: SETUP.command, panel: PB.command, settings: A.settings, roles: A.roles,
  claim: (i) => T.claim(i), unclaim: (i) => T.unclaim(i), transfer: T.transfer, rename: T.rename, priority: T.priority,
  close: (i) => T.requestClose(i, i.options.getString('reason')),
  add: (i) => T.addRemove(i, true),
  remove: (i) => T.addRemove(i, false),
  createticket: (i) => T.manualCreate(i, i.options.getUser('user'), i.options.getString('type'), i.options.getString('reason')),
};

const ADMIN_COMMANDS = new Set(['setup', 'settings', 'roles', 'panel']);
const canManage = (i) => !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild); // server owners can override Discord's default command permissions, so check again here
const NO_ACCESS = { content: 'Only members with **Manage Server** can use this.', flags: MessageFlags.Ephemeral };

client.once(Events.ClientReady, async () => {
  if (process.env.GUILD_ID) await (await client.guilds.fetch(process.env.GUILD_ID)).commands.set(commands);
  else await client.application.commands.set(commands);
  console.log(`Logged in as ${client.user.tag}`);
  migratePanels(client);
  startBackups();
  dashboard.start(client);
});

client.on(Events.GuildCreate, (g) => SETUP.onJoin(g, commands).catch((e) => console.error('Welcome failed:', e)));

async function route(i) {
  if (!i.guild) return;
  if (i.isAutocomplete()) return canManage(i) ? PB.autocomplete(i) : i.respond([]);
  if (i.isChatInputCommand()) {
    if (ADMIN_COMMANDS.has(i.commandName) && !canManage(i)) return i.reply(NO_ACCESS);
    return slash[i.commandName]?.(i);
  }
  if (i.isMessageContextMenuCommand() && i.commandName === 'Create Ticket') {
    const a = i.targetMessage.author;
    if (a.bot) return i.reply({ content: "Can't open a ticket for a bot.", flags: MessageFlags.Ephemeral });
    return T.manualCreate(i, a, 'Message', null, i.targetMessage.content || '(no text)');
  }
  if (i.isButton()) {
    const [kind, arg, arg2] = i.customId.split(':');
    if (kind === 'claim') return T.claim(i);                       // button inside a ticket (used when no tickets channel is set)
    if (kind === 'close') return T.requestClose(i, null);
    if (kind === 'qclaim') return T.claim(i, arg);                 // buttons on the tickets-channel message
    if (kind === 'qunclaim') return T.unclaim(i, arg);
    if (kind === 'qclose') return T.requestClose(i, null, arg);
    if (kind === 'pbtn') return T.openOption(i, arg, arg2);
    if (kind === 'setup') return SETUP.button(i, arg);
    if (kind === 'resetcfg') return A.resetConfirm(i, arg);
  }
  if (i.isStringSelectMenu() && i.customId.startsWith('pselect:')) return T.openOption(i, i.customId.split(':')[1], i.values[0]);
  if (i.isModalSubmit()) {
    if (i.customId.startsWith('tmodal:')) return T.handleTicketModal(i);
    if (i.customId.startsWith('pb_')) return canManage(i) ? PB.modalSubmit(i) : i.reply(NO_ACCESS);
    if (i.customId.startsWith('closereason')) {
      return T.requestClose(i, i.fields.getTextInputValue('reason'), i.customId.split(':')[1] || i.channelId);
    }
  }
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    await route(i); // must be awaited, otherwise errors escape the try/catch and crash the bot
  } catch (err) {
    console.error(err);
    const msg = {
      content: err.code === 50013
        ? "I don't have permission to do that. An admin needs to give the bot **Manage Channels** and **Manage Roles**, and move the bot's role **above** the staff roles (and check the ticket category's permissions)."
        : 'Something went wrong. Check the bot permissions and role order, then try again.',
      flags: MessageFlags.Ephemeral,
    };
    if (i.isAutocomplete?.()) return;
    if (i.deferred || i.replied) i.followUp(msg).catch(() => {}); else i.reply?.(msg).catch(() => {});
  }
});

client.on(Events.Error, (e) => console.error('Client error:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

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

// Channel deleted by hand instead of closed (no transcript possible)
client.on(Events.ChannelDelete, async (ch) => {
  const t = db.tickets[ch.id];
  if (!t || t.closedAt) return;
  await T.closeTicketCore({ guild: ch.guild, channel: null, ticket: t, closedBy: null, reason: 'Ticket channel was manually deleted by an administrator.', deleted: true });
});

// Save and close cleanly when stopped (Ctrl+C, pm2 stop/restart, system shutdown).
let stopping = false;
async function shutdown(signal) {
  if (stopping) return; stopping = true;
  console.log(`${signal}: saving and shutting down…`);
  try { saveTickets(); } catch (e) { console.error('Final save failed:', e.message); }
  try { await client.destroy(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('message', (m) => { if (m === 'shutdown') shutdown('shutdown message'); }); // how pm2 asks on Windows (shutdown_with_message)

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is missing. Copy .env.example to .env and paste your bot token into it.');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN).catch((e) => { console.error(`❌ Could not log in: ${e.message}. Check DISCORD_TOKEN in .env.`); process.exit(1); });
