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
const mcp = require('./mcp');
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

// ── The Claude connector (MCP) — auth is the Bearer deploy token ──
app.post('/mcp', mcp.handler);
app.get('/mcp', (req, res) => res.status(405).json({ error: 'MCP endpoint — use POST' }));

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

// ── The dashboard's API — requires being logged in ───────────────
app.use('/api', auth.requireAuth, api);

// ── The dashboard + live status web pages ────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

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

// Write an initial Caddyfile (at least routes the dashboard). Caddy
// picks it up when it starts; harmless if Caddy isn't running yet.
caddy.writeAndReload().catch(() => {});

app.listen(config.port, () => {
  console.log(`Perch is running on http://localhost:${config.port}`);
  if (!config.webhookSecret) {
    console.warn('WARNING: WEBHOOK_SECRET is empty — set it in your .env file!');
  }
});
