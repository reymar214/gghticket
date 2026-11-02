const { EmbedBuilder, MessageFlags } = require('discord.js');
const { getSettings, saveSettings, loadPanels } = require('./store');
const { panelMessage } = require('./tickets');

const EPH = MessageFlags.Ephemeral;
const list = (ids, pre) => (ids.length ? ids.map((x) => `<${pre}${x}>`).join(' ') : '—');

function settingsEmbed(s) {
  return new EmbedBuilder().setColor(parseInt(s.color.replace('#', ''), 16) || 0xd4af37).setTitle('Ticket settings').addFields(
    { name: 'Support roles', value: list(s.supportRoleIds, '@&') },
    { name: 'Blocked roles', value: list(s.blockedRoleIds, '@&') },
    { name: 'Categories', value: list(s.categoryIds, '#') },
    { name: 'Opened log', value: s.openedLogId ? `<#${s.openedLogId}>` : '—', inline: true },
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
  const o = i.options; const s = getSettings(g); const p = {};
  if (o.getChannel('opened_log')) p.openedLogId = o.getChannel('opened_log').id;
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
  const key = kind === 'support' ? 'supportRoleIds' : 'blockedRoleIds';
  const id = i.options.getRole('role').id;
  const next = verb === 'add' ? [...new Set([...s[key], id])].slice(0, 25) : s[key].filter((r) => r !== id);
  saveSettings(g, { [key]: next });
  return i.reply({ content: `${kind === 'support' ? 'Support' : 'Blocked'} roles: ${list(next, '@&')}`, flags: EPH, allowedMentions: { parse: [] } });
}

async function panel(i) {
  const panels = loadPanels();
  if (i.options.getSubcommand() === 'list') {
    const ids = Object.keys(panels);
    return i.reply({ content: ids.length ? ids.map((k) => `• \`${k}\``).join('\n') : 'No panels found in panels.json.', flags: EPH });
  }
  const id = i.options.getString('panel');
  if (!panels[id]) return i.reply({ content: `No panel called \`${id}\`. Use \`/panel list\`.`, flags: EPH });
  const target = i.options.getChannel('channel') || i.channel;
  await target.send(panelMessage(id, panels[id], getSettings(i.guildId)));
  return i.reply({ content: `Panel posted in <#${target.id}>.`, flags: EPH });
}

async function help(i) {
  return i.reply({ flags: EPH, embeds: [new EmbedBuilder().setColor(0xd4af37).setTitle('Ticket bot').setDescription([
    '**In a ticket (staff):** `/claim` `/unclaim` `/transfer` `/add` `/remove` `/rename` `/priority`',
    '**Close:** `/close [reason]` or the Close button (staff or the ticket author)',
    '**Open for someone:** `/createticket` or right-click a message → Apps → Create Ticket',
    '**Admin:** `/settings view|set`, `/roles`, `/panel list|send`',
  ].join('\n'))] });
}

module.exports = { settings, roles, panel, help };
