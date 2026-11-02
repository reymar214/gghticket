const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data');
const PANELS_FILE = path.join(__dirname, '..', 'panels.json');
const TRANSCRIPT_DIR = path.join(DIR, 'transcripts');
const BACKUP_DIR = path.join(DIR, 'backups');
fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

class DataDamagedError extends Error {
  constructor(message) { super(message); this.name = 'DataDamagedError'; this.userMessage = message; }
}

// ---------- safe file access ----------
// Saves are atomic: write a temp file, keep the previous version as .bak, then rename over the real file.
// A crash or power cut can no longer leave a half-written file behind.
function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  if (fs.existsSync(file)) { try { fs.copyFileSync(file, `${file}.bak`); } catch { /* backup is best effort */ } }
  try { fs.renameSync(tmp, file); }
  catch { fs.writeFileSync(file, fs.readFileSync(tmp)); fs.rmSync(tmp, { force: true }); } // some Windows setups refuse to rename over an open file
}

// A missing file means "first run". A damaged file is NEVER treated as empty: use the last good copy, or stop.
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  for (const candidate of [file, `${file}.bak`]) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (candidate !== file) console.error(`⚠️  ${path.basename(file)} was damaged; restored the last good copy (${path.basename(candidate)}).`);
      return value;
    } catch { /* try the next copy */ }
  }
  const kept = `${file}.damaged-${Date.now()}`;
  try { fs.copyFileSync(file, kept); } catch { /* ignore */ }
  throw new DataDamagedError(`❌ ${path.basename(file)} is damaged and no backup copy could be read.\n   A copy was kept as ${path.basename(kept)}. Starting anyway would erase your data, so the bot stopped.\n   Restore ${path.basename(file)} from ${BACKUP_DIR} (daily copies) or fix it, then start again.`);
}

// ---------- settings & tickets ----------
// Defaults mirror Ticket King's documented defaults where known.
const DEFAULTS = {
  supportRoleIds: [], pingRoleIds: [], blockedRoleIds: [], categoryIds: [],
  queueChannelId: null,            // the "Tickets" channel: one live message per open ticket
  openedLogId: null,               // legacy: older installs used this as the tickets channel
  closedLogId: null,
  claimMode: 'private',            // disabled | nochange | readonly | private
  pingAuthorOnClaim: true,
  maxPerUser: 1, maxTotal: 500,
  closeRequiresReason: true, closeRequiresSupport: false,
  dmOnClose: true, defaultCloseReason: '', hideCloser: false,
  color: '#d4af37', autoCloseHours: 0, autoCloseOnLeave: true, logStaffCounts: false,
};

const SETTINGS_FILE = path.join(DIR, 'settings.json');
const TICKETS_FILE = path.join(DIR, 'tickets.json');
fs.mkdirSync(DIR, { recursive: true });
const settingsDb = readJson(SETTINGS_FILE, {});
const rawTickets = readJson(TICKETS_FILE, {});
const db = { counter: rawTickets.counter || {}, tickets: rawTickets.tickets || {} };

const getSettings = (g) => {
  const s = { ...DEFAULTS, ...(settingsDb[g] || {}) };
  if (!s.queueChannelId && s.openedLogId) s.queueChannelId = s.openedLogId; // old "opened log" becomes the tickets channel
  return s;
};
const saveSettings = (g, patch) => { settingsDb[g] = { ...(settingsDb[g] || {}), ...patch }; writeAtomic(SETTINGS_FILE, settingsDb); };
const resetSettings = (g) => { delete settingsDb[g]; writeAtomic(SETTINGS_FILE, settingsDb); }; // back to defaults for one server
const saveTickets = () => writeAtomic(TICKETS_FILE, db);

