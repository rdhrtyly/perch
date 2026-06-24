// portfolio.js — a public showcase of one person's live sites (/u/<handle>).

const handle = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
const listEl = document.getElementById('list');

async function load() {
  if (!handle) { fail('No portfolio here.'); return; }
  let data;
  try {
    const r = await fetch('/api/public/portfolio/' + encodeURIComponent(handle));
    if (!r.ok) { fail('No portfolio found for “' + handle + '”.'); return; }
    data = await r.json();
  } catch { fail('Couldn’t load this portfolio.'); return; }

  document.getElementById('title').textContent = '@' + data.handle;
  document.title = '@' + data.handle + ' · Perch';
  const sites = data.sites || [];
  document.getElementById('sub').textContent = sites.length
    ? `${sites.length} live ${sites.length === 1 ? 'project' : 'projects'}`
    : 'No live projects yet.';

  listEl.innerHTML = sites.length
    ? sites.map((s) => `
      <a class="card portfolio-card" href="${s.url}" target="_blank" rel="noopener">
        <div class="info">
          <p class="name">${esc(s.name)}</p>
          <span class="domain">${esc(s.domain)} ↗</span>
        </div>
      </a>`).join('')
    : `<div class="empty">Nothing here yet — check back soon.</div>`;
}

function fail(msg) {
  document.getElementById('title').textContent = 'Not found';
  document.getElementById('sub').textContent = '';
  listEl.innerHTML = `<div class="empty">${msg}</div>`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

load();
