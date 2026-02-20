// MW Project - Service Worker (safe for Firebase)
// NOTE: Cache only GET requests for static assets. Never cache POST (Firebase uses POST).
const CACHE_NAME = 'mw-project-static-v2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './firebase.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve()))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Never touch non-GET requests (prevents "Request method 'POST' is unsupported")
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Do not cache Firebase/Google API domains
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('firebase') || url.hostname.includes('gstatic.com')) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // Cache only successful, basic responses
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
