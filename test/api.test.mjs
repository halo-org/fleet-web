import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SSEParser, request, prepareWrite, write, subscribe } from '../public/api.js';

test('parses fragmented SSE lines and preserves raw preview text', () => {
  const events = [];
  const parser = new SSEParser((event) => events.push(event));
  const text =
    ': heartbeat\r\nid: 123\r\nevent: update\r\ndata: {"events":[]}\r\n\r\nevent: preview_text\ndata:  hello\ndata: world\ndata: \n\n';
  for (const character of text) parser.push(character);

  assert.deepEqual(events, [
    { type: 'update', data: '{"events":[]}', id: '123' },
    { type: 'preview_text', data: ' hello\nworld\n', id: undefined },
  ]);
});

test('does not dispatch an incomplete revision batch', () => {
  const events = [];
  const parser = new SSEParser((event) => events.push(event));
  parser.push('id: 9\nevent: update\ndata: {"events":[]}', true);

  assert.deepEqual(events, []);
});

test('accepts empty successful mutation responses', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));

  assert.deepEqual(await request('/agents', { method: 'POST' }), { data: null, revision: null });
});

test('redirects to sign-in only for an expired Fleet session', async (context) => {
  const replace = context.mock.fn();
  globalThis.location = { replace };
  context.after(() => delete globalThis.location);
  const respond = (code) => new Response(JSON.stringify({ error: { code } }), { status: 401 });
  const fetch = context.mock.method(globalThis, 'fetch', async () =>
    respond('authorization_required'),
  );

  await assert.rejects(request('/connections'));
  assert.equal(replace.mock.callCount(), 0);

  fetch.mock.mockImplementation(async () => respond('sign_in_required'));
  await assert.rejects(request('/agents'));
  assert.deepEqual(replace.mock.calls[0].arguments, ['/login.html']);
});

test('retries a mutation with the same idempotency key and payload', async (context) => {
  const attempts = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    attempts.push(options);
    if (attempts.length === 1) throw new TypeError('Connection lost');
    return new Response(null, { status: 201 });
  });
  const operation = prepareWrite('/agents', { id: '42' });

  await write(operation);

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].headers['idempotency-key'], attempts[1].headers['idempotency-key']);
  assert.equal(attempts[0].body, attempts[1].body);
});

test('reconnects stalled subscriptions from the last applied revision', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = new AbortController();
  context.after(() => stop.abort());
  const revisions = [];
  const events = [];
  let stream;
  context.mock.method(globalThis, 'fetch', async (url, { headers, signal }) => {
    revisions.push(headers['last-event-id']);
    return eventStream(signal, (controller) => {
      stream = controller;
      controller.enqueue(new TextEncoder().encode(`id: ${revisions.length}\ndata: {}\n\n`));
    });
  });

  const subscription = subscribe('/agents/subscription', {
    after: '0',
    signal: stop.signal,
    onEvent: (event) => {
      events.push(event.id);
      if (event.id === '2') stop.abort();
    },
  });
  await new Promise(setImmediate);

  context.mock.timers.tick(30_000);
  stream.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
  await new Promise(setImmediate);
  context.mock.timers.tick(30_000);
  await new Promise(setImmediate);
  assert.deepEqual(revisions, ['0']);

  context.mock.timers.tick(15_000);
  await new Promise(setImmediate);
  context.mock.timers.tick(500);
  await new Promise(setImmediate);
  assert.deepEqual(revisions, ['0', '1']);

  await subscription;
  assert.deepEqual(events, ['1', '2']);
});

test('resumes subscriptions when the app returns to the foreground', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = new EventTarget();
  document.visibilityState = 'hidden';
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  });
  const stop = new AbortController();
  context.after(() => stop.abort());
  const revisions = [];
  context.mock.method(globalThis, 'fetch', async (url, { headers, signal }) => {
    revisions.push(headers['last-event-id']);
    return eventStream(signal, (controller) => {
      controller.enqueue(new TextEncoder().encode(`id: ${revisions.length}\ndata: {}\n\n`));
    });
  });

  const subscription = subscribe('/agents/subscription', {
    after: '0',
    signal: stop.signal,
    onEvent: (event) => {
      if (event.id === '2') stop.abort();
    },
  });
  await new Promise(setImmediate);
  document.dispatchEvent(new Event('visibilitychange'));
  await new Promise(setImmediate);
  context.mock.timers.tick(500);
  await new Promise(setImmediate);
  assert.deepEqual(revisions, ['0']);

  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await new Promise(setImmediate);
  context.mock.timers.tick(500);
  await new Promise(setImmediate);
  assert.deepEqual(revisions, ['0', '1']);

  await subscription;
});

function eventStream(signal, start) {
  return new Response(
    new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        start(controller);
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
