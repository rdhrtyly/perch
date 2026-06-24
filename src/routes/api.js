// routes/api.js — the endpoints the dashboard uses.

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns').promises;
const { exec, execSync } = require('child_process');
const multer = require('multer');
const config = require('../config');
const store = require('../store');
const logs = require('../logs/stream');
const deployer = require('../deployer');
const caddy = require('../deployer/caddy');
const porkbun = require('../domains/porkbun');
const stats = require('../stats');
const uptime = require('../uptime');
const notify = require('../notify');
const tokens = require('../tokens');
const settings = require('../settings');
const activity = require('../activity');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const auth = require('../auth');
const guards = require('../guards');
const system = require('../system');
const history = require('../history');
const templates = require('../templates');
const { removeSiteCascade } = require('../site-actions');

const router = express.Router();

// Hold uploaded files in memory briefly, then we write them to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 5000 },
});

// Owner only (for destructive / sharing actions).
function ownedSite(req) {
  const s = store.getSite(req.params.id);
  return s && s.userId === req.userId ? s : null;
}

// Owner OR a collaborator the site is shared with (for managing).
function accessibleSite(req) {
  const s = store.getSite(req.params.id);
  if (!s) return null;
  if (s.userId === req.userId) return s;
  if (s.collaborators && s.collaborators.includes(req.userId)) return s;
  return null;
}

// Strip secret fields and add per-user flags before sending to the browser.
function publicSite(s, userId) {
  const { authHash, env, collaborators, ...rest } = s;
  return {
    ...rest,
    isOwner: s.userId === userId,
    shared: !!(collaborators && collaborators.length),
    sharedWithMe: !!(collaborators && collaborators.includes(userId)) && s.userId !== userId,
  };
}

// Is this user at their site limit? (Owners/overrides handled by effectiveLimit; previews don't count.)
function atLimit(req) {
  const limit = auth.effectiveLimit(req.user);
  if (!Number.isFinite(limit)) return false;
  return store.listByUser(req.userId).filter((s) => !s.isPreview).length >= limit;
}

// Folder size in bytes (for storage stats).
function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : (fs.statSync(p).size || 0);
    }
  } catch { /* missing dir */ }
  return total;
}

// ── Sites ─────────────────────────────────────────────────────────

// Dashboard lists real sites only (previews live under their parent).
router.get('/sites', (req, res) => {
  res.json(
    store.listByUser(req.userId)
      .filter((s) => !s.isPreview)
      .map((s) => ({ ...publicSite(s, req.userId), ...uptime.getUptime(s.id), views: stats.getStats(s.id).total }))
  );
});

// ── Public profile handle (for the portfolio page /u/<handle>) ───
const RESERVED_HANDLES = new Set(['api', 'badge', 'u', 'status', 'deploy', 'landing', 'admin', 'login', 'styles', 'app', 'site', 'sw', 'manifest', 'docs', 'portfolio', 'oauth', 'mcp', 'connect', 'webhook', 'assets', 'public', 'me', 'home']);
router.post('/profile', (req, res) => {
  let handle = (req.body || {}).handle;
  if (handle === '' || handle === null || handle === undefined) { auth.updateUser(req.userId, { handle: null }); return res.json({ ok: true, handle: null }); }
  handle = String(handle).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(handle)) return res.status(400).json({ error: 'Handle must be 2–30 letters, numbers, or dashes and start with a letter or number.' });
  if (RESERVED_HANDLES.has(handle)) return res.status(400).json({ error: 'That handle is reserved — pick another.' });
  if (auth.listAllUsers().some((u) => u.handle === handle && u.id !== req.userId)) return res.status(409).json({ error: 'That handle is taken.' });
  auth.updateUser(req.userId, { handle });
  res.json({ ok: true, handle });
});

// Add a site from a GitHub repo.
router.post('/sites', (req, res) => {
  const { name, repo, branch, domain, domainSource } = req.body || {};
  if (!name || !repo) return res.status(400).json({ error: 'name and repo are required' });
  if (atLimit(req)) return res.status(403).json({ error: `You've hit the limit of ${config.maxSitesPerUser} sites.` });
  const g = guards.checkDeploy(req.userId, { isNew: true });
  if (!g.ok) return res.status(g.status).json({ error: g.error });

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
  res.status(201).json(publicSite(store.getSite(id), req.userId));
});

