// Welcome message when the bot joins a server: one-click auto setup, or a manual step-by-step guide.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits: P, MessageFlags } = require('discord.js');
const { getSettings, saveSettings, loadPanels, savePanels } = require('./store');
const { panelMessage } = require('./tickets');

const EPH = MessageFlags.Ephemeral;
const GOLD = 0xd4af37;
const NEEDED = [['ManageChannels', 'Manage Channels'], ['ManageRoles', 'Manage Roles'], ['ViewChannel', 'View Channels'], ['SendMessages', 'Send Messages'],
  ['EmbedLinks', 'Embed Links'], ['AttachFiles', 'Attach Files'], ['ReadMessageHistory', 'Read Message History']];
const busy = new Set(); // servers where auto setup is running right now (stops double-clicks)
const canManage = (i) => !!i.memberPermissions?.has(P.ManageGuild);
const missingPerms = (guild) => NEEDED.filter(([k]) => !guild.members.me.permissions.has(P[k])).map(([, name]) => name);

// ---------- messages ----------
function welcomePayload(guild) {
  const missing = missingPerms(guild);
  const e = new EmbedBuilder().setColor(GOLD).setTitle('👋 Thanks for adding me!')
    .setDescription('I run **support tickets**: members open a ticket from a panel, staff get it in a staff channel, claim it, chat, and close it with a reason.\nChoose how to set me up:')
    .addFields(
      { name: '⚡ Auto setup', value: [
        'I create everything for you in a few seconds:',
        '• **🎫 Tickets** category (private): ticket channels are created here, plus `#ticket-queue` and `#ticket-logs` for staff',
        '• **📩 Support** category with `#open-a-ticket`, where members click to open a ticket (I post the panel there)',
        '• a **Ticket Staff** role (I give it to you; give it to your staff)'].join('\n') },
      { name: '🛠️ Customize', value: "I create nothing. I'll send the commands to run, in order, and what each one does." })
    .setFooter({ text: 'Only members with Manage Server can press these buttons · /setup shows this again' });
  if (missing.length) e.addFields({ name: "⚠️ I'm missing permissions", value: `${missing.join(', ')}.\nAdd them to my role, and put my role above your staff roles, or setup will fail.` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:auto').setLabel('Auto setup').setEmoji('⚡').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:manual').setLabel('Customize').setEmoji('🛠️').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [row] };
}

function guideEmbed() {
  return new EmbedBuilder().setColor(GOLD).setTitle('🛠️ Manual setup: run these in order')
    .setDescription('I won\'t create anything. Make the channels and roles yourself, then tell me about them with these commands:')
    .addFields(
      { name: '1️⃣ Staff role', value: '`/roles action:Add support role role:@Staff`\nWho can see and handle tickets. Optional: `Add ping role` picks who is pinged on new tickets (default: the support roles; the role must be mentionable).' },
      { name: '2️⃣ Ticket category', value: 'Create a category, then `/settings set category:#Tickets`\nEvery ticket becomes a private channel inside it.' },
      { name: '3️⃣ Tickets channel (staff only)', value: 'Create a staff-only channel, then `/settings set tickets_channel:#ticket-queue`\nEach open ticket gets one live message there (🟢 Unclaimed / 🟡 Claimed) with Claim, Open and Close buttons, and the role is pinged.' },
      { name: '4️⃣ Closed log', value: '`/settings set closed_log:#ticket-logs`\nClosed tickets are logged with who opened and closed them, the answers and the reason.' },
      { name: '5️⃣ Panel members click', value: '`/panel create`, then `/panel addoption` for each button (with the questions members answer), then `/panel send panel:<id> channel:#open-a-ticket`' },
      { name: '6️⃣ Check it', value: '`/settings view` shows everything. `/settings set` also has claim mode, close rules, auto-close and more.' },
      { name: 'Inside tickets (staff)', value: '`/claim` `/unclaim` `/transfer` `/add` `/remove` `/rename` `/priority` `/close`\n`/createticket`, or right-click a message → Apps → Create Ticket' })
    .setFooter({ text: 'My role needs Manage Channels + Manage Roles and must sit above your staff roles · /setup shows this again' });
}

const defaultPanel = () => ({
  title: 'Support Tickets', description: 'Need help or want to report something? Pick an option below to open a ticket.', type: 'buttons',
  options: [
    { id: 'report', label: 'Report', emoji: '🚨', style: 'Danger', nameFormat: 'report-{number}', embedMessage: 'Thanks {user}! A staff member will be with you shortly.',
      questions: [{ label: 'What do you want to report?', style: 'short', maxLength: 100 }, { label: 'Briefly describe it', style: 'paragraph', maxLength: 1000 }] },
    { id: 'help', label: 'General Help', emoji: '❓', style: 'Primary', nameFormat: 'help-{number}',
      questions: [{ label: 'How can we help?', style: 'paragraph', maxLength: 1000 }] },
  ],
});

// ---------- joining a server ----------
async function pickChannel(guild) {
  const me = guild.members.me;
  const can = (c) => c && c.type === ChannelType.GuildText && c.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]);
  if (can(guild.systemChannel)) return guild.systemChannel;
  return guild.channels.cache.filter(can).sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0)).first() || null;
}

