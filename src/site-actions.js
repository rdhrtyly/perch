// site-actions.js — shared site teardown.
//
// Removing a site touches several places (its files, a Docker container for
// Next.js apps, its stats + uptime records, and the store). Both the dashboard
// API and the Claude connector (MCP) need to do this the same way, so the
// logic lives here once instead of being copied — deleting is destructive, and
// two copies could quietly drift apart.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('./config');
const store = require('./store');
const stats = require('./stats');
const uptime = require('./uptime');
const history = require('./history');

// Remove a single site's files, container, and records.
function removeSiteArtifacts(s) {
  if (s.type === 'nextjs') { try { execSync(`docker rm -f perch-${s.id}`, { stdio: 'ignore' }); } catch { /* ok */ } }
  for (const dir of [config.workspaceDir, config.sitesDir, config.versionsDir]) {
    fs.rmSync(path.join(dir, s.id), { recursive: true, force: true });
  }
  store.removeSite(s.id); stats.removeSite(s.id); uptime.removeSite(s.id); history.removeSite(s.id);
}

// Remove a site AND its previews.
function removeSiteCascade(site) {
  [site, ...store.listSites().filter((s) => s.parentId === site.id)].forEach(removeSiteArtifacts);
}

module.exports = { removeSiteArtifacts, removeSiteCascade };
