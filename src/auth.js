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
const settings = require('./settings');
const notify = require('./notify');
const activity = require('./activity');

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

// Owner accounts (ADMIN_EMAILS in .env, OR promoted in the Owner Panel)
// skip limits and can use the Owner Panel.
function isAdmin(user) {
  return !!user && (config.adminEmails.includes(user.email) || user.admin === true);
}

// How many sites a user is allowed (owners = unlimited).
function effectiveLimit(user) {
  if (isAdmin(user)) return Infinity;
  if (user) {
    if (user.siteLimit === -1) return Infinity;             // owner gave them "unlimited"
    if (Number.isFinite(user.siteLimit)) return user.siteLimit; // a custom number
  }
  const d = settings.get().defaultLimit;
  return Number.isFinite(d) ? d : config.maxSitesPerUser;
}

function requireAuth(req, res, next) {
  // Login cookie first, then a "Authorization: Bearer <token>" header (connector).
  let user = getUser(getUserId(req));
  if (!user) {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (m) user = getUser(tokens.verify(m[1].trim()));
  }
  if (!user) return res.status(401).json({ error: 'not logged in' });
  if (user.suspended && !isAdmin(user)) return res.status(403).json({ error: 'Your account is suspended.' });
  if (settings.get().maintenance && !isAdmin(user)) return res.status(503).json({ error: 'Perch is down for maintenance — back soon.' });
  req.userId = user.id;
  req.user = user;
  req.isAdmin = isAdmin(user);
  next();
}

// Owners only past this point.
function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'owner only' });
  next();
}

// ── user management (used by the Owner Panel) ────────────────────
function listAllUsers() { return readUsers(); }
function updateUser(id, patch) {
  const users = readUsers();
  const i = users.findIndex((u) => u.id === id);
  if (i === -1) return null;
  users[i] = { ...users[i], ...patch };
  writeUsers(users);
  return users[i];
}
function deleteUserRecord(id) { writeUsers(readUsers().filter((u) => u.id !== id)); }
function setUserPassword(id, pw) { return updateUser(id, { password: hashPassword(pw) }); }
function getAdminIds() { return readUsers().filter((u) => isAdmin(u)).map((u) => u.id); }

// ── routes (mounted at /api/auth) ─────────────────────────────────
const router = express.Router();
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

router.post('/signup', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  const s = settings.get();
  if (!s.signupsOpen) return res.status(403).json({ error: 'New signups are closed right now.' });
  if (s.bannedEmails.includes(email)) return res.status(403).json({ error: 'This email can’t sign up.' });
  if (!validEmail(email)) return res.status(400).json({ error: 'enter a valid email' });
  if (pw.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  if (findByEmail(email)) return res.status(409).json({ error: 'that email already has an account' });

  const firstUser = readUsers().length === 0;
  const user = { id: crypto.randomUUID(), email, password: hashPassword(pw), createdAt: Date.now(), admin: firstUser };
  const users = readUsers(); users.push(user); writeUsers(users);

  // The very first account adopts any sites made before logins existed.
  if (firstUser) store.claimOwnerless(user.id);

  // Tell the owners + log it.
  activity.log('signup', `${email} joined`);
  for (const aid of getAdminIds()) if (aid !== user.id) notify.add(aid, { type: 'signup', message: `${email} made an account` });

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
  if (user.suspended && !isAdmin(user)) return res.status(403).json({ error: 'Your account is suspended.' });
  setCookie(req, res, sign(user.id));
  res.json({ email: user.email });
});

router.post('/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

router.get('/me', (req, res) => {
  const user = getUser(getUserId(req));
  if (!user) return res.status(401).json({ error: 'not logged in' });
  const lim = effectiveLimit(user);
  res.json({
    id: user.id, email: user.email,
    admin: isAdmin(user), unlimited: isAdmin(user),
    maxSites: Number.isFinite(lim) ? lim : null,
    announcement: settings.get().announcement,
  });
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

module.exports = {
  router, requireAuth, requireAdmin, getUserId,
  findUserByEmail, getUserById, checkLogin,
  isAdmin, effectiveLimit,
  listAllUsers, updateUser, deleteUserRecord, setUserPassword, getAdminIds,
};
