// Ronin Hop offline cache. Network first, so players always get the newest game when they are online.
const C = 'ronin-v1';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(['./','three.min.js','icon-192.png'])).catch(() => {})); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  if (new URL(r.url).origin !== location.origin) return;            // contest server and counter always go straight to the network
  const key = r.mode === 'navigate' ? './' : r;
  e.respondWith(fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(C).then(c => c.put(key, cp)); } return res; })
    .catch(() => caches.match(key, { ignoreSearch:true }).then(m => m || Response.error())));
});
