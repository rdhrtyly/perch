// webhook.js — the "Bouncer".
// Confirms a webhook really came from GitHub (signed with YOUR secret)
// before we trust it. Without this, anyone who found your URL could
// trigger deploys. With it, they can't.

const crypto = require('crypto');
const config = require('./config');

// GitHub signs the request body with your secret and sends the result
// in the "X-Hub-Signature-256" header. We recompute it and compare.
function verifySignature(req) {
  const signature = req.get('X-Hub-Signature-256') || '';
  if (!config.webhookSecret || !signature || !req.rawBody) return false;

  const hmac = crypto.createHmac('sha256', config.webhookSecret);
  hmac.update(req.rawBody);
  const expected = `sha256=${hmac.digest('hex')}`;

  // Compare safely (timingSafeEqual needs equal-length buffers).
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Pull out the bits we care about from a GitHub "push" event.
function parsePush(req) {
  const event = req.get('X-GitHub-Event');
  if (event !== 'push') return null; // ignore stars, forks, etc.

  const body = req.body || {};
  const repo = body.repository && body.repository.full_name; // "owner/name"
  const ref = body.ref || '';                                // "refs/heads/main"
  const branch = ref.replace('refs/heads/', '');
  return { repo, branch };
}

module.exports = { verifySignature, parsePush };
