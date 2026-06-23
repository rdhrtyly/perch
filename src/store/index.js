// store/index.js — where the list of your sites is kept.
//
// Today it's a simple JSON file. Tomorrow it could be a real database
// (SQLite, Postgres...) without changing the rest of the app, because
// everything else only ever calls these functions — never touches the
// file directly. That's how we keep "scale later" easy.

const fs = require('fs');
const path = require('path');
const config = require('../config');

function ensureFile() {
  fs.mkdirSync(path.dirname(config.sitesFile), { recursive: true });
  if (!fs.existsSync(config.sitesFile)) {
    fs.writeFileSync(config.sitesFile, '[]');
  }
}

function readAll() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(config.sitesFile, 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(sites) {
  ensureFile();
  fs.writeFileSync(config.sitesFile, JSON.stringify(sites, null, 2));
}

function listSites() {
  return readAll();
}

function getSite(id) {
  return readAll().find((s) => s.id === id) || null;
}

// Match an incoming GitHub webhook to a site by its repo name,
// e.g. "hartley/forkful".
function getSiteByRepo(repoFullName) {
  return readAll().find((s) => s.repo === repoFullName) || null;
}

// Add a new site, or replace an existing one with the same id.
function upsertSite(site) {
  const sites = readAll();
  const i = sites.findIndex((s) => s.id === site.id);
  if (i === -1) sites.push(site);
  else sites[i] = { ...sites[i], ...site };
  writeAll(sites);
  return getSite(site.id);
}

// Change just a few fields on a site (e.g. status, port).
function updateSite(id, patch) {
  const sites = readAll();
  const i = sites.findIndex((s) => s.id === id);
  if (i === -1) return null;
  sites[i] = { ...sites[i], ...patch };
  writeAll(sites);
  return sites[i];
}

// Remove a site from the list.
function removeSite(id) {
  writeAll(readAll().filter((s) => s.id !== id));
}

// Sites a user can see: ones they own, plus ones shared with them.
function listByUser(userId) {
  return readAll().filter(
    (s) => s.userId === userId || (s.collaborators && s.collaborators.includes(userId))
  );
}

// Give any owner-less sites (made before logins existed) to a user.
function claimOwnerless(userId) {
  const sites = readAll();
  let changed = false;
  for (const s of sites) if (!s.userId) { s.userId = userId; changed = true; }
  if (changed) writeAll(sites);
}

// Make a site id (= subdomain) that no one else is using.
function uniqueId(base) {
  const ids = new Set(readAll().map((s) => s.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

module.exports = {
  listSites, getSite, getSiteByRepo, upsertSite, updateSite, removeSite,
  listByUser, claimOwnerless, uniqueId,
};
