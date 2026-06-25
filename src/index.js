// index.js — starts everything: the webhook, the dashboard API, and
// the dashboard web pages. Run it with:  npm start

const express = require('express');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const store = require('./store');
const deployer = require('./deployer');
const caddy = require('./deployer/caddy');
const stats = require('./stats');
const uptime = require('./uptime');
const notify = require('./notify');
const tokens = require('./tokens');
const oauth = require('./oauth');
const mcp = require('./mcp');
const settings = require('./settings');
const activity = require('./activity');
const history = require('./history');
const backup = require('./backup');
const auth = require('./auth');
const { verifySignature, parsePush } = require('./webhook');
const api = require('./routes/api');

const app = express();

// Caddy forwards real visitor IPs in a header — trust it so req.ip is right.
app.set('trust proxy', true);

// Read JSON bodies AND keep the raw bytes — we need the raw bytes to
// check GitHub's signature.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
// OAuth login + token endpoints post form data.
app.use(express.urlencoded({ extended: false }));

// ── The webhook: GitHub knocks here when you push ────────────────
app.post('/webhook', (req, res) => {
  // Bouncer: reject anything not signed with your secret.
  if (!verifySignature(req)) {
    console.warn('Rejected a webhook: bad or missing signature');
    return res.status(401).json({ error: 'bad signature' });
  }

  const push = parsePush(req);
  if (!push) return res.status(204).end(); // not a push event — ignore

  // Deploy every site (main OR preview) that tracks this repo + branch.
  const matches = store.listSites().filter(
    (s) => s.repo === push.repo && (s.branch || 'main') === push.branch
  );
  if (!matches.length) {
    return res.status(202).json({ ok: true, note: `no site for ${push.repo}@${push.branch}` });
  }

  matches.forEach((s) => deployer.deploy(s)); // build in the background
  res.status(202).json({ ok: true, deployed: matches.length });
});

// ── Analytics beacon ─────────────────────────────────────────────
// A tiny script injected into deployed pages pings this. We answer with
// a 1x1 transparent pixel and count the visit.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
app.get('/_perch/hit', (req, res) => {
  // Caddy puts the real visitor IP in X-Forwarded-For (take the first one).
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  stats.recordHit(req.query.s, ip);
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store');
  res.end(PIXEL);
});

// ── Health check (public) ────────────────────────────────────────
// A plain 200 for uptime monitors (UptimeRobot, Cloudflare) and any load
// balancer out front. Reveals nothing sensitive.
app.get('/_perch/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), ts: Date.now() });
});

