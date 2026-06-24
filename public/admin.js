// admin.js — the Owner Panel (only loaded/shown for owner accounts).
// app.js calls window.initOwnerPanel() when the logged-in user is an owner.

(function () {
  const $ = (id) => document.getElementById(id);
  function api(method, path, body) {
    return fetch('/api' + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  async function jget(path) { return (await api('GET', path)).json(); }
  function bytes(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
  function ago(ms) { const s = Math.floor((Date.now() - ms) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; }
  async function err(r) { try { return (await r.json()).error; } catch { return 'failed'; } }

  // ── stats ──
  async function loadStats() {
    const s = await jget('/admin/stats');
    $('ownerStats').textContent = `${s.users} users · ${s.sites} sites`;
  }

  // ── server health + control ──
  function meter(label, pct, detail) {
    const color = pct == null ? 'var(--faint)' : pct >= 90 ? 'var(--failed)' : pct >= 75 ? 'var(--building)' : 'var(--live)';
    return `<div class="meter-row">
      <span class="meter-label"><b>${label}</b></span>
      <span class="meter"><span class="meter-fill" style="width:${pct == null ? 0 : pct}%;background:${color}"></span></span>
      <span class="subtitle meter-detail">${detail}</span></div>`;
  }
  async function loadHealth() {
    $('ownerHealth').innerHTML = '<div class="adm-title">Server health</div><div class="subtitle">Checking…</div>';
    let h;
    try { h = await jget('/admin/health'); }
    catch { $('ownerHealth').innerHTML = '<div class="adm-title">Server health</div><div class="subtitle">Could not load.</div>'; return; }
    const m = Math.floor(h.uptimeSeconds / 60);
    const up = m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    $('ownerHealth').innerHTML = `
      <div class="adm-title">Server health <button class="btn btn-ghost btn-sm" id="healthRefresh" style="float:right">↻ Refresh</button></div>
      ${meter('Memory', h.mem.pct, `${bytes(h.mem.used)} / ${bytes(h.mem.total)}`)}
      ${h.disk ? meter('Disk', h.disk.pct, `${bytes(h.disk.used)} / ${bytes(h.disk.total)}`) : meter('Disk', null, 'unavailable here')}
      <div class="subtitle" style="font-size:12.5px;margin-top:8px">${h.sites} sites · ${h.previews} previews · ${bytes(h.storageBytes)} served · ${h.containers == null ? '?' : h.containers} containers · load ${h.loadAvg == null ? '?' : h.loadAvg} · up ${up}</div>
      <div class="adm-actions" style="margin-top:12px">
        <button class="btn btn-ghost btn-sm" id="restartCaddy">Restart Caddy</button>
        <button class="btn btn-danger btn-sm" id="restartPerch">Restart Perch</button>
      </div>`;
    $('healthRefresh').addEventListener('click', loadHealth);
    $('restartCaddy').addEventListener('click', async () => {
      if (!confirm('Restart Caddy (the web server + HTTPS)? Sites blink for a second.')) return;
      const r = await api('POST', '/admin/restart', { target: 'caddy' });
      alert(r.ok ? 'Caddy restarted.' : await err(r));
    });
    $('restartPerch').addEventListener('click', async () => {
      if (!confirm('Restart Perch itself? The dashboard disconnects for a few seconds, then comes back.')) return;
      await api('POST', '/admin/restart', { target: 'perch' });
      alert('Perch is restarting — give it a few seconds, then refresh this page.');
    });
  }

  // ── owner charts (signups + deploys) ──
  function barChart(title, days, key) {
    const max = Math.max(1, ...days.map((d) => d[key]));
    return `<div class="chart-card" style="margin-top:0">
      <div class="chart-title">${title}</div>
      <div class="chart">${days.map((d) => `<div class="bar" title="${d.label}: ${d[key]}">
        <div class="bar-fill" style="height:${Math.round((d[key] / max) * 100)}%"></div>
        <div class="bar-x">${d.label.split('/')[1]}</div></div>`).join('')}</div></div>`;
  }
  async function loadCharts() {
    let c;
    try { c = await jget('/admin/charts'); } catch { return; }
    $('ownerCharts').innerHTML = `<div class="adm-title">Last 14 days</div>
      <div class="chart-grid">${barChart('New signups', c.days, 'signups')}${barChart('Deploys', c.days, 'deploys')}</div>`;
  }

  // ── server settings ──
  async function loadServer() {
    const s = await jget('/admin/settings');
    $('ownerServer').innerHTML = `
      <div class="adm-title">Server</div>
      <div class="adm-row"><b>New signups</b>
        <button class="btn ${s.signupsOpen ? 'btn-ghost' : 'btn-primary'} btn-sm" data-toggle="signupsOpen">${s.signupsOpen ? 'Open ✓ — click to close' : 'Closed — click to open'}</button></div>
      <div class="adm-row"><b>Maintenance mode</b>
        <button class="btn ${s.maintenance ? 'btn-danger' : 'btn-ghost'} btn-sm" data-toggle="maintenance">${s.maintenance ? 'ON — site paused' : 'Off'}</button></div>
      <div class="adm-row"><b>Default site limit</b> <span class="subtitle">${s.defaultLimit == null ? '(.env default)' : s.defaultLimit}</span>
        <button class="btn btn-ghost btn-sm" id="admDefault">Change</button></div>
      <div class="adm-row"><b>Default storage</b> <span class="subtitle">${s.defaultStorageMb == null ? '(.env default)' : (s.defaultStorageMb === 0 ? 'unlimited' : s.defaultStorageMb + ' MB')}</span>
        <button class="btn btn-ghost btn-sm" id="admStorage">Change</button></div>
      <div class="adm-row"><b>Announcement</b> <span class="subtitle">${s.announcement ? '“' + s.announcement + '”' : '(none)'}</span>
        <button class="btn btn-ghost btn-sm" id="admAnnounce">Set</button></div>`;
    $('ownerServer').querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      await api('POST', '/admin/settings', { [b.dataset.toggle]: !s[b.dataset.toggle] }); loadServer();
    }));
    $('admDefault').addEventListener('click', async () => {
      const v = prompt('Default site limit for everyone (a number, or blank for the .env default):', s.defaultLimit == null ? '' : s.defaultLimit);
      if (v === null) return;
      await api('POST', '/admin/settings', { defaultLimit: v.trim() === '' ? null : Number(v) }); loadServer();
    });
    $('admStorage').addEventListener('click', async () => {
      const v = prompt('Default storage per user in MB (a number, 0 = unlimited, blank = .env default):', s.defaultStorageMb == null ? '' : s.defaultStorageMb);
      if (v === null) return;
      await api('POST', '/admin/settings', { defaultStorageMb: v.trim() === '' ? null : Number(v) }); loadServer();
    });
    $('admAnnounce').addEventListener('click', async () => {
      const v = prompt('Announcement banner shown to everyone (blank to clear):', s.announcement || '');
      if (v === null) return;
      await api('POST', '/admin/settings', { announcement: v }); loadServer();
    });
  }

  // ── people ──
  async function loadUsers() {
    const { users } = await jget('/admin/users');
    $('ownerUsers').innerHTML = `<div class="adm-title">People (${users.length})</div>` + users.map((u) => `
      <div class="adm-user">
        <div class="adm-uinfo">
          <b>${u.email}</b> ${u.admin ? '<span class="badge">owner</span>' : ''} ${u.suspended ? '<span class="badge" style="color:var(--failed)">suspended</span>' : ''}
          <div class="subtitle" style="font-size:12px">${u.sites} sites · limit ${u.limit} · ${bytes(u.storageBytes)} / ${u.storageCap === 'unlimited' ? '∞' : u.storageCap + ' MB'} · joined ${ago(u.createdAt)} ago</div>
        </div>
        <div class="adm-actions">
          <button class="btn btn-ghost btn-sm" data-act="view" data-id="${u.id}">View</button>
          <button class="btn btn-ghost btn-sm" data-act="limit" data-id="${u.id}">Limit</button>
          <button class="btn btn-ghost btn-sm" data-act="storage" data-id="${u.id}">Storage</button>
          <button class="btn btn-ghost btn-sm" data-act="owner" data-id="${u.id}" data-v="${u.admin ? '0' : '1'}">${u.admin ? 'Remove owner' : 'Make owner'}</button>
          <button class="btn btn-ghost btn-sm" data-act="suspend" data-id="${u.id}" data-v="${u.suspended ? '0' : '1'}">${u.suspended ? 'Unsuspend' : 'Suspend'}</button>
          <button class="btn btn-ghost btn-sm" data-act="resetpw" data-id="${u.id}">Reset PW</button>
          <button class="btn btn-ghost btn-sm" data-act="tokens" data-id="${u.id}">Revoke tokens</button>
          <button class="btn btn-danger btn-sm" data-act="delete" data-id="${u.id}" data-email="${u.email}">Delete</button>
        </div>
      </div>`).join('');
    $('ownerUsers').querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => userAction(b)));
  }

  async function userAction(b) {
    const id = b.dataset.id, act = b.dataset.act;
    let r;
    if (act === 'view') { await toggleUserDetail(b); return; }
    else if (act === 'limit') { const v = prompt('Site limit — a number, "unlimited", or "default":'); if (v === null) return; r = await api('POST', `/admin/users/${id}/limit`, { limit: v.trim() }); }
    else if (act === 'storage') { const v = prompt('Storage cap in MB — a number, "unlimited", or "default":'); if (v === null) return; r = await api('POST', `/admin/users/${id}/storage`, { mb: v.trim() }); if (r && !r.ok) { alert(await err(r)); return; } }
    else if (act === 'owner') { r = await api('POST', `/admin/users/${id}/owner`, { admin: b.dataset.v === '1' }); }
    else if (act === 'suspend') { r = await api('POST', `/admin/users/${id}/suspend`, { suspended: b.dataset.v === '1' }); }
    else if (act === 'resetpw') { const v = prompt('New password for this user (min 6 chars):'); if (!v) return; r = await api('POST', `/admin/users/${id}/reset-password`, { password: v }); if (r.ok) alert('Password reset.'); }
    else if (act === 'tokens') { if (!confirm('Revoke all of this user’s connector tokens?')) return; r = await api('POST', `/admin/users/${id}/revoke-tokens`); if (r.ok) alert('Tokens revoked.'); }
    else if (act === 'delete') { if (!confirm(`Delete ${b.dataset.email} AND all their sites? Cannot be undone.`)) return; r = await api('DELETE', `/admin/users/${id}`); }
    if (r && !r.ok) alert(await err(r));
    loadUsers(); loadStats();
  }

  // View-as-user: expand/collapse a read-only overview under the user row.
  async function toggleUserDetail(b) {
    const host = b.closest('.adm-user');
    const next = host.nextElementSibling;
    if (next && next.classList.contains('adm-detail')) { next.remove(); return; }
    const o = await jget(`/admin/users/${b.dataset.id}/overview`);
    const div = document.createElement('div');
    div.className = 'adm-detail';
    div.innerHTML = `<div class="subtitle" style="margin-bottom:8px">${o.user.sites} sites · ${bytes(o.user.storageBytes)} used / ${o.user.storageCap === 'unlimited' ? '∞' : o.user.storageCap + ' MB'} · ${o.tokens} connector token(s)</div>`
      + (o.sites.map((s) => `<div class="adm-row">
          <span><b>${s.name}</b> <span class="subtitle" style="font-size:12px">${s.status} · ${s.up === true ? '🟢 up' : s.up === false ? '🔴 down' : '— '} · ${s.views} views · ${bytes(s.storageBytes)}</span></span>
          <a class="btn btn-ghost btn-sm" href="${s.url}" target="_blank" rel="noopener">Open</a></div>`).join('')
        || '<div class="subtitle">No sites.</div>');
    host.after(div);
  }

  // ── extras: all sites / activity / bans ──
  function loadExtra() {
    $('ownerExtra').innerHTML = `<div class="adm-tabs">
      <button class="btn btn-ghost btn-sm" data-tab="sites">All sites</button>
      <button class="btn btn-ghost btn-sm" data-tab="containers">Containers</button>
      <button class="btn btn-ghost btn-sm" data-tab="broadcast">Broadcast</button>
      <button class="btn btn-ghost btn-sm" data-tab="activity">Activity</button>
      <button class="btn btn-ghost btn-sm" data-tab="bans">Banned emails</button>
    </div><div id="admTabBody" style="margin-top:12px"></div>`;
    $('ownerExtra').querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    showTab('sites');
  }

  async function showTab(tab) {
    const body = $('admTabBody');
    if (tab === 'sites') {
      const { sites } = await jget('/admin/sites');
      body.innerHTML = `<div class="adm-bulk" id="bulkBar" style="display:none">
          <span class="subtitle" id="bulkCount"></span>
          <button class="btn btn-ghost btn-sm" data-bulk="redeploy">Redeploy selected</button>
          <button class="btn btn-danger btn-sm" data-bulk="delete">Delete selected</button>
        </div>`
        + (sites.map((s) => `<div class="adm-row">
        <span><input type="checkbox" class="bulk-cb" data-id="${s.id}">${s.isPreview ? '🌿 ' : ''}<b>${s.name}</b> ${s.locked ? '🔒' : ''} ${s.featured ? '⭐' : ''} <span class="subtitle" style="font-size:12px">${s.owner} · ${s.status}</span></span>
        <span class="adm-actions">
          <button class="btn btn-ghost btn-sm" data-s="redeploy" data-id="${s.id}">Redeploy</button>
          <button class="btn btn-ghost btn-sm" data-s="transfer" data-id="${s.id}">Transfer</button>
          <button class="btn btn-ghost btn-sm" data-s="lock" data-id="${s.id}" data-v="${s.locked ? '0' : '1'}">${s.locked ? 'Unlock' : 'Lock'}</button>
          <button class="btn btn-ghost btn-sm" data-s="feature" data-id="${s.id}" data-v="${s.featured ? '0' : '1'}">${s.featured ? 'Unfeature' : 'Feature'}</button>
          <button class="btn btn-danger btn-sm" data-s="delete" data-id="${s.id}">Delete</button>
        </span></div>`).join('') || '<div class="subtitle">No sites.</div>');
      body.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => siteAction(b)));
      // Bulk select + actions.
      const selected = () => Array.from(body.querySelectorAll('.bulk-cb:checked')).map((c) => c.dataset.id);
      const bar = $('bulkBar');
      body.querySelectorAll('.bulk-cb').forEach((c) => c.addEventListener('change', () => {
        const n = selected().length;
        bar.style.display = n ? 'flex' : 'none';
        if (n) $('bulkCount').textContent = `${n} selected`;
      }));
      body.querySelectorAll('[data-bulk]').forEach((btn) => btn.addEventListener('click', async () => {
        const ids = selected(); if (!ids.length) return;
        const action = btn.dataset.bulk;
        if (!confirm(`${action === 'delete' ? 'Delete' : 'Redeploy'} ${ids.length} site${ids.length === 1 ? '' : 's'}?${action === 'delete' ? ' Cannot be undone.' : ''}`)) return;
        const r = await api('POST', '/admin/sites/bulk', { action, ids });
        if (r.ok) { const j = await r.json(); alert(`${action === 'delete' ? 'Deleted' : 'Redeploying'} ${j.done}${j.skipped ? `, skipped ${j.skipped}` : ''}.`); }
        else alert(await err(r));
        showTab('sites');
      }));
    } else if (tab === 'containers') {
      const { apps, caddyRunning } = await jget('/admin/containers');
      const dot = (on) => `<span class="badge" style="color:${on ? 'var(--live)' : 'var(--failed)'}">${on ? 'running' : 'stopped'}</span>`;
      body.innerHTML = `<div class="adm-row"><span>🧱 <b>Caddy</b> <span class="subtitle" style="font-size:12px">web server + HTTPS</span></span>${dot(caddyRunning)}</div>`
        + (apps.map((a) => `<div class="adm-row">
            <span><b>${a.name}</b> <span class="subtitle" style="font-size:12px">Next.js · port ${a.port || '?'}</span></span>
            <span class="adm-actions">${dot(a.running)}<button class="btn btn-ghost btn-sm" data-restart="${a.id}">Restart</button></span></div>`).join('')
          || '<div class="subtitle" style="margin-top:10px">No Next.js apps running. (Static sites don’t use a container.)</div>');
      body.querySelectorAll('[data-restart]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Restart this app’s container?')) return;
        const r = await api('POST', `/admin/sites/${b.dataset.restart}/restart`);
        alert(r.ok ? 'Restarted.' : await err(r)); showTab('containers');
      }));
    } else if (tab === 'broadcast') {
      body.innerHTML = `<div class="subtitle" style="margin-bottom:8px">Send a note to every user's 🔔 bell.</div>
        <textarea id="bcMsg" class="adm-textarea" rows="2" maxlength="280" placeholder="e.g. Heads up — quick maintenance tonight at 8pm"></textarea>
        <div style="margin-top:8px"><button class="btn btn-primary btn-sm" id="bcSend">Send to everyone</button></div>`;
      $('bcSend').addEventListener('click', async () => {
        const message = $('bcMsg').value.trim();
        if (!message) return;
        const r = await api('POST', '/admin/broadcast', { message });
        if (r.ok) { const j = await r.json(); alert(`Sent to ${j.sent} ${j.sent === 1 ? 'user' : 'users'}.`); $('bcMsg').value = ''; }
        else alert(await err(r));
      });
    } else if (tab === 'activity') {
      const { activity } = await jget('/admin/activity');
      body.innerHTML = activity.map((a) => `<div class="adm-row"><span>${a.message}</span><span class="subtitle" style="font-size:12px">${ago(a.t)} ago</span></div>`).join('') || '<div class="subtitle">Nothing yet.</div>';
    } else if (tab === 'bans') {
      const { bannedEmails } = await jget('/admin/bans');
      body.innerHTML = `<button class="btn btn-primary btn-sm" id="admBan">Ban an email</button>` +
        (bannedEmails.map((e) => `<div class="adm-row"><span>🚫 ${e}</span><button class="btn btn-ghost btn-sm" data-unban="${e}">Unban</button></div>`).join('') || '<div class="subtitle" style="margin-top:10px">No bans.</div>');
      $('admBan').addEventListener('click', async () => { const e = prompt('Email to ban from signing up:'); if (!e) return; await api('POST', '/admin/ban', { email: e }); showTab('bans'); });
      body.querySelectorAll('[data-unban]').forEach((b) => b.addEventListener('click', async () => { await api('POST', '/admin/unban', { email: b.dataset.unban }); showTab('bans'); }));
    }
  }

  async function siteAction(b) {
    const id = b.dataset.id, act = b.dataset.s;
    let r;
    if (act === 'redeploy') { r = await api('POST', `/admin/sites/${id}/redeploy`); if (r.ok) alert('Redeploying.'); }
    else if (act === 'transfer') { const e = prompt('Transfer to which user? (their email)'); if (!e) return; r = await api('POST', `/admin/sites/${id}/transfer`, { email: e }); }
    else if (act === 'lock') { r = await api('POST', `/admin/sites/${id}/lock`, { locked: b.dataset.v === '1' }); }
    else if (act === 'feature') { r = await api('POST', `/admin/sites/${id}/feature`, { featured: b.dataset.v === '1' }); }
    else if (act === 'delete') { if (!confirm('Delete this site for good?')) return; r = await api('DELETE', `/admin/sites/${id}`); }
    if (r && !r.ok) alert(await err(r));
    showTab('sites');
  }

  window.initOwnerPanel = function () { loadStats(); loadHealth(); loadCharts(); loadServer(); loadUsers(); loadExtra(); };
})();
