// auth.js — accounts + login. Email/password for now.
//
// Passwords are hashed with scrypt (built into Node — no extra package).
// Logins are kept in a signed cookie (no server-side session store), so
// they survive restarts and work across devices.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const store = require('./store');
const tokens = require('./tokens');

const USERS_FILE = path.join(config.dataDir, 'users.json');
const KEY_FILE = path.join(config.dataDir, 'session.key');
const COOKIE = 'perch_session';

// ── secret used to sign cookies (stable across restarts) ──────────
let SECRET = null;
function secret() {
  if (SECRET) return SECRET;
  if (config.sessionSecret) return (SECRET = config.sessionSecret);
  try { SECRET = fs.readFileSync(KEY_FILE, 'utf8').trim(); }
  catch {
    SECRET = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, SECRET);
  }
  return SECRET;
}

// ── users storage ─────────────────────────────────────────────────
function readUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; } }
function writeUsers(u) { fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true }); fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }
function findByEmail(email) { return readUsers().find((u) => u.email === email); }
function getUser(id) { return readUsers().find((u) => u.id === id); }

// ── password hashing ──────────────────────────────────────────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'); const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── login token (signed, stateless) ───────────────────────────────
function sign(userId) {
  const payload = Buffer.from(JSON.stringify({ u: userId, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verify(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (Date.now() - data.t > 30 * 86400000) return null; // 30-day expiry
    return data.u;
  } catch { return null; }
}

// ── cookie helpers ────────────────────────────────────────────────
function readToken(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}
function setCookie(req, res, token) {
  // "secure" only when actually on HTTPS (so local http testing works too).
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 86400000, path: '/' });
}

// ── middleware ────────────────────────────────────────────────────
function getUserId(req) { return verify(readToken(req)); }

// Owner accounts (listed in ADMIN_EMAILS) skip limits.
function isAdmin(user) {
  return !!user && config.adminEmails.includes(user.email);
}

function requireAuth(req, res, next) {
  // Login cookie first, then a "Authorization: Bearer <token>" header (connector).
  let user = getUser(getUserId(req));
  if (!user) {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (m) user = getUser(tokens.verify(m[1].trim()));
  }
  if (!user) return res.status(401).json({ error: 'not logged in' });
  req.userId = user.id;
  req.user = user;
  req.isAdmin = isAdmin(user);
  next();
}

// ── routes (mounted at /api/auth) ─────────────────────────────────
const router = express.Router();
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

router.post('/signup', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  if (!validEmail(email)) return res.status(400).json({ error: 'enter a valid email' });
  if (pw.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  if (findByEmail(email)) return res.status(409).json({ error: 'that email already has an account' });

  const firstUser = readUsers().length === 0;
  const user = { id: crypto.randomUUID(), email, password: hashPassword(pw), createdAt: Date.now() };
  const users = readUsers(); users.push(user); writeUsers(users);

  // The very first account adopts any sites made before logins existed.
  if (firstUser) store.claimOwnerless(user.id);

  setCookie(req, res, sign(user.id));
  res.status(201).json({ email: user.email });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  const user = findByEmail(email);
  if (!user || !verifyPassword(pw, user.password)) {
    return res.status(401).json({ error: 'wrong email or password' });
  }
  setCookie(req, res, sign(user.id));
  res.json({ email: user.email });
});

router.post('/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

router.get('/me', (req, res) => {
  const user = getUser(getUserId(req));
  if (!user) return res.status(401).json({ error: 'not logged in' });
  res.json({ id: user.id, email: user.email, maxSites: config.maxSitesPerUser, unlimited: isAdmin(user) });
});

// Look up a user by email (for sharing). Returns the user or undefined.
function findUserByEmail(email) {
  return findByEmail(String(email || '').trim().toLowerCase());
}
function getUserById(id) {
  return getUser(id);
}

// Check an email + password (for the OAuth login page). Returns user or null.
function checkLogin(email, password) {
  const user = findByEmail(String(email || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.password)) return null;
  return user;
}

module.exports = { router, requireAuth, getUserId, findUserByEmail, getUserById, checkLogin };
