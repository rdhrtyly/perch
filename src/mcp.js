// mcp.js — the Claude connector.
//
// Speaks MCP (Model Context Protocol) over HTTP so Claude gets tools to
// deploy to YOUR Perch. It's plain JSON-RPC, kept minimal & dependency-free.
// Auth is your deploy token sent as "Authorization: Bearer perch_...".

const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const deployer = require('./deployer');
const tokens = require('./tokens');
const oauth = require('./oauth');
const stats = require('./stats');
const uptime = require('./uptime');
const logs = require('./logs/stream');
const caddy = require('./deployer/caddy');
const guards = require('./guards');
const { removeSiteCascade } = require('./site-actions');

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Find one of the user's sites by id, or by name (case-insensitive / slug).
// Includes sites shared with the user, not just ones they own.
function resolveSite(userId, { id, name } = {}) {
  if (id) {
    const s = store.getSite(String(id));
    if (s && (s.userId === userId || (s.collaborators || []).includes(userId))) return s;
  }
  if (name) {
    const want = slugify(name);
    const mine = store.listByUser(userId);
    return mine.find((s) => s.id === want)
      || mine.find((s) => slugify(s.name) === want)
      || mine.find((s) => String(s.name).toLowerCase() === String(name).toLowerCase())
      || null;
  }
  return null;
}

function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// Human-friendly "how long ago" for a timestamp.
function fmtAge(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// The tools Claude can use.
const TOOLS = [
  {
    name: 'list_sites',
    description: "List the user's deployed sites with their live URLs and status.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'deploy_site',
    description: 'Deploy a website to Perch and get a live HTTPS URL. Works for plain HTML/CSS/JS AND full React / Vite / Next.js apps — just include ALL the project source files (index.html or package.json, src/, configs, etc.) but NOT node_modules. Perch auto-detects the type, installs dependencies, and builds it (React/Vite → built and served as static; Next.js → run as a live app). Re-deploying the same name updates that site.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Site name; becomes the subdomain.' },
        files: {
          type: 'array',
          description: 'Every source file in the project. For static: index.html + assets. For React/Vite/Next.js: package.json + src/ + configs (no node_modules).',
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
      },
      required: ['name', 'files'],
    },
  },
  {
    name: 'deploy_from_github',
    description: 'Deploy a GitHub repo to Perch — it clones, builds, and serves it. Works for static, React/Vite, and Next.js. Best for existing projects (no need to send every file). The repo must be public, or a GITHUB_TOKEN configured on the server for private repos.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub repo as owner/name, e.g. rdhrtyly/creami' },
        name: { type: 'string', description: 'Optional site name (defaults to the repo name).' },
        branch: { type: 'string', description: 'Optional branch (defaults to main).' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'redeploy_site',
    description: 'Redeploy an existing site by its id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'check_site',
    description: "Check that a deployed site is actually live and working: fetches its real URL from the server and reports the HTTP status, response time, the page title, a snippet of the page's text, plus its recent uptime % and visit counts. Use this right after a deploy to prove it works, or any time you want to confirm a site is up. Identify the site by id OR name.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The site id (subdomain). Optional if you pass name.' },
        name: { type: 'string', description: 'The site name. Optional if you pass id.' },
      },
    },
  },
  {
    name: 'get_site_stats',
    description: 'Get visitor analytics and uptime for a site: total page views, views in the last 24 hours and 7 days, an estimate of unique visitors, recent uptime %, and a 14-day daily view count. Identify the site by id OR name.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The site id. Optional if you pass name.' },
        name: { type: 'string', description: 'The site name. Optional if you pass id.' },
      },
    },
  },
  {
    name: 'get_deploy_logs',
    description: "Get the build log for a site's most recent deploy — the step-by-step output of cloning/building/publishing. Useful when a deploy failed and you want to see why. Identify the site by id OR name.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The site id. Optional if you pass name.' },
        name: { type: 'string', description: 'The site name. Optional if you pass id.' },
      },
    },
  },
  {
    name: 'delete_site',
    description: "Permanently delete a site: removes its files, any running container, its stats, and its web address. This cannot be undone, and only the site's owner can do it. Requires the exact site id (not the name) to avoid deleting the wrong site.",
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The exact site id to delete.' } }, required: ['id'] },
  },
];

