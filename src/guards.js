// guards.js — safety checks that run BEFORE a deploy:
//   • disk guard      — refuse deploys when the droplet's disk is nearly full
//   • storage cap     — stop one user from filling the server (per-user MB cap)
//   • deploy rate     — stop deploy spam (too many in a short window)
//
// One shared place so the dashboard API and the Claude connector (MCP)
// enforce exactly the same rules.

const path = require('path');
const config = require('./config');
const store = require('./store');
const system = require('./system');
const ratelimit = require('./ratelimit');
const auth = require('./auth');

const MB = 1024 * 1024;

// Total published bytes across a user's owned sites.
function userStorageBytes(userId) {
  let total = 0;
  for (const s of store.listSites()) {
    if (s.userId === userId) total += system.dirSize(path.join(config.sitesDir, s.id));
  }
  return total;
}

// Returns { ok:true } or { ok:false, status, error }.
// isNew = true when this deploy creates a brand-new site (so it counts toward
// the storage cap); redeploys pass isNew:false.
function checkDeploy(userId, { isNew = false } = {}) {
  const user = auth.getUserById(userId);
  const admin = auth.isAdmin(user);

  // 1) Disk guard — a full disk breaks builds for EVERYONE, owners included.
  const d = system.disk();
  if (d && d.pct >= config.diskGuardPct) {
    return { ok: false, status: 507, error: `The server's disk is almost full (${d.pct}%). Deploys are paused until space frees up.` };
  }

  // 2) Per-user storage cap (owners exempt; only when adding a new site).
  if (isNew && !admin) {
    const capMb = auth.effectiveStorageMb(user);
    if (Number.isFinite(capMb) && userStorageBytes(userId) / MB >= capMb) {
      return { ok: false, status: 507, error: `You've used all ${capMb} MB of your storage. Delete a site to free space.` };
    }
  }

  // 3) Deploy rate limit (owners exempt). Checked last so a deploy blocked
  // above doesn't burn a rate-limit slot.
  if (!admin) {
    const r = ratelimit.allow(userId);
    if (!r.ok) return { ok: false, status: 429, error: `Too many deploys in a row — wait about ${r.retryAfterSec}s and try again.` };
  }

  return { ok: true };
}

module.exports = { checkDeploy, userStorageBytes };
