// Local dashboard: runs inside the bot process (shares its live data), bound to 127.0.0.1 only. No extra dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');
const { db, getSettings, saveSettings, loadPanels, savePanels, TRANSCRIPT_DIR } = require('./store');
const { panelMessage } = require('./tickets');
const { fetchAll, buildHtml } = require('./transcript');

const PAGE = fs.readFileSync(path.join(__dirname, 'dashboard.html'));
const ID_RE = /^[a-z0-9_-]{1,30}$/;
const SNOWFLAKE = /^\d{5,25}$/;
const STYLES = ['Primary', 'Secondary', 'Success', 'Danger'];
const EMOJI_RE = /^(<a?:\w+:\d+>|\p{Extended_Pictographic}\uFE0F?(\u200D\p{Extended_Pictographic}\uFE0F?)*)$/u;
const CLAIM_MODES = ['disabled', 'nochange', 'readonly', 'private'];
const BOOLS = ['pingAuthorOnClaim', 'closeRequiresReason', 'closeRequiresSupport', 'dmOnClose', 'hideCloser', 'autoCloseOnLeave', 'logStaffCounts'];

class HttpError extends Error { constructor(code, msg) { super(msg); this.status = code; } }
const bad = (msg) => new HttpError(400, msg);
const persist = (gid, panels) => { try { savePanels(gid, panels); } catch (e) { throw new HttpError(500, e.message); } };

// ---------- validation ----------
function cleanSettings(guild, body) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const list = (v, name) => { if (!Array.isArray(v)) throw bad(`${name} must be a list`); const u = [...new Set(v.map(String))]; if (u.length > 25) throw bad(`${name}: at most 25`); return u; };
  const chan = (v, name, type) => {
    if (v === null || v === '') return null;
    const c = guild.channels.cache.get(String(v));
    if (!c || c.type !== type) throw bad(`${name}: pick a ${type === ChannelType.GuildText ? 'text channel' : 'category'} from this server`);
    return c.id;
  };
  const int = (v, name, min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number from ${min} to ${max}`); return n; };

  for (const k of ['supportRoleIds', 'pingRoleIds', 'blockedRoleIds']) {
    if (!has(k)) continue;
    out[k] = list(body[k], k);
    for (const id of out[k]) if (!guild.roles.cache.has(id)) throw bad(`${k}: unknown role ${id}`);
  }
  if (has('categoryIds')) out.categoryIds = list(body.categoryIds, 'Categories').map((id) => chan(id, 'Categories', ChannelType.GuildCategory));
  if (has('queueChannelId')) { out.queueChannelId = chan(body.queueChannelId, 'Tickets channel', ChannelType.GuildText); out.openedLogId = null; }
  if (has('closedLogId')) out.closedLogId = chan(body.closedLogId, 'Closed log', ChannelType.GuildText);
  if (has('claimMode')) { if (!CLAIM_MODES.includes(body.claimMode)) throw bad('Invalid claim mode'); out.claimMode = body.claimMode; }
  for (const k of BOOLS) if (has(k)) { if (typeof body[k] !== 'boolean') throw bad(`${k} must be on or off`); out[k] = body[k]; }
  if (has('maxPerUser')) out.maxPerUser = int(body.maxPerUser, 'Max per user', 1, 100);
  if (has('maxTotal')) out.maxTotal = int(body.maxTotal, 'Max total', 1, 5000);
  if (has('autoCloseHours')) out.autoCloseHours = int(body.autoCloseHours, 'Auto-close hours', 0, 8760);
  if (has('defaultCloseReason')) { const v = String(body.defaultCloseReason ?? '').trim(); if (v.length > 200) throw bad('Default close reason: max 200 characters'); out.defaultCloseReason = v; }
  if (has('color')) { if (!/^#?[0-9a-f]{6}$/i.test(String(body.color))) throw bad('Color must look like #d4af37'); out.color = String(body.color).startsWith('#') ? body.color : `#${body.color}`; }
  return out;
}

