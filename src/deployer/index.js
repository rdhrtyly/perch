// deployer/index.js — runs a deploy from start to finish, keeping the
// site's status and live log updated the whole way through.
//
// The steps:  get code → detect type → build → publish → wire up Caddy

const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('../store');
const logs = require('../logs/stream');
const notify = require('../notify');
const activity = require('../activity');
const history = require('../history');
const { run, buildStatic, buildAndRunNext } = require('./docker');
const { detect } = require('./detect');
const caddy = require('./caddy');

// Pick the next free port for Next.js apps (they each need their own).
function nextPort() {
  const used = store.listSites().map((s) => s.port).filter(Boolean);
  let p = 4001;
  while (used.includes(p)) p++;
  return p;
}

async function deploy(site) {
  const startedAt = Date.now();
  const deployId = logs.startDeploy(site.id);
  store.updateSite(site.id, {
    status: 'building',
    lastDeployId: deployId,
    lastDeployAt: Date.now(),
  });

  const repoDir = path.join(config.workspaceDir, site.id);

  try {
    const from = site.source === 'upload' ? 'uploaded files' : site.repo;
    logs.log(deployId, `Starting deploy of "${site.name}"  (${from})`);

    // 1) Get the code.
    if (site.source === 'upload') {
      // Files were already saved to the workspace by the upload step —
      // nothing to clone.
      logs.log(deployId, 'Using uploaded files (no GitHub needed).');
    } else {
      await getCode(deployId, site, repoDir);
    }

    // 2) Work out what kind of project this is.
    const plan = detect(repoDir);
    logs.log(deployId, `Detected project type: ${plan.type}`);
    store.updateSite(site.id, { type: plan.type });

    // 3) Build + publish based on the type.
    if (plan.type === 'nextjs') {
      let fresh = store.getSite(site.id);
      if (!fresh.port) fresh = store.updateSite(site.id, { port: nextPort() });
      logs.log(deployId, `Building Next.js app (will run on port ${fresh.port})...`);
      await buildAndRunNext(deployId, repoDir, fresh);
    } else if (plan.type === 'static-build') {
      logs.log(deployId, 'Building in Docker...');
      const builtDir = await buildStatic(deployId, repoDir, plan, store.getSite(site.id).env);
      publishStatic(deployId, site, builtDir);
    } else {
      logs.log(deployId, 'Static site — no build needed, publishing files...');
      publishStatic(deployId, site, path.join(repoDir, plan.outputDir || '.'));
    }

    // 4) Point the web address at the result and turn on HTTPS.
    logs.log(deployId, 'Updating web address + HTTPS (Caddy)...');
    store.updateSite(site.id, { status: 'live' });
    await caddy.writeAndReload();

    logs.log(deployId, `Done! Live at ${site.url}`);
    activity.log('deploy', `deployed "${site.name}"`);
    history.record(site.id, { status: 'live', ms: Date.now() - startedAt });
    logs.finish(deployId, 'live');
  } catch (err) {
    logs.log(deployId, `Deploy FAILED: ${err.message}`);
    store.updateSite(site.id, { status: 'failed' });
    notify.add(site.userId, { type: 'deploy-failed', message: `"${site.name}" failed to deploy`, siteId: site.id });
    history.record(site.id, { status: 'failed', ms: Date.now() - startedAt, error: err.message });
    logs.finish(deployId, 'failed');
  }
}

// Clone the repo the first time, then just pull updates after that.
async function getCode(deployId, site, repoDir) {
  // Add the token to the URL only if you set one (for private repos).
  const auth = config.githubToken ? `${config.githubToken}@` : '';
  const repoUrl = `https://${auth}github.com/${site.repo}.git`;
  const branch = site.branch || 'main';

  if (fs.existsSync(path.join(repoDir, '.git'))) {
    logs.log(deployId, 'Fetching latest changes...');
    await run(deployId, 'git', ['-C', repoDir, 'fetch', '--all']);
    await run(deployId, 'git', ['-C', repoDir, 'reset', '--hard', `origin/${branch}`]);
  } else {
    logs.log(deployId, 'Cloning repository...');
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    await run(deployId, 'git', ['clone', '--branch', branch, repoUrl, repoDir]);
  }
}

// Copy the finished files into the folder Caddy serves from.
function publishStatic(deployId, site, builtDir) {
  const dest = path.join(config.sitesDir, site.id);
  // Save the currently-live version first, so we can roll back to it later.
  if (fs.existsSync(dest)) snapshotVersion(deployId, site);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  // Copy everything except git/node_modules junk.
  fs.cpSync(builtDir, dest, {
    recursive: true,
    filter: (src) =>
      !src.includes(`${path.sep}.git`) && !src.includes(`${path.sep}node_modules`),
  });

  injectBeacon(dest, site);
  logs.log(deployId, `Published files to ${dest}`);
}

// Add the tiny visit-counter script to every .html page we publish.
function injectBeacon(dir, site) {
  if (!config.dashboardDomain) return; // need a place to send hits
  const snippet =
    `\n<script>(function(){try{var i=new Image();` +
    `i.src="https://${config.dashboardDomain}/_perch/hit?s=${site.id}&t="+Date.now();}catch(e){}})();</script>\n`;
  for (const file of walkHtml(dir)) {
    let html = fs.readFileSync(file, 'utf8');
    if (html.includes('/_perch/hit')) continue; // already has it
    html = html.includes('</body>') ? html.replace('</body>', snippet + '</body>') : html + snippet;
    fs.writeFileSync(file, html);
  }
}

function walkHtml(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkHtml(p, out);
    else if (e.name.toLowerCase().endsWith('.html')) out.push(p);
  }
  return out;
}

// Save the current live files as a version we can roll back to (keep last 3).
function snapshotVersion(deployId, site) {
  try {
    const src = path.join(config.sitesDir, site.id);
    const verId = String(Date.now());
    const verDir = path.join(config.versionsDir, site.id, verId);
    fs.mkdirSync(path.dirname(verDir), { recursive: true });
    fs.cpSync(src, verDir, { recursive: true });

    const fresh = store.getSite(site.id) || site;
    const versions = [{ id: verId, at: Date.now() }, ...(fresh.versions || [])];
    const keep = versions.slice(0, 3);
    for (const old of versions.slice(3)) {
      fs.rmSync(path.join(config.versionsDir, site.id, old.id), { recursive: true, force: true });
    }
    store.updateSite(site.id, { versions: keep });
    logs.log(deployId, 'Saved the previous version (you can roll back to it).');
  } catch (e) { /* snapshots are best-effort */ }
}

module.exports = { deploy };
