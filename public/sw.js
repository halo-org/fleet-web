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

const agentHash = (agent) => `#agent/${agent}`;

async function agentWindows() {
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
  let message;
  try {
    message = event.data?.json();
  } catch {
    return;
  }
  if (message?.kind !== 'turn_completed' || !/^\d{1,39}$/.test(message.agent)) return;
  event.waitUntil(
    agentWindows().then(async (windows) => {
      const visible = windows.filter((client) => client.visibilityState === 'visible');
      const hashes = await Promise.all(visible.map(showing));
      if (hashes.includes(agentHash(message.agent))) return;
      return self.registration.showNotification(
        message.title || `${message.role} · ${message.agent.slice(-6)}`,
        {
          body: 'Finished',
          tag: `agent-${message.agent}`,
          icon: '/icons/icon-192.png',
          badge: '/icons/monochrome-512.png',
          data: { agent: message.agent },
        },
      );
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { agent } = event.notification.data || {};
  if (!agent) return;
  event.waitUntil(
    agentWindows().then((windows) => {
      const client = windows.find((client) => client.focused) || windows[0];
      if (!client) return clients.openWindow(`/${agentHash(agent)}`);
      client.postMessage({ type: 'open-agent', agent });
      return client.focus();
    }),
  );
});
