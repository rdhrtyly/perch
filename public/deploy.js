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
  if (status === 'live') { titleEl.textContent = 'Deployed 🎉'; celebrate(); }
  if (status === 'failed') titleEl.textContent = 'Deploy failed';
}

// Confetti + a little success chime when a deploy goes live.
function celebrate() {
  if (window.confetti) {
    window.confetti({ particleCount: 130, spread: 80, origin: { y: 0.6 } });
    const end = Date.now() + 700;
    (function frame() {
      window.confetti({ particleCount: 3, angle: 60, spread: 55, origin: { x: 0 } });
      window.confetti({ particleCount: 3, angle: 120, spread: 55, origin: { x: 1 } });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [523.25, 659.25, 783.99].forEach((f, i) => { // C-E-G chord
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.start(t); o.stop(t + 0.45);
    });
  } catch (e) { /* sound is optional */ }
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
