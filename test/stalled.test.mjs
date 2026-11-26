import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resume, findStalled, stallNotice, stallReason, stallStatus } from '../public/stalled.js';

const toolNotFound = {
  kind: 'tool_not_found',
  role: 'broken',
  alias: 'missing',
  tool: 'tools:missing',
};

test('formats known stall reasons from their kind and names', () => {
  assert.equal(
    stallReason(toolNotFound),
    'Role “broken” uses tool “tools:missing”, which doesn’t exist.',
  );
  assert.equal(
    stallReason({ kind: 'model_error', model: 'openai:gpt' }),
    'Model “openai:gpt” can’t be used until its connection or settings are fixed.',
  );
  assert.equal(
    stallReason({ kind: 'invalid_tool_parameters', role: 'writer' }),
    'Role “writer” can’t apply the agent’s parameters to its tools.',
  );
});

test('unknown kinds and malformed reasons have no detail', () => {
  assert.equal(stallReason({ kind: 'quota_exhausted', provider: 'x' }), '');
  assert.equal(stallReason({ kind: 'toString' }), '');
  assert.equal(stallReason({ kind: 'model_not_found', role: 'broken' }), '');
  assert.equal(stallReason(null), '');
  assert.deepEqual(stallNotice({ stalled: { kind: 'quota_exhausted' }, stalled_descendants: 0 }), {
    title: 'This agent can’t continue.',
    reason: '',
  });
});

test('the agent’s own stall leads, and stalls below start general', () => {
  const activity = (stalled, stalled_descendants) => ({
    turn: 'active',
    stalled,
    stalled_descendants,
  });
  assert.equal(stallNotice(activity(null, 0)), null);
  assert.equal(stallNotice({ turn: 'active' }), null); // Backends without the fields.
  assert.deepEqual(stallNotice(activity(null, 1)), {
    title: 'A subagent can’t continue.',
    reason: '',
  });
  const descendant = { id: '3', stalled: { kind: 'role_not_found', role: 'gone' } };
  assert.deepEqual(stallNotice(activity(null, 2), descendant), {
    title: '2 subagents can’t continue.',
    reason: 'Role “gone” doesn’t exist.',
  });
  assert.deepEqual(stallNotice(activity(toolNotFound, 1), descendant), {
    title: 'This agent and 1 subagent can’t continue.',
    reason: 'Role “broken” uses tool “tools:missing”, which doesn’t exist.',
  });
});

test('Trace tells an agent’s own stall from one below it', () => {
  assert.equal(stallStatus({ stalled: null, stalled_descendants: 0 }), null);
  assert.equal(stallStatus({}), null);
  assert.deepEqual(stallStatus({ stalled: toolNotFound, stalled_descendants: 2 }), {
    status: 'Stalled',
    reason: 'Role “broken” uses tool “tools:missing”, which doesn’t exist.',
  });
  assert.deepEqual(stallStatus({ stalled: null, stalled_descendants: 1 }), {
    status: 'Subagent stalled',
    reason: '',
  });
  assert.equal(
    stallStatus({ stalled: null, stalled_descendants: 3 }).status,
    '3 subagents stalled',
  );
});

test('descends only into branches that report stalled agents', async () => {
  const tree = {
    1: [
      { id: '2', stalled: null, stalled_descendants: 0 },
      { id: '3', stalled: null, stalled_descendants: 1 },
    ],
    3: [{ id: '4', stalled: null, stalled_descendants: 1 }],
    4: [
      { id: '5', stalled: null, stalled_descendants: 0 },
      { id: '6', stalled: toolNotFound, stalled_descendants: 0 },
    ],
  };
  const visited = [];
  const children = async (id) => {
    visited.push(id);
    return tree[id] || [];
  };
  assert.equal((await findStalled('1', children)).id, '6');
  assert.deepEqual(visited, ['1', '3', '4']);
});

test('a descent that races with a cleared stall finds nothing', async () => {
  const children = async (id) =>
    id === '1' ? [{ id: '2', stalled: null, stalled_descendants: 0 }] : [];
  assert.equal(await findStalled('1', children), null);
});

const stalled = { title: 'This agent can’t continue.', reason: '' };
const at = (revision, changes = {}) => ({
  revision,
  notice: stalled,
  latest: '9',
  preview: null,
  work: true,
  ...changes,
});
const accepted =
  (activityRevision = '43') =>
  async (url, options) =>
    options.method === 'POST'
      ? new Response(null, { status: 202 })
      : new Response(JSON.stringify({ turn: 'active', stalled: null, stalled_descendants: 0 }), {
          headers: { 'read-revision': activityRevision },
        });

test('resumes with an empty body, then reads activity to order the outcome', async (context) => {
  const calls = [];
  const respond = accepted();
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options });
    return respond(url, options);
  });
  const resume = new Resume('7');
  const request = resume.send(at('40'), true);
  assert.deepEqual(resume.status(at('40')), { notice: stalled, retrying: true });
  const read = await request;
  assert.equal(calls[0].url, '/api/agents/7/resumes');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, '{}');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.ok(calls[0].headers['idempotency-key']);
  assert.equal(calls[1].url, '/api/agents/7/activity');
  assert.equal(read.revision, '43');
  assert.equal(resume.operation, null);
});

