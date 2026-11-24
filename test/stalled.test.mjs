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

test('resumes with an empty body and waits for activity to change', async (context) => {
  let sent;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    sent = { url, ...options };
    return new Response(null, { status: 202 });
  });
  const resume = new Resume('7');
  const request = resume.send('40');
  assert.equal(resume.waiting('40'), true);
  await request;
  assert.equal(sent.url, '/api/agents/7/resumes');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.body, '{}');
  assert.equal(sent.headers['content-type'], 'application/json');
  assert.ok(sent.headers['idempotency-key']);
  assert.equal(resume.operation, null);
  // Accepted, but the notice stays until Fleet's activity says what happened.
  assert.equal(resume.waiting('40'), true);
  assert.equal(resume.waiting('41'), false);
  assert.equal(resume.waiting('40'), false);
});

test('a second press while retrying sends nothing', async (context) => {
  const attempts = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    attempts.push(options);
    return new Response(null, { status: 202 });
  });
  const resume = new Resume('7');
  await Promise.all([resume.send('40'), resume.send('40')]);
  assert.equal(attempts.length, 1);
});

const lostConnection = async (context, resume, revision) => {
  const failed = assert.rejects(resume.send(revision), /Connection lost/);
  await new Promise(setImmediate);
  context.mock.timers.tick(400);
  await new Promise(setImmediate);
  context.mock.timers.tick(800);
  await failed;
};

test('an uncertain resume keeps its idempotency key; a rejected one does not', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    attempts.push(options);
    if (attempts.length <= 3) throw new TypeError('Connection lost');
    if (attempts.length === 4)
      return new Response(JSON.stringify({ error: { message: 'Agent not found' } }), {
        status: 404,
      });
    return new Response(null, { status: 202 });
  });
  const resume = new Resume('7');
  await lostConnection(context, resume, '40');
  assert.ok(resume.operation);
  assert.equal(resume.waiting('40'), false);
  await assert.rejects(resume.send('40'), { status: 404 });
  assert.equal(resume.operation, null);
  await resume.send('40');
  const keys = attempts.map((attempt) => attempt.headers['idempotency-key']);
  assert.equal(new Set(keys.slice(0, 4)).size, 1);
  assert.notEqual(keys[4], keys[0]);
});

test('once activity changes, an uncertain resume’s key is not reused', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    attempts.push(options);
    if (attempts.length <= 3) throw new TypeError('Connection lost');
    return new Response(null, { status: 202 });
  });
  const resume = new Resume('7');
  await lostConnection(context, resume, '40');
  // The stall cleared and the agent stalled again. A replayed key would not resume the new stall.
  await resume.send('42');
  assert.notEqual(attempts[3].headers['idempotency-key'], attempts[0].headers['idempotency-key']);
});
