// settings.js — server-wide settings the owner can toggle (e.g. signups).

const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.dataDir, 'settings.json');
const DEFAULTS = {
  signupsOpen: true,      // can new people make accounts?
  maintenance: false,     // pause the whole site for non-owners
  announcement: '',       // banner message shown to everyone
  defaultLimit: null,     // override config.maxSitesPerUser (null = use .env)
  bannedEmails: [],       // emails blocked from signing up
};

let data = { ...DEFAULTS };

function load() {
  try { data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { data = { ...DEFAULTS }; }
}
function get() { return { ...data }; }
function set(patch) {
  data = { ...data, ...patch };
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
  return get();
}

module.exports = { load, get, set };
