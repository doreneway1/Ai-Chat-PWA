// __PRECACHE_INJECT__
const CACHE_NAME = 'dorenewai-shell-__CACHE_VERSION__';
const RUNTIME_CACHE_NAME = 'dorenewai-runtime-v1';
const MAX_RUNTIME_ENTRIES = 60;
const FALLBACK_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg'
];
// Bila sw.js disajikan langsung dari source (bukan hasil build), plugin tidak
// menyuntikkan PRECACHE_ASSETS sehingga fallback dipakai.
const APP_SHELL = typeof PRECACHE_ASSETS !== 'undefined' ? PRECACHE_ASSETS : FALLBACK_SHELL;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME && key !== RUNTIME_CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

async function trimRuntimeCache(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_RUNTIME_ENTRIES) {
    await Promise.all(
      keys.slice(0, keys.length - MAX_RUNTIME_ENTRIES).map(key => cache.delete(key))
    );
  }
}

self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          return caches.open(RUNTIME_CACHE_NAME)
            .then(cache => cache.put(event.request, response.clone()).then(() => trimRuntimeCache(cache)))
            .then(() => response);
        }
        return response;
      }).catch(error => {
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html').then(cachedPage => cachedPage || Promise.reject(error));
        }
        throw error;
      });
    })
  );
});
