const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, PermissionFlagsBits: P, ChannelType, AttachmentBuilder, MessageFlags,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { db, getSettings, saveTickets, loadPanels, TRANSCRIPT_DIR } = require('./store');
const { fetchAll, buildHtml } = require('./transcript');

const EPH = MessageFlags.Ephemeral;
const pad = (n) => String(n).padStart(4, '0');
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const hex = (c) => parseInt(String(c).replace('#', ''), 16) || 0xd4af37;
const STAFF = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true };
const PRIORITY = { low: '🟢 Low', normal: '⚪ Normal', high: '🟠 High', urgent: '🔴 Urgent' };

const supportRolesFor = (t, s) => [...new Set([...s.supportRoleIds, ...(t?.supportRoleIds || [])])];
const pingRolesFor = (t, s) => (s.pingRoleIds.length ? s.pingRoleIds : supportRolesFor(t, s));
const link = (guild, t) => `https://discord.com/channels/${guild.id}/${t.channelId}`;

function isStaff(member, ticket, s) {
  if (!member) return false;
  if (member.guild.ownerId === member.id) return true;
  if (member.permissions.has(P.ManageChannels) || member.permissions.has(P.ManageGuild)) return true;
  return (ticket ? supportRolesFor(ticket, s) : s.supportRoleIds).some((r) => member.roles.cache.has(r));
}
const isManager = (m) => m.guild.ownerId === m.id || m.permissions.has(P.ManageChannels) || m.permissions.has(P.ManageGuild);

// ---------- embeds ----------
const statusText = (t, s) => (s.claimMode === 'disabled' ? null
  : t.claimedBy ? `🟡 Claimed by <@${t.claimedBy}> — staff already on this ticket` : '🟢 Unclaimed — waiting for staff');

// Creator, ticket # and the member's answers. Used in the ticket channel, the tickets channel and the closed log.
function ticketEmbed(t, s, title, showStatus = !title) {
  const e = new EmbedBuilder().setColor(hex(s.color)).setTitle(title || `Ticket #${pad(t.num)}`)
    .addFields(
      { name: 'Created by', value: `<@${t.userId}> (${t.username})`, inline: true },
      { name: 'Ticket #', value: pad(t.num), inline: true },
      { name: 'Type', value: clip(t.type, 100), inline: true },
    );
  if (t.welcome && !title) e.setDescription(clip(t.welcome, 2000));
  const st = showStatus && statusText(t, s);
  if (st) e.addFields({ name: 'Status', value: st });
  for (const a of t.answers) e.addFields({ name: clip(a.q, 256), value: clip(a.a || '—', 900) });
  if (t.priority !== 'normal') e.addFields({ name: 'Priority', value: PRIORITY[t.priority], inline: true });
  if (!showStatus && t.claimedBy) e.addFields({ name: 'Claimed by', value: `<@${t.claimedBy}>`, inline: true });
  return e.setTimestamp(new Date(t.openedAt));
}

// Inside the ticket channel: Close only when a tickets channel exists (claiming happens there).
function controls(s) {
  const row = new ActionRowBuilder();
  if (s.claimMode !== 'disabled' && !s.queueChannelId) {
    row.addComponents(new ButtonBuilder().setCustomId('claim').setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Success));
  }
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

// ---------- tickets channel (one live message per open ticket) ----------
const queueEmbed = (t, s) =>
  ticketEmbed(t, s, `Ticket #${pad(t.num)} — ${t.claimedBy ? 'Claimed' : 'Unclaimed'}`, true).setColor(t.claimedBy ? 0xf0b232 : 0x57f287);

function queueRow(guild, t, s) {
  const row = new ActionRowBuilder();
  if (s.claimMode !== 'disabled') {
    row.addComponents(t.claimedBy
      ? new ButtonBuilder().setCustomId(`qunclaim:${t.channelId}`).setLabel('Unclaim').setEmoji('↩️').setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder().setCustomId(`qclaim:${t.channelId}`).setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Success));
  }
  row.addComponents(
    new ButtonBuilder().setLabel('Open Ticket').setStyle(ButtonStyle.Link).setURL(link(guild, t)),
    new ButtonBuilder().setCustomId(`qclose:${t.channelId}`).setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );
  return row;
}

