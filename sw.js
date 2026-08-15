/* Task Master — Service Worker (sw.js)
   Cache-first strategy for static assets, network-first for sync and APIs. */

const CACHE_NAME = 'tm-cache-v1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('SW pre-cache warning:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET requests and chrome-extension requests
  if (req.method !== 'GET' || url.protocol.startsWith('chrome-extension')) {
    return;
  }

  // Network-first for Supabase API requests and auth
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(req).catch(() => {
        return new Response(JSON.stringify({ error: 'offline', offline: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Cache-first with network fallback for local static assets and CDNs
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) {
        // Refresh cache in background for app assets
        if (url.origin === location.origin) {
          fetch(req).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(req, networkResponse));
            }
          }).catch(() => {});
        }
        return cachedResponse;
      }

      return fetch(req).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, responseToCache));
        return networkResponse;
      }).catch(() => {
        if (req.headers.get('accept') && req.headers.get('accept').includes('text/html')) {
          return caches.match('./index.html') || caches.match('/');
        }
      });
    })
  );
});
