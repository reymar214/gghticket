const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, PermissionFlagsBits: P, ChannelType, AttachmentBuilder, MessageFlags,
} = require('discord.js');
const { db, getSettings, saveTickets, loadPanels } = require('./store');
const { fetchAll, buildHtml } = require('./transcript');

const EPH = MessageFlags.Ephemeral;
const pad = (n) => String(n).padStart(4, '0');
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const hex = (c) => parseInt(String(c).replace('#', ''), 16) || 0xd4af37;
const STAFF = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true };
const PRIORITY = { low: '🟢 Low', normal: '⚪ Normal', high: '🟠 High', urgent: '🔴 Urgent' };

const supportRolesFor = (t, s) => [...new Set([...s.supportRoleIds, ...(t?.supportRoleIds || [])])];

function isStaff(member, ticket, s) {
  if (!member) return false;
  if (member.guild.ownerId === member.id) return true;
  if (member.permissions.has(P.ManageChannels) || member.permissions.has(P.ManageGuild)) return true;
  return (ticket ? supportRolesFor(ticket, s) : s.supportRoleIds).some((r) => member.roles.cache.has(r));
}
const isManager = (m) => m.guild.ownerId === m.id || m.permissions.has(P.ManageChannels) || m.permissions.has(P.ManageGuild);

// ---------- embeds ----------
// The creator, ticket # and the member's answers are shown here and in the Opened/Closed logs.
function ticketEmbed(t, s, title) {
  const e = new EmbedBuilder().setColor(hex(s.color)).setTitle(title || `Ticket #${pad(t.num)}`)
    .addFields(
      { name: 'Created by', value: `<@${t.userId}> (${t.username})`, inline: true },
      { name: 'Ticket #', value: pad(t.num), inline: true },
      { name: 'Type', value: clip(t.type, 100), inline: true },
    );
  if (t.welcome && !title) e.setDescription(clip(t.welcome, 2000));
  for (const a of t.answers) e.addFields({ name: clip(a.q, 256), value: clip(a.a || '—', 900) });
  if (t.priority !== 'normal') e.addFields({ name: 'Priority', value: PRIORITY[t.priority], inline: true });
  if (t.claimedBy) e.addFields({ name: 'Claimed by', value: `<@${t.claimedBy}>`, inline: true });
  return e.setTimestamp(new Date(t.openedAt));
}

