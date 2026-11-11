import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followPosition } from '../public/scroll.js';

const view = { scrollTop: 1000, scrollHeight: 1800, clientHeight: 800 };

test('following scrolls to the end while the newest response fits', () => {
  assert.deepEqual(followPosition({ ...view, scrollHeight: 1900, responseTop: 1400 }), {
    top: 1100,
    follow: true,
    smooth: false,
  });
});

test('a streaming response stops at its top and releases following', () => {
  assert.deepEqual(followPosition({ ...view, scrollHeight: 1850, responseTop: 1030 }), {
    top: 1030,
    follow: false,
    smooth: false,
  });
});

test('a large response whose start is visible does not move the view', () => {
  assert.deepEqual(followPosition({ ...view, scrollHeight: 2600, responseTop: 1400 }), {
    top: 1000,
    follow: false,
    smooth: false,
  });
});

test('a large response that starts low glides to its start', () => {
  assert.deepEqual(followPosition({ ...view, scrollHeight: 3000, responseTop: 1700 }), {
    top: 1700,
    follow: false,
    smooth: true,
  });
});

test('a response already scrolled past keeps following to the end', () => {
  assert.deepEqual(
    followPosition({ ...view, scrollTop: 1600, scrollHeight: 2600, responseTop: 1500 }),
    { top: 1800, follow: true, smooth: false },
  );
});

test('following never scrolls back up when content shrinks', () => {
  assert.deepEqual(followPosition({ ...view, scrollHeight: 1700 }), {
    top: 1000,
    follow: true,
    smooth: false,
  });
});
