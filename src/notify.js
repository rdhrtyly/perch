// notify.js — simple in-app notifications (the 🔔 bell).
// We add a note for a user when something they care about happens
// (a deploy fails, a site goes down or comes back). No email needed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const FILE = path.join(config.dataDir, 'notifications.json');
const CAP = 50; // keep the most recent N per user

let data = {};   // { userId: [{ id, type, message, siteId, at, read }] }
let dirty = false;

function load() {
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { data = {}; }
}
function flush() {
  if (!dirty) return;
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data)); dirty = false; } catch { /* ignore */ }
}

function add(userId, note) {
  if (!userId) return;
  const list = data[userId] || (data[userId] = []);
  list.unshift({ id: crypto.randomUUID(), at: Date.now(), read: false, ...note });
  if (list.length > CAP) list.length = CAP;
  dirty = true;
}

function listFor(userId) {
  const items = data[userId] || [];
  return { items, unread: items.filter((n) => !n.read).length };
}

function markReadAll(userId) { (data[userId] || []).forEach((n) => { n.read = true; }); dirty = true; }
function clear(userId) { data[userId] = []; dirty = true; }
function startAutoFlush() { setInterval(flush, 15000).unref?.(); }

module.exports = { load, flush, add, listFor, markReadAll, clear, startAutoFlush };
