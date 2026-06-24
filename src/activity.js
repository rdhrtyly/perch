// activity.js — a small log of things happening on the server
// (signups, deploys, deletes) for the owner's activity feed.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.dataDir, 'activity.json');
const CAP = 300;

let data = [];
let dirty = false;

function load() { try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { data = []; } }
function flush() {
  if (!dirty) return;
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data)); dirty = false; } catch { /* ignore */ }
}
function log(type, message) {
  data.unshift({ t: Date.now(), type, message });
  if (data.length > CAP) data.length = CAP;
  dirty = true;
}
function recent(n = 100) { return data.slice(0, n); }
function startAutoFlush() { setInterval(flush, 15000).unref?.(); }

module.exports = { load, flush, log, recent, startAutoFlush };