function validatePanel(p) {
  if (!p || typeof p !== 'object') throw bad('Panel must be an object');
  const str = (v, max, name, required = false) => {
    v = v == null ? '' : String(v).trim();
    if (required && !v) throw bad(`${name} is required`);
    if (v.length > max) throw bad(`${name} is too long (max ${max})`);
    return v || undefined;
  };
  const color = (v, name) => { v = str(v, 7, name); if (v === undefined) return undefined; if (!/^#?[0-9a-f]{6}$/i.test(v)) throw bad(`${name} must look like #d4af37`); return v.startsWith('#') ? v : `#${v}`; };
  const out = { title: str(p.title, 100, 'Title', true), description: str(p.description, 2000, 'Description', true), color: color(p.color, 'Color'), footer: str(p.footer, 200, 'Footer') };
  out.image = str(p.image, 300, 'Image URL');
  if (out.image && !/^https?:\/\/\S+$/i.test(out.image)) throw bad('Image must start with http:// or https://');
  out.type = p.type === 'select' ? 'select' : 'buttons';
  if (out.type === 'select') out.placeholder = str(p.placeholder, 100, 'Placeholder');

  const opts = Array.isArray(p.options) ? p.options : [];
  if (opts.length > 25) throw bad('A panel can have at most 25 options');
  const seen = new Set();
  out.options = opts.map((o, i) => {
    const w = `Option ${i + 1}`;
    if (!o || typeof o !== 'object') throw bad(`${w} is invalid`);
    const id = str(o.id, 30, `${w} id`, true);
    if (!ID_RE.test(id)) throw bad(`${w}: id may only use lowercase letters, numbers, - and _`);
    if (seen.has(id)) throw bad(`${w}: duplicate id "${id}"`);
    seen.add(id);
    if (o.style && !STYLES.includes(o.style)) throw bad(`${w}: color must be ${STYLES.join(', ')}`);
    const emoji = str(o.emoji, 60, `${w} emoji`);
    if (emoji && !EMOJI_RE.test(emoji)) throw bad(`${w}: emoji must be a normal emoji or <:name:id>`);
    const qs = Array.isArray(o.questions) ? o.questions : [];
    if (qs.length > 5) throw bad(`${w}: at most 5 questions`);
    const opt = {
      id, label: str(o.label, 80, `${w} label`, true), emoji, style: o.style || 'Primary', description: str(o.description, 100, `${w} description`),
      nameFormat: str(o.nameFormat, 100, `${w} channel name format`), embedMessage: str(o.embedMessage, 500, `${w} welcome message`),
      questions: qs.map((q, n) => {
        const qw = `${w}, question ${n + 1}`;
        const style = q.style === 'paragraph' ? 'paragraph' : 'short';
        const max = q.maxLength === undefined || q.maxLength === '' ? (style === 'paragraph' ? 1000 : 200) : Number(q.maxLength);
        if (!Number.isInteger(max) || max < 1 || max > 1000) throw bad(`${qw}: max length must be 1 to 1000`);
        return { label: str(q.label, 45, `${qw} label`, true), style, maxLength: max, placeholder: str(q.placeholder, 100, `${qw} placeholder`), ...(q.required === false ? { required: false } : {}) };
      }),
    };
    // Per-option roles/category are edited in panels.json by hand; keep them if present.
    if (Array.isArray(o.supportRoleIds)) opt.supportRoleIds = o.supportRoleIds.map(String).filter((x) => SNOWFLAKE.test(x));
    if (typeof o.categoryId === 'string' && SNOWFLAKE.test(o.categoryId)) opt.categoryId = o.categoryId;
    return opt;
  });
  return out;
}

// ---------- http plumbing ----------
function send(res, code, body, type = 'application/json') {
  const headers = { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (code === 413) headers.Connection = 'close'; // the oversized body is not read, so the connection must not be reused
  if (type === 'text/html') headers['Content-Security-Policy'] = "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; connect-src 'self'; frame-ancestors 'none'";
  res.writeHead(code, headers);
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 300_000) throw new HttpError(413, 'Request too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw bad('Invalid JSON'); }
}

function start(client, port = Number(process.env.DASHBOARD_PORT) || 3737) {
  if (String(process.env.DASHBOARD || '').toLowerCase() === 'off') return null;
  const names = new Map();
  const nameOf = async (id) => {
    if (!id) return null;
    if (names.has(id)) return names.get(id);
    const u = client.users.cache.get(id) || await client.users.fetch(id).catch(() => null);
    if (!u) return id;
    const n = u.globalName || u.username; names.set(id, n); return n;
  };
  const guildOf = (id) => { const g = client.guilds.cache.get(id); if (!g) throw new HttpError(404, 'Unknown server'); return g; };

  async function route(req, res, url) {
    const p = url.pathname; const M = req.method; let m;
    if (M === 'GET' && p === '/') return send(res, 200, PAGE, 'text/html');
    if (M === 'GET' && p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (M === 'GET' && p === '/api/meta') {
      const guilds = [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name }));
      const def = process.env.GUILD_ID && client.guilds.cache.has(process.env.GUILD_ID) ? process.env.GUILD_ID : guilds[0]?.id || null;
      return send(res, 200, { guilds, defaultGuild: def, bot: client.user?.tag || null });
    }
    if (M === 'GET' && (m = p.match(/^\/api\/guild\/(\w+)$/))) {
      const g = guildOf(m[1]);
      const channels = [...g.channels.cache.values()]
        .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildCategory)
        .map((c) => ({ id: c.id, name: c.name, type: c.type === ChannelType.GuildCategory ? 'category' : 'text' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const roles = [...g.roles.cache.values()].filter((r) => r.id !== g.id && !r.managed)
        .sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name }));
      return send(res, 200, { id: g.id, name: g.name, channels, roles, settings: getSettings(g.id) });
    }
    if (M === 'POST' && (m = p.match(/^\/api\/guild\/(\w+)\/settings$/))) {
      const g = guildOf(m[1]);
      saveSettings(g.id, cleanSettings(g, await readJson(req)));
      return send(res, 200, getSettings(g.id));
    }
    if (M === 'GET' && (m = p.match(/^\/api\/guild\/(\w+)\/tickets$/))) {
      const g = guildOf(m[1]);
      const list = Object.values(db.tickets).filter((t) => t.guildId === g.id).sort((a, b) => b.num - a.num);
      await Promise.all([...new Set(list.flatMap((t) => [t.claimedBy, t.closedBy]).filter(Boolean))].map(nameOf));
      return send(res, 200, list.map((t) => ({
        num: t.num, channelId: t.channelId, userId: t.userId, username: t.username, type: t.type, answers: t.answers || [],
        priority: t.priority, claimedBy: t.claimedBy, claimedByName: t.claimedBy ? names.get(t.claimedBy) || t.claimedBy : null,
        openedAt: t.openedAt, closedAt: t.closedAt, closedBy: t.closedBy, closedByName: t.closedBy ? names.get(t.closedBy) || t.closedBy : null,
        closeReason: t.closeReason || null, status: t.closedAt ? 'closed' : 'open', hasTranscript: !!t.hasTranscript,
      })));
    }
    if (M === 'GET' && (m = p.match(/^\/transcripts\/(\d+)\/(\d+)$/))) {
      const file = path.join(TRANSCRIPT_DIR, `${m[1]}-${String(m[2]).padStart(4, '0')}.html`);
      if (!fs.existsSync(file)) throw new HttpError(404, 'No transcript saved for this ticket');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'" });
      return res.end(fs.readFileSync(file));
    }

    if (M === 'GET' && (m = p.match(/^\/live\/(\w+)\/(\d+)$/))) {   // conversation of a ticket that is still open, read from Discord right now
      const g = guildOf(m[1]);
      const t = Object.values(db.tickets).find((x) => x.guildId === g.id && x.num === Number(m[2]));
      if (!t || t.closedAt) throw new HttpError(404, 'That ticket is not open');
      const ch = await g.channels.fetch(t.channelId).catch(() => null);
      if (!ch) throw new HttpError(404, 'The ticket channel no longer exists');
      const msgs = await fetchAll(ch, 500).catch(() => { throw new HttpError(502, 'Could not read the channel from Discord'); });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'" });
      return res.end(buildHtml(t, msgs, { closer: null }));
    }

    if (M === 'GET' && (m = p.match(/^\/api\/guild\/(\w+)\/panels$/))) {
      const g = guildOf(m[1]);
      const out = {};
      for (const [id, panel] of Object.entries(loadPanels(g.id))) { const { messages, ...rest } = panel; out[id] = { ...rest, options: rest.options || [], postedCount: (messages || []).length }; }
      return send(res, 200, out);
    }
    if ((M === 'PUT' || M === 'DELETE') && (m = p.match(/^\/api\/guild\/(\w+)\/panels\/([^/]+)$/))) {
      const g = guildOf(m[1]);
      const id = decodeURIComponent(m[2]);
      if (!ID_RE.test(id)) throw bad('Panel id may only use lowercase letters, numbers, - and _ (max 30)');
      const panels = loadPanels(g.id);
      if (M === 'DELETE') {
        if (!panels[id]) throw new HttpError(404, 'No such panel');
        delete panels[id]; persist(g.id, panels); return send(res, 200, { ok: true });
      }
      const clean = validatePanel(await readJson(req));
      const messages = panels[id]?.messages;
      panels[id] = { ...clean, ...(messages ? { messages } : {}) };
      persist(g.id, panels);
      return send(res, 200, { ok: true });
    }
    if (M === 'POST' && (m = p.match(/^\/api\/guild\/(\w+)\/panels\/([^/]+)\/(send|refresh)$/))) {
      const g = guildOf(m[1]); const id = decodeURIComponent(m[2]);
      const panels = loadPanels(g.id); const panel = panels[id];
      if (!panel) throw new HttpError(404, 'No such panel (save it first)');
      if (!(panel.options || []).length) throw bad('Add at least one option first');
      try {
        if (m[3] === 'send') {
          const { channelId } = await readJson(req);
          const ch = g.channels.cache.get(String(channelId));
          if (!ch || ch.type !== ChannelType.GuildText) throw bad('Pick a text channel');
          const msg = await ch.send(panelMessage(id, panel, getSettings(g.id)));
          (panel.messages ||= []).push({ channelId: ch.id, messageId: msg.id });
          persist(g.id, panels);
          return send(res, 200, { ok: true, posted: 1 });
        }
        let done = 0; const keep = [];
        for (const ref of panel.messages || []) {
          const ch = await g.channels.fetch(ref.channelId).catch(() => null);
          const msg = ch ? await ch.messages.fetch(ref.messageId).catch(() => null) : null;
          if (!msg) continue;
          await msg.edit(panelMessage(id, panel, getSettings(g.id))); keep.push(ref); done++;
        }
        panel.messages = keep; persist(g.id, panels);
        return send(res, 200, { ok: true, updated: done });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(502, `Discord refused: ${e.message}`);
      }
    }
    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'Forbidden');   // blocks DNS-rebinding
      if (req.method !== 'GET') {
        if (req.headers['x-dashboard'] !== '1') throw new HttpError(403, 'Forbidden');                         // forces a CORS preflight for other sites
        if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new HttpError(403, 'Forbidden');
      }
      await route(req, res, new URL(req.url, `http://${host}`));
    } catch (e) {
      const known = e instanceof HttpError;
      if (!known) console.error('Dashboard error:', e);
      if (!res.headersSent) send(res, known ? e.status : 500, { error: known ? e.message : 'Internal error' });
    }
  });
  server.on('error', (e) => console.error(e.code === 'EADDRINUSE' ? `Dashboard: port ${port} is already in use. Set DASHBOARD_PORT in .env to another number.` : `Dashboard error: ${e.message}`));
  server.listen(port, '127.0.0.1', () => console.log(`Dashboard: http://127.0.0.1:${port}`));
  return server;
}

module.exports = { start, validatePanel, cleanSettings };
