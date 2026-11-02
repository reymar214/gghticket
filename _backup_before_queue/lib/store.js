const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DIR, { recursive: true });

const read = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return fb; } };
const write = (f, d) => fs.writeFileSync(path.join(DIR, f), JSON.stringify(d, null, 2));

// Defaults mirror Ticket King's documented defaults where known.
const DEFAULTS = {
  supportRoleIds: [], blockedRoleIds: [], categoryIds: [],
  openedLogId: null, closedLogId: null,
  claimMode: 'private',            // disabled | nochange | readonly | private
  pingAuthorOnClaim: true,
  maxPerUser: 1, maxTotal: 500,
  closeRequiresReason: false, closeRequiresSupport: false,
  dmOnClose: true, defaultCloseReason: '', hideCloser: false,
  color: '#d4af37', autoCloseHours: 0, autoCloseOnLeave: true, logStaffCounts: false,
};

const settingsDb = read('settings.json', {});
const db = read('tickets.json', { counter: {}, tickets: {} });

const getSettings = (g) => ({ ...DEFAULTS, ...(settingsDb[g] || {}) });
const saveSettings = (g, patch) => { settingsDb[g] = { ...(settingsDb[g] || {}), ...patch }; write('settings.json', settingsDb); };
const saveTickets = () => write('tickets.json', db);

// panels.json is re-read on every use, so you can edit it without restarting.
const loadPanels = () => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'panels.json'), 'utf8')).panels || {}; }
  catch (e) { console.error('panels.json error:', e.message); return {}; }
};

module.exports = { db, getSettings, saveSettings, saveTickets, loadPanels, DEFAULTS };