// Add a site by UPLOADING files (no GitHub needed) — the Vercel-style flow.
router.post('/upload', upload.any(), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'a name is required' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'no files were uploaded' });
  if (atLimit(req)) return res.status(403).json({ error: `You've hit the limit of ${config.maxSitesPerUser} sites.` });
  const g = guards.checkDeploy(req.userId, { isNew: true });
  if (!g.ok) return res.status(g.status).json({ error: g.error });

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

// ── Templates: deploy a starter site with no upload ──────────────
router.get('/templates', (req, res) => res.json({ templates: templates.list() }));
router.post('/sites/template', (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const files = templates.files(String((req.body || {}).template || ''));
  if (!name) return res.status(400).json({ error: 'a name is required' });
  if (!files) return res.status(400).json({ error: 'unknown template' });
  if (atLimit(req)) return res.status(403).json({ error: `You've hit the limit of ${config.maxSitesPerUser} sites.` });
  const g = guards.checkDeploy(req.userId, { isNew: true });
  if (!g.ok) return res.status(g.status).json({ error: g.error });

  const id = store.uniqueId(slugify(name));
  const dest = path.join(config.workspaceDir, id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const rel = String(f.path).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) continue;
    const fp = path.join(dest, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, String(f.content == null ? '' : f.content));
  }
  const domain = `${id}.${config.baseDomain}`;
  store.upsertSite({
    id, name, repo: null, branch: null, userId: req.userId,
    source: 'upload', domain, domainSource: 'manual',
    type: null, port: null, status: 'new',
    lastDeployAt: null, lastDeployId: null, url: `https://${domain}`,
  });
  deployer.deploy(store.getSite(id));
  res.status(201).json({ ok: true, id, deployId: store.getSite(id).lastDeployId });
});

// Redeploy a site.
router.post('/sites/:id/deploy', (req, res) => {
  const site = accessibleSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  const g = guards.checkDeploy(req.userId, { isNew: false });
  if (!g.ok) return res.status(g.status).json({ error: g.error });
  deployer.deploy(site);
  res.status(202).json({ ok: true, deployId: store.getSite(site.id).lastDeployId });
});

// Visit stats for a site (for the per-site page).
router.get('/sites/:id/stats', (req, res) => {
  if (!accessibleSite(req)) return res.status(404).json({ error: 'not found' });
  res.json(stats.getStats(req.params.id));
});

// Deploy history (persisted across restarts).
router.get('/sites/:id/history', (req, res) => {
  if (!accessibleSite(req)) return res.status(404).json({ error: 'not found' });
  res.json({ history: history.getFor(req.params.id) });
});

// Pin/unpin a site (owner only — keeps it at the top of the dashboard).
router.post('/sites/:id/pin', (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  store.updateSite(site.id, { pinned: !!(req.body || {}).pinned });
  res.json({ ok: true });
});

// Rename a site's display name (the subdomain/URL stays the same).
router.post('/sites/:id/rename', (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  const name = String((req.body || {}).name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'enter a name' });
  store.updateSite(site.id, { name });
  res.json({ ok: true, name });
});

