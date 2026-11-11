import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TitleEdit, agentTitle, initialTitle, newestMetadata } from '../public/titles.js';

const agent = (title = 'Original', metadata_version = '5') => ({
  id: '1234567',
  role: 'assistant',
  title,
  metadata_version,
});

const problem = (status) =>
  new Response(JSON.stringify({ error: { message: 'Changed' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('chooses titles by metadata version, not collection or read revisions', () => {
  const summary = { ...agent('Old', '5'), version: '1000' };
  const metadata = agent('New', '7');
  assert.equal(newestMetadata(summary, metadata), metadata);
  assert.equal(newestMetadata({ ...summary, ...agent(null, '8') }, metadata).title, null);
  assert.equal(newestMetadata(null, metadata), metadata);
  assert.equal(newestMetadata(summary, null), summary);
  assert.equal(agentTitle(metadata), 'New');
  assert.equal(agentTitle(agent(null)), 'assistant · 234567');
  assert.equal(agentTitle(agent(null), 'Assistant'), 'Assistant · 234567');
  assert.equal(initialTitle('  First\n\nmessage  '), 'First message');
  assert.equal(initialTitle('x'.repeat(200)).length, 100);
  assert.equal(initialTitle(`${'x'.repeat(99)}🚀more`), `${'x'.repeat(99)}🚀`);
});

test('saves titles with the metadata precondition and an idempotency key', async (context) => {
  let sent;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    sent = { url, ...options };
    return new Response(null, { status: 204 });
  });
  const edit = new TitleEdit({ ...agent(), version: '1000' });
  edit.value = '  Review 🚀  ';
  await edit.save();
  assert.equal(sent.url, '/api/agents/1234567/title');
  assert.equal(sent.method, 'PUT');
  assert.equal(sent.headers['if-match'], '"5"');
  assert.ok(sent.headers['idempotency-key']);
  assert.deepEqual(JSON.parse(sent.body), { title: 'Review 🚀' });
  assert.equal(edit.operation, null);
});

test('a blank title explicitly clears the server title', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.deepEqual(JSON.parse(options.body), { title: null });
    return new Response(null, { status: 204 });
  });
  const edit = new TitleEdit(agent());
  edit.value = '   ';
  await edit.save();
});

test('a conflict preserves the draft and requires review before a new write', async (context) => {
  const attempts = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    attempts.push(options);
    if (attempts.length === 1) return problem(412);
    if (attempts.length === 2)
      return new Response(JSON.stringify(agent('Other client', '7')), {
        headers: { 'read-revision': '50' },
      });
    return new Response(null, { status: 204 });
  });
  const edit = new TitleEdit(agent());
  edit.value = 'My draft';
  await assert.rejects(edit.save(), { status: 412 });
  assert.equal(edit.value, 'My draft');
  assert.equal(edit.operation, null);
  assert.equal(edit.conflict, true);
  await assert.rejects(edit.save(), /Load the current title/);
  assert.equal(attempts.length, 1);
  const response = await edit.refresh();
  assert.equal(response.revision, '50');
  assert.equal(edit.version, '7');
  assert.equal(edit.current, 'Other client');
  assert.equal(edit.value, 'My draft');
  assert.equal(edit.conflict, false);
  assert.equal(attempts.length, 2); // Refreshing never automatically overwrites.
  await edit.save();
  assert.equal(attempts[2].headers['if-match'], '"7"');
  assert.notEqual(attempts[2].headers['idempotency-key'], attempts[0].headers['idempotency-key']);
  assert.deepEqual(JSON.parse(attempts[2].body), { title: 'My draft' });
});

test('a failed conflict refresh keeps both the draft and the save guard', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => problem(503));
  const edit = new TitleEdit(agent());
  edit.value = 'My draft';
  edit.conflict = true;
  await assert.rejects(edit.refresh(), { status: 503 });
  assert.equal(edit.conflict, true);
  assert.equal(edit.value, 'My draft');
  assert.equal(edit.version, '5');
});

test('an uncertain edit retains its exact operation for manual retries', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    attempts.push(options);
    if (attempts.length <= 3) throw new TypeError('Connection lost');
    return new Response(null, { status: 204 });
  });
  const edit = new TitleEdit(agent());
  edit.value = 'My draft';
  const failed = assert.rejects(edit.save(), /Connection lost/);
  await new Promise(setImmediate);
  context.mock.timers.tick(400);
  await new Promise(setImmediate);
  context.mock.timers.tick(800);
  await failed;
  assert.ok(edit.operation);
  assert.equal(edit.value, 'My draft');
  edit.value = 'A different draft';
  await assert.rejects(edit.save(), /Retry the unconfirmed edit/);
  assert.equal(attempts.length, 3);
  edit.value = 'My draft';
  await edit.save();
  assert.equal(attempts.length, 4);
  for (const attempt of attempts) {
    assert.equal(attempt.headers['idempotency-key'], attempts[0].headers['idempotency-key']);
    assert.equal(attempt.headers['if-match'], '"5"');
    assert.equal(attempt.body, attempts[0].body);
  }
  assert.equal(edit.operation, null);
});
