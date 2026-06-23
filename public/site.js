// site.js — the per-site management page.

const id = new URLSearchParams(location.search).get('id');
const $ = (x) => document.getElementById(x);

let SITE = null;

function timeAgo(ms) {
  if (!ms) return 'never';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// Full load: runs on first open and after any action.
async function load() {
  const r = await fetch('/api/sites');
  if (r.status === 401) { location.href = '/login.html'; return; }
  const sites = await r.json();
  SITE = sites.find((s) => s.id === id);
  if (!SITE) { $('title').textContent = 'Site not found'; return; }

  renderHeader();
  renderUptime();
  renderPrivacy();
  renderVersions();
  await refreshStats();
  loadEnv();

  const qr = $('qr');
  if (qr && !qr.src) qr.src = `/api/sites/${id}/qr`;
}

// Load the site's secret env vars into the textarea (once).
let envLoaded = false;
async function loadEnv() {
  if (envLoaded) return;
  const res = await fetch(`/api/sites/${id}/env`);
  if (!res.ok) return;
  const { env } = await res.json();
  $('envBox').value = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  envLoaded = true;
}

function renderHeader() {
  $('title').textContent = SITE.name;
  const label = { live: 'Live', building: 'Building', failed: 'Failed', new: 'Not deployed' }[SITE.status] || SITE.status;
  $('status').className = 'pill ' + SITE.status;
  $('status').innerHTML = `<span class="dot"></span>${label}`;
  $('lastDeploy').textContent = 'Last deployed ' + timeAgo(SITE.lastDeployAt);

  $('domains').innerHTML = [SITE.domain, SITE.customDomain].filter(Boolean)
    .map((d) => `<a class="domain" href="https://${d}" target="_blank" rel="noopener">${d} ↗</a>`)
    .join(' &nbsp;·&nbsp; ');

  $('openBtn').href = SITE.url;
  $('logsBtn').href = SITE.lastDeployId ? `/deploy.html?id=${SITE.lastDeployId}` : '#';
  $('logsBtn').style.display = SITE.lastDeployId ? '' : 'none';
}

// Stats only — safe to run on the auto-refresh without disturbing inputs.
async function refreshStats() {
  const res = await fetch(`/api/sites/${id}/stats`);
  if (!res.ok) return;
  const st = await res.json();
  $('sViews').textContent = st.total ?? 0;
  $('sVisitors').textContent = st.visitors ?? 0;
  $('sWeek').textContent = st.last7d ?? 0;
  $('sDay').textContent = st.last24h ?? 0;
  $('statsNote').textContent = SITE && SITE.type === 'nextjs'
    ? 'Live apps (Next.js) aren’t counted yet — stats are for static/React sites.'
    : 'Counting starts from the first deploy after analytics was added — redeploy if you see zeros.';
  renderChart(st.daily || []);
}

function renderUptime() {
  const el = $('uptimePanel');
  if (!el) return;
  if (SITE.up === null || SITE.up === undefined) {
    el.innerHTML = `<span class="subtitle" style="font-size:13px">Not checked yet — Perch pings live sites every minute.</span>`;
    return;
  }
  const dot = SITE.up ? '🟢' : '🔴';
  const word = SITE.up ? 'Up' : 'Down';
  const pct = SITE.pct != null ? ` · ${SITE.pct}% uptime` : '';
  const checked = SITE.lastCheckedAt ? ` · checked ${timeAgo(SITE.lastCheckedAt)}` : '';
  el.innerHTML = `<span style="font-size:15px"><b>${dot} ${word}</b></span><span class="subtitle" style="font-size:13px">${pct}${checked}</span>`;
}

function renderChart(daily) {
  const el = $('chart');
  if (!el) return;
  const max = Math.max(1, ...daily.map((d) => d.count));
  el.innerHTML = daily.map((d) => {
    const h = Math.round((d.count / max) * 100);
    return `<div class="bar" title="${d.label}: ${d.count} views"><div class="bar-fill" style="height:${h}%"></div><div class="bar-x">${d.label.split('/')[1]}</div></div>`;
  }).join('');
}

// ── Privacy (password protect) ───────────────────────────────────
function renderPrivacy() {
  const el = $('privacyPanel');
  if (SITE.protected) {
    el.innerHTML = `<div class="row-between">
      <div>🔒 <b>Password-protected.</b> <span class="subtitle" style="font-size:13px">Username: <code>perch</code></span></div>
      <button class="btn btn-ghost" id="unprotectBtn">Remove password</button></div>`;
    $('unprotectBtn').addEventListener('click', async () => {
      $('unprotectBtn').disabled = true;
      await fetch(`/api/sites/${id}/unprotect`, { method: 'POST' });
      load();
    });
  } else {
    el.innerHTML = `<div class="inline-form">
        <input id="pwInput" type="text" class="inline-input" placeholder="set a password" />
        <button class="btn btn-primary" id="protectBtn">Protect</button>
      </div>
      <div class="subtitle" style="font-size:12.5px;margin-top:10px">Visitors will need username <code>perch</code> + this password to open the site.</div>`;
    $('protectBtn').addEventListener('click', async () => {
      const pw = $('pwInput').value.trim();
      if (pw.length < 4) { alert('Password must be at least 4 characters'); return; }
      $('protectBtn').disabled = true; $('protectBtn').textContent = 'Locking…';
      const r = await fetch(`/api/sites/${id}/protect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
      if (r.ok) load(); else { alert('Could not protect'); $('protectBtn').disabled = false; $('protectBtn').textContent = 'Protect'; }
    });
  }
}

// ── Versions (rollback) ──────────────────────────────────────────
function renderVersions() {
  const el = $('versionsPanel');
  const vs = SITE.versions || [];
  if (!vs.length) {
    el.innerHTML = `<div class="subtitle" style="font-size:13px">No previous versions yet — Perch saves one each time you redeploy, so you can roll back here.</div>`;
    return;
  }
  el.innerHTML = vs.map((v) => `<div class="version-row">
    <span>Saved ${timeAgo(v.at)} <span class="subtitle" style="font-size:12px">(${new Date(v.at).toLocaleString()})</span></span>
    <button class="btn btn-ghost btn-sm" data-restore="${v.id}">Restore</button>
  </div>`).join('');
  el.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Roll back to this version? It replaces the current live version.')) return;
    b.disabled = true; b.textContent = 'Restoring…';
    const r = await fetch(`/api/sites/${id}/rollback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: b.dataset.restore }) });
    if (r.ok) load(); else { alert('Rollback failed'); b.disabled = false; b.textContent = 'Restore'; }
  }));
}

