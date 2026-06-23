// routes/api.js — the endpoints the dashboard uses to read & change things.

const express = require('express');
const config = require('../config');
const store = require('../store');
const logs = require('../logs/stream');
const deployer = require('../deployer');

const router = express.Router();

// List all sites (the dashboard loads this).
router.get('/sites', (req, res) => {
  res.json(store.listSites());
});

// Add a new site — the "add a site" flow.
//
// This is built so Phase 2 (buying a domain from Porkbun) slots in
// cleanly: a Porkbun-bought site would arrive here too, just with
// domainSource set to "porkbun" and a custom domain.
router.post('/sites', (req, res) => {
  const { name, repo, branch, domain, domainSource } = req.body || {};
  if (!name || !repo) {
    return res.status(400).json({ error: 'name and repo are required' });
  }

  const id = slugify(name);
  // Default: a subdomain of your base domain. Phase 2 can pass a full
  // custom domain instead.
  const finalDomain = domain || `${id}.${config.baseDomain}`;

  const site = {
    id,
    name,
    repo, // "owner/name"
    branch: branch || 'main',
    domain: finalDomain,
    domainSource: domainSource || 'manual', // PHASE 2: 'porkbun'
    type: null,
    port: null,
    status: 'new',
    lastDeployAt: null,
    lastDeployId: null,
    url: `https://${finalDomain}`,
  };

  store.upsertSite(site);
  res.status(201).json(site);
});

// Trigger a deploy by hand (the "Redeploy" button).
router.post('/sites/:id/deploy', (req, res) => {
  const site = store.getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'not found' });

  deployer.deploy(site); // runs in the background
  const fresh = store.getSite(site.id);
  res.status(202).json({ ok: true, deployId: fresh.lastDeployId });
});

// Info about a single deploy (the live page header uses this).
router.get('/deploys/:id', (req, res) => {
  const d = logs.getDeploy(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json({
    id: d.id,
    siteId: d.siteId,
    status: d.status,
    startedAt: d.startedAt,
    finishedAt: d.finishedAt,
    lines: d.lines,
  });
});

// THE LIVE LOG STREAM ("cool part B").
router.get('/deploys/:id/logs', (req, res) => {
  logs.subscribe(req.params.id, res);
});

// "My Project!" -> "my-project"
function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = router;
