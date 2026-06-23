// site.js — the per-site management page.

const id = new URLSearchParams(location.search).get('id');

const $ = (x) => document.getElementById(x);

function pill(status) {
  const label = { live: 'Live', building: 'Building', failed: 'Failed', new: 'Not deployed' }[status] || status;
  $('status').className = 'pill ' + status;
  $('status').innerHTML = `<span class="dot"></span>${label}`;
}
function timeAgo(ms) {
  if (!ms) return 'never';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

let SITE = null;

async function load() {
  const r = await fetch('/api/sites');
  if (r.status === 401) { location.href = '/login.html'; return; }
  const sites = await r.json();
  SITE = sites.find((s) => s.id === id);
  if (!SITE) { $('title').textContent = 'Site not found'; return; }

  $('title').textContent = SITE.name;
  pill(SITE.status);
  $('lastDeploy').textContent = 'Last deployed ' + timeAgo(SITE.lastDeployAt);

  // Domains (subdomain + custom, if any)
  const links = [SITE.domain, SITE.customDomain].filter(Boolean)
    .map((d) => `<a class="domain" href="https://${d}" target="_blank" rel="noopener">${d} ↗</a>`)
    .join(' &nbsp;·&nbsp; ');
  $('domains').innerHTML = links;

  // Action buttons
  $('openBtn').href = SITE.url;
  $('logsBtn').href = SITE.lastDeployId ? `/deploy.html?id=${SITE.lastDeployId}` : '#';
  if (!SITE.lastDeployId) $('logsBtn').style.display = 'none';

  // Stats
  const st = await fetch(`/api/sites/${id}/stats`).then((r) => r.json());
  $('sViews').textContent = st.total ?? 0;
  $('sVisitors').textContent = st.visitors ?? 0;
  $('sWeek').textContent = st.last7d ?? 0;
  $('sDay').textContent = st.last24h ?? 0;
  $('statsNote').textContent = SITE.type === 'nextjs'
    ? 'Live apps (Next.js) aren’t counted yet — stats are for static/React sites.'
    : 'Counting starts from the first deploy after analytics was added — redeploy if you see zeros.';
}

$('redeployBtn').addEventListener('click', async () => {
  $('redeployBtn').disabled = true; $('redeployBtn').textContent = 'Starting…';
  const r = await fetch(`/api/sites/${id}/deploy`, { method: 'POST' });
  const d = await r.json();
  if (d.deployId) location.href = `/deploy.html?id=${d.deployId}`;
});

$('deleteBtn').addEventListener('click', async () => {
  if (!confirm(`Delete "${SITE.name}"? This removes the site and its files for good.`)) return;
  $('deleteBtn').disabled = true; $('deleteBtn').textContent = 'Deleting…';
  const r = await fetch(`/api/sites/${id}`, { method: 'DELETE' });
  if (r.ok) location.href = '/';
  else { alert('Could not delete'); $('deleteBtn').disabled = false; $('deleteBtn').textContent = 'Delete site'; }
});

load();
setInterval(load, 8000);