// ── Actions ──────────────────────────────────────────────────────
$('redeployBtn').addEventListener('click', async () => {
  $('redeployBtn').disabled = true; $('redeployBtn').textContent = 'Starting…';
  const r = await fetch(`/api/sites/${id}/deploy`, { method: 'POST' });
  const d = await r.json();
  if (d.deployId) location.href = `/deploy.html?id=${d.deployId}`;
});

$('saveEnvBtn').addEventListener('click', async () => {
  const env = {};
  for (let line of $('envBox').value.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  $('saveEnvBtn').disabled = true;
  const r = await fetch(`/api/sites/${id}/env`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env }) });
  $('saveEnvBtn').disabled = false;
  $('envMsg').textContent = r.ok ? '✓ Saved! Redeploy to apply.' : 'Save failed';
});

$('deleteBtn').addEventListener('click', async () => {
  if (!confirm(`Delete "${SITE.name}"? This removes the site and its files for good.`)) return;
  $('deleteBtn').disabled = true; $('deleteBtn').textContent = 'Deleting…';
  const r = await fetch(`/api/sites/${id}`, { method: 'DELETE' });
  if (r.ok) location.href = '/';
  else { alert('Could not delete'); $('deleteBtn').disabled = false; $('deleteBtn').textContent = 'Delete site'; }
});

// Live refresh of status + uptime + stats, WITHOUT clobbering the editable panels.
async function tick() {
  const r = await fetch('/api/sites');
  if (r.status === 401) { location.href = '/login.html'; return; }
  const fresh = (await r.json()).find((s) => s.id === id);
  if (!fresh) return;
  SITE = fresh;
  renderHeader();
  renderUptime();
  await refreshStats();
}

load();
setInterval(tick, 10000);
