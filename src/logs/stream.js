// logs/stream.js — keeps each deploy's live build log + status, and
// pushes new log lines to any browser watching the status page.
//
// "Cool part B" lives here. We use Server-Sent Events (SSE): the
// simplest way for a server to keep sending updates to a web page.

const crypto = require('crypto');

// Every deploy we've seen, kept in memory:
// { id, siteId, status, startedAt, finishedAt, lines:[], clients:Set<res> }
const deploys = new Map();

// Start tracking a brand-new deploy and return its id.
function startDeploy(siteId) {
  const id = crypto.randomUUID();
  deploys.set(id, {
    id,
    siteId,
    status: 'building',
    startedAt: Date.now(),
    finishedAt: null,
    lines: [],
    clients: new Set(),
  });
  return id;
}

function getDeploy(id) {
  return deploys.get(id) || null;
}

// Add one line to the log and send it to everyone watching live.
function log(id, text) {
  const d = deploys.get(id);
  if (!d) return;
  const line = { t: Date.now(), text };
  d.lines.push(line);
  for (const res of d.clients) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }
  // Also print to the server console — handy when you're on the server.
  process.stdout.write(`[${d.siteId}] ${text}\n`);
}

// Mark a deploy finished ('live' or 'failed') and tell the watchers.
function finish(id, status) {
  const d = deploys.get(id);
  if (!d) return;
  d.status = status;
  d.finishedAt = Date.now();
  for (const res of d.clients) {
    res.write(`event: status\ndata: ${JSON.stringify({ status })}\n\n`);
    res.end();
  }
  d.clients.clear();
}

// Connect a browser (SSE) so it sees the log live.
function subscribe(id, res) {
  const d = deploys.get(id);
  if (!d) {
    res.status(404).end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  // Send everything so far, so someone who opens the page late still
  // sees the whole story.
  for (const line of d.lines) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }

  // If it's already done, send the final status and close.
  if (d.status !== 'building') {
    res.write(`event: status\ndata: ${JSON.stringify({ status: d.status })}\n\n`);
    res.end();
    return;
  }

  // Otherwise keep the connection open for live updates.
  d.clients.add(res);
  res.on('close', () => d.clients.delete(res));
}

module.exports = { startDeploy, getDeploy, log, finish, subscribe, deploys };