async function onJoin(guild, commands) {
  // With GUILD_ID set, slash commands are registered for that server only; give new servers the commands too.
  if (process.env.GUILD_ID) await guild.commands.set(commands).catch((e) => console.error('Could not register commands in the new server:', e.message));
  const s = getSettings(guild.id);
  if (s.queueChannelId && s.categoryIds.length) return; // already configured (re-invite): stay quiet
  const ch = await pickChannel(guild);
  if (ch) return ch.send(welcomePayload(guild)).catch((e) => console.error('Welcome message failed:', e.message));
  const owner = await guild.fetchOwner().catch(() => null);
  await owner?.send(`Thanks for adding me to **${guild.name}**! I couldn't find a channel I can post in. Give me access to a channel and run \`/setup\` there to get started.`).catch(() => {});
}

// ---------- buttons & command ----------
async function button(i, which) {
  if (!canManage(i)) return i.reply({ content: 'Only members with **Manage Server** can use this.', flags: EPH });
  if (which === 'manual') return i.update({ embeds: [guideEmbed()], components: [] });
  if (which === 'auto') return autoSetup(i);
}

async function command(i) {
  if (!canManage(i)) return i.reply({ content: 'Only members with **Manage Server** can use this.', flags: EPH });
  if (i.options.getString('show') === 'guide') return i.reply({ embeds: [guideEmbed()] });
  return i.reply(welcomePayload(i.guild));
}

async function autoSetup(i) {
  const g = i.guild;
  const cur = getSettings(g.id);
  if (cur.queueChannelId && cur.categoryIds.length) {
    return i.reply({ content: 'This server is already set up. Use `/settings view` to see it, or `/settings set` to change it.', flags: EPH });
  }
  if (busy.has(g.id)) return i.reply({ content: 'Setup is already running, give it a few seconds.', flags: EPH });
  busy.add(g.id);
  await i.deferReply({ flags: EPH });

  const made = []; // everything created so far, so a failure can undo it
  const track = async (p) => { const x = await p; made.push(x); return x; };
  const why = 'Ticket bot auto setup';
  try {
    const me = g.members.me.id;
    const allow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles];
    const role = await track(g.roles.create({ name: 'Ticket Staff', color: GOLD, mentionable: true, reason: why }));
    const staffOnly = [{ id: g.id, deny: [P.ViewChannel] }, { id: role.id, allow }, { id: me, allow }];

    const ticketCat = await track(g.channels.create({ name: '🎫 Tickets', type: ChannelType.GuildCategory, permissionOverwrites: staffOnly, reason: why }));
    const queue = await track(g.channels.create({ name: 'ticket-queue', type: ChannelType.GuildText, parent: ticketCat.id, permissionOverwrites: staffOnly,
      topic: 'New and claimed tickets. Claim a ticket here.', reason: why }));
    const logs = await track(g.channels.create({ name: 'ticket-logs', type: ChannelType.GuildText, parent: ticketCat.id, permissionOverwrites: staffOnly,
      topic: 'Closed tickets are logged here.', reason: why }));
    const supportCat = await track(g.channels.create({ name: '📩 Support', type: ChannelType.GuildCategory, reason: why }));
    const open = await track(g.channels.create({ name: 'open-a-ticket', type: ChannelType.GuildText, parent: supportCat.id, topic: 'Click a button to open a ticket.', reason: why,
      permissionOverwrites: [
        { id: g.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads] },
        { id: me, allow }] }));

    // A starter panel for this server (panels are kept separately for every server).
    const panels = loadPanels(g.id);
    let pid = 'support'; let n = 2;
    while (panels[pid]) pid = `support-${n++}`;
    panels[pid] = defaultPanel();
    const msg = await open.send(panelMessage(pid, panels[pid], getSettings(g.id)));
    panels[pid].messages = [{ channelId: open.id, messageId: msg.id }];
    savePanels(g.id, panels);
    saveSettings(g.id, { supportRoleIds: [role.id], categoryIds: [ticketCat.id], queueChannelId: queue.id, closedLogId: logs.id, openedLogId: null });

    const gave = await i.member.roles.add(role, why).then(() => true).catch(() => false);
    const lines = [
      `• Members open tickets in <#${open.id}>`,
      `• Staff see new tickets in <#${queue.id}> and claim them there; closed tickets are logged in <#${logs.id}>`,
      `• <@&${role.id}> can handle tickets${gave ? ` (I gave it to <@${i.user.id}>)` : ''}. Give it to your staff.`,
      '• Customize with `/panel`, `/settings` and `/roles`. `/help` lists everything.'];
    await i.message?.edit({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ Ticket system is set up').setDescription(lines.join('\n'))], components: [], allowedMentions: { parse: [] } }).catch(() => {});
    return i.editReply({ content: '✅ Done! Everything is created and the panel is posted.', allowedMentions: { parse: [] } });
  } catch (e) {
    console.error('Auto setup failed:', e);
    for (const x of made.reverse()) await x.delete('Ticket setup failed, rolling back').catch(() => {});
    return i.editReply(e.code === 50013
      ? '❌ I\'m missing permissions, so I undid what I had created. My role needs **Manage Channels** and **Manage Roles** (plus View Channels, Send Messages, Embed Links, Attach Files, Read Message History). Fix that and press **Auto setup** again.'
      : '❌ Setup failed, so I undid what I had created. Check my permissions and try again, or use **Customize** for manual steps.');
  } finally { busy.delete(g.id); }
}

module.exports = { onJoin, button, command, welcomePayload, guideEmbed };