// Clone a site into a brand-new one (copies uploaded files / re-clones a repo).
router.post('/sites/:id/clone', (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  if (site.isPreview) return res.status(400).json({ error: "can't clone a preview" });
  if (atLimit(req)) return res.status(403).json({ error: `You've hit the limit of ${config.maxSitesPerUser} sites.` });
  const g = guards.checkDeploy(req.userId, { isNew: true });
  if (!g.ok) return res.status(g.status).json({ error: g.error });

  const newName = String((req.body || {}).name || '').trim() || `${site.name} copy`;
  const newId = store.uniqueId(slugify(newName));

  if (site.source === 'upload') {
    const from = path.join(config.workspaceDir, site.id);
    const to = path.join(config.workspaceDir, newId);
    fs.rmSync(to, { recursive: true, force: true });
    if (!fs.existsSync(from)) return res.status(400).json({ error: 'the original files are no longer available to clone' });
    fs.cpSync(from, to, { recursive: true });
  }
  const domain = `${newId}.${config.baseDomain}`;
  store.upsertSite({
    id: newId, name: newName, repo: site.repo || null, branch: site.branch || null,
    userId: req.userId, source: site.source, domain, domainSource: 'manual',
    type: null, port: null, status: 'new',
    lastDeployAt: null, lastDeployId: null, url: `https://${domain}`,
  });
  deployer.deploy(store.getSite(newId));
  res.status(201).json({ ok: true, id: newId, deployId: store.getSite(newId).lastDeployId });
});

// ── Custom domain wizard (connect a domain you already own) ──────
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
router.post('/sites/:id/domain', async (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  const domain = String((req.body || {}).domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Enter a domain like mysite.com' });
  if (store.listSites().some((s) => s.customDomain === domain && s.id !== site.id)) return res.status(409).json({ error: 'That domain is already connected to another site.' });
  store.updateSite(site.id, { customDomain: domain });
  await caddy.writeAndReload();
  res.json({ ok: true, domain, serverIp: config.serverIp || null });
});
router.get('/sites/:id/domain/check', async (req, res) => {
  const site = accessibleSite(req);
  if (!site || !site.customDomain) return res.status(404).json({ error: 'no custom domain set' });
  let ips = [];
  try { ips = await dns.resolve4(site.customDomain); } catch { /* not resolving yet */ }
  const pointed = config.serverIp ? ips.includes(config.serverIp) : ips.length > 0;
  res.json({ domain: site.customDomain, ips, serverIp: config.serverIp || null, pointed });
});
router.delete('/sites/:id/domain', async (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  store.updateSite(site.id, { customDomain: null });
  await caddy.writeAndReload();
  res.json({ ok: true });
});

// Password-protect a site (HTTP basic auth via Caddy). Username is "perch".
router.post('/sites/:id/protect', async (req, res) => {
  const site = accessibleSite(req);
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
  const site = accessibleSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  store.updateSite(site.id, { protected: false, authHash: null });
  await caddy.writeAndReload();
  res.json({ ok: true });
});

// Roll back to a saved previous version (static sites).
router.post('/sites/:id/rollback', async (req, res) => {
  const site = accessibleSite(req);
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
  const site = accessibleSite(req);
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
  const site = ownedSite(req); // only the owner can delete
  if (!site) return res.status(404).json({ error: 'not found' });
  if (site.locked) return res.status(403).json({ error: 'This site is locked by the owner and can’t be deleted.' });
  removeSiteCascade(site);
  activity.log('delete', `deleted "${site.name}"`);
  await caddy.writeAndReload();
  res.json({ ok: true });
});

// Get a site's secret env variables (owner only).
router.get('/sites/:id/env', (req, res) => {
  const site = accessibleSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  res.json({ env: site.env || {} });
});

// Set a site's secret env variables. (Redeploy to apply them.)
router.post('/sites/:id/env', (req, res) => {
  const site = accessibleSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  const input = (req.body || {}).env || {};
  const env = {};
  for (const [k, v] of Object.entries(input)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v); // valid env-var names only
  }
  store.updateSite(site.id, { env });
  res.json({ ok: true, env });
});

// ── Preview deploys (deploy a branch to a temporary URL) ─────────

// List a site's previews.
router.get('/sites/:id/previews', (req, res) => {
  if (!accessibleSite(req)) return res.status(404).json({ error: 'not found' });
  const previews = store.listSites()
    .filter((s) => s.parentId === req.params.id)
    .map((s) => ({ ...publicSite(s, req.userId), ...uptime.getUptime(s.id) }));
  res.json({ previews });
});

