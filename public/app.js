// app.js — the Perch dashboard.

const sitesEl = document.getElementById('sites');
const addForm = document.getElementById('addForm');
const addCancel = document.getElementById('addCancel');
const toggleGithub = document.getElementById('toggleGithub');

const dropzone = document.getElementById('dropzone');
const folderInput = document.getElementById('folderInput');
const chooseFolder = document.getElementById('chooseFolder');
const uploadName = document.getElementById('uploadName');

const domainsSection = document.getElementById('domainsSection');
const domainsBody = document.getElementById('domainsBody');

let SITES = [];

// ── helpers ───────────────────────────────────────────────────────
function timeAgo(ms) {
  if (!ms) return 'never';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function pill(status) {
  const label = { live: 'Live', building: 'Building', failed: 'Failed', new: 'Not deployed' }[status] || status;
  return `<span class="pill ${status}"><span class="dot"></span>${label}</span>`;
}

// ── sites list ────────────────────────────────────────────────────
function card(site) {
  const open = site.status === 'live'
    ? `<a class="btn btn-ghost btn-sm" href="${site.url}" target="_blank" rel="noopener">Open ↗</a>` : '';
  const logs = site.lastDeployId
    ? `<a class="btn btn-ghost btn-sm" href="/deploy.html?id=${site.lastDeployId}">Logs</a>` : '';
  const badge = site.source === 'upload' ? `<span class="badge">uploaded</span>`
    : (site.repo ? `<span class="badge">github</span>` : '');
  const sub = site.repo ? site.repo : 'uploaded files';
  return `
    <div class="card">
      <div class="info">
        <p class="name">${site.name} ${badge}</p>
        <a class="domain" href="${site.url}" target="_blank" rel="noopener">${site.domain}</a>
        <div class="meta">${sub} · deployed ${timeAgo(site.lastDeployAt)}</div>
      </div>
      ${pill(site.status)}
      <div class="actions">${open}${logs}
        <button class="btn btn-primary btn-sm" data-deploy="${site.id}">Redeploy</button>
      </div>
    </div>`;
}

async function loadSites() {
  SITES = await fetch('/api/sites').then(r => r.json());
  sitesEl.innerHTML = SITES.length
    ? SITES.map(card).join('')
    : `<div class="empty">No sites yet — drag a folder up top to deploy your first one. 🚀</div>`;
  sitesEl.querySelectorAll('[data-deploy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Starting…';
      const r = await fetch(`/api/sites/${btn.dataset.deploy}/deploy`, { method: 'POST' });
      const d = await r.json();
      if (d.deployId) location.href = `/deploy.html?id=${d.deployId}`;
    });
  });
}

// ── upload (the Vercel-style flow) ────────────────────────────────
chooseFolder.addEventListener('click', () => folderInput.click());

folderInput.addEventListener('change', () => {
  const files = [...folderInput.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
  doUpload(files);
});

// Drag + drop a folder
['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); if (ev !== 'dragover') dropzone.classList.remove('drag'); }));
// stop the browser from opening files dropped elsewhere
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

dropzone.addEventListener('drop', async (e) => {
  const files = await collectDropped(e.dataTransfer);
  doUpload(files);
});

// Read a dropped folder (with all its subfolders) into a flat list.
async function collectDropped(dt) {
  const out = [];
  const entries = [...(dt.items || [])]
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (entries.length) {
    for (const entry of entries) await walk(entry, '', out);
  } else {
    for (const f of dt.files) out.push({ file: f, path: f.name });
  }
  return out;
}
function walk(entry, prefix, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => { out.push({ file, path: prefix + entry.name }); resolve(); });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const read = () => reader.readEntries(async (batch) => {
        if (!batch.length) { for (const e of all) await walk(e, prefix + entry.name + '/', out); resolve(); }
        else { all.push(...batch); read(); }
      });
      read();
    } else resolve();
  });
}

async function doUpload(files) {
  if (!files.length) return;
  let name = uploadName.value.trim();
  if (!name) { const p = files[0].path; name = p.includes('/') ? p.split('/')[0] : 'site'; }

  dropzone.classList.add('drag');
  dropzone.querySelector('.big').textContent = `Uploading ${files.length} files…`;

  const fd = new FormData();
  fd.append('name', name);
  for (const { file, path } of files) fd.append('files', file, path);

  try {
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await r.json();
    if (r.ok && data.deployId) location.href = `/deploy.html?id=${data.deployId}`;
    else { alert(data.error || 'Upload failed'); resetDrop(); }
  } catch (e) { alert('Upload failed: ' + e.message); resetDrop(); }
}
function resetDrop() {
  dropzone.classList.remove('drag');
  dropzone.querySelector('.big').textContent = "Drag your site's folder here";
}

