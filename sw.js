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
// record alerts
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Ronin Hop', { body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: 'ronin-record', renotify: true, data: { url: d.url || './' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(cs => { for (const c of cs) if ('focus' in c) return c.focus(); return self.clients.openWindow(e.notification.data && e.notification.data.url || './'); }));
});
