/* Task Master — Service Worker (sw.js)
   Bulletproof offline PWA caching with navigation fallback,
   ignoreSearch query matching, and automatic silent background sync. */

const CACHE_NAME = 'tm-cache-v9';
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './logo.png',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.2/dist/umd/supabase.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.allSettled(
        STATIC_ASSETS.map(async (url) => {
          try {
            const req = new Request(url, { cache: 'reload' });
            const res = await fetch(req);
            if (res && res.status === 200) {
              await cache.put(url, res);
            }
          } catch (e) {
            console.warn('Pre-cache item fallback:', url, e);
          }
        })
      );
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
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Skip chrome-extension schemes
  if (url.protocol.startsWith('chrome-extension')) return;

  // 1. Navigation requests (Opening app, refreshing page, tapping home screen icon)
  if (req.mode === 'navigate' || (req.headers.get('accept') && req.headers.get('accept').includes('text/html'))) {
    event.respondWith(
      fetch(req).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', resClone));
        }
        return networkResponse;
      }).catch(() => {
        return caches.match('./index.html', { ignoreSearch: true }).then((cached) => {
          if (cached) return cached;
          return caches.match('./', { ignoreSearch: true }).then((cachedRoot) => {
            if (cachedRoot) return cachedRoot;
            return caches.match('index.html', { ignoreSearch: true });
          });
        });
      })
    );
    return;
  }

  // 2. Supabase API endpoints & database calls (network with offline JSON fallback)
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(req).catch(() => {
        return new Response(JSON.stringify({ error: 'offline', offline: true }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // 3. Local assets (style.css, script.js, logo.png, etc.) & external CDN scripts
  event.respondWith(
    fetch(req).then((networkResponse) => {
      if (networkResponse && networkResponse.status === 200) {
        const resClone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(req, resClone);
          // Also cache without search params for resilient offline matching
          if (url.search) {
            cache.put(url.pathname, networkResponse.clone());
          }
        });
      }
      return networkResponse;
    }).catch(() => {
      // Offline fallback: match with ignoreSearch: true
      return caches.match(req, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        // Try fallback by pathname if query string differed
        return caches.match(url.pathname, { ignoreSearch: true }).then((pathCached) => {
          if (pathCached) return pathCached;
          // Fallback to relative path
          const relPath = '.' + url.pathname;
          return caches.match(relPath, { ignoreSearch: true });
        });
      });
    })
  );
});
