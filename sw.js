// ponytail: cache-first for static HTML, network-first for API
const CACHE = 'ridesa-v1';
const FILES = ['/client','/driver','/admin','/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) {
    // API: network first
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  } else {
    // Static: cache first
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }))
    );
  }
});