// ── The Claude connector (MCP) + OAuth login ─────────────────────
// Browser-based Claude clients call these cross-origin, so allow CORS.
function cors(req, res, next) {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
  res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
  res.set('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}
app.use(['/mcp', '/connect', '/oauth', '/.well-known'], cors);

const oauthBase = (req) => (config.dashboardDomain ? `https://${config.dashboardDomain}` : `${req.protocol}://${req.get('host')}`);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The MCP endpoint — reachable at /mcp AND /connect (a spare URL in case
// the connector registry won't let you re-add /mcp).
app.post('/mcp', mcp.handler);
app.get('/mcp', (req, res) => res.status(405).json({ error: 'MCP endpoint — use POST' }));
app.post('/connect', mcp.handler);
app.get('/connect', (req, res) => res.status(405).json({ error: 'MCP endpoint — use POST' }));

// ── OAuth discovery metadata ─────────────────────────────────────
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const b = oauthBase(req);
  res.json({ resource: `${b}/mcp`, authorization_servers: [b] });
});
// Path-specific metadata (so /mcp and /connect each advertise themselves).
app.get('/.well-known/oauth-protected-resource/:rsrc', (req, res) => {
  const b = oauthBase(req);
  res.json({ resource: `${b}/${req.params.rsrc}`, authorization_servers: [b] });
});
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const b = oauthBase(req);
  res.json({
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

// ── OAuth: dynamic client registration ───────────────────────────
app.post('/oauth/register', (req, res) => {
  const c = oauth.registerClient(req.body || {});
  res.status(201).json({
    client_id: c.client_id, redirect_uris: c.redirect_uris, client_name: c.client_name,
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  });
});

// ── OAuth: the login + consent page ──────────────────────────────
function renderAuthorize(p, error) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize · Perch</title><link rel="stylesheet" href="/styles.css"></head>
<body><main class="wrap" style="max-width:420px">
  <header class="masthead"><div class="logo">🪺 Perch</div><h1 style="font-size:34px">Authorize</h1>
  <p class="subtitle">Let <b>${esc(p.client_name || 'this app')}</b> deploy to your Perch? Log in to allow it.</p></header>
  <form class="panel" method="POST" action="/oauth/authorize">
    <div class="field" style="margin-bottom:14px"><label>Email</label><input name="email" type="email" autocomplete="email" required></div>
    <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
    ${error ? `<div class="avail-no" style="margin-top:12px;font-size:14px">${esc(error)}</div>` : ''}
    <input type="hidden" name="client_id" value="${esc(p.client_id)}">
    <input type="hidden" name="redirect_uri" value="${esc(p.redirect_uri)}">
    <input type="hidden" name="code_challenge" value="${esc(p.code_challenge)}">
    <input type="hidden" name="state" value="${esc(p.state)}">
    <button class="btn btn-primary" type="submit" style="width:100%;justify-content:center;margin-top:18px">Log in &amp; authorize</button>
  </form>
  <p class="subtitle" style="font-size:13px;text-align:center;margin-top:16px">Only approve apps you trust.</p>
</main></body></html>`;
}

app.get('/oauth/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query;
  const client = oauth.getClient(String(client_id || ''));
  if (response_type !== 'code') return res.status(400).send('unsupported response_type');
  if (!client) return res.status(400).send('unknown client');
  if (!client.redirect_uris.includes(String(redirect_uri))) return res.status(400).send('invalid redirect_uri');
  if (!code_challenge || code_challenge_method !== 'S256') return res.status(400).send('PKCE (S256) required');
  res.send(renderAuthorize({ client_id, redirect_uri, code_challenge, state, client_name: client.client_name }, null));
});

app.post('/oauth/authorize', (req, res) => {
  const { email, password, client_id, redirect_uri, code_challenge, state } = req.body || {};
  const client = oauth.getClient(String(client_id || ''));
  if (!client || !client.redirect_uris.includes(String(redirect_uri))) return res.status(400).send('invalid client/redirect');
  const user = auth.checkLogin(email, password);
  if (!user) return res.status(401).send(renderAuthorize({ client_id, redirect_uri, code_challenge, state, client_name: client.client_name }, 'Wrong email or password'));
  const code = oauth.createCode({ userId: user.id, clientId: client_id, redirectUri: redirect_uri, codeChallenge: code_challenge });
  const sep = String(redirect_uri).includes('?') ? '&' : '?';
  res.redirect(302, `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`);
});

// ── OAuth: token endpoint ────────────────────────────────────────
app.post('/oauth/token', (req, res) => {
  const grant = (req.body || {}).grant_type;
  if (grant === 'authorization_code') {
    const { code, redirect_uri, client_id, code_verifier } = req.body;
    const c = oauth.consumeCode(String(code || ''));
    if (!c || c.clientId !== client_id || c.redirectUri !== redirect_uri) return res.status(400).json({ error: 'invalid_grant' });
    if (!oauth.pkceOk(String(code_verifier || ''), c.codeChallenge)) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE check failed' });
    const t = oauth.issueTokens(c.userId);
    return res.json({ access_token: t.access, token_type: 'Bearer', expires_in: t.expiresIn, refresh_token: t.refresh });
  }
  if (grant === 'refresh_token') {
    const t = oauth.refreshTokens(String((req.body || {}).refresh_token || ''));
    if (!t) return res.status(400).json({ error: 'invalid_grant' });
    return res.json({ access_token: t.access, token_type: 'Bearer', expires_in: t.expiresIn, refresh_token: t.refresh });
  }
  return res.status(400).json({ error: 'unsupported_grant_type' });
});

// ── Accounts (signup / login / logout) — public ──────────────────
app.use('/api/auth', auth.router);

// ── Public status page data (no login) ───────────────────────────
// Shows one user's sites + status. Keyed by their (unguessable) id.
app.get('/api/public/status/:userId', (req, res) => {
  const sites = store.listByUser(req.params.userId).filter((s) => !s.isPreview).map((s) => ({
    name: s.name,
    domain: s.customDomain || s.domain,
    url: s.url,
    status: s.status,
    lastDeployAt: s.lastDeployAt,
    ...uptime.getUptime(s.id), // up, lastCheckedAt, pct
  }));
  res.json({ sites });
});

// Public info for the landing/login pages (announcement, signups, maintenance).
app.get('/api/public/info', (req, res) => {
  const s = settings.get();
  res.json({ announcement: s.announcement, signupsOpen: s.signupsOpen, maintenance: s.maintenance });
});

// Featured sites (owner-picked) for the public homepage.
app.get('/api/public/featured', (req, res) => {
  res.json({ sites: store.listSites().filter((s) => s.featured && !s.isPreview).map((s) => ({ name: s.name, url: s.url })) });
});

// Public portfolio data — one user's LIVE sites, by their chosen handle.
app.get('/api/public/portfolio/:handle', (req, res) => {
  const handle = String(req.params.handle || '').toLowerCase();
  const user = auth.listAllUsers().find((u) => u.handle === handle);
  if (!user) return res.status(404).json({ error: 'not found' });
  const sites = store.listSites()
    .filter((s) => s.userId === user.id && !s.isPreview && s.status === 'live')
    .map((s) => ({ name: s.name, url: s.url, domain: s.customDomain || s.domain }));
  res.json({ handle: user.handle, sites });
});

// The public portfolio PAGE (/u/<handle>) — served to anyone, no login.
app.get('/u/:handle', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'portfolio.html')));

// ── Status badge (public, embeddable SVG) ────────────────────────
// Usage:  ![status](https://useperch.dev/badge/<site-id>.svg)
app.get('/badge/:file', (req, res) => {
  const id = String(req.params.file).replace(/\.svg$/i, '');
  const site = store.getSite(id);
  let label = 'unknown', color = '#9b9b9b';
  if (site) {
    const up = uptime.getUptime(site.id).up;
    if (site.status === 'live') { label = up === false ? 'down' : 'live'; color = up === false ? '#e05d57' : '#3fb950'; }
    else if (site.status === 'building') { label = 'building'; color = '#d9a441'; }
    else if (site.status === 'failed') { label = 'failed'; color = '#e05d57'; }
    else { label = 'new'; color = '#9b9b9b'; }
  }
  const left = 'perch';
  const lw = 42, rw = 16 + label.length * 6.5, w = lw + rw;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="perch: ${label}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="20" fill="#2d2a26"/>
    <rect x="${lw}" width="${rw}" height="20" fill="${color}"/>
    <rect width="${w}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lw / 2}" y="14">${left}</text>
    <text x="${lw + rw / 2}" y="14">${label}</text>
  </g></svg>`;
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'no-cache, max-age=60');
  res.send(svg);
});

