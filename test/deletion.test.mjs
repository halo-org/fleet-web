import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDeletion, deletionError, deletionText } from '../public/deletion.js';

test('deletes once at a time and retries uncertain deletions as sent', async (context) => {
  const requests = [];
  const fetch = context.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...options });
    throw new TypeError('Connection lost');
  });
  const deletion = new AgentDeletion('7');

  const sent = deletion.send();
  assert.equal(deletion.label(), 'Deleting…');
  await deletion.send();
  const error = await sent.catch((error) => error);

  assert.equal(requests.length, 3);
  assert.equal(deletion.uncertain, true);
  assert.equal(deletion.label(), 'Retry delete');
  assert.equal(
    deletionError(error, deletion),
    'Could not confirm the deletion. Retry to confirm it.',
  );

  fetch.mock.mockImplementation(async (url, options) => {
    requests.push({ url, ...options });
    return new Response(null, { status: 204 });
  });
  await deletion.send();

  assert.equal(deletion.uncertain, false);
  assert.equal(deletion.label(), 'Delete agent');
  for (const request of requests) {
    assert.equal(request.url, '/api/agents/7');
    assert.equal(request.method, 'DELETE');
    assert.equal(request.body, undefined);
    assert.equal(request.headers['idempotency-key'], undefined);
  }
});

test('a refused deletion is certain and explains subagents', async (context) => {
  context.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { message: 'Forbidden' } }, { status: 403 }),
  );
  const deletion = new AgentDeletion('9');

  const error = await deletion.send().catch((error) => error);

  assert.equal(deletion.uncertain, false);
  assert.match(deletionError(error, deletion), /Delete the agent that created it/);
});

test('mentions running work only while the agent works', () => {
  assert.equal(
    deletionText(false),
    'The agent, its subagents and their history are permanently deleted.',
  );
  assert.match(deletionText(true), /Its running work will be stopped\.$/);
});
