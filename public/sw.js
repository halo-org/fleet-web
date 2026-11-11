self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) => cache.addAll(assets.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'activate-update') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('fleet-shell-') && name !== cacheName)
            .map((name) => caches.delete(name)),
        ),
      ),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
  const asset = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!assets.includes(asset)) return;

  event.respondWith(
    caches.open(cacheName).then(async (cache) => (await cache.match(asset)) || fetch(request)),
  );
});