// ---------- panels (kept separately for every server) ----------
// panels.json: { guilds: { <serverId>: { <panelId>: panel } }, legacy: { ... } }. Older files had one shared "panels" list.
let panelsCache = { guilds: {}, legacy: {} };
let panelsReadable = true;
function readPanelsFile() {
  if (!fs.existsSync(PANELS_FILE)) { panelsReadable = true; return panelsCache; }
  for (const candidate of [PANELS_FILE, `${PANELS_FILE}.bak`]) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      panelsCache = { guilds: raw.guilds || {}, legacy: { ...(raw.panels || {}), ...(raw.legacy || {}) } };
      panelsReadable = true;
      if (candidate !== PANELS_FILE) console.error('⚠️  panels.json was damaged; restored the last good copy.');
      return panelsCache;
    } catch { /* try the next copy */ }
  }
  console.error('❌ panels.json cannot be read (a typo?). Using the last good copy from memory; saving panels is blocked until it is fixed.');
  panelsReadable = false;
  return panelsCache;
}
const loadPanels = (guildId) => readPanelsFile().guilds[guildId] || {};
function savePanels(guildId, panels) {
  const data = readPanelsFile();
  if (!panelsReadable) throw new Error('panels.json is damaged (a typo?). Fix it and try again. Nothing was saved.');
  data.guilds[guildId] = panels;
  writeAtomic(PANELS_FILE, data);
  panelsCache = data;
}

// Moves panels from the old shared list to the server they belong to: found by where they were posted, else by the
// starter-panel name, else the GUILD_ID server (or the only server the bot is in). Anything left stays untouched.
function migratePanels(client) {
  const data = readPanelsFile();
  const ids = Object.keys(data.legacy);
  if (!ids.length || !panelsReadable) return;
  const fallback = process.env.GUILD_ID && client.guilds.cache.has(process.env.GUILD_ID) ? process.env.GUILD_ID
    : client.guilds.cache.size === 1 ? client.guilds.cache.first().id : null;
  const moved = []; const left = [];
  for (const id of ids) {
    const panel = data.legacy[id];
    let gid = null;
    for (const ref of panel.messages || []) { const ch = client.channels.cache.get(ref.channelId); if (ch?.guild) { gid = ch.guild.id; break; } }
    const starter = id.match(/^s-(\d+)$/);
    if (!gid && starter && client.guilds.cache.has(starter[1])) gid = starter[1];
    if (!gid) gid = fallback;
    if (!gid) { left.push(id); continue; }
    data.guilds[gid] = data.guilds[gid] || {};
    let nid = id; let n = 2;
    while (data.guilds[gid][nid]) nid = `${id}-${n++}`;
    data.guilds[gid][nid] = panel; delete data.legacy[id]; moved.push(`${id} → ${client.guilds.cache.get(gid)?.name || gid}`);
  }
  writeAtomic(PANELS_FILE, data); panelsCache = data;
  if (moved.length) console.log(`Panels are now kept per server. Moved: ${moved.join(', ')}`);
  if (left.length) console.warn(`⚠️  ${left.length} panel(s) could not be matched to a server and were left unused: ${left.join(', ')}. Set GUILD_ID in .env and restart to adopt them.`);
}

// ---------- backups ----------
// Daily copies of the data files (last 14 kept) plus a mirror of every transcript (they never change once written).
// This protects against bad edits and corruption, but it is on the same disk: also copy the data folder elsewhere.
function backupNow() {
  try {
    const dir = path.join(BACKUP_DIR, new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, src] of [['tickets.json', TICKETS_FILE], ['settings.json', SETTINGS_FILE], ['panels.json', PANELS_FILE]]) {
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
    }
    const mirror = path.join(BACKUP_DIR, 'transcripts');
    fs.mkdirSync(mirror, { recursive: true });
    for (const f of fs.readdirSync(TRANSCRIPT_DIR)) {
      const to = path.join(mirror, f);
      if (!fs.existsSync(to)) fs.copyFileSync(path.join(TRANSCRIPT_DIR, f), to);
    }
    const days = fs.readdirSync(BACKUP_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    for (const old of days.slice(0, Math.max(0, days.length - 14))) fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
  } catch (e) { console.error('Backup failed:', e.message); }
}
function startBackups() { backupNow(); const t = setInterval(backupNow, 6 * 3_600_000); t.unref?.(); }

module.exports = {
  db, getSettings, saveSettings, resetSettings, saveTickets, loadPanels, savePanels, migratePanels,
  backupNow, startBackups, TRANSCRIPT_DIR, BACKUP_DIR, DEFAULTS, DataDamagedError,
};