function controls(s) {
  const row = new ActionRowBuilder();
  if (s.claimMode !== 'disabled') row.addComponents(new ButtonBuilder().setCustomId('claim').setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Success));
  row.addComponents(new ButtonBuilder().setCustomId('close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger));
  return row;
}

async function sendLog(guild, channelId, payload) {
  if (!channelId) return;
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (ch) await ch.send(payload).catch((e) => console.error('Log send failed:', e.message));
}

async function refreshOpening(channel, t, s) {
  const m = await channel.messages.fetch(t.openingMessageId).catch(() => null);
  if (m) await m.edit({ embeds: [ticketEmbed(t, s)] }).catch(() => {});
}

// ---------- panels ----------
function panelMessage(panelId, panel, s) {
  const embed = new EmbedBuilder()
    .setColor(panel.color ? hex(panel.color) : hex(s.color))
    .setTitle(panel.title || 'Support Tickets')
    .setDescription(panel.description || 'Click below to open a ticket.');
  const opts = (panel.options || []).slice(0, 25);
  if (panel.type === 'select') {
    const menu = new StringSelectMenuBuilder().setCustomId(`pselect:${panelId}`)
      .setPlaceholder(panel.placeholder || 'Select a ticket type')
      .addOptions(opts.map((o) => {
        const item = { label: clip(o.label, 100), value: o.id };
        if (o.description) item.description = clip(o.description, 100);
        if (o.emoji) item.emoji = o.emoji;
        return item;
      }));
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
  }
  const rows = [];
  for (let n = 0; n < opts.length; n += 5) {
    rows.push(new ActionRowBuilder().addComponents(opts.slice(n, n + 5).map((o) => {
      const b = new ButtonBuilder().setCustomId(`pbtn:${panelId}:${o.id}`).setLabel(o.label)
        .setStyle(ButtonStyle[o.style] || ButtonStyle.Primary);
      if (o.emoji) b.setEmoji(o.emoji);
      return b;
    })));
  }
  return { embeds: [embed], components: rows };
}

async function openOption(i, panelId, optionId) {
  const option = loadPanels()[panelId]?.options?.find((o) => o.id === optionId);
  if (!option) return i.reply({ content: 'This panel option no longer exists.', flags: EPH });
  const qs = (option.questions || []).slice(0, 5);
  if (!qs.length) return submitTicket(i, panelId, option, []);
  const modal = new ModalBuilder().setCustomId(`tmodal:${panelId}:${optionId}`).setTitle(clip(option.label, 45))
    .addComponents(qs.map((q, n) => {
      const input = new TextInputBuilder().setCustomId(`q${n}`).setLabel(clip(q.label, 45))
        .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(q.required !== false).setMaxLength(Math.min(q.maxLength || 1000, 1000));
      if (q.placeholder) input.setPlaceholder(clip(q.placeholder, 100));
      return new ActionRowBuilder().addComponents(input);
    }));
  return i.showModal(modal);
}

async function handleTicketModal(i) {
  const [, panelId, optionId] = i.customId.split(':');
  const option = loadPanels()[panelId]?.options?.find((o) => o.id === optionId);
  if (!option) return i.reply({ content: 'This panel option no longer exists.', flags: EPH });
  const answers = (option.questions || []).slice(0, 5).map((q, n) => ({ q: q.label, a: i.fields.getTextInputValue(`q${n}`) }));
  return submitTicket(i, panelId, option, answers);
}

async function submitTicket(i, panelId, option, answers) {
  await i.deferReply({ flags: EPH });
  const r = await createTicket({ guild: i.guild, user: i.user, panelId, option, answers, type: option.label });
  return i.editReply(r.error || `✅ Your ticket has been created: <#${r.channel.id}>`);
}

// ---------- create ----------
async function createTicket({ guild, user, panelId = null, option = {}, answers = [], type }) {
  const s = getSettings(guild.id);
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return { error: 'That user is not in this server.' };
  if (s.blockedRoleIds.some((r) => member.roles.cache.has(r))) return { error: 'You are not allowed to open tickets.' };

  const open = Object.values(db.tickets).filter((t) => t.guildId === guild.id && !t.closedAt);
  const mine = open.filter((t) => t.userId === user.id);
  if (mine.length >= s.maxPerUser) return { error: `You already have an open ticket: <#${mine[0].channelId}>` };
  if (open.length >= s.maxTotal) return { error: 'The server has too many open tickets right now. Please try again later.' };

  // Try the option's category first, then the server categories in order (Discord caps a category at 50 channels).
  const parent = [option.categoryId, ...s.categoryIds].filter(Boolean).find((id) =>
    guild.channels.cache.has(id) && guild.channels.cache.filter((c) => c.parentId === id).size < 50);
  if (!parent) return { error: 'No ticket category is set up (or all are full). Ask an admin to run `/settings set category:`.' };

  const num = (db.counter[guild.id] || 0) + 1; // only committed after the channel is created

  const fmt = option.nameFormat || 'ticket-{number}';
  const name = fmt.replaceAll('{number}', pad(num)).replaceAll('{username}', user.username).replaceAll('{type}', type || 'ticket')
    .toLowerCase().replace(/[^a-z0-9-_]+/g, '-').slice(0, 100) || `ticket-${pad(num)}`;

  const supportIds = [...new Set([...s.supportRoleIds, ...(option.supportRoleIds || [])])];
  const channel = await guild.channels.create({
    name, type: ChannelType.GuildText, parent,
    topic: `Ticket #${pad(num)} | ${user.username} | ${user.id}`,
    permissionOverwrites: [
      { id: guild.id, deny: [P.ViewChannel] },
      { id: user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles] },
      ...supportIds.map((id) => ({ id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles] })),
      { id: guild.members.me.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles] },
    ],
  });

  db.counter[guild.id] = num;
  const ticket = {
    num, guildId: guild.id, channelId: channel.id, userId: user.id, username: user.username,
    panelId, type: type || 'General', answers, supportRoleIds: option.supportRoleIds || [],
    welcome: (option.embedMessage || 'Thanks for opening a ticket! A staff member will be with you shortly.')
      .replaceAll('{user}', `<@${user.id}>`).replaceAll('{number}', pad(num)),
    priority: 'normal', claimedBy: null, openedAt: new Date().toISOString(), lastActivity: Date.now(), closedAt: null,
  };
  db.tickets[channel.id] = ticket;

  const msg = await channel.send({
    content: `${supportIds.map((r) => `<@&${r}>`).join(' ')} <@${user.id}>`.trim(),
    embeds: [ticketEmbed(ticket, s)], components: [controls(s)],
    allowedMentions: { roles: supportIds, users: [user.id] },
  });
  ticket.openingMessageId = msg.id;
  saveTickets();

  await sendLog(guild, s.openedLogId, {
    embeds: [ticketEmbed(ticket, s, `Ticket Opened #${pad(num)}`)],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Open Ticket').setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${guild.id}/${channel.id}`))],
  });
  return { channel };
}

