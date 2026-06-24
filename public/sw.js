// sw.js — a tiny service worker so Perch is installable (PWA) and the
// dashboard shell loads even on a flaky connection. Live data (/api) is
// never cached — it always goes to the network.

const CACHE = 'perch-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/admin.js', '/site.js', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Always fresh: API, badges, login/oauth.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/badge') || url.pathname.startsWith('/oauth')) return;
  // Network-first, fall back to cache (then to the shell for navigations).
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((m) => m || caches.match('/')))
  );
});