// Create a preview of a branch → builds it at <branch>--<site>.<domain>.
router.post('/sites/:id/preview', (req, res) => {
  const parent = accessibleSite(req);
  if (!parent) return res.status(404).json({ error: 'not found' });
  if (parent.isPreview) return res.status(400).json({ error: "can't preview a preview" });
  if (!parent.repo) return res.status(400).json({ error: 'previews are for GitHub sites only' });

  const branch = String((req.body || {}).branch || '').trim();
  const branchSlug = slugify(branch);
  if (!branchSlug) return res.status(400).json({ error: 'enter a valid branch name' });
  const g = guards.checkDeploy(req.userId, { isNew: true });
  if (!g.ok) return res.status(g.status).json({ error: g.error });

  const id = store.uniqueId(`${branchSlug}--${parent.id}`);
  const domain = `${id}.${config.baseDomain}`;
  store.upsertSite({
    id, name: `${parent.name} · ${branch}`, repo: parent.repo, branch,
    userId: parent.userId,
    source: 'git', isPreview: true, parentId: parent.id,
    domain, domainSource: 'manual',
    type: null, port: null, status: 'new',
    lastDeployAt: null, lastDeployId: null,
    url: `https://${domain}`,
  });
  deployer.deploy(store.getSite(id));
  res.status(201).json({ ok: true, id, deployId: store.getSite(id).lastDeployId });
});

// ── Sharing (owner only) ─────────────────────────────────────────

// Who can this site be managed by? (owner + collaborators, with emails)
router.get('/sites/:id/collaborators', (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  const people = (site.collaborators || []).map((uid) => {
    const u = auth.getUserById(uid);
    return { userId: uid, email: u ? u.email : '(unknown)' };
  });
  res.json({ collaborators: people });
});

// Share with a friend by email (they must already have an account).
router.post('/sites/:id/share', (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  const friend = auth.findUserByEmail((req.body || {}).email || '');
  if (!friend) return res.status(404).json({ error: 'No account with that email — they need to sign up first.' });
  if (friend.id === site.userId) return res.status(400).json({ error: "That's you (the owner)." });

  const collaborators = site.collaborators || [];
  if (!collaborators.includes(friend.id)) collaborators.push(friend.id);
  store.updateSite(site.id, { collaborators });
  res.json({ ok: true });
});

// Stop sharing with someone.
router.post('/sites/:id/unshare', (req, res) => {
  const site = ownedSite(req);
  if (!site) return res.status(404).json({ error: 'not found' });
  const userId = String((req.body || {}).userId || '');
  store.updateSite(site.id, { collaborators: (site.collaborators || []).filter((u) => u !== userId) });
  res.json({ ok: true });
});

// ── Deploy tokens (for the Claude connector) ─────────────────────
router.get('/tokens', (req, res) => res.json({ tokens: tokens.listFor(req.userId) }));
router.post('/tokens', (req, res) => {
  const token = tokens.generate(req.userId, String((req.body || {}).name || 'connector'));
  res.status(201).json({ token }); // shown once
});
router.delete('/tokens/:id', (req, res) => { tokens.revoke(req.params.id, req.userId); res.json({ ok: true }); });

// ── Notifications (the 🔔 bell) ──────────────────────────────────
router.get('/notifications', (req, res) => res.json(notify.listFor(req.userId)));
router.post('/notifications/read', (req, res) => { notify.markReadAll(req.userId); res.json({ ok: true }); });
router.post('/notifications/clear', (req, res) => { notify.clear(req.userId); res.json({ ok: true }); });

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

// ════════════════════════════════════════════════════════════════
//  OWNER PANEL — every route below is owner-only (Lucas gets 403).
// ════════════════════════════════════════════════════════════════
router.use('/admin', auth.requireAdmin);

function userSummary(u) {
  const sites = store.listSites().filter((s) => s.userId === u.id);
  let bytes = 0;
  for (const s of sites) bytes += dirSize(path.join(config.sitesDir, s.id));
  const lim = auth.effectiveLimit(u);
  const storageMb = auth.effectiveStorageMb(u);
  return {
    id: u.id, email: u.email, createdAt: u.createdAt,
    admin: auth.isAdmin(u), suspended: !!u.suspended,
    siteLimit: u.siteLimit === undefined ? null : u.siteLimit,
    limit: lim === Infinity ? 'unlimited' : lim,
    storageLimitMb: u.storageLimitMb === undefined ? null : u.storageLimitMb,
    storageCap: storageMb === Infinity ? 'unlimited' : storageMb,
    sites: sites.filter((s) => !s.isPreview).length, storageBytes: bytes,
  };
}