test('the notice stays in place until Fleet reports how the retry went', async (context) => {
  context.mock.method(globalThis, 'fetch', accepted('43'));
  const resume = new Resume('7');
  await resume.send(at('40'), true);
  // Updates from before the resume took effect don't decide anything, even a stall below.
  const below = { title: 'This agent and 1 subagent can’t continue.', reason: '' };
  assert.deepEqual(resume.status(at('41', { notice: below })), { notice: stalled, retrying: true });
  // Cleared, with nothing new in the conversation: Fleet is working on the retry.
  assert.deepEqual(resume.status(at('43', { notice: null })), { notice: stalled, retrying: true });
  // The same error stalls it again. The notice never left.
  assert.deepEqual(resume.status(at('44')), { notice: stalled, retrying: false });
  assert.equal(resume.retry, null);
});

test('a retry settles once the conversation moves on or no work remains', () => {
  const started = { revision: '40', notice: stalled, latest: '9', own: true, confirmed: true };
  for (const outcome of [
    { latest: '10' },
    { preview: { status: 'streaming', output: [] } },
    { work: false },
  ]) {
    const resume = new Resume('7');
    resume.retry = { ...started, preview: JSON.stringify(null) };
    assert.equal(resume.status(at('41', { notice: null })).retrying, true);
    assert.deepEqual(resume.status(at('41', { notice: null, ...outcome })), {
      notice: null,
      retrying: false,
    });
  }
});

test('output that was already streaming is not progress', () => {
  const preview = { status: 'streaming', input_cursor: '9', output: [] };
  const resume = new Resume('7');
  resume.retry = {
    revision: '40',
    notice: stalled,
    latest: '9',
    preview: JSON.stringify(preview),
    own: true,
    confirmed: true,
  };
  assert.equal(resume.status(at('41', { notice: null, preview })).retrying, true);
});

test('a subagent’s retry settles when Fleet reports its stall cleared', () => {
  const resume = new Resume('7');
  resume.retry = { revision: '40', notice: stalled, latest: '9', own: false, confirmed: true };
  assert.equal(resume.status(at('39')).retrying, true);
  assert.deepEqual(resume.status(at('40', { notice: null })), { notice: null, retrying: false });
});

test('a reload from before the retry forgets it', () => {
  const resume = new Resume('7');
  resume.retry = { revision: '40', notice: stalled, latest: '9', own: true, confirmed: true };
  resume.reloaded('45');
  assert.ok(resume.retry);
  resume.reloaded('2');
  assert.equal(resume.retry, null);
});

test('a second press while retrying sends nothing', async (context) => {
  const posts = [];
  const respond = accepted();
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'POST') posts.push(options);
    return respond(url, options);
  });
  const resume = new Resume('7');
  await Promise.all([resume.send(at('40'), true), resume.send(at('40'), true)]);
  await resume.send(at('43', { notice: null }), true);
  assert.equal(posts.length, 1);
});

const lostConnection = async (context, resume, revision) => {
  const failed = assert.rejects(resume.send(at(revision), true), /Connection lost/);
  await new Promise(setImmediate);
  context.mock.timers.tick(400);
  await new Promise(setImmediate);
  context.mock.timers.tick(800);
  await failed;
};

test('an uncertain resume keeps its idempotency key; a rejected one does not', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts = [];
  const respond = accepted();
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method !== 'POST') return respond(url, options);
    attempts.push(options);
    if (attempts.length <= 3) throw new TypeError('Connection lost');
    if (attempts.length === 4)
      return new Response(JSON.stringify({ error: { message: 'Agent not found' } }), {
        status: 404,
      });
    return respond(url, options);
  });
  const resume = new Resume('7');
  await lostConnection(context, resume, '40');
  assert.ok(resume.operation);
  // A failed request offers Retry again.
  assert.deepEqual(resume.status(at('40')), { notice: stalled, retrying: false });
  await assert.rejects(resume.send(at('40'), true), { status: 404 });
  assert.equal(resume.operation, null);
  await resume.send(at('40'), true);
  const keys = attempts.map((attempt) => attempt.headers['idempotency-key']);
  assert.equal(new Set(keys.slice(0, 4)).size, 1);
  assert.notEqual(keys[4], keys[0]);
});

test('once activity changes, an uncertain resume’s key is not reused', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts = [];
  const respond = accepted('50');
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method !== 'POST') return respond(url, options);
    attempts.push(options);
    if (attempts.length <= 3) throw new TypeError('Connection lost');
    return respond(url, options);
  });
  const resume = new Resume('7');
  await lostConnection(context, resume, '40');
  // The stall cleared and the agent stalled again. A replayed key would not resume the new stall.
  await resume.send(at('42'), true);
  assert.notEqual(attempts[3].headers['idempotency-key'], attempts[0].headers['idempotency-key']);
});
