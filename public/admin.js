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
          <div class="subtitle" style="font-size:12px">${u.sites} sites · limit ${u.limit} · ${bytes(u.storageBytes)} · joined ${ago(u.createdAt)} ago</div>
        </div>
        <div class="adm-actions">
          <button class="btn btn-ghost btn-sm" data-act="limit" data-id="${u.id}">Limit</button>
          <button class="btn btn-ghost btn-sm" data-act="owner" data-id="${u.id}" data-v="${u.admin ? '0' : '1'}">${u.admin ? 'Remove owner' : 'Make owner'}</button>
          <button class="btn btn-ghost btn-sm" data-act="suspend" data-id="${u.id}" data-v="${u.suspended ? '0' : '1'}">${u.suspended ? 'Unsuspend' : 'Suspend'}</button>
          <button class="btn btn-ghost btn-sm" data-act="sites" data-id="${u.id}">Sites</button>
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
    if (act === 'limit') { const v = prompt('Site limit — a number, "unlimited", or "default":'); if (v === null) return; r = await api('POST', `/admin/users/${id}/limit`, { limit: v.trim() }); }
    else if (act === 'owner') { r = await api('POST', `/admin/users/${id}/owner`, { admin: b.dataset.v === '1' }); }
    else if (act === 'suspend') { r = await api('POST', `/admin/users/${id}/suspend`, { suspended: b.dataset.v === '1' }); }
    else if (act === 'resetpw') { const v = prompt('New password for this user (min 6 chars):'); if (!v) return; r = await api('POST', `/admin/users/${id}/reset-password`, { password: v }); if (r.ok) alert('Password reset.'); }
    else if (act === 'tokens') { if (!confirm('Revoke all of this user’s connector tokens?')) return; r = await api('POST', `/admin/users/${id}/revoke-tokens`); if (r.ok) alert('Tokens revoked.'); }
    else if (act === 'sites') { const { sites } = await jget(`/admin/users/${id}/sites`); alert(sites.length ? sites.map((s) => `${s.name} — ${s.url} (${s.status})`).join('\n') : 'No sites.'); return; }
    else if (act === 'delete') { if (!confirm(`Delete ${b.dataset.email} AND all their sites? Cannot be undone.`)) return; r = await api('DELETE', `/admin/users/${id}`); }
    if (r && !r.ok) alert(await err(r));
    loadUsers(); loadStats();
  }

  // ── extras: all sites / activity / bans ──
  function loadExtra() {
    $('ownerExtra').innerHTML = `<div class="adm-tabs">
      <button class="btn btn-ghost btn-sm" data-tab="sites">All sites</button>
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
      body.innerHTML = sites.map((s) => `<div class="adm-row">
        <span>${s.isPreview ? '🌿 ' : ''}<b>${s.name}</b> ${s.locked ? '🔒' : ''} ${s.featured ? '⭐' : ''} <span class="subtitle" style="font-size:12px">${s.owner} · ${s.status}</span></span>
        <span class="adm-actions">
          <button class="btn btn-ghost btn-sm" data-s="redeploy" data-id="${s.id}">Redeploy</button>
          <button class="btn btn-ghost btn-sm" data-s="transfer" data-id="${s.id}">Transfer</button>
          <button class="btn btn-ghost btn-sm" data-s="lock" data-id="${s.id}" data-v="${s.locked ? '0' : '1'}">${s.locked ? 'Unlock' : 'Lock'}</button>
          <button class="btn btn-ghost btn-sm" data-s="feature" data-id="${s.id}" data-v="${s.featured ? '0' : '1'}">${s.featured ? 'Unfeature' : 'Feature'}</button>
          <button class="btn btn-danger btn-sm" data-s="delete" data-id="${s.id}">Delete</button>
        </span></div>`).join('') || '<div class="subtitle">No sites.</div>';
      body.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => siteAction(b)));
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

  window.initOwnerPanel = function () { loadStats(); loadServer(); loadUsers(); loadExtra(); };
})();
