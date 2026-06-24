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

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
];

// Write provided files to a workspace and deploy as a static site.
function deployFromFiles(userId, name, files) {
  if (!name) throw new Error('a name is required');
  if (!Array.isArray(files) || !files.length) throw new Error('files are required');

  const baseId = slugify(name);
  const existing = store.getSite(baseId);
  if (existing && existing.userId !== userId) throw new Error('a site with that name already exists');
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
    deployer.deploy(s);
    return text(`Redeploying "${s.name}".`);
  }
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
