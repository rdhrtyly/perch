// uptime.js — pings each live site on a schedule and remembers whether
// it's up or down, plus a rolling uptime %.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const notify = require('./notify');

const FILE = path.join(config.dataDir, 'uptime.json');
const KEEP = 50; // how many recent checks we remember per site

let data = {};   // { siteId: { up, lastCheckedAt, recent: [1,0,...] } }
let dirty = false;

function load() {
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { data = {}; }
}
function flush() {
  if (!dirty) return;
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data)); dirty = false; } catch { /* ignore */ }
}

function record(siteId, up) {
  const u = data[siteId] || (data[siteId] = { recent: [] });
  u.up = up;
  u.lastCheckedAt = Date.now();
  u.recent.push(up ? 1 : 0);
  if (u.recent.length > KEEP) u.recent.shift();
  dirty = true;
}

function getUptime(siteId) {
  const u = data[siteId];
  if (!u) return { up: null, lastCheckedAt: null, pct: null };
  const pct = u.recent.length ? Math.round((u.recent.reduce((a, b) => a + b, 0) / u.recent.length) * 100) : null;
  return { up: u.up, lastCheckedAt: u.lastCheckedAt, pct };
}

function removeSite(siteId) { delete data[siteId]; dirty = true; }

// Ping a URL. "Up" = we got any non-server-error response within 8s.
// (A 401 from a password-protected site still counts as up; a 502 from a
// crashed app counts as down.)
async function ping(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    clearTimeout(timer);
    return res.status < 500;
  } catch {
    clearTimeout(timer);
    return false;
  }
}

async function checkAll() {
  const sites = store.listSites().filter((s) => s.status === 'live' && s.domain);
  for (const s of sites) {
    const prev = (data[s.id] || {}).up;
    const up = await ping('https://' + (s.customDomain || s.domain));
    record(s.id, up);
    // Notify the owner when a site changes state.
    if (prev === true && up === false) notify.add(s.userId, { type: 'down', message: `"${s.name}" went down`, siteId: s.id });
    else if (prev === false && up === true) notify.add(s.userId, { type: 'up', message: `"${s.name}" is back up`, siteId: s.id });
  }
}

function startMonitor() {
  setTimeout(() => { checkAll().catch(() => {}); }, 10000);          // first check after 10s
  setInterval(() => { checkAll().catch(() => {}); }, 60000).unref?.(); // then every minute
  setInterval(flush, 20000).unref?.();
}

module.exports = { load, flush, record, getUptime, removeSite, ping, checkAll, startMonitor };