// ── The dashboard's API — requires being logged in ───────────────
app.use('/api', auth.requireAuth, api);

// ── The dashboard + live status web pages ────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// Anything that didn't match a route or a static file → a friendly 404.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
});

// Make sure the folders Perch needs exist.
for (const dir of [config.dataDir, config.workspaceDir, config.sitesDir, config.versionsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Load saved visit stats and flush new ones to disk periodically.
stats.load();
stats.startAutoFlush();

// Start the uptime monitor (pings live sites every minute).
uptime.load();
uptime.startMonitor();

// Load notifications (the 🔔 bell).
notify.load();
notify.startAutoFlush();

// Load deploy tokens (for the Claude connector).
tokens.load();
tokens.startAutoFlush();

// Load OAuth state (for the desktop/Cowork connector).
oauth.load();
oauth.startAutoFlush();

// Load owner-panel state (settings + activity log).
settings.load();
activity.load();
activity.startAutoFlush();

// Load persisted deploy history (survives restarts).
history.load();
history.startAutoFlush();

// Start automatic daily safety backups of the important records.
backup.start();

// Write an initial Caddyfile (at least routes the dashboard). Caddy
// picks it up when it starts; harmless if Caddy isn't running yet.
caddy.writeAndReload().catch(() => {});

app.listen(config.port, () => {
  console.log(`Perch is running on http://localhost:${config.port}`);
  if (!config.webhookSecret) {
    console.warn('WARNING: WEBHOOK_SECRET is empty — set it in your .env file!');
  }
});
