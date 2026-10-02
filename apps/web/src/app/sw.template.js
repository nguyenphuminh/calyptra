// Calyptra's service worker (§11.6, PWA). The build (vite.config.ts) fills in the three placeholders.
// App shell and proving files are served cache-first from caches named after their versions; a new
// build installs new caches and deletes the old ones when it activates.
const SHELL_CACHE = 'calyptra-shell-__SHELL_VERSION__';
const ARTIFACTS_CACHE = 'calyptra-artifacts-__ARTIFACTS_VERSION__';
const SHELL_FILES = JSON.parse('__SHELL_FILES__');
const SHELL_PATHS = new Set(SHELL_FILES);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith('calyptra-') && name !== SHELL_CACHE && name !== ARTIFACTS_CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/artifacts/')) {
    event.respondWith(cacheFirst(ARTIFACTS_CACHE, request));
  } else if (request.mode === 'navigate') {
    // Hash routing keeps every screen at "/", so every navigation is the cached page.
    event.respondWith(caches.match('/', { cacheName: SHELL_CACHE }).then((hit) => hit ?? fetch(request)));
  } else if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirst(SHELL_CACHE, request));
  }
});