// Write provided files to a workspace and deploy as a static site.
function deployFromFiles(userId, name, files) {
  if (!name) throw new Error('a name is required');
  if (!Array.isArray(files) || !files.length) throw new Error('files are required');

  const baseId = slugify(name);
  const existing = store.getSite(baseId);
  if (existing && existing.userId !== userId) throw new Error('a site with that name already exists');
  const g = guards.checkDeploy(userId, { isNew: !existing });
  if (!g.ok) throw new Error(g.error);
  const id = existing ? baseId : store.uniqueId(baseId);

  const dest = path.join(config.workspaceDir, id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    let rel = String(f.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) continue;
    const fp = path.join(dest, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, String(f.content == null ? '' : f.content));
  }

  const domain = `${id}.${config.baseDomain}`;
  store.upsertSite({
    id, name, repo: null, branch: null, userId,
    source: 'upload', domain, domainSource: 'manual',
    type: null, port: null, status: 'new',
    lastDeployAt: null, lastDeployId: null, url: `https://${domain}`,
  });
  deployer.deploy(store.getSite(id));
  return store.getSite(id);
}

// Deploy an existing GitHub repo (Perch clones + builds it).
function deployFromGithub(userId, repo, name, branch) {
  repo = String(repo || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must be in the form owner/name');
  const siteName = (name && String(name).trim()) || repo.split('/')[1];
  const baseId = slugify(siteName);
  const existing = store.getSite(baseId);
  if (existing && existing.userId !== userId) throw new Error('a site with that name already exists');
  const g = guards.checkDeploy(userId, { isNew: !existing });
  if (!g.ok) throw new Error(g.error);
  const id = existing ? baseId : store.uniqueId(baseId);

  const domain = `${id}.${config.baseDomain}`;
  store.upsertSite({
    id, name: siteName, repo, branch: (branch && String(branch).trim()) || 'main', userId,
    source: 'git', domain, domainSource: 'manual',
    type: null, port: null, status: 'new',
    lastDeployAt: null, lastDeployId: null, url: `https://${domain}`,
  });
  deployer.deploy(store.getSite(id));
  return store.getSite(id);
}

// Fetch the live site and report whether it's really up and serving content.
async function checkSite(userId, args) {
  const site = resolveSite(userId, args);
  if (!site) throw new Error('site not found — use list_sites to see ids and names');
  const url = site.url || `https://${site.customDomain || site.domain}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  const started = Date.now();
  let res = null, body = '', err = null;
  try {
    res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    body = await res.text();
  } catch (e) {
    err = e;
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;
  const up = uptime.getUptime(site.id);
  const st = stats.getStats(site.id);

  const out = [];
  out.push(`Site: ${site.name}  (id: ${site.id})`);
  out.push(`URL:  ${url}`);
  if (site.customDomain) out.push(`Custom domain: https://${site.customDomain}`);
  out.push(`Type: ${site.type || 'unknown'}   Perch status: ${site.status}`);
  out.push('');

  if (err) {
    const why = err.name === 'AbortError' ? 'timed out after 10s' : err.message;
    out.push(`❌ Could NOT reach the site (${why}).`);
    out.push(`   It may still be building (Perch status is "${site.status}"). Try get_deploy_logs to see what happened.`);
  } else {
    const ok = res.status < 400;
    const locked = res.status === 401;
    const titleMatch = body.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : null;
    out.push(`${ok || locked ? '✅' : '⚠️'} HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}  (${ms} ms)`);
    if (locked) out.push('   (401 = password-protected and responding — that still counts as live.)');
    out.push(`   Served: ${res.headers.get('content-type') || '?'}, ${fmtBytes(Buffer.byteLength(body))}`);
    if (title) out.push(`   Page title: "${title}"`);
    const textOnly = body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (textOnly) out.push(`   First words: ${textOnly.slice(0, 160)}${textOnly.length > 160 ? '…' : ''}`);
  }

  out.push('');
  out.push(`Uptime (recent checks): ${up.pct == null ? 'n/a' : up.pct + '%'}${up.lastCheckedAt ? `, last checked ${fmtAge(up.lastCheckedAt)}` : ''}`);
  out.push(`Visits: ${st.total} total · ${st.last24h} in 24h · ${st.last7d} in 7d · ~${st.visitors} unique`);
  out.push(`Last deploy: ${fmtAge(site.lastDeployAt)}`);
  return text(out.join('\n'));
}

function getSiteStats(userId, args) {
  const site = resolveSite(userId, args);
  if (!site) throw new Error('site not found — use list_sites to see ids and names');
  const st = stats.getStats(site.id);
  const up = uptime.getUptime(site.id);
  return text([
    `Stats for "${site.name}"  (${site.url})`,
    `Total page views: ${st.total}`,
    `Last 24h: ${st.last24h}    Last 7 days: ${st.last7d}`,
    `Unique visitors (recent): ~${st.visitors}`,
    `Uptime (recent checks): ${up.pct == null ? 'n/a' : up.pct + '%'}`,
    '',
    'Last 14 days:',
    st.daily.map((d) => `  ${d.label}: ${d.count}`).join('\n'),
  ].join('\n'));
}

function getDeployLogs(userId, args) {
  const site = resolveSite(userId, args);
  if (!site) throw new Error('site not found — use list_sites to see ids and names');
  const d = site.lastDeployId ? logs.getDeploy(site.lastDeployId) : null;
  if (!d) {
    return text(`No build log is in memory for "${site.name}". Perch only keeps logs since its last restart — redeploy to get fresh logs. Current status: ${site.status}.`);
  }
  const lines = d.lines.map((l) => l.text).join('\n');
  return text(`Build log for "${site.name}" — deploy status: ${d.status}\n\n${lines || '(no log lines recorded)'}`);
}

async function deleteSite(userId, id) {
  id = String(id || '');
  const s = store.getSite(id);
  if (!s || s.userId !== userId) throw new Error('site not found (only the owner can delete a site)');
  if (s.locked) throw new Error('this site is locked by the owner and can’t be deleted');
  removeSiteCascade(s);
  await caddy.writeAndReload();
  return text(`Deleted "${s.name}" (${id}) — files, container, stats, and web address all removed. This can't be undone.`);
}

function text(t) { return { content: [{ type: 'text', text: t }] }; }

async function runTool(userId, name, args) {
  if (name === 'list_sites') {
    const sites = store.listByUser(userId).filter((s) => !s.isPreview)
      .map((s) => ({ id: s.id, name: s.name, url: s.url, status: s.status }));
    return text(sites.length ? JSON.stringify(sites, null, 2) : 'No sites yet.');
  }
  if (name === 'deploy_site') {
    const site = deployFromFiles(userId, String(args.name || ''), args.files);
    return text(`Deploying "${site.name}". It will be live at ${site.url} shortly (React/Next.js builds take a minute or two). Use list_sites to check status.`);
  }
  if (name === 'deploy_from_github') {
    const site = deployFromGithub(userId, args.repo, args.name, args.branch);
    return text(`Deploying "${site.name}" from ${site.repo} (${site.branch}). It will be live at ${site.url} shortly. Use list_sites to check status.`);
  }
  if (name === 'redeploy_site') {
    const s = store.getSite(String(args.id || ''));
    if (!s || s.userId !== userId) throw new Error('site not found');
    const g = guards.checkDeploy(userId, { isNew: false });
    if (!g.ok) throw new Error(g.error);
    deployer.deploy(s);
    return text(`Redeploying "${s.name}".`);
  }
  if (name === 'check_site') return await checkSite(userId, args);
  if (name === 'get_site_stats') return getSiteStats(userId, args);
  if (name === 'get_deploy_logs') return getDeployLogs(userId, args);
  if (name === 'delete_site') return await deleteSite(userId, args.id);
  throw new Error('unknown tool: ' + name);
}

// Handle one JSON-RPC message; returns a response object, or null for notifications.
async function handleOne(m, userId) {
  const { id, method, params } = m || {};

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'perch', version: '1.0.0' },
      },
    };
  }
  if (method && method.startsWith('notifications/')) return null; // no reply to notifications
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

  if (method === 'tools/call') {
    if (!userId) return { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized — add your Perch deploy token.' } };
    try {
      const r = await runTool(userId, params.name, params.arguments || {});
      return { jsonrpc: '2.0', id, result: r };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
}

function baseUrl(req) {
  return config.dashboardDomain ? `https://${config.dashboardDomain}` : `${req.protocol}://${req.get('host')}`;
}

// Express handler for POST /mcp.
async function handler(req, res) {
  const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : '';
  // Accept either an OAuth access token (desktop/Cowork) or a deploy token (CLI).
  const userId = token ? (oauth.verifyAccessToken(token) || tokens.verify(token)) : null;

  // No valid token → 401 with a pointer to our OAuth metadata (kicks off login).
  if (!userId) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource${req.path}"`);
    return res.status(401).json({ jsonrpc: '2.0', id: (req.body && req.body.id) || null, error: { code: -32001, message: 'Unauthorized' } });
  }

  try {
    const body = req.body;
    if (Array.isArray(body)) {
      const out = [];
      for (const m of body) { const r = await handleOne(m, userId); if (r) out.push(r); }
      return out.length ? res.json(out) : res.status(202).end();
    }
    const r = await handleOne(body, userId);
    if (r === null) return res.status(202).end();
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message } });
  }
}

module.exports = { handler };
