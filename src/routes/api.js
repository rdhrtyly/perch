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

const router = express.Router();

// Hold uploaded files in memory briefly, then we write them to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 5000 },
});

// ── Sites ─────────────────────────────────────────────────────────

router.get('/sites', (req, res) => {
  res.json(store.listSites());
});

// Add a site from a GitHub repo.
router.post('/sites', (req, res) => {
  const { name, repo, branch, domain, domainSource } = req.body || {};
  if (!name || !repo) return res.status(400).json({ error: 'name and repo are required' });

  const id = slugify(name);
  const finalDomain = domain || `${id}.${config.baseDomain}`;
  store.upsertSite({
    id, name, repo, branch: branch || 'main',
    source: 'git',
    domain: finalDomain,
    domainSource: domainSource || 'manual', // PHASE 2: 'porkbun'
    type: null, port: null, status: 'new',
    lastDeployAt: null, lastDeployId: null,
    url: `https://${finalDomain}`,
  });
  res.status(201).json(store.getSite(id));
});

// Add a site by UPLOADING files (no GitHub needed) — the Vercel-style flow.
router.post('/upload', upload.any(), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'a name is required' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'no files were uploaded' });

  const id = slugify(name);
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
  const site = store.getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'not found' });
  deployer.deploy(site);
  res.status(202).json({ ok: true, deployId: store.getSite(site.id).lastDeployId });
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
    if (!dryRun) {
      await porkbun.pointDomainAtServer(domain, config.serverIp);
      if (siteId && store.getSite(siteId)) {
        store.updateSite(siteId, { domain, domainSource: 'porkbun', url: `https://${domain}` });
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
