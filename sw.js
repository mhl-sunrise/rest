const CACHE_NAME = 'restclient-shell-v1';
const ASSETS = [
  '/',                // ensure your server serves index.html at '/'
  '/index.html',      // optional if your file is index.html
  '/manifest.json',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/sw.js'
  // add any other static asset URLs here (external scripts, css files, etc.)
];

// Install: pre-cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k !== CACHE_NAME) ? caches.delete(k) : null))
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for GET requests, network fallback, return offline page for navigation
self.addEventListener('fetch', (event) => {
  // only handle GET
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);

  // For navigation requests (SPA style), return cached index.html or offline fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(res => {
        // update cache in background
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => { cache.put('/', copy); });
        return res;
      }).catch(() => {
        return caches.match('/')  // index
          .then(resp => resp || caches.match('/offline.html'));
      })
    );
    return;
  }

  // For other requests: try cache first, then network, then offline fallback
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // update cache asynchronously
        fetch(event.request).then(resp => {
          if (resp && resp.ok) caches.open(CACHE_NAME).then(c => c.put(event.request, resp.clone()));
        }).catch(()=>{});
        return cached;
      }
      return fetch(event.request).then(networkResp => {
        // put in cache for future
        if (networkResp && networkResp.ok) {
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, networkResp.clone()));
        }
        return networkResp;
      }).catch(() => {
        // for images etc you might return a placeholder, otherwise fall back to offline page
        return caches.match('/offline.html');
      });
    })
  );
});