// Owl Feed service worker: network-first for the app shell so updates land instantly, cache fallback offline.
const C = 'owlfeed-v4';
const SHELL = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/apple-touch-icon.png', '/socket.io/socket.io.js'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== C) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || (url.pathname.startsWith('/socket.io') && url.pathname !== '/socket.io/socket.io.js')) return;
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)).catch(() => {}); return r; })
    .catch(() => caches.match(e.request).then(m => m || caches.match('/'))));
});
