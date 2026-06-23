// routes/api.js — the endpoints the dashboard uses.

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const store = require('../store');
const logs = require('../logs/stream');
const deployer = require('../deployer');
const caddy = require('../deployer/caddy');
const porkbun = require('../domains/porkbun');
const stats = require('../stats');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const { execSync } = require('child_process');

const router = express.Router();

// Hold uploaded files in memory briefly, then we write them to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 5000 },
});

// Get a site only if it belongs to the logged-in user (else null).
function ownedSite(req) {
  const s = store.getSite(req.params.id);
  return s && s.userId === req.userId ? s : null;
}

// Strip secret fields before sending a site to the browser.
function publicSite(s) {
  const { authHash, env, ...rest } = s;
  return rest;
}

// Is this user at their site limit?
function atLimit(req) {
  return store.listByUser(req.userId).length >= config.maxSitesPerUser;
}

// ── Sites ─────────────────────────────────────────────────────────

router.get('/sites', (req, res) => {
  res.json(store.listByUser(req.userId).map(publicSite));
});

// Add a site from a GitHub repo.
router.post('/sites', (req, res) => {
  const { name, repo, branch, domain, domainSource } = req.body || {};
  if (!name || !repo) return res.status(400).json({ error: 'name and repo are required' });
  if (atLimit(req)) return res.status(403).json({ error: `You've hit the limit of ${config.maxSitesPerUser} sites.` });

  const id = store.uniqueId(slugify(name));
  const finalDomain = domain || `${id}.${config.baseDomain}`;
  store.upsertSite({
    id, name, repo, branch: branch || 'main',
    userId: req.userId,
    source: 'git',
    domain: finalDomain,
    domainSource: domainSource || 'manual', // PHASE 2: 'porkbun'
    type: null, port: null, status: 'new',
    lastDeployAt: null, lastDeployId: null,
    url: `https://${finalDomain}`,
  });
  res.status(201).json(publicSite(store.getSite(id)));
});

// Add a site by UPLOADING files (no GitHub needed) — the Vercel-style flow.
router.post('/upload', upload.any(), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'a name is required' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'no files were uploaded' });
  if (atLimit(req)) return res.status(403).json({ error: `You've hit the limit of ${config.maxSitesPerUser} sites.` });

  const id = store.uniqueId(slugify(name));
  const dest = path.join(config.workspaceDir, id);

  // Start clean, then write every uploaded file (keeping its folder layout).
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  for (const f of req.files) {
    let rel = f.originalname.replace(/\\/g, '/');
    // Browsers prefix files with the chosen folder's name — drop that one level
    // so index.html lands at the top.
    const slash = rel.indexOf('/');
    if (slash !== -1) rel = rel.slice(slash + 1);
    if (!rel || rel.includes('..')) continue; // safety
    const filePath = path.join(dest, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, f.buffer);
  }

  const domain = `${id}.${config.baseDomain}`;
  store.upsertSite({
    id, name, repo: null, branch: null,
    userId: req.userId,
    source: 'upload',
    domain, domainSource: 'manual',
    type: null, port: null, status: 'new',
    lastDeployAt: null, lastDeployId: null,
    url: `https://${domain}`,
  });

  deployer.deploy(store.getSite(id)); // build/publish in the background
  res.status(201).json({ ok: true, id, deployId: store.getSite(id).lastDeployId });
});

// Redeploy a site.
router.post('/sites/:id/deploy', (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  deployer.deploy(site);
  res.status(202).json({ ok: true, deployId: store.getSite(site.id).lastDeployId });
});

// Visit stats for a site (for the per-site page).
router.get('/sites/:id/stats', (req, res) => {
  if (!ownedSite(req)) return res.status(404).json({ error: 'not found' });
  res.json(stats.getStats(req.params.id));
});