// ── add from GitHub ───────────────────────────────────────────────
toggleGithub.addEventListener('click', () => addForm.classList.toggle('open'));
addCancel.addEventListener('click', () => addForm.classList.remove('open'));
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: document.getElementById('name').value.trim(),
    repo: document.getElementById('repo').value.trim(),
    branch: document.getElementById('branch').value.trim() || undefined,
  };
  const r = await fetch('/api/sites', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.ok) { addForm.reset(); addForm.classList.remove('open'); loadSites(); }
  else { const err = await r.json(); alert(err.error || 'Could not add site'); }
});

// ── domains (Phase 2 — Porkbun) ───────────────────────────────────
async function initDomains() {
  const s = await fetch('/api/domains/status').then(r => r.json()).catch(() => ({ enabled: false }));
  domainsSection.style.display = '';
  if (!s.enabled) {
    domainsBody.innerHTML =
      `<div class="panel off">🔌 Domain-buying is off. Add your <b>Porkbun</b> API keys to <code>.env</code> and restart Perch to turn this on.</div>`;
    return;
  }
  domainsBody.innerHTML = `
    <div class="panel">
      <div class="domain-search">
        <input id="domainInput" placeholder="type a domain, e.g. mycoolsite.com" />
        <button class="btn btn-primary" id="checkBtn">Check</button>
      </div>
      <div class="domain-result" id="domainResult"></div>
    </div>`;
  const input = document.getElementById('domainInput');
  const checkBtn = document.getElementById('checkBtn');
  const result = document.getElementById('domainResult');

  async function check() {
    const domain = input.value.trim().toLowerCase();
    if (!domain.includes('.')) { alert('Type a full domain like mycoolsite.com'); return; }
    checkBtn.disabled = true; checkBtn.textContent = 'Checking…';
    try {
      const d = await fetch('/api/domains/check?domain=' + encodeURIComponent(domain)).then(r => r.json());
      if (d.error) { result.innerHTML = `<div class="row"><span class="avail-no">${d.error}</span></div>`; }
      else renderResult(d, result);
    } finally { checkBtn.disabled = false; checkBtn.textContent = 'Check'; result.classList.add('show'); }
  }
  checkBtn.addEventListener('click', check);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
}

function renderResult(d, el) {
  if (!d.available) {
    el.innerHTML = `<div class="row"><span class="name">${d.domain}</span><span class="avail-no">already taken</span></div>`;
    return;
  }
  const siteOpts = SITES.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  el.innerHTML = `
    <div class="row">
      <span class="name">${d.domain}</span>
      <span><span class="avail-yes">available</span> <span class="price">· $${d.price}/yr</span></span>
    </div>
    <div class="buy-controls">
      <label class="checkline">Connect to:
        <select id="buySite"><option value="">(none yet)</option>${siteOpts}</select>
      </label>
      <label class="checkline"><input type="checkbox" id="dryRun" checked /> Test only (don't spend money)</label>
      <button class="btn btn-primary" id="buyBtn">Buy & connect</button>
    </div>
    <div id="buyMsg" class="meta" style="margin-top:10px"></div>`;
  document.getElementById('buyBtn').addEventListener('click', () => buy(d.domain));
}

async function buy(domain) {
  const dryRun = document.getElementById('dryRun').checked;
  const siteId = document.getElementById('buySite').value || undefined;
  const msg = document.getElementById('buyMsg');
  const btn = document.getElementById('buyBtn');
  if (!dryRun && !confirm(`Really buy ${domain}? This spends real money.`)) return;
  btn.disabled = true; btn.textContent = dryRun ? 'Testing…' : 'Buying…';
  try {
    const r = await fetch('/api/domains/buy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, siteId, dryRun }),
    });
    const d = await r.json();
    if (!r.ok) { msg.innerHTML = `<span class="avail-no">${d.error}</span>`; }
    else if (dryRun) { msg.innerHTML = `✅ Test passed — buying this for real would work ($${d.price}/yr).`; }
    else { msg.innerHTML = `🎉 Bought ${domain}! Pointing it here now — give DNS a few minutes.`; loadSites(); }
  } catch (e) { msg.innerHTML = `<span class="avail-no">${e.message}</span>`; }
  finally { btn.disabled = false; btn.textContent = 'Buy & connect'; }
}

// ── boot ──────────────────────────────────────────────────────────
loadSites();
initDomains();
setInterval(loadSites, 5000);
