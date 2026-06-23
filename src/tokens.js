// tokens.js — deploy tokens (API keys for YOUR Perch).
//
// A token lets a program (like the Claude connector) act as you without
// your password. We store only a hash of each token; the real token is
// shown once when created. Tokens are long & random, so a SHA-256 hash
// is plenty.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const FILE = path.join(config.dataDir, 'tokens.json');

let data = [];   // [{ id, userId, name, hash, createdAt, lastUsedAt }]
let dirty = false;

function load() {
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { data = []; }
}
function flush() {
  if (!dirty) return;
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); dirty = false; } catch { /* ignore */ }
}
function hash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

// Make a new token for a user. Returns the plaintext token ONCE.
function generate(userId, name) {
  const token = 'perch_' + crypto.randomBytes(24).toString('hex');
  data.push({ id: crypto.randomUUID(), userId, name: name || 'token', hash: hash(token), createdAt: Date.now(), lastUsedAt: null });
  dirty = true; flush();
  return token;
}

// Check a token → returns its userId (or null).
function verify(token) {
  if (!token) return null;
  const rec = data.find((t) => t.hash === hash(token));
  if (!rec) return null;
  rec.lastUsedAt = Date.now(); dirty = true;
  return rec.userId;
}

function listFor(userId) {
  return data.filter((t) => t.userId === userId).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }));
}
function revoke(id, userId) {
  const before = data.length;
  data = data.filter((t) => !(t.id === id && t.userId === userId));
  if (data.length !== before) { dirty = true; flush(); }
}
function startAutoFlush() { setInterval(flush, 15000).unref?.(); }

module.exports = { load, flush, generate, verify, listFor, revoke, startAutoFlush };
