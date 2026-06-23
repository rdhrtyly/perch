// stats.js — tiny, privacy-friendly visit counter.
//
// Each deployed page gets a one-line script that pings /_perch/hit.
// We count those pings per site. We DON'T store anyone's real IP — we
// store a short scrambled code instead, just so we can estimate how
// many *different* people visited.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.dataDir, 'stats.json');
const CAP = 4000; // how many recent visits we remember per site

let data = {};     // { siteId: { total, events: [{ t, ip }] } }
let dirty = false;

function load() {
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { data = {}; }
}

function flush() {
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data));
    dirty = false;
  } catch { /* ignore */ }
}

// Turn an IP into a short non-reversible code (privacy).
function scramble(ip) {
  let h = 0;
  const str = String(ip || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function recordHit(siteId, ip) {
  if (!siteId) return;
  const s = data[siteId] || (data[siteId] = { total: 0, events: [] });
  s.total++;
  s.events.push({ t: Date.now(), ip: scramble(ip) });
  if (s.events.length > CAP) s.events.splice(0, s.events.length - CAP);
  dirty = true;
}

function getStats(siteId) {
  const s = data[siteId] || { total: 0, events: [] };
  const now = Date.now();
  const DAY = 86400000;

  // Views per day for the last 14 days (for the little graph).
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const start = today.getTime() - i * DAY;
    const end = start + DAY;
    const d = new Date(start);
    daily.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, count: s.events.filter((e) => e.t >= start && e.t < end).length });
  }

  return {
    total: s.total,                                                   // all-time page views
    last24h: s.events.filter((e) => now - e.t < DAY).length,
    last7d: s.events.filter((e) => now - e.t < 7 * DAY).length,
    visitors: new Set(s.events.map((e) => e.ip)).size,               // unique-ish (recent)
    daily,
  };
}

function removeSite(siteId) { delete data[siteId]; dirty = true; }

function startAutoFlush() { setInterval(flush, 15000).unref?.(); }

module.exports = { load, flush, recordHit, getStats, removeSite, startAutoFlush };
