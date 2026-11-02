const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getSettings, saveSettings, resetSettings } = require('./store');

const EPH = MessageFlags.Ephemeral;
const list = (ids, pre) => (ids.length ? ids.map((x) => `<${pre}${x}>`).join(' ') : '—');
const ROLE_KEYS = { support: ['supportRoleIds', 'Support'], ping: ['pingRoleIds', 'Ping'], blocked: ['blockedRoleIds', 'Blocked'] };

function settingsEmbed(s) {
  return new EmbedBuilder().setColor(parseInt(s.color.replace('#', ''), 16) || 0xd4af37).setTitle('Ticket settings').addFields(
    { name: 'Support roles', value: list(s.supportRoleIds, '@&') },
    { name: 'Ping roles (new tickets)', value: s.pingRoleIds.length ? list(s.pingRoleIds, '@&') : 'support roles' },
    { name: 'Blocked roles', value: list(s.blockedRoleIds, '@&') },
    { name: 'Categories', value: list(s.categoryIds, '#') },
    { name: 'Tickets channel', value: s.queueChannelId ? `<#${s.queueChannelId}>` : '— (not set)', inline: true },
    { name: 'Closed log', value: s.closedLogId ? `<#${s.closedLogId}>` : '—', inline: true },
    { name: 'Claim mode', value: s.claimMode, inline: true },
    { name: 'Max per user / total', value: `${s.maxPerUser} / ${s.maxTotal}`, inline: true },
    { name: 'Close needs reason / staff', value: `${s.closeRequiresReason} / ${s.closeRequiresSupport}`, inline: true },
    { name: 'DM on close / hide closer', value: `${s.dmOnClose} / ${s.hideCloser}`, inline: true },
    { name: 'Auto-close (hours) / on leave', value: `${s.autoCloseHours || 'off'} / ${s.autoCloseOnLeave}`, inline: true },
    { name: 'Staff counts in close log', value: String(s.logStaffCounts), inline: true },
  );
}

async function settings(i) {
  const g = i.guildId;
  if (i.options.getSubcommand() === 'view') return i.reply({ embeds: [settingsEmbed(getSettings(g))], flags: EPH });
  if (i.options.getSubcommand() === 'reset') {
    return i.reply({ flags: EPH, content: '⚠️ This clears **all ticket settings for this server** (support roles, channels, categories, claim mode, close rules…) back to defaults. It does **not** delete tickets, panels, or any channels or roles on Discord. Continue?',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('resetcfg:yes').setLabel('Yes, reset settings').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('resetcfg:no').setLabel('Cancel').setStyle(ButtonStyle.Secondary))] });
  }
  const o = i.options; const s = getSettings(g); const p = {};
  if (o.getChannel('tickets_channel')) p.queueChannelId = o.getChannel('tickets_channel').id;
  if (o.getChannel('closed_log')) p.closedLogId = o.getChannel('closed_log').id;
  const base = o.getBoolean('clear_categories') ? [] : s.categoryIds;
  if (o.getBoolean('clear_categories') || o.getChannel('category')) {
    p.categoryIds = [...new Set([...base, ...(o.getChannel('category') ? [o.getChannel('category').id] : [])])].slice(0, 25);
  }
  if (o.getString('claim_mode')) p.claimMode = o.getString('claim_mode');
  for (const [opt, key] of [['ping_author', 'pingAuthorOnClaim'], ['close_requires_reason', 'closeRequiresReason'],
    ['close_requires_support', 'closeRequiresSupport'], ['dm_on_close', 'dmOnClose'], ['hide_closer', 'hideCloser'],
    ['auto_close_on_leave', 'autoCloseOnLeave'], ['log_staff_counts', 'logStaffCounts']]) {
    const v = o.getBoolean(opt); if (v !== null) p[key] = v;
  }
  for (const [opt, key] of [['max_per_user', 'maxPerUser'], ['max_total', 'maxTotal'], ['auto_close_hours', 'autoCloseHours']]) {
    const v = o.getInteger(opt); if (v !== null) p[key] = v;
  }
  if (o.getString('default_close_reason') !== null) p.defaultCloseReason = o.getString('default_close_reason');
  const color = o.getString('color');
  if (color) {
    if (!/^#?[0-9a-f]{6}$/i.test(color)) return i.reply({ content: 'Color must look like `#d4af37`.', flags: EPH });
    p.color = color.startsWith('#') ? color : `#${color}`;
  }
  saveSettings(g, p);
  return i.reply({ content: 'Settings saved.', embeds: [settingsEmbed(getSettings(g))], flags: EPH });
}

async function roles(i) {
  const g = i.guildId; const s = getSettings(g);
  const [kind, verb] = i.options.getString('action').split('_');
  const [key, label] = ROLE_KEYS[kind];
  const id = i.options.getRole('role').id;
  const next = verb === 'add' ? [...new Set([...s[key], id])].slice(0, 25) : s[key].filter((r) => r !== id);
  saveSettings(g, { [key]: next });
  return i.reply({ content: `${label} roles: ${list(next, '@&')}`, flags: EPH, allowedMentions: { parse: [] } });
}

async function help(i) {
  return i.reply({ flags: EPH, embeds: [new EmbedBuilder().setColor(0xd4af37).setTitle('Ticket bot').setDescription([
    '**Tickets channel:** every open ticket has one message there (🟢 Unclaimed / 🟡 Claimed by staff) with **Claim**, **Open Ticket** and **Close** buttons.',
    '**In a ticket (staff):** `/claim` `/unclaim` `/transfer` `/add` `/remove` `/rename` `/priority`',
    '**Close:** asks for a short explanation, then logs it in the closed log',
    '**Open for someone:** `/createticket` or right-click a message → Apps → Create Ticket',
    '**Admin:** `/setup` (setup options + manual guide), `/settings view|set`, `/roles`, `/panel list|create|edit|addoption|removeoption|type|send|refresh|delete`',
  ].join('\n'))] });
}

async function resetConfirm(i, answer) {
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return i.reply({ content: 'Only members with **Manage Server** can do this.', flags: EPH });
  if (answer !== 'yes') return i.update({ content: 'Cancelled. Nothing was changed.', components: [] });
  resetSettings(i.guildId);
  return i.update({ content: '✅ Settings reset to defaults for this server. Run `/setup` to set it up again.', components: [] });
}

module.exports = { settings, roles, help, resetConfirm };
