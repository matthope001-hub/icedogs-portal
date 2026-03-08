// IceDogs Portal — Service Worker
// Caches the app shell for fast loads and basic offline support

const CACHE_NAME = 'icedogs-portal-v1';

// Core files to cache on install
const PRECACHE_URLS = [
  '/icedogs-portal/',
  '/icedogs-portal/index.html',
  '/icedogs-portal/manifest.json',
  '/icedogs-portal/icons/icon-192.png',
  '/icedogs-portal/icons/icon-512.png'
];

// Install: pre-cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: serve from cache first, fall back to network
// Google Apps Script calls always go to network (never cache API calls)
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Always go network-first for Google Apps Script calls
  if (url.includes('script.google.com') || url.includes('googleapis.com')) {
    return; // let browser handle it normally
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses for app shell files
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback — return cached index.html for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/icedogs-portal/index.html');
        }
      });
    })
  );
});