function notSelf(req, res) {
  if (req.params.id === req.userId) { res.status(400).json({ error: "you can't do that to your own account" }); return true; }
  return false;
}

// ── overview ──
router.get('/admin/users', (req, res) => res.json({ users: auth.listAllUsers().map(userSummary) }));
router.get('/admin/sites', (req, res) => {
  const email = {}; auth.listAllUsers().forEach((u) => { email[u.id] = u.email; });
  res.json({ sites: store.listSites().map((s) => ({ id: s.id, name: s.name, url: s.url, status: s.status, owner: email[s.userId] || '(unknown)', isPreview: !!s.isPreview, locked: !!s.locked, featured: !!s.featured })) });
});
router.get('/admin/stats', (req, res) => {
  const sites = store.listSites();
  res.json({ users: auth.listAllUsers().length, sites: sites.filter((s) => !s.isPreview).length, previews: sites.filter((s) => s.isPreview).length });
});
router.get('/admin/activity', (req, res) => res.json({ activity: activity.recent(100) }));

// ── server health + control ──
// A snapshot of how the droplet is doing: memory, disk, containers, storage.
router.get('/admin/health', (req, res) => {
  const sites = store.listSites();
  let storageBytes = 0;
  for (const s of sites) storageBytes += system.dirSize(path.join(config.sitesDir, s.id));

  res.json({
    mem: system.memory(),
    disk: system.disk(),
    containers: system.containerCount(),
    sites: sites.filter((s) => !s.isPreview).length,
    previews: sites.filter((s) => s.isPreview).length,
    storageBytes,
    uptimeSeconds: Math.round(process.uptime()),
    loadAvg: typeof os.loadavg === 'function' ? Math.round(os.loadavg()[0] * 100) / 100 : null,
  });
});

// Next.js sites run as their own container; list them + whether they're up.
router.get('/admin/containers', (req, res) => {
  const running = system.dockerNames() || [];
  const apps = store.listSites().filter((s) => s.type === 'nextjs').map((s) => ({
    id: s.id, name: s.name, url: s.url, port: s.port || null,
    running: running.includes(`perch-${s.id}`),
  }));
  res.json({ caddyRunning: running.includes('perch-caddy'), apps });
});

// Restart one Next.js site's container.
router.post('/admin/sites/:id/restart', (req, res) => {
  const s = store.getSite(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.type !== 'nextjs') return res.status(400).json({ error: 'only Next.js sites run as a container' });
  try { execSync(`docker restart perch-${s.id}`, { stdio: 'ignore' }); }
  catch { return res.status(500).json({ error: 'restart failed — is the container running?' }); }
  activity.log('restart', `restarted the container for "${s.name}"`);
  res.json({ ok: true });
});

// Restart Caddy (safe) or Perch itself (answers first, then restarts).
router.post('/admin/restart', (req, res) => {
  const target = String((req.body || {}).target || '');
  if (target === 'caddy') {
    try { execSync('docker restart perch-caddy', { stdio: 'ignore' }); }
    catch { return res.status(500).json({ error: 'could not restart Caddy' }); }
    activity.log('restart', 'restarted Caddy');
    return res.json({ ok: true });
  }
  if (target === 'perch') {
    activity.log('restart', 'restarted Perch');
    res.json({ ok: true, note: 'Perch is restarting — the dashboard may blink for a few seconds.' });
    // Restart AFTER the response flushes (pm2 will respawn this process).
    setTimeout(() => { try { exec('pm2 restart perch'); } catch { /* ignore */ } }, 600);
    return;
  }
  res.status(400).json({ error: 'target must be "caddy" or "perch"' });
});