async function postQueue(guild, t, s) {
  if (!s.queueChannelId) return;
  const ch = await guild.channels.fetch(s.queueChannelId).catch(() => null);
  if (!ch) return;
  const roles = pingRolesFor(t, s);
  const m = await ch.send({
    content: roles.map((r) => `<@&${r}>`).join(' ') || undefined, // ping only happens here, once, on a new ticket
    embeds: [queueEmbed(t, s)], components: [queueRow(guild, t, s)], allowedMentions: { roles },
  }).catch((e) => console.error('Tickets channel post failed:', e.message));
  if (m) { t.queueChannelId = ch.id; t.queueMessageId = m.id; saveTickets(); }
}

async function queueMessage(guild, t) {
  if (!t.queueMessageId) return null;
  const ch = await guild.channels.fetch(t.queueChannelId).catch(() => null);
  return ch ? ch.messages.fetch(t.queueMessageId).catch(() => null) : null;
}
async function refreshQueue(guild, t, s) {
  const m = await queueMessage(guild, t);
  if (m) await m.edit({ embeds: [queueEmbed(t, s)], components: [queueRow(guild, t, s)] }).catch(() => {});
}
async function removeQueue(guild, t) {
  const m = await queueMessage(guild, t);
  if (m) await m.delete().catch(() => {});
  t.queueMessageId = null;
}

