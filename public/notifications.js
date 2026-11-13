import { newId, request } from './api.js';

const deviceKey = 'fleet.notification-device';
const syncInterval = 60 * 60_000;

const notes = {
  install: 'Add Fleet to your Home Screen to get notifications.',
  blocked: 'Notifications are blocked. Allow them for this site in your browser settings.',
};

export function notificationState({ supported, apple, installed, permission, subscribed }) {
  if (!supported) return apple && !installed ? 'install' : 'unsupported';
  if (permission === 'denied') return 'blocked';
  return permission === 'granted' && subscribed ? 'on' : 'off';
}

export function deviceLabel(userAgent) {
  const browsers = [
    ['Edg', 'Edge'],
    ['CriOS', 'Chrome'],
    ['FxiOS', 'Firefox'],
    ['Firefox/', 'Firefox'],
    ['Chrome/', 'Chrome'],
    ['Safari/', 'Safari'],
  ];
  const platforms = [
    ['iPhone', 'iPhone'],
    ['iPad', 'iPad'],
    ['Android', 'Android'],
    ['CrOS', 'ChromeOS'],
    ['Mac OS X', 'macOS'],
    ['Windows', 'Windows'],
    ['Linux', 'Linux'],
  ];
  const find = (names) => names.find(([token]) => userAgent.includes(token))?.[1];
  const browser = find(browsers) || 'Browser';
  const platform = find(platforms);
  return platform ? `${browser} on ${platform}` : browser;
}

export function sameKey(buffer, key) {
  const bytes = new Uint8Array(buffer ?? []);
  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}

export function decodeKey(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function supported() {
  return (
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function current(registration) {
  return (await registration?.pushManager.getSubscription()) ?? null;
}

async function serverKey() {
  const { data } = await request('/notifications');
  return decodeKey(data.web_push.public_key);
}

async function register(current) {
  let id = localStorage.getItem(deviceKey);
  if (!id) {
    id = newId();
    localStorage.setItem(deviceKey, id);
  }
  const { endpoint, keys } = current.toJSON();
  await request(`/notifications/devices/${id}`, {
    method: 'PUT',
    body: { label: deviceLabel(navigator.userAgent), transport: 'web_push', endpoint, keys },
  });
}

async function subscribe(registration, current) {
  const key = await serverKey();
  if (current && sameKey(current.options.applicationServerKey, key)) return current;
  await current?.unsubscribe();
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

async function forget() {
  const id = localStorage.getItem(deviceKey);
  if (!id) return;
  await request(`/notifications/devices/${id}`, { method: 'DELETE' });
  localStorage.removeItem(deviceKey);
}

/** Stops notifications in this browser and removes it from Fleet. */
export async function disableNotifications() {
  if (!supported()) return;
  await (await current(await navigator.serviceWorker.getRegistration()))?.unsubscribe();
  await forget();
}

/** Closes notifications about an agent that is open. */
export function dismissNotifications(agent) {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .getRegistration()
    .then((registration) => registration?.getNotifications({ tag: `agent-${agent}` }))
    .then((notifications) => notifications?.forEach((notification) => notification.close()))
    .catch(() => {});
}

export function enableNotifications(section, toggle, note) {
  const apple =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && navigator.userAgent.includes('Macintosh'));
  const installed = matchMedia('(display-mode: standalone)').matches || !!navigator.standalone;
  let queue = Promise.resolve();
  let pending = 0;
  let synced = 0;
  let error = '';

  const render = (subscribed) => {
    const state = notificationState({
      supported: supported(),
      apple,
      installed,
      permission: globalThis.Notification?.permission,
      subscribed,
    });
    section.hidden = state === 'unsupported';
    toggle.checked = state === 'on';
    toggle.disabled = state === 'install' || state === 'blocked';
    note.textContent = error || notes[state] || '';
    note.classList.toggle('error-text', !!error);
    note.hidden = !note.textContent;
  };

  const run = (task) => {
    pending++;
    toggle.setAttribute('aria-busy', 'true');
    queue = queue
      .then(async () => task(await navigator.serviceWorker.ready))
      .catch((problem) => console.warn('Could not update notifications.', problem))
      .then(async () => {
        if (--pending) return;
        toggle.removeAttribute('aria-busy');
        render(!!(await current(await navigator.serviceWorker.ready)));
      });
  };

  const sync = () =>
    run(async (registration) => {
      const subscription = await current(registration);
      if (!subscription || Notification.permission !== 'granted') {
        await subscription?.unsubscribe();
        await forget();
      } else if (Date.now() - synced > syncInterval) {
        await register(await subscribe(registration, subscription));
        synced = Date.now();
      }
    });

  render(false);
  if (!supported()) return;

  toggle.onchange = () => {
    const enable = toggle.checked;
    const permission = enable && Notification.requestPermission();
    error = '';
    run(async (registration) => {
      let subscription = await current(registration);
      if (!enable) {
        await subscription?.unsubscribe();
        await forget();
        return;
      }
      if ((await permission) !== 'granted') return;
      try {
        subscription = await subscribe(registration, subscription);
        await register(subscription);
        synced = Date.now();
      } catch (problem) {
        await subscription?.unsubscribe().catch(() => {});
        error = `Notifications could not be turned on. ${problem.message}`;
      }
    });
  };

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'showing') event.ports[0]?.postMessage(location.hash);
    if (event.data?.type === 'navigate') location.hash = new URL(event.data.url).hash;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
  });
  sync();
}
