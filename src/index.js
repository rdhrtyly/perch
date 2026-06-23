// index.js — starts everything: the webhook, the dashboard API, and
// the dashboard web pages. Run it with:  npm start

const express = require('express');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const store = require('./store');
const deployer = require('./deployer');
const caddy = require('./deployer/caddy');
const { verifySignature, parsePush } = require('./webhook');
const api = require('./routes/api');

const app = express();

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

  const site = store.getSiteByRepo(push.repo);
  if (!site) {
    return res.status(202).json({ ok: true, note: `no site for ${push.repo}` });
  }

  // Only deploy when the branch we deploy actually changed.
  if (site.branch && push.branch && site.branch !== push.branch) {
    return res.status(202).json({ ok: true, note: `ignored branch ${push.branch}` });
  }

  deployer.deploy(site); // build in the background
  res.status(202).json({ ok: true });
});

// ── The dashboard's API ──────────────────────────────────────────
app.use('/api', api);

// ── The dashboard + live status web pages ────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// Make sure the folders Perch needs exist.
for (const dir of [config.dataDir, config.workspaceDir, config.sitesDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Write an initial Caddyfile (at least routes the dashboard). Caddy
// picks it up when it starts; harmless if Caddy isn't running yet.
caddy.writeAndReload().catch(() => {});

app.listen(config.port, () => {
  console.log(`Perch is running on http://localhost:${config.port}`);
  if (!config.webhookSecret) {
    console.warn('WARNING: WEBHOOK_SECRET is empty — set it in your .env file!');
  }
});