// ---------- panels ----------
function panelMessage(panelId, panel, s) {
  const embed = new EmbedBuilder()
    .setColor(panel.color ? hex(panel.color) : hex(s.color))
    .setTitle(panel.title || 'Support Tickets')
    .setDescription(panel.description || 'Click below to open a ticket.');
  if (panel.image) embed.setImage(panel.image);
  if (panel.footer) embed.setFooter({ text: clip(panel.footer, 2048) });
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
  const option = loadPanels(i.guildId)[panelId]?.options?.find((o) => o.id === optionId);
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
  const option = loadPanels(i.guildId)[panelId]?.options?.find((o) => o.id === optionId);
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
// Ticket creation runs one at a time per server: the limit checks, the ticket number and the new channel must not interleave.
const chains = new Map();
function withLock(key, fn) {
  const run = (chains.get(key) || Promise.resolve()).then(() => fn());
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}
function createTicket(args) { return withLock(`create:${args.guild.id}`, () => createTicketUnlocked(args)); }

async function createTicketUnlocked({ guild, user, panelId = null, option = {}, answers = [], type }) {
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

  // With a tickets channel, staff are pinged there; the ticket channel itself only pings the author.
  const pingRoles = s.queueChannelId ? [] : supportIds;
  const msg = await channel.send({
    content: `${pingRoles.map((r) => `<@&${r}>`).join(' ')} <@${user.id}>`.trim(),
    embeds: [ticketEmbed(ticket, s)], components: [controls(s)],
    allowedMentions: { roles: pingRoles, users: [user.id] },
  });
  ticket.openingMessageId = msg.id;
  saveTickets();

  await postQueue(guild, ticket, s);
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
  if (!channel || (s.claimMode !== 'private' && s.claimMode !== 'readonly')) return;
  const lock = s.claimMode === 'private' ? { ViewChannel: false } : { ViewChannel: true, SendMessages: false };
  for (const r of supportRolesFor(t, s)) await channel.permissionOverwrites.edit(r, t.claimedBy ? lock : STAFF).catch(() => {});
  if (prev && prev !== t.userId) await channel.permissionOverwrites.delete(prev).catch(() => {});
  if (t.claimedBy && t.claimedBy !== t.userId) {
    const m = await channel.guild.members.fetch(t.claimedBy).catch(() => null);
    if (m) await channel.permissionOverwrites.edit(m, STAFF).catch(() => {});
  }
}

// chId lets the same handlers work from a ticket channel (default) or from the tickets-channel buttons.
async function ticketCtx(i, staffOnly = true, chId = i.channelId) {
  const t = db.tickets[chId];
  const s = getSettings(i.guildId);
  if (!t || t.closedAt) {
    await i.reply({ content: chId === i.channelId ? 'Use this inside an open ticket.' : 'That ticket is already closed.', flags: EPH });
    return null;
  }
  if (staffOnly && !isStaff(i.member, t, s)) { await i.reply({ content: 'Staff only.', flags: EPH }); return null; }
  return { t, s };
}
const ticketChannel = (i, t) => i.guild.channels.fetch(t.channelId).catch(() => null);
const note = (s, text) => new EmbedBuilder().setColor(hex(s.color)).setDescription(text);
async function syncViews(i, ch, t, s) { if (ch) await refreshOpening(ch, t, s); await refreshQueue(i.guild, t, s); }

async function claim(i, chId = i.channelId) {
  const ctx = await ticketCtx(i, true, chId); if (!ctx) return;
  const { t, s } = ctx;
  if (s.claimMode === 'disabled') return i.reply({ content: 'Claiming is turned off.', flags: EPH });
  if (t.claimedBy) return i.reply({ content: `Already claimed by <@${t.claimedBy}>.`, flags: EPH });
  t.claimedBy = i.user.id; saveTickets(); // set before any await so two quick clicks can't both claim
  const viaQueue = chId !== i.channelId;
  await i.deferReply(viaQueue ? { flags: EPH } : {});
  const ch = await ticketChannel(i, t);
  await applyClaimPerms(ch, t, s, null);
  await syncViews(i, ch, t, s);
  const notice = {
    content: s.pingAuthorOnClaim ? `<@${t.userId}>` : undefined,
    embeds: [note(s, `🙋 Ticket claimed by <@${i.user.id}>.`)], allowedMentions: { users: [t.userId] },
  };
  if (viaQueue) { await ch?.send(notice).catch(() => {}); return i.editReply(`✅ You claimed Ticket #${pad(t.num)} → <#${t.channelId}>`); }
  return i.editReply(notice);
}

async function unclaim(i, chId = i.channelId) {
  const ctx = await ticketCtx(i, true, chId); if (!ctx) return;
  const { t, s } = ctx;
  if (!t.claimedBy) return i.reply({ content: 'This ticket is not claimed.', flags: EPH });
  if (t.claimedBy !== i.user.id && !isManager(i.member)) return i.reply({ content: 'Only the claimer (or a manager) can unclaim.', flags: EPH });
  const prev = t.claimedBy; t.claimedBy = null; saveTickets();
  const viaQueue = chId !== i.channelId;
  await i.deferReply(viaQueue ? { flags: EPH } : {});
  const ch = await ticketChannel(i, t);
  await applyClaimPerms(ch, t, s, prev);
  await syncViews(i, ch, t, s);
  const notice = { embeds: [note(s, `Ticket unclaimed by <@${i.user.id}>.`)] };
  if (viaQueue) { await ch?.send(notice).catch(() => {}); return i.editReply(`↩️ You released Ticket #${pad(t.num)}.`); }
  return i.editReply(notice);
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
  await syncViews(i, i.channel, t, s);
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
  await syncViews(i, i.channel, ctx.t, ctx.s);
  return i.reply({ embeds: [note(ctx.s, `Priority set to ${PRIORITY[ctx.t.priority]}.`)] });
}

// ---------- close ----------
const closeModal = (t, chId) => new ModalBuilder().setCustomId(`closereason:${chId}`).setTitle(`Close ticket #${pad(t.num)}`).addComponents(
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Why is this ticket being closed?')
    .setPlaceholder('e.g. Resolved').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)));