// Password-protect a site (HTTP basic auth via Caddy). Username is "perch".
router.post('/sites/:id/protect', async (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  const password = String((req.body || {}).password || '');
  if (password.length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' });
  const authHash = bcrypt.hashSync(password, 10);
  store.updateSite(site.id, { protected: true, authHash });
  await caddy.writeAndReload();
  res.json({ ok: true });
});

// Remove the password lock.
router.post('/sites/:id/unprotect', async (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  store.updateSite(site.id, { protected: false, authHash: null });
  await caddy.writeAndReload();
  res.json({ ok: true });
});

// Roll back to a saved previous version (static sites).
router.post('/sites/:id/rollback', async (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  const versionId = String((req.body || {}).versionId || '');
  const verDir = path.join(config.versionsDir, site.id, versionId);
  if (!versionId || !fs.existsSync(verDir)) return res.status(404).json({ error: 'version not found' });

  const dest = path.join(config.sitesDir, site.id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(verDir, dest, { recursive: true });
  store.updateSite(site.id, { status: 'live' });
  await caddy.writeAndReload();
  res.json({ ok: true });
});

// A QR code (SVG) that opens the site — generated on the server, no CDN.
router.get('/sites/:id/qr', async (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).end();
  const url = 'https://' + (site.customDomain || site.domain);
  try {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#161a17', light: '#ffffff' } });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (e) {
    res.status(500).end();
  }
});

// Delete a site: remove its files, container, stats, and Caddy entry.
router.delete('/sites/:id', async (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });

  if (site.type === 'nextjs') {
    try { execSync(`docker rm -f perch-${site.id}`, { stdio: 'ignore' }); } catch { /* ok */ }
  }
  fs.rmSync(path.join(config.workspaceDir, site.id), { recursive: true, force: true });
  fs.rmSync(path.join(config.sitesDir, site.id), { recursive: true, force: true });
  fs.rmSync(path.join(config.versionsDir, site.id), { recursive: true, force: true });
  store.removeSite(site.id);
  stats.removeSite(site.id);
  await caddy.writeAndReload();
  res.json({ ok: true });
});

// Get a site's secret env variables (owner only).
router.get('/sites/:id/env', (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  res.json({ env: site.env || {} });
});

// Set a site's secret env variables. (Redeploy to apply them.)
router.post('/sites/:id/env', (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  const input = (req.body || {}).env || {};
  const env = {};
  for (const [k, v] of Object.entries(input)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v); // valid env-var names only
  }
  store.updateSite(site.id, { env });
  res.json({ ok: true, env });
});

// ── Deploys / live logs ──────────────────────────────────────────

router.get('/deploys/:id', (req, res) => {
  const d = logs.getDeploy(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json({ id: d.id, siteId: d.siteId, status: d.status, startedAt: d.startedAt, finishedAt: d.finishedAt, lines: d.lines });
});

router.get('/deploys/:id/logs', (req, res) => {
  logs.subscribe(req.params.id, res);
});

// ── Domains (PHASE 2 — Porkbun) ──────────────────────────────────

// Is domain-buying turned on? (dashboard hides the tab if not)
router.get('/domains/status', (req, res) => {
  res.json({ enabled: porkbun.enabled() });
});

// Check availability + price.
router.get('/domains/check', async (req, res) => {
  if (!porkbun.enabled()) return res.status(400).json({ error: 'Porkbun keys not set in .env' });
  const domain = (req.query.domain || '').trim().toLowerCase();
  if (!domain || !domain.includes('.')) return res.status(400).json({ error: 'enter a full domain like example.com' });
  try {
    res.json(await porkbun.checkAvailability(domain));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Buy a domain, auto-point it here, and (optionally) attach it to a site.
// Pass { dryRun: true } to test the whole flow WITHOUT spending money.
router.post('/domains/buy', async (req, res) => {
  if (!porkbun.enabled()) return res.status(400).json({ error: 'Porkbun keys not set in .env' });
  const { domain, siteId, dryRun } = req.body || {};
  if (!domain) return res.status(400).json({ error: 'domain is required' });
  try {
    const reg = await porkbun.registerDomain(domain, { dryRun: !!dryRun });

    // On a real purchase, wire it up: DNS → server, attach to site, HTTPS.
    // We ADD the custom domain (the site keeps its .useperch.dev address too).
    if (!dryRun) {
      await porkbun.pointDomainAtServer(domain, config.serverIp);
      const site = siteId ? store.getSite(siteId) : null;
      if (site && site.userId === req.userId) {
        store.updateSite(siteId, { customDomain: domain, domainSource: 'porkbun' });
        await caddy.writeAndReload();
      }
    }
    res.json({ ok: true, ...reg });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

module.exports = router;
