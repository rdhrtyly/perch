// status.js — the public status page (no login needed).

const userId = new URLSearchParams(location.search).get('u');
const listEl = document.getElementById('list');

function timeAgo(ms) {
  if (!ms) return 'never';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function pill(status) {
  const label = { live: 'Up', building: 'Building', failed: 'Down', new: 'Not deployed' }[status] || status;
  const cls = status === 'live' ? 'live' : status === 'failed' ? 'failed' : status === 'building' ? 'building' : '';
  return `<span class="pill ${cls}"><span class="dot"></span>${label}</span>`;
}

async function load() {
  if (!userId) { listEl.innerHTML = `<div class="empty">No status to show.</div>`; return; }
  let data;
  try { data = await fetch('/api/public/status/' + encodeURIComponent(userId)).then((r) => r.json()); }
  catch { listEl.innerHTML = `<div class="empty">Couldn’t load status.</div>`; return; }

  const sites = (data && data.sites) || [];
  if (!sites.length) { listEl.innerHTML = `<div class="empty">No sites yet.</div>`; return; }

  listEl.innerHTML = sites.map((s) => `
    <div class="card">
      <div class="info">
        <p class="name">${s.name}</p>
        <a class="domain" href="${s.url}" target="_blank" rel="noopener">${s.domain}</a>
        <div class="meta">deployed ${timeAgo(s.lastDeployAt)}</div>
      </div>
      ${pill(s.status)}
    </div>`).join('');
}

load();
setInterval(load, 10000);
