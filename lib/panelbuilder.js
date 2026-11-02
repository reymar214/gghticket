// Panel builder: create and edit ticket panels from Discord instead of editing panels.json by hand.
const { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle: S, MessageFlags } = require('discord.js');
const { loadPanels, savePanels, getSettings } = require('./store');
const { panelMessage } = require('./tickets');

const EPH = MessageFlags.Ephemeral;
const ID_RE = /^[a-z0-9_-]{1,30}$/;
const STYLES = ['Primary', 'Secondary', 'Success', 'Danger'];
const EMOJI_RE = /^(<a?:\w+:\d+>|\p{Extended_Pictographic}\uFE0F?(\u200D\p{Extended_Pictographic}\uFE0F?)*)$/u;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'option';
const okColor = (c) => (/^#?[0-9a-f]{6}$/i.test(c) ? (c.startsWith('#') ? c : `#${c}`) : null);
const okUrl = (u) => /^https?:\/\/\S+$/i.test(u);

const field = (id, label, style, { value, required = true, max, placeholder } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (max) t.setMaxLength(max);
  if (placeholder) t.setPlaceholder(placeholder);
  if (value) t.setValue(String(value).slice(0, max || 4000));
  return new ActionRowBuilder().addComponents(t);
};
const modal = (id, title, rows) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(rows);
const fail = (i, text) => i.reply({ content: `❌ ${text}`, flags: EPH });

async function preview(i, id, panels, text) {
  const m = panelMessage(id, panels[id], getSettings(i.guildId));
  return i.reply({ content: `${text}\nPreview below. Post it with \`/panel send panel:${id}\`, or update posted copies with \`/panel refresh panel:${id}\`.`, embeds: m.embeds, flags: EPH });
}

async function command(i) {
  const sub = i.options.getSubcommand();
  const panels = loadPanels(i.guildId);

  if (sub === 'list') {
    const ids = Object.keys(panels);
    return i.reply({ flags: EPH, content: ids.length
      ? ids.map((k) => `• \`${k}\` — ${(panels[k].options || []).length} option(s), ${panels[k].type === 'select' ? 'dropdown' : 'buttons'}`).join('\n')
      : 'No panels yet. Create one with `/panel create`.' });
  }
  if (sub === 'create') {
    return i.showModal(modal('pb_create', 'Create panel', [
      field('id', 'Panel id (letters, numbers, -)', S.Short, { max: 30, placeholder: 'support' }),
      field('title', 'Embed title', S.Short, { max: 100, value: 'Support Tickets' }),
      field('description', 'Embed description', S.Paragraph, { max: 2000, value: 'Click a button below to open a ticket.' }),
      field('color', 'Color (hex, optional)', S.Short, { max: 7, required: false, placeholder: '#d4af37' }),
      field('image', 'Image URL (optional)', S.Short, { max: 300, required: false }),
    ]));
  }

  const id = i.options.getString('panel');
  const p = panels[id];
  if (!p) return fail(i, `No panel called \`${id}\`. Use \`/panel list\`.`);

  if (sub === 'edit') {
    return i.showModal(modal(`pb_edit:${id}`, `Edit panel: ${id}`.slice(0, 45), [
      field('title', 'Embed title', S.Short, { max: 100, value: p.title }),
      field('description', 'Embed description', S.Paragraph, { max: 2000, value: p.description }),
      field('color', 'Color (hex, optional)', S.Short, { max: 7, required: false, value: p.color }),
      field('image', 'Image URL (optional)', S.Short, { max: 300, required: false, value: p.image }),
      field('footer', 'Footer text (optional)', S.Short, { max: 200, required: false, value: p.footer }),
    ]));
  }
  if (sub === 'addoption') {
    if ((p.options || []).length >= 25) return fail(i, 'A panel can have at most 25 options.');
    return i.showModal(modal(`pb_opt:${id}`, 'Add ticket option', [
      field('label', 'Button label', S.Short, { max: 80, placeholder: 'Report' }),
      field('emoji', 'Emoji (optional)', S.Short, { max: 60, required: false, placeholder: '🚨' }),
      field('style', 'Color: Primary/Secondary/Success/Danger', S.Short, { max: 10, required: false, placeholder: 'Primary' }),
      field('questions', 'Questions (one per line, max 5)', S.Paragraph, { max: 600, required: false, placeholder: 'What do you want to report?\nBriefly describe it |long' }),
      field('welcome', 'Welcome message in ticket (optional)', S.Paragraph, { max: 500, required: false }),
    ]));
  }
  if (sub === 'removeoption') {
    const oid = i.options.getString('option');
    const before = (p.options || []).length;
    p.options = (p.options || []).filter((o) => o.id !== oid);
    if (p.options.length === before) return fail(i, `No option \`${oid}\` in \`${id}\`.`);
    savePanels(i.guildId, panels);
    return preview(i, id, panels, `✅ Removed option \`${oid}\`.`);
  }
  if (sub === 'type') {
    p.type = i.options.getString('type'); savePanels(i.guildId, panels);
    return preview(i, id, panels, `✅ \`${id}\` now uses ${p.type === 'select' ? 'a dropdown' : 'buttons'}.`);
  }
  if (sub === 'delete') {
    delete panels[id]; savePanels(i.guildId, panels);
    return i.reply({ content: `🗑️ Deleted panel \`${id}\`. Copies already posted in channels stay until you delete those messages.`, flags: EPH });
  }
  if (sub === 'send') {
    if (!(p.options || []).length) return fail(i, 'Add at least one option first with `/panel addoption`.');
    const target = i.options.getChannel('channel') || i.channel;
    const m = await target.send(panelMessage(id, p, getSettings(i.guildId)));
    (p.messages ||= []).push({ channelId: target.id, messageId: m.id }); savePanels(i.guildId, panels);
    return i.reply({ content: `✅ Panel posted in <#${target.id}>.`, flags: EPH });
  }
  if (sub === 'refresh') {
    await i.deferReply({ flags: EPH });
    let done = 0; const keep = [];
    for (const ref of p.messages || []) {
      const ch = await i.guild.channels.fetch(ref.channelId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(ref.messageId).catch(() => null) : null;
      if (!msg) continue; // deleted: forget it
      await msg.edit(panelMessage(id, p, getSettings(i.guildId))); keep.push(ref); done++;
    }
    p.messages = keep; savePanels(i.guildId, panels);
    return i.editReply(done ? `✅ Updated ${done} posted panel(s).` : 'No posted copies found. Use `/panel send`.');
  }
}

async function modalSubmit(i) {
  const [kind, id] = i.customId.split(':');
  const get = (k) => (i.fields.getTextInputValue(k) || '').trim();
  const panels = loadPanels(i.guildId);

  if (kind === 'pb_create') {
    const pid = get('id').toLowerCase();
    if (!ID_RE.test(pid)) return fail(i, 'Panel id may only use lowercase letters, numbers, `-` and `_`.');
    if (panels[pid]) return fail(i, `A panel called \`${pid}\` already exists. Use \`/panel edit\`.`);
    const color = get('color') ? okColor(get('color')) : undefined;
    if (get('color') && !color) return fail(i, 'Color must look like `#d4af37`.');
    if (get('image') && !okUrl(get('image'))) return fail(i, 'Image must be a link starting with http:// or https://.');
    panels[pid] = { title: get('title'), description: get('description'), color, image: get('image') || undefined, type: 'buttons', options: [] };
    savePanels(i.guildId, panels);
    return preview(i, pid, panels, `✅ Panel \`${pid}\` created. Add buttons with \`/panel addoption panel:${pid}\`.`);
  }

  const p = panels[id];
  if (!p) return fail(i, `Panel \`${id}\` no longer exists.`);

  if (kind === 'pb_edit') {
    const color = get('color') ? okColor(get('color')) : undefined;
    if (get('color') && !color) return fail(i, 'Color must look like `#d4af37`.');
    if (get('image') && !okUrl(get('image'))) return fail(i, 'Image must be a link starting with http:// or https://.');
    Object.assign(p, { title: get('title'), description: get('description'), color, image: get('image') || undefined, footer: get('footer') || undefined });
    savePanels(i.guildId, panels);
    return preview(i, id, panels, `✅ Panel \`${id}\` updated.`);
  }

  if (kind === 'pb_opt') {
    const label = get('label');
    const emoji = get('emoji');
    if (emoji && !EMOJI_RE.test(emoji)) return fail(i, 'Emoji must be a normal emoji (🚨) or a custom one like `<:name:123456789>`.');
    const styleRaw = get('style');
    const style = styleRaw ? STYLES.find((x) => x.toLowerCase() === styleRaw.toLowerCase()) : 'Primary';
    if (!style) return fail(i, 'Color must be Primary, Secondary, Success or Danger.');
    const lines = get('questions').split('\n').map((l) => l.trim()).filter(Boolean);
    const questions = lines.slice(0, 5).map((l) => {
      const long = /\|\s*long\s*$/i.test(l);
      return { label: l.replace(/\|\s*long\s*$/i, '').trim().slice(0, 45), style: long ? 'paragraph' : 'short', maxLength: long ? 1000 : 200 };
    }).filter((q) => q.label);
    p.options = p.options || [];
    let oid = slug(label); let n = 2;
    while (p.options.some((o) => o.id === oid)) oid = `${slug(label)}-${n++}`;
    const opt = { id: oid, label, style, nameFormat: `${oid}-{number}`, questions };
    if (emoji) opt.emoji = emoji;
    if (get('welcome')) opt.embedMessage = get('welcome');
    p.options.push(opt); savePanels(i.guildId, panels);
    const extra = lines.length > 5 ? ' (only the first 5 questions were kept)' : '';
    return preview(i, id, panels, `✅ Added option **${label}** (\`${oid}\`) with ${questions.length} question(s)${extra}.`);
  }
}

async function autocomplete(i) {
  const f = i.options.getFocused(true);
  const panels = loadPanels(i.guildId);
  const q = String(f.value).toLowerCase();
  let names = [];
  if (f.name === 'panel') names = Object.keys(panels);
  else if (f.name === 'option') names = (panels[i.options.getString('panel')]?.options || []).map((o) => o.id);
  return i.respond(names.filter((n) => n.toLowerCase().includes(q)).slice(0, 25).map((n) => ({ name: n, value: n })));
}

module.exports = { command, modalSubmit, autocomplete };
