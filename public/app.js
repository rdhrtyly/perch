// app.js — the dashboard. Loads your sites and lets you add/redeploy.

const sitesEl = document.getElementById('sites');
const addForm = document.getElementById('addForm');
const addToggle = document.getElementById('addToggle');
const addCancel = document.getElementById('addCancel');

// Show / hide the "Add site" form.
addToggle.addEventListener('click', () => addForm.classList.toggle('open'));
addCancel.addEventListener('click', () => addForm.classList.remove('open'));

// Turn a timestamp into "3 min ago" style text.
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

function card(site) {
  const open = site.status === 'live'
    ? `<a class="btn btn-ghost" href="${site.url}" target="_blank" rel="noopener">Open ↗</a>`
    : '';
  const logs = site.lastDeployId
    ? `<a class="btn btn-ghost" href="/deploy.html?id=${site.lastDeployId}">Logs</a>`
    : '';

  return `
    <div class="card">
      <div class="info">
        <p class="name">${site.name}</p>
        <a class="domain" href="${site.url}" target="_blank" rel="noopener">${site.domain}</a>
        <div class="meta">${site.repo} · deployed ${timeAgo(site.lastDeployAt)}</div>
      </div>
      ${pill(site.status)}
      <div class="actions">
        ${open}
        ${logs}
        <button class="btn btn-primary" data-deploy="${site.id}">Redeploy</button>
      </div>
    </div>`;
}

async function load() {
  const res = await fetch('/api/sites');
  const sites = await res.json();

  if (!sites.length) {
    sitesEl.innerHTML = `<div class="empty">No sites yet. Click <b>+ Add site</b> to add your first one.</div>`;
    return;
  }
  sitesEl.innerHTML = sites.map(card).join('');

  // Wire up the Redeploy buttons.
  sitesEl.querySelectorAll('[data-deploy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Starting…';
      const id = btn.getAttribute('data-deploy');
      const r = await fetch(`/api/sites/${id}/deploy`, { method: 'POST' });
      const data = await r.json();
      // Jump straight to the live log page.
      if (data.deployId) location.href = `/deploy.html?id=${data.deployId}`;
    });
  });
}

// Add a new site.
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: document.getElementById('name').value.trim(),
    repo: document.getElementById('repo').value.trim(),
    branch: document.getElementById('branch').value.trim() || undefined,
  };
  const r = await fetch('/api/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.ok) {
    addForm.reset();
    addForm.classList.remove('open');
    load();
  } else {
    const err = await r.json();
    alert(err.error || 'Could not add site');
  }
});

load();
// Refresh the list every few seconds so statuses update on their own.
setInterval(load, 4000);