// Daily signups + deploys for the last 14 days (owner charts).
router.get('/admin/charts', (req, res) => {
  const DAY = 86400000;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const start = today.getTime() - i * DAY;
    const d = new Date(start);
    days.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, start, end: start + DAY, signups: 0, deploys: 0 });
  }
  const bucket = (t) => days.find((d) => t >= d.start && t < d.end);
  for (const u of auth.listAllUsers()) { const b = bucket(u.createdAt || 0); if (b) b.signups++; }
  for (const a of activity.recent(300)) { if (a.type === 'deploy') { const b = bucket(a.t); if (b) b.deploys++; } }
  res.json({ days: days.map(({ label, signups, deploys }) => ({ label, signups, deploys })) });
});

// Send a notification to EVERY user's bell at once.
router.post('/admin/broadcast', (req, res) => {
  const message = String((req.body || {}).message || '').trim().slice(0, 280);
  if (!message) return res.status(400).json({ error: 'message required' });
  const users = auth.listAllUsers();
  for (const u of users) notify.add(u.id, { type: 'broadcast', message });
  activity.log('broadcast', `sent an announcement to ${users.length} ${users.length === 1 ? 'user' : 'users'}`);
  res.json({ ok: true, sent: users.length });
});

// ── server settings ──
router.get('/admin/settings', (req, res) => res.json(settings.get()));
router.post('/admin/settings', (req, res) => {
  const b = req.body || {}; const patch = {};
  if ('signupsOpen' in b) patch.signupsOpen = !!b.signupsOpen;
  if ('maintenance' in b) patch.maintenance = !!b.maintenance;
  if ('announcement' in b) patch.announcement = String(b.announcement || '').slice(0, 280);
  if ('defaultLimit' in b) patch.defaultLimit = (b.defaultLimit === null || b.defaultLimit === '') ? null : Number(b.defaultLimit);
  if ('defaultStorageMb' in b) patch.defaultStorageMb = (b.defaultStorageMb === null || b.defaultStorageMb === '') ? null : Number(b.defaultStorageMb);
  res.json(settings.set(patch));
});

// ── bans ──
router.get('/admin/bans', (req, res) => res.json({ bannedEmails: settings.get().bannedEmails }));
router.post('/admin/ban', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  settings.set({ bannedEmails: Array.from(new Set([...settings.get().bannedEmails, email])) });
  res.json({ ok: true });
});
router.post('/admin/unban', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  settings.set({ bannedEmails: settings.get().bannedEmails.filter((e) => e !== email) });
  res.json({ ok: true });
});