async function manualCreate(i, user, type, reason, content) {
  const s = getSettings(i.guildId);
  if (!isStaff(i.member, null, s)) return i.reply({ content: 'Staff only.', flags: EPH });
  if (user.bot) return i.reply({ content: "Can't open a ticket for a bot.", flags: EPH });
  await i.deferReply({ flags: EPH });
  const answers = [];
  if (reason) answers.push({ q: 'Reason', a: reason });
  if (content) answers.push({ q: 'Message', a: content });
  const r = await createTicket({ guild: i.guild, user, answers, type: type || 'Manual' });
  return i.editReply(r.error || `✅ Ticket created: <#${r.channel.id}>`);
}

// ---------- claim / unclaim / transfer ----------
async function applyClaimPerms(channel, t, s, prev) {
  if (s.claimMode !== 'private' && s.claimMode !== 'readonly') return;
  const lock = s.claimMode === 'private' ? { ViewChannel: false } : { ViewChannel: true, SendMessages: false };
  for (const r of supportRolesFor(t, s)) await channel.permissionOverwrites.edit(r, t.claimedBy ? lock : STAFF).catch(() => {});
  if (prev && prev !== t.userId) await channel.permissionOverwrites.delete(prev).catch(() => {});
  if (t.claimedBy && t.claimedBy !== t.userId) {
    const m = await channel.guild.members.fetch(t.claimedBy).catch(() => null);
    if (m) await channel.permissionOverwrites.edit(m, STAFF).catch(() => {});
  }
}

async function ticketCtx(i, staffOnly = true) {
  const t = db.tickets[i.channelId];
  const s = getSettings(i.guildId);
  if (!t || t.closedAt) { await i.reply({ content: 'Use this inside an open ticket.', flags: EPH }); return null; }
  if (staffOnly && !isStaff(i.member, t, s)) { await i.reply({ content: 'Staff only.', flags: EPH }); return null; }
  return { t, s };
}
const note = (s, text) => new EmbedBuilder().setColor(hex(s.color)).setDescription(text);

async function claim(i) {
  const ctx = await ticketCtx(i); if (!ctx) return;
  const { t, s } = ctx;
  if (s.claimMode === 'disabled') return i.reply({ content: 'Claiming is turned off.', flags: EPH });
  if (t.claimedBy) return i.reply({ content: `Already claimed by <@${t.claimedBy}>.`, flags: EPH });
  await i.deferReply();
  t.claimedBy = i.user.id; saveTickets();
  await applyClaimPerms(i.channel, t, s, null);
  await refreshOpening(i.channel, t, s);
  return i.editReply({
    content: s.pingAuthorOnClaim ? `<@${t.userId}>` : undefined,
    embeds: [note(s, `🙋 Ticket claimed by <@${i.user.id}>.`)], allowedMentions: { users: [t.userId] },
  });
}

async function unclaim(i) {
  const ctx = await ticketCtx(i); if (!ctx) return;
  const { t, s } = ctx;
  if (!t.claimedBy) return i.reply({ content: 'This ticket is not claimed.', flags: EPH });
  if (t.claimedBy !== i.user.id && !isManager(i.member)) return i.reply({ content: 'Only the claimer (or a manager) can unclaim.', flags: EPH });
  await i.deferReply();
  const prev = t.claimedBy; t.claimedBy = null; saveTickets();
  await applyClaimPerms(i.channel, t, s, prev);
  await refreshOpening(i.channel, t, s);
  return i.editReply({ embeds: [note(s, `Ticket unclaimed by <@${i.user.id}>.`)] });
}

async function transfer(i) {
  const ctx = await ticketCtx(i); if (!ctx) return;
  const { t, s } = ctx;
  if (!t.claimedBy) return i.reply({ content: 'Claim the ticket first.', flags: EPH });
  if (t.claimedBy !== i.user.id && !isManager(i.member)) return i.reply({ content: 'Only the claimer (or a manager) can transfer.', flags: EPH });
  const target = await i.guild.members.fetch(i.options.getUser('user').id).catch(() => null);
  if (!target || target.user.bot || !isStaff(target, t, s)) return i.reply({ content: 'That user is not a staff member.', flags: EPH });
  await i.deferReply();
  const prev = t.claimedBy; t.claimedBy = target.id; saveTickets();
  await applyClaimPerms(i.channel, t, s, prev);
  await refreshOpening(i.channel, t, s);
  return i.editReply({ embeds: [note(s, `Ticket transferred to <@${target.id}>.`)] });
}

