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
