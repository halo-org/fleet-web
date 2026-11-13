import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeKey, deviceLabel, notificationState, sameKey } from '../public/notifications.js';

test('derives the notification switch state from browser support and permission', () => {
  const state = (options) =>
    notificationState({ supported: true, permission: 'default', subscribed: false, ...options });
  assert.equal(state({ supported: false }), 'unsupported');
  assert.equal(state({ supported: false, apple: true }), 'install');
  assert.equal(state({ supported: false, apple: true, installed: true }), 'unsupported');
  assert.equal(state({ permission: 'denied', subscribed: true }), 'blocked');
  assert.equal(state({ subscribed: true }), 'off');
  assert.equal(state({ permission: 'granted' }), 'off');
  assert.equal(state({ permission: 'granted', subscribed: true }), 'on');
});

test('labels devices by browser and platform', () => {
  assert.equal(
    deviceLabel(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    ),
    'Safari on iPhone',
  );
  assert.equal(
    deviceLabel(
      'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Mobile Safari/537.36',
    ),
    'Chrome on Android',
  );
  assert.equal(
    deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0'),
    'Firefox on Linux',
  );
  assert.equal(deviceLabel(''), 'Browser');
});

test('compares the subscription key with the server key', () => {
  const key = decodeKey('BAEC_-8');
  assert.deepEqual([...key], [4, 1, 2, 255, 239]);
  assert.equal(sameKey(key.buffer, key), true);
  assert.equal(sameKey(new Uint8Array([4, 1, 2, 255, 238]).buffer, key), false);
  assert.equal(sameKey(null, key), false);
});