async function requestClose(i, reason, chId = i.channelId) {
  const ctx = await ticketCtx(i, false, chId); if (!ctx) return;
  const { t, s } = ctx;
  if (!isStaff(i.member, t, s) && (i.user.id !== t.userId || s.closeRequiresSupport)) {
    return i.reply({ content: 'You cannot close this ticket.', flags: EPH });
  }
  if (s.closeRequiresReason && !reason) return i.showModal(closeModal(t, chId));
  const viaQueue = chId !== i.channelId;
  await i.deferReply(viaQueue ? { flags: EPH } : {});
  const ch = await ticketChannel(i, t);
  const closed = await closeTicketCore({ guild: i.guild, channel: ch, ticket: t, closedBy: i.user, reason: reason || s.defaultCloseReason || 'No reason given' });
  if (!closed) return i.editReply('This ticket was already closed.').catch(() => {});
  return i.editReply(viaQueue ? `🔒 Ticket #${pad(t.num)} closed.` : '🔒 Ticket closed. This channel will be deleted in 5 seconds.').catch(() => {});
}

// Shared by /close, the buttons, auto-close, author-left and manual channel deletion.
async function closeTicketCore({ guild, channel, ticket, closedBy, reason, deleted = false }) {
  if (ticket.closedAt) return false; // someone else is already closing it
  const s = getSettings(guild.id);
  ticket.closedAt = new Date().toISOString(); ticket.closedBy = closedBy?.id || null; ticket.closeReason = reason;
  await removeQueue(guild, ticket); // closed tickets leave the tickets channel
  saveTickets();

  const messages = !deleted && channel ? await fetchAll(channel).catch(() => []) : [];
  const closerText = s.hideCloser ? 'Staff Team' : closedBy ? `<@${closedBy.id}>` : 'System';
  const html = messages.length
    ? buildHtml(ticket, messages, { closer: s.hideCloser ? 'Staff Team' : closedBy?.username || 'System', reason }) : null;
  if (html) { // keep a copy so the dashboard can show it later
    try {
      fs.writeFileSync(path.join(TRANSCRIPT_DIR, `${guild.id}-${pad(ticket.num)}.html`), html);
      ticket.hasTranscript = true; saveTickets();
    } catch (e) { console.error('Transcript save failed:', e.message); }
  }
  const file = () => (html ? [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `ticket-${pad(ticket.num)}.html` })] : []);

  const embed = ticketEmbed(ticket, s, `Ticket Closed #${pad(ticket.num)}`).setColor(0xed4245)
    .addFields({ name: 'Closed by', value: closerText, inline: true }, { name: 'Reason', value: clip(reason, 1024), inline: true });
  if (s.logStaffCounts && messages.length) {
    const counts = {};
    for (const m of messages) if (!m.author.bot && m.author.id !== ticket.userId) counts[m.author.id] = (counts[m.author.id] || 0) + 1;
    const lines = Object.entries(counts).map(([id, n]) => `<@${id}>: ${n}`);
    if (lines.length) embed.addFields({ name: 'Staff messages', value: clip(lines.join('\n'), 1024) });
  }
  await sendLog(guild, s.closedLogId, { embeds: [embed] }); // the conversation is kept in data/transcripts and shown in the dashboard

  if (s.dmOnClose) {
    const u = await guild.client.users.fetch(ticket.userId).catch(() => null);
    await u?.send({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle(`Ticket #${pad(ticket.num)} closed`)
        .setDescription(`Your ticket in **${guild.name}** was closed.\n**Reason:** ${clip(reason, 1000)}`)],
      files: file(),
    }).catch(() => {});
  }
  if (!deleted && channel) setTimeout(() => channel.delete('Ticket closed').catch(() => {}), 5000);
  return true;
}

module.exports = {
  createTicket, manualCreate, panelMessage, openOption, handleTicketModal,
  claim, unclaim, transfer, addRemove, rename, priority, requestClose, closeTicketCore,
};
