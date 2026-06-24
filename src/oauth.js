// oauth.js — a small OAuth 2.1 server so Claude (desktop / Cowork) can
// log in and get a token to use the Perch connector.
//
// Implements the slice of OAuth that MCP needs:
//   • Dynamic Client Registration (RFC 7591)
//   • Authorization Code flow with PKCE (S256)
//   • Refresh tokens
// The token it issues is then accepted by /mcp (see mcp.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const FILE = path.join(config.dataDir, 'oauth.json');

let data = { clients: [], tokens: [] }; // tokens: {access, refresh, userId, accessExp, refreshExp}
const codes = new Map();                 // code -> { userId, clientId, redirectUri, codeChallenge, exp }
let dirty = false;

function load() { try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { data = { clients: [], tokens: [] }; } }
function flush() {
  if (!dirty) return;
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data)); dirty = false; } catch { /* ignore */ }
}
function startAutoFlush() { setInterval(flush, 15000).unref?.(); }

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function rand(n) { return b64url(crypto.randomBytes(n)); }

// ── clients (dynamic registration) ────────────────────────────────
function registerClient(meta) {
  const client = {
    client_id: 'perchc_' + rand(12),
    redirect_uris: Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [],
    client_name: meta.client_name || 'MCP Client',
    token_endpoint_auth_method: 'none',
    created: Date.now(),
  };
  data.clients.push(client);
  if (data.clients.length > 200) data.clients.splice(0, data.clients.length - 200);
  dirty = true; flush();
  return client;
}
function getClient(id) { return data.clients.find((c) => c.client_id === id); }

// ── authorization codes ───────────────────────────────────────────
function createCode({ userId, clientId, redirectUri, codeChallenge }) {
  const code = rand(24);
  codes.set(code, { userId, clientId, redirectUri, codeChallenge, exp: Date.now() + 5 * 60 * 1000 });
  return code;
}
function consumeCode(code) {
  const c = codes.get(code);
  if (!c) return null;
  codes.delete(code);
  return Date.now() > c.exp ? null : c;
}

// PKCE: code_challenge must equal base64url(sha256(code_verifier)).
function pkceOk(verifier, challenge) {
  if (!verifier || !challenge) return false;
  return b64url(crypto.createHash('sha256').update(verifier).digest()) === challenge;
}

// ── access / refresh tokens ───────────────────────────────────────
function issueTokens(userId) {
  const access = 'perch_at_' + rand(24);
  const refresh = 'perch_rt_' + rand(24);
  data.tokens.push({ access, refresh, userId, accessExp: Date.now() + 60 * 60 * 1000, refreshExp: Date.now() + 30 * 86400000 });
  data.tokens = data.tokens.filter((t) => t.refreshExp > Date.now()); // drop dead ones
  dirty = true; flush();
  return { access, refresh, expiresIn: 3600 };
}
// Used by /mcp to check an access token. Returns userId or null.
function verifyAccessToken(token) {
  const t = data.tokens.find((x) => x.access === token);
  if (!t || Date.now() > t.accessExp) return null;
  return t.userId;
}
function refreshTokens(refreshToken) {
  const i = data.tokens.findIndex((x) => x.refresh === refreshToken);
  if (i === -1) return null;
  const t = data.tokens[i];
  if (Date.now() > t.refreshExp) return null;
  data.tokens.splice(i, 1); // rotate (single-use refresh)
  return issueTokens(t.userId);
}

module.exports = {
  load, flush, startAutoFlush,
  registerClient, getClient,
  createCode, consumeCode, pkceOk,
  issueTokens, verifyAccessToken, refreshTokens,
};
