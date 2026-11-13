import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importRole, roleFile } from '../public/role-import.js';

test('names roles after Markdown and JSON files', () => {
  assert.deepEqual(roleFile('code-review_2.md'), { name: 'code-review_2', type: 'text/markdown' });
  assert.deepEqual(roleFile('Assistant.JSON'), { name: 'Assistant', type: 'application/json' });
  for (const name of ['notes.txt', 'two words.md', 'role.md.bak', '.md', 'résumé.md'])
    assert.equal(roleFile(name), null);
});

test('replaces an existing role with its current version', async (context) => {
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...options });
    if (requests.length === 1) return Response.json({}, { status: 412 });
    if (requests.length === 2) return Response.json({ version: '7' });
    return new Response(null, { status: 204 });
  });
  const source = '---\nmodel:\n  name: work:model\n---\nBe helpful.\n';
  const item = { file: 'assistant.md', name: 'assistant', type: 'text/markdown', source };

  await importRole(item);
  assert.equal(item.status, 'exists');
  await importRole(item, true);
  assert.equal(item.status, 'replaced');

  const [create, , replace] = requests;
  assert.equal(create.headers['if-none-match'], '*');
  assert.equal(replace.url, '/api/roles/assistant');
  assert.equal(replace.method, 'PUT');
  assert.equal(replace.body, source);
  assert.equal(replace.headers['content-type'], 'text/markdown');
  assert.equal(replace.headers['if-match'], '"7"');
  assert.notEqual(replace.headers['idempotency-key'], create.headers['idempotency-key']);
});

test('retries an uncertain import with the same idempotency key', async (context) => {
  const keys = [];
  const fetch = context.mock.method(globalThis, 'fetch', async (url, options) => {
    keys.push(options.headers['idempotency-key']);
    return new Response(null, { status: 503 });
  });
  context.mock.method(globalThis, 'setTimeout', (resolve) => resolve());
  const item = { file: 'a.json', name: 'a', type: 'application/json', source: '{}' };

  await importRole(item);
  assert.equal(item.status, 'failed');
  assert.equal(item.retry, true);
  fetch.mock.mockImplementation(async (url, options) => {
    keys.push(options.headers['idempotency-key']);
    return new Response(null, { status: 201 });
  });
  await importRole(item);

  assert.equal(item.status, 'imported');
  assert.equal(new Set(keys).size, 1);
});
