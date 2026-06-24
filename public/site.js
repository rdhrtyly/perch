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
  renderBadge();
  renderDomain();
  renderHistory();
  renderPreviews();
  renderPrivacy();
  renderShare();
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

// ── Deploy history (persisted) ───────────────────────────────────
async function renderHistory() {
  const el = $('historyPanel');
  if (!el) return;
  const data = await fetch(`/api/sites/${id}/history`).then((r) => (r.ok ? r.json() : { history: [] })).catch(() => ({ history: [] }));
  const items = data.history || [];
  if (!items.length) { el.innerHTML = `<div class="subtitle" style="font-size:13px">No deploys recorded yet.</div>`; return; }
  el.innerHTML = items.map((h) => {
    const ok = h.status === 'live';
    const dur = h.ms != null ? ` · ${(h.ms / 1000).toFixed(1)}s` : '';
    return `<div class="version-row"><span>${ok ? '🟢' : '🔴'} ${ok ? 'Deployed' : 'Failed'} <span class="subtitle" style="font-size:12px">${timeAgo(h.at)}${dur}</span></span><span class="subtitle" style="font-size:12px">${new Date(h.at).toLocaleString()}</span></div>`;
  }).join('');
}

// ── Status badge (embeddable) ────────────────────────────────────
function renderBadge() {
  const el = $('badgePanel');
  if (!el) return;
  const url = `${location.origin}/badge/${id}.svg`;
  const md = `[![Perch status](${url})](${SITE.url})`;
  el.innerHTML = `<div class="row-between" style="gap:14px;flex-wrap:wrap">
      <img src="${url}?t=${Date.now()}" alt="status badge" style="height:20px">
      <span class="subtitle" style="font-size:12.5px">A live status badge — paste it in a README or webpage.</span>
    </div>
    <div class="inline-form" style="margin-top:12px">
      <input class="inline-input" id="badgeMd" readonly value="${md.replace(/"/g, '&quot;')}" style="flex:1" />
      <button class="btn btn-ghost" id="copyBadge">Copy</button>
    </div>`;
  $('copyBadge').addEventListener('click', () => {
    const inp = $('badgeMd'); inp.select();
    const done = () => { $('copyBadge').textContent = 'Copied!'; setTimeout(() => { $('copyBadge').textContent = 'Copy'; }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(inp.value).then(done).catch(() => { document.execCommand('copy'); done(); });
    else { document.execCommand('copy'); done(); }
  });
}

// ── Custom domain wizard ─────────────────────────────────────────
function renderDomain() {
  const el = $('domainPanel');
  if (!el) return;
  if (!SITE.isOwner) { el.innerHTML = `<span class="subtitle" style="font-size:13px">Only the owner can connect a custom domain.</span>`; return; }
  if (SITE.customDomain) {
    el.innerHTML = `<div class="row-between" style="flex-wrap:wrap;gap:10px">
        <div>🌐 <b><a class="domain" href="https://${SITE.customDomain}" target="_blank" rel="noopener">${SITE.customDomain} ↗</a></b></div>
        <div class="adm-actions"><button class="btn btn-ghost btn-sm" id="checkDns">Check DNS</button><button class="btn btn-ghost btn-sm" id="removeDomain">Remove</button></div>
      </div>
      <div id="dnsHelp" class="subtitle" style="font-size:12.5px;margin-top:10px">Point your domain's <b>A record</b> at this server, then click “Check DNS”.</div>`;
    $('checkDns').addEventListener('click', checkDns);
    $('removeDomain').addEventListener('click', async () => { if (!confirm('Disconnect this domain?')) return; await fetch(`/api/sites/${id}/domain`, { method: 'DELETE' }); load(); });
  } else {
    el.innerHTML = `<div class="inline-form">
        <input id="domainInput" class="inline-input" placeholder="yourdomain.com" />
        <button class="btn btn-primary" id="connectDomain">Connect</button>
      </div>
      <div id="domainMsg" class="subtitle" style="font-size:12.5px;margin-top:8px">Already own a domain? Connect it here, or <a class="namelink" href="/#domainsSection">buy one</a>.</div>`;
    $('connectDomain').addEventListener('click', async () => {
      const domain = $('domainInput').value.trim();
      if (!domain) return;
      const r = await fetch(`/api/sites/${id}/domain`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) load(); else $('domainMsg').textContent = d.error || 'Could not connect';
    });
  }
}
async function checkDns() {
  const help = $('dnsHelp');
  help.textContent = 'Checking…';
  const d = await fetch(`/api/sites/${id}/domain/check`).then((r) => r.json()).catch(() => null);
  if (!d) { help.textContent = 'Check failed.'; return; }
  if (d.pointed) help.innerHTML = `✅ <b>Pointed correctly!</b> HTTPS turns on automatically within a minute or two.`;
  else help.innerHTML = `⏳ Not pointed yet. Add an <b>A record</b>: <code>@ → ${d.serverIp || 'your server IP'}</code>. DNS can take a while.${d.ips && d.ips.length ? ` Currently resolves to ${d.ips.join(', ')}.` : ' Not resolving yet.'}`;
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

// ── Preview deploys ──────────────────────────────────────────────
async function renderPreviews() {
  const el = $('previewsPanel');
  if (SITE.isPreview) {
    el.innerHTML = `<span class="subtitle" style="font-size:13px">🌿 This is a preview of branch <code>${SITE.branch}</code>.</span>`;
    return;
  }
  if (!SITE.repo) {
    el.innerHTML = `<span class="subtitle" style="font-size:13px">Previews are for GitHub sites — deploy any branch to a test URL. (Uploaded sites don't have branches.)</span>`;
    return;
  }
  const data = await fetch(`/api/sites/${id}/previews`).then((r) => (r.ok ? r.json() : { previews: [] }));
  const list = (data.previews || []).length
    ? data.previews.map((p) => `<div class="version-row">
        <span>🌿 <b>${p.branch}</b> &nbsp;<a class="domain" href="${p.url}" target="_blank" rel="noopener">${p.domain} ↗</a></span>
        <button class="btn btn-ghost btn-sm" data-delprev="${p.id}">Delete</button>
      </div>`).join('')
    : `<div class="subtitle" style="font-size:13px">No previews yet.</div>`;
  el.innerHTML = `<p class="subtitle" style="font-size:13px;margin-top:0">Test a branch on its own URL before it hits your real site.</p>
    <div class="inline-form">
      <input id="prevBranch" class="inline-input" placeholder="branch name (e.g. new-design)" />
      <button class="btn btn-primary" id="prevBtn">Create preview</button>
    </div>
    <div id="prevMsg" class="subtitle" style="font-size:12.5px;margin-top:8px"></div>
    <div style="margin-top:14px">${list}</div>`;
  $('prevBtn').addEventListener('click', async () => {
    const branch = $('prevBranch').value.trim();
    if (!branch) return;
    $('prevBtn').disabled = true; $('prevBtn').textContent = 'Deploying…';
    const r = await fetch(`/api/sites/${id}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branch }) });
    const d = await r.json();
    if (r.ok && d.deployId) location.href = `/deploy.html?id=${d.deployId}`;
    else { $('prevMsg').textContent = d.error || 'Failed'; $('prevBtn').disabled = false; $('prevBtn').textContent = 'Create preview'; }
  });
  el.querySelectorAll('[data-delprev]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this preview?')) return;
    await fetch(`/api/sites/${b.dataset.delprev}`, { method: 'DELETE' });
    renderPreviews();
  }));
}

// ── Share with a friend ──────────────────────────────────────────
async function renderShare() {
  const el = $('sharePanel');
  // Collaborators (non-owners) can manage but not share/delete.
  if (!SITE.isOwner) {
    document.querySelector('#shareSection h2').textContent = 'Shared';
    el.innerHTML = `<span class="subtitle" style="font-size:13px">👥 This site was shared with you. You can manage it, but only the owner can delete, rename, clone, or change who it's shared with.</span>`;
    ['deleteBtn', 'renameBtn', 'cloneBtn'].forEach((bid) => { const b = $(bid); if (b) b.style.display = 'none'; });
    return;
  }
  const data = await fetch(`/api/sites/${id}/collaborators`).then((r) => (r.ok ? r.json() : { collaborators: [] }));
  const list = (data.collaborators || []).length
    ? data.collaborators.map((c) => `<div class="version-row"><span>${c.email}</span><button class="btn btn-ghost btn-sm" data-unshare="${c.userId}">Remove</button></div>`).join('')
    : `<div class="subtitle" style="font-size:13px">Not shared with anyone yet.</div>`;
  el.innerHTML = `<div class="inline-form">
      <input id="shareEmail" type="email" class="inline-input" placeholder="friend's email" />
      <button class="btn btn-primary" id="shareBtn">Share</button>
    </div>
    <div id="shareMsg" class="subtitle" style="font-size:12.5px;margin-top:8px"></div>
    <div style="margin-top:14px">${list}</div>`;
  $('shareBtn').addEventListener('click', async () => {
    const email = $('shareEmail').value.trim();
    if (!email) return;
    $('shareBtn').disabled = true;
    const r = await fetch(`/api/sites/${id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const d = await r.json();
    $('shareBtn').disabled = false;
    if (r.ok) { $('shareEmail').value = ''; renderShare(); }
    else $('shareMsg').textContent = d.error || 'Could not share';
  });
  el.querySelectorAll('[data-unshare]').forEach((b) => b.addEventListener('click', async () => {
    await fetch(`/api/sites/${id}/unshare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: b.dataset.unshare }) });
    renderShare();
  }));
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

$('renameBtn').addEventListener('click', async () => {
  const name = prompt('New name for this site (the web address stays the same):', SITE.name);
  if (!name || !name.trim()) return;
  const r = await fetch(`/api/sites/${id}/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
  if (r.ok) load(); else { const d = await r.json().catch(() => ({})); alert(d.error || 'Rename failed'); }
});

$('cloneBtn').addEventListener('click', async () => {
  const name = prompt('Name for the copy:', `${SITE.name} copy`);
  if (!name || !name.trim()) return;
  $('cloneBtn').disabled = true; $('cloneBtn').textContent = 'Cloning…';
  const r = await fetch(`/api/sites/${id}/clone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
  const d = await r.json().catch(() => ({}));
  if (r.ok && d.deployId) location.href = `/deploy.html?id=${d.deployId}`;
  else { alert(d.error || 'Clone failed'); $('cloneBtn').disabled = false; $('cloneBtn').textContent = 'Clone'; }
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