// ---------- add / remove / rename / priority ----------
async function addRemove(i, add) {
  const ctx = await ticketCtx(i); if (!ctx) return;
  const user = i.options.getUser('user'); const role = i.options.getRole('role');
  if (!user && !role) return i.reply({ content: 'Pick a user or a role.', flags: EPH });
  if (!add && user?.id === ctx.t.userId) return i.reply({ content: "You can't remove the ticket creator.", flags: EPH });
  const target = user ? await i.guild.members.fetch(user.id).catch(() => null) : role;
  if (!target) return i.reply({ content: 'That user is not in this server.', flags: EPH });
  if (add) await i.channel.permissionOverwrites.edit(target, STAFF);
  else await i.channel.permissionOverwrites.delete(target);
  return i.reply({ embeds: [note(ctx.s, `${add ? 'Added' : 'Removed'} ${user ? `<@${user.id}>` : `<@&${role.id}>`}.`)], allowedMentions: { parse: [] } });
}

async function rename(i) {
  const ctx = await ticketCtx(i); if (!ctx) return;
  const name = i.options.getString('name').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').slice(0, 100);
  await i.deferReply({ flags: EPH });
  // Discord allows only 2 channel renames per 10 minutes.
  const done = await Promise.race([i.channel.setName(name).then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]).catch(() => false);
  return i.editReply(done ? `Renamed to **${name}**.` : 'Discord rate-limits renames (2 per 10 minutes). Try again later.');
}

async function priority(i) {
  const ctx = await ticketCtx(i); if (!ctx) return;
  ctx.t.priority = i.options.getString('level'); saveTickets();
  await refreshOpening(i.channel, ctx.t, ctx.s);
  return i.reply({ embeds: [note(ctx.s, `Priority set to ${PRIORITY[ctx.t.priority]}.`)] });
}

// ---------- close ----------
async function requestClose(i, reason) {
  const ctx = await ticketCtx(i, false); if (!ctx) return;
  const { t, s } = ctx;
  if (!isStaff(i.member, t, s) && (i.user.id !== t.userId || s.closeRequiresSupport)) {
    return i.reply({ content: 'You cannot close this ticket.', flags: EPH });
  }
  if (s.closeRequiresReason && !reason) {
    return i.showModal(new ModalBuilder().setCustomId('closereason').setTitle('Close ticket').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason for closing')
        .setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true))));
  }
  await i.deferReply();
  await closeTicketCore({ guild: i.guild, channel: i.channel, ticket: t, closedBy: i.user, reason: reason || s.defaultCloseReason || 'No reason given' });
  return i.editReply('🔒 Ticket closed. This channel will be deleted in 5 seconds.').catch(() => {});
}

// Shared by /close, the button, auto-close, author-left and manual channel deletion.
async function closeTicketCore({ guild, channel, ticket, closedBy, reason, deleted = false }) {
  const s = getSettings(guild.id);
  ticket.closedAt = new Date().toISOString(); ticket.closedBy = closedBy?.id || null; saveTickets();

  const messages = !deleted && channel ? await fetchAll(channel).catch(() => []) : [];
  const closerText = s.hideCloser ? 'Staff Team' : closedBy ? `<@${closedBy.id}>` : 'System';
  const html = messages.length
    ? buildHtml(ticket, messages, { closer: s.hideCloser ? 'Staff Team' : closedBy?.username || 'System', reason }) : null;
  const file = () => (html ? [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `ticket-${pad(ticket.num)}.html` })] : []);

  const embed = ticketEmbed(ticket, s, `Ticket Closed #${pad(ticket.num)}`).setColor(0xed4245)
    .addFields({ name: 'Closed by', value: closerText, inline: true }, { name: 'Reason', value: clip(reason, 1024), inline: true });
  if (s.logStaffCounts && messages.length) {
    const counts = {};
    for (const m of messages) if (!m.author.bot && m.author.id !== ticket.userId) counts[m.author.id] = (counts[m.author.id] || 0) + 1;
    const lines = Object.entries(counts).map(([id, n]) => `<@${id}>: ${n}`);
    if (lines.length) embed.addFields({ name: 'Staff messages', value: clip(lines.join('\n'), 1024) });
  }
  await sendLog(guild, s.closedLogId, { embeds: [embed], files: file() });

  if (s.dmOnClose) {
    const u = await guild.client.users.fetch(ticket.userId).catch(() => null);
    await u?.send({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle(`Ticket #${pad(ticket.num)} closed`)
        .setDescription(`Your ticket in **${guild.name}** was closed.\n**Reason:** ${clip(reason, 1000)}`)],
      files: file(),
    }).catch(() => {});
  }
  if (!deleted && channel) setTimeout(() => channel.delete('Ticket closed').catch(() => {}), 5000);
}

module.exports = {
  createTicket, manualCreate, panelMessage, openOption, handleTicketModal,
  claim, unclaim, transfer, addRemove, rename, priority, requestClose, closeTicketCore,
};
