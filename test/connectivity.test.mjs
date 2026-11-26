import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connectivity, LOST_AFTER, SLOW_AFTER } from '../public/connectivity.js';

function connection(context, { online = true } = {}) {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const state = { online, changes: 0 };
  state.connectivity = new Connectivity(
    () => state.changes++,
    () => state.online,
  );
  return state;
}

test('a brief interruption never leaves the grace period', (context) => {
  const { connectivity } = connection(context);
  connectivity.set(true);
  connectivity.set(false);
  context.mock.timers.tick(SLOW_AFTER - 1);
  assert.equal(connectivity.stage, 'grace');
  connectivity.set(true);
  context.mock.timers.tick(LOST_AFTER);
  assert.equal(connectivity.stage, 'live');
});

test('a lasting interruption escalates and reports each step', (context) => {
  const state = connection(context);
  const { connectivity } = state;
  connectivity.set(true);
  connectivity.set(false);
  const changes = state.changes;
  context.mock.timers.tick(SLOW_AFTER);
  assert.equal(connectivity.stage, 'slow');
  assert.equal(state.changes, changes + 1);
  context.mock.timers.tick(LOST_AFTER - SLOW_AFTER);
  assert.equal(connectivity.stage, 'lost');
  assert.equal(state.changes, changes + 2);
});

test('reconnect attempts do not restart an ongoing outage', (context) => {
  const { connectivity } = connection(context);
  connectivity.set(false);
  context.mock.timers.tick(LOST_AFTER);
  connectivity.set(false);
  assert.equal(connectivity.stage, 'lost');
  assert.equal(connectivity.connected, false);
});

test('a restart gives a browser-triggered reconnect a new grace period', (context) => {
  const { connectivity } = connection(context);
  context.mock.timers.tick(LOST_AFTER);
  connectivity.restart();
  assert.equal(connectivity.stage, 'grace');
  context.mock.timers.tick(SLOW_AFTER);
  assert.equal(connectivity.stage, 'slow');
});

test('an offline device is reported once the grace period ends', (context) => {
  const state = connection(context, { online: false });
  context.mock.timers.tick(SLOW_AFTER - 1);
  assert.equal(state.connectivity.stage, 'grace');
  context.mock.timers.tick(1);
  assert.equal(state.connectivity.stage, 'offline');
  state.online = true;
  assert.equal(state.connectivity.stage, 'slow');
});

test('a browser that goes offline interrupts a connection that still looks live', (context) => {
  const state = connection(context);
  state.connectivity.set(true);
  state.online = false;
  state.connectivity.set(true);
  assert.equal(state.connectivity.stage, 'grace');
  context.mock.timers.tick(SLOW_AFTER);
  assert.equal(state.connectivity.stage, 'offline');
});

test('a working connection has nothing to report', (context) => {
  const { connectivity } = connection(context);
  assert.equal(connectivity.problem, '');
  connectivity.set(true);
  assert.equal(connectivity.problem, '');
  connectivity.set(false);
  assert.equal(connectivity.problem, '');
});

test('a lasting interruption is reported until the connection returns', (context) => {
  const state = connection(context);
  const { connectivity } = state;
  context.mock.timers.tick(SLOW_AFTER);
  assert.equal(connectivity.problem, 'Connecting…');
  connectivity.set(true);
  connectivity.set(false);
  context.mock.timers.tick(SLOW_AFTER);
  assert.equal(connectivity.problem, 'Reconnecting…');
  context.mock.timers.tick(LOST_AFTER);
  assert.equal(connectivity.problem, 'Can’t reach Fleet. Retrying…');
  state.online = false;
  assert.equal(connectivity.problem, 'You’re offline. Waiting for network…');
  state.online = true;
  connectivity.set(true);
  assert.equal(connectivity.problem, '');
});
