// ratelimit.js — caps how many deploys one user can start in a time window.
// In-memory only (resets when Perch restarts), which is plenty for stopping
// accidental or abusive deploy spam.

const config = require('./config');

const hits = new Map(); // userId -> [timestamps]

// Records an attempt and says whether it's allowed.
function allow(userId) {
  const now = Date.now();
  const win = config.deployRateWindowMs;
  const arr = (hits.get(userId) || []).filter((t) => now - t < win);
  if (arr.length >= config.deployRateMax) {
    hits.set(userId, arr);
    const retryAfterSec = Math.max(1, Math.ceil((win - (now - arr[0])) / 1000));
    return { ok: false, retryAfterSec };
  }
  arr.push(now);
  hits.set(userId, arr);
  return { ok: true };
}

module.exports = { allow };