// ── per-user actions ──
router.post('/admin/users/:id/limit', (req, res) => {
  const u = auth.getUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  let limit = (req.body || {}).limit;
  if (limit === 'unlimited') limit = -1;
  else if (limit === null || limit === '' || limit === 'default') limit = null;
  else { limit = Number(limit); if (!Number.isFinite(limit) || limit < 0) return res.status(400).json({ error: 'limit must be a number, "unlimited", or "default"' }); }
  auth.updateUser(u.id, { siteLimit: limit });
  res.json({ ok: true });
});
router.post('/admin/users/:id/storage', (req, res) => {
  const u = auth.getUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  let mb = (req.body || {}).mb;
  if (mb === 'unlimited') mb = -1;
  else if (mb === null || mb === '' || mb === 'default') mb = null;
  else { mb = Number(mb); if (!Number.isFinite(mb) || mb < 0) return res.status(400).json({ error: 'storage must be a number of MB, "unlimited", or "default"' }); }
  auth.updateUser(u.id, { storageLimitMb: mb });
  res.json({ ok: true });
});
router.post('/admin/users/:id/owner', (req, res) => {
  if (notSelf(req, res)) return;
  const u = auth.getUserById(req.params.id); if (!u) return res.status(404).json({ error: 'not found' });
  auth.updateUser(u.id, { admin: !!(req.body || {}).admin }); res.json({ ok: true });
});
router.post('/admin/users/:id/suspend', (req, res) => {
  if (notSelf(req, res)) return;
  const u = auth.getUserById(req.params.id); if (!u) return res.status(404).json({ error: 'not found' });
  auth.updateUser(u.id, { suspended: !!(req.body || {}).suspended }); res.json({ ok: true });
});
router.post('/admin/users/:id/reset-password', (req, res) => {
  const u = auth.getUserById(req.params.id); if (!u) return res.status(404).json({ error: 'not found' });
  const pw = String((req.body || {}).password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  auth.setUserPassword(u.id, pw); res.json({ ok: true });
});
router.post('/admin/users/:id/revoke-tokens', (req, res) => { tokens.revokeAllForUser(req.params.id); res.json({ ok: true }); });
router.get('/admin/users/:id/sites', (req, res) => {
  res.json({ sites: store.listByUser(req.params.id).filter((s) => !s.isPreview).map((s) => ({ ...publicSite(s, req.userId), ...uptime.getUptime(s.id) })) });
});
// View-as-user: a read-only overview of one account, for debugging their sites.
router.get('/admin/users/:id/overview', (req, res) => {
  const u = auth.getUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const sites = store.listSites().filter((s) => s.userId === u.id && !s.isPreview).map((s) => ({
    id: s.id, name: s.name, url: s.url, status: s.status, type: s.type,
    storageBytes: system.dirSize(path.join(config.sitesDir, s.id)),
    views: stats.getStats(s.id).total,
    ...uptime.getUptime(s.id),
  }));
  res.json({ user: userSummary(u), sites, tokens: tokens.listFor(u.id).length });
});
router.delete('/admin/users/:id', async (req, res) => {
  if (notSelf(req, res)) return;
  const u = auth.getUserById(req.params.id); if (!u) return res.status(404).json({ error: 'not found' });
  for (const s of store.listSites().filter((x) => x.userId === u.id && !x.isPreview)) removeSiteCascade(s);
  tokens.revokeAllForUser(u.id); auth.deleteUserRecord(u.id);
  activity.log('user-delete', `removed account ${u.email}`);
  await caddy.writeAndReload(); res.json({ ok: true });
});

// ── admin actions on ANY site ──
router.post('/admin/sites/:id/redeploy', (req, res) => {
  const s = store.getSite(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  deployer.deploy(s); res.json({ ok: true });
});
// Bulk redeploy/delete several sites at once (owner panel checkboxes).
router.post('/admin/sites/bulk', async (req, res) => {
  const b = req.body || {};
  const action = String(b.action || '');
  const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: 'no sites selected' });
  if (action !== 'redeploy' && action !== 'delete') return res.status(400).json({ error: 'action must be "redeploy" or "delete"' });

  let done = 0, skipped = 0;
  for (const id of ids) {
    const s = store.getSite(id);
    if (!s) { skipped++; continue; }
    if (action === 'redeploy') { deployer.deploy(s); done++; }
    else { if (s.locked) { skipped++; continue; } removeSiteCascade(s); done++; }
  }
  if (action === 'delete') {
    activity.log('delete', `bulk-deleted ${done} site${done === 1 ? '' : 's'}`);
    await caddy.writeAndReload();
  }
  res.json({ ok: true, done, skipped });
});
router.delete('/admin/sites/:id', async (req, res) => {
  const s = store.getSite(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  removeSiteCascade(s); await caddy.writeAndReload(); res.json({ ok: true });
});
router.post('/admin/sites/:id/transfer', (req, res) => {
  const s = store.getSite(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  const target = auth.findUserByEmail((req.body || {}).email || '');
  if (!target) return res.status(404).json({ error: 'no user with that email' });
  store.updateSite(s.id, { userId: target.id }); res.json({ ok: true });
});
router.post('/admin/sites/:id/lock', (req, res) => {
  const s = store.getSite(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  store.updateSite(s.id, { locked: !!(req.body || {}).locked }); res.json({ ok: true });
});
router.post('/admin/sites/:id/feature', (req, res) => {
  const s = store.getSite(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  store.updateSite(s.id, { featured: !!(req.body || {}).featured }); res.json({ ok: true });
});

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

module.exports = router;
