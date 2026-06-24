// history.js — remembers each site's recent deploys ON DISK, so the history
// survives restarts. (The live build log in logs/stream is in-memory only and
// disappears when Perch restarts — this is the durable record.)

const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.dataDir, 'deploy-history.json');
const KEEP = 20; // recent deploys remembered per site

let data = {}; // { siteId: [{ at, status, ms }] }
let dirty = false;

function load() { try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { data = {}; } }
function flush() {
  if (!dirty) return;
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data)); dirty = false; } catch { /* ignore */ }
}

// Add one finished deploy to a site's history (newest first).
function record(siteId, entry) {
  const list = data[siteId] || (data[siteId] = []);
  list.unshift({ at: Date.now(), ...entry });
  if (list.length > KEEP) list.length = KEEP;
  dirty = true;
  flush();
}

function getFor(siteId) { return data[siteId] || []; }
function removeSite(siteId) { delete data[siteId]; dirty = true; }
function startAutoFlush() { setInterval(flush, 15000).unref?.(); }

module.exports = { load, flush, record, getFor, removeSite, startAutoFlush };
