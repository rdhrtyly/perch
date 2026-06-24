// config.js — the ONE place that reads every setting and secret.
// Everything else imports from here. That means when we add new
// settings later (like the Porkbun keys in Phase 2), we change THIS
// file only — never hunt through the whole app.

const path = require('path');

// Load the .env file into process.env first.
require('./load-env');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

const config = {
  port: Number(process.env.PORT) || 3000,
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  baseDomain: process.env.BASE_DOMAIN || 'example.dev',
  dashboardDomain: process.env.DASHBOARD_DOMAIN || '',
  acmeEmail: process.env.ACME_EMAIL || '',
  githubToken: process.env.GITHUB_TOKEN || '',

  // This server's public IP — used by Phase 2 to point bought domains here.
  serverIp: process.env.SERVER_IP || '',

  // Secret used to sign login cookies. If unset, Perch makes one and
  // saves it to data/session.key so logins survive restarts.
  sessionSecret: process.env.SESSION_SECRET || '',

  // Most sites a single account can have (stops one person filling the server).
  maxSitesPerUser: Number(process.env.MAX_SITES_PER_USER) || 10,

  // Pause all deploys when the disk is at/above this % full.
  diskGuardPct: Number(process.env.DISK_GUARD_PCT) || 95,
  // Storage each account may use, in MB (0 = unlimited). Owners are exempt.
  maxStorageMbPerUser: Number(process.env.MAX_STORAGE_MB) || 0,
  // Deploy rate limit: at most N deploys per window (ms) per user.
  deployRateMax: Number(process.env.DEPLOY_RATE_MAX) || 30,
  deployRateWindowMs: Number(process.env.DEPLOY_RATE_WINDOW_MS) || 600000,

  // Owner accounts (by email) — these skip the site limit (unlimited).
  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  // Folders on disk
  dataDir: DATA_DIR,
  workspaceDir: path.join(DATA_DIR, 'workspace'), // git clones live here
  sitesDir: path.join(DATA_DIR, 'sites'),         // built static files Caddy serves
  versionsDir: path.join(DATA_DIR, 'versions'),   // past versions, for rollback
  sitesFile: path.join(DATA_DIR, 'sites.json'),   // the list of your sites
  caddyfile: path.join(DATA_DIR, 'Caddyfile'),    // the config Caddy reads

  // The path where the Caddy CONTAINER sees the built sites.
  // (Set by the volume in docker-compose.yml.)
  caddySitesPath: '/srv/sites',

  // ── PHASE 2: Porkbun ──────────────────────────────────────────
  // Already wired up to read your keys. The functions that use them
  // live in src/domains/porkbun.js (empty for now).
  porkbun: {
    apiKey: process.env.PORKBUN_API_KEY || '',
    secretKey: process.env.PORKBUN_SECRET_KEY || '',
    get enabled() {
      return Boolean(this.apiKey && this.secretKey);
    },
  },
};

module.exports = config;
