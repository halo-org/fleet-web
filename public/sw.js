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

const fallback = { title: 'Fleet', body: 'An agent finished', navigate: self.registration.scope };

function notification(data) {
  let message;
  try {
    message = data?.json();
  } catch {}
  const content = message?.web_push === 8030 ? message.notification : null;
  if (typeof content?.title !== 'string' || typeof content.navigate !== 'string') return fallback;
  let url;
  try {
    url = new URL(content.navigate, self.registration.scope);
  } catch {
    return fallback;
  }
  if (url.origin !== self.location.origin) return fallback;
  return {
    title: content.title,
    body: typeof content.body === 'string' ? content.body : '',
    tag: typeof content.tag === 'string' ? content.tag : '',
    navigate: url.href,
  };
}

async function windows() {
  return clients.matchAll({ type: 'window', includeUncontrolled: true });
}

// Window client URLs do not follow hash navigation, so ask each visible window.
function showing(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data);
    client.postMessage({ type: 'showing' }, [channel.port2]);
    setTimeout(() => resolve(null), 500);
  });
}

self.addEventListener('push', (event) => {
  const { title, body, tag, navigate } = notification(event.data);
  const { hash } = new URL(navigate);
  event.waitUntil(
    windows().then(async (windows) => {
      const visible = windows.filter((client) => client.visibilityState === 'visible');
      if (hash && (await Promise.all(visible.map(showing))).includes(hash)) return;
      return self.registration.showNotification(title, {
        body,
        tag,
        icon: '/icons/icon-192.png',
        badge: '/icons/monochrome-512.png',
        data: { navigate },
      });
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { navigate } = event.notification.data || {};
  if (!navigate) return;
  const url = new URL(navigate);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    windows().then((windows) => {
      const client = windows.find((client) => client.focused) || windows[0];
      if (!client) return clients.openWindow(url.href);
      client.postMessage({ type: 'navigate', url: url.href });
      return client.focus();
    }),
  );
});
