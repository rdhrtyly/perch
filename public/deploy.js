// deploy.js — the LIVE status page. Streams build logs as they happen.

const params = new URLSearchParams(location.search);
const id = params.get('id');

const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const titleEl = document.getElementById('title');
const elapsedEl = document.getElementById('elapsed');

let startedAt = Date.now();

// Color a log line a little: commands, success, errors.
function classify(text) {
  if (text.startsWith('$ ')) return 'cmd';
  const t = text.toLowerCase();
  if (t.includes('done!') || t.includes('live at')) return 'ok';
  if (t.includes('failed') || t.includes('error')) return 'err';
  return '';
}

function addLine(text) {
  const div = document.createElement('span');
  div.className = 'l ' + classify(text);
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight; // keep newest in view
}

function setStatus(status) {
  const label = { live: 'Live', building: 'Building', failed: 'Failed' }[status] || status;
  statusEl.className = 'pill ' + status;
  statusEl.innerHTML = `<span class="dot"></span>${label}`;
  if (status === 'live') titleEl.textContent = 'Deployed 🎉';
  if (status === 'failed') titleEl.textContent = 'Deploy failed';
}

// Tick the elapsed-time label.
setInterval(() => {
  if (statusEl.classList.contains('building')) {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    elapsedEl.textContent = `${s}s`;
  }
}, 1000);

if (!id) {
  addLine('No deploy id in the URL.');
} else {
  // Open a live stream of log lines (Server-Sent Events).
  const es = new EventSource(`/api/deploys/${id}/logs`);

  es.onmessage = (e) => {
    const line = JSON.parse(e.data);
    if (!startedAt || line.t < startedAt) startedAt = line.t;
    addLine(line.text);
  };

  // A special "status" event tells us when it finished.
  es.addEventListener('status', (e) => {
    const { status } = JSON.parse(e.data);
    setStatus(status);
    es.close();
  });

  es.onerror = () => {
    // Stream closed (usually because the deploy finished).
    es.close();
  };
}
