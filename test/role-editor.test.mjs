import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleEdit, roleDefinition, roleFields } from '../public/role-editor.js';

const role = {
  name: 'reviewer',
  version: '7',
  title: 'Reviewer',
  hidden: false,
  model: { name: 'work:model', config: { effort: 'high' } },
  tools: {},
  parameters: {},
  system_prompt: 'Review changes.\n',
};

test('edits settings as JSON next to the plain fields', () => {
  const fields = roleFields(role);
  assert.equal(fields.title, 'Reviewer');
  assert.equal(fields.system_prompt, 'Review changes.\n');
  assert.deepEqual(JSON.parse(fields.settings), {
    model: { name: 'work:model', config: { effort: 'high' } },
    tools: {},
    parameters: {},
  });

  assert.deepEqual(
    roleDefinition({ ...fields, title: ' ', description: 'Reviews.', hidden: true }),
    {
      description: 'Reviews.',
      hidden: true,
      model: { name: 'work:model', config: { effort: 'high' } },
      tools: {},
      parameters: {},
      system_prompt: 'Review changes.\n',
    },
  );
});

test('rejects settings that are not a JSON object or repeat a field', () => {
  const fields = roleFields(role);
  for (const settings of ['{', '[]', 'null', '{"title": "Other"}'])
    assert.throws(() => roleDefinition({ ...fields, settings }));
});

test('keeps a conflicting draft until the current version is loaded', async (context) => {
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...options });
    if (requests.length === 1) return Response.json({}, { status: 412 });
    if (requests.length === 2) return Response.json({ ...role, version: '8' });
    return new Response(null, { status: 204 });
  });
  const edit = new RoleEdit(role);
  edit.fields.system_prompt = 'Be brief.\n';

  await assert.rejects(edit.save());
  assert.equal(edit.conflict, true);
  await assert.rejects(edit.save(), /Load the current role/);
  await edit.refresh();
  assert.equal(edit.fields.system_prompt, 'Be brief.\n');
  assert.equal(await edit.save(), 'reviewer');

  const [stale, , saved] = requests;
  assert.equal(stale.headers['if-match'], '"7"');
  assert.equal(saved.url, '/api/roles/reviewer');
  assert.equal(saved.headers['if-match'], '"8"');
  assert.equal(JSON.parse(saved.body).system_prompt, 'Be brief.\n');
});

test('creates a role only if its name is free', async (context) => {
  const fetch = context.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 201 }),
  );
  const edit = new RoleEdit();
  edit.fields.name = 'two words';
  await assert.rejects(edit.save(), /letters, digits/);
  assert.equal(fetch.mock.callCount(), 0);

  edit.fields.name = 'assistant';
  edit.fields.settings = '{"model": {"name": "work:model"}}';
  assert.equal(await edit.save(), 'assistant');
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, '/api/roles/assistant');
  assert.equal(options.headers['if-none-match'], '*');
  assert.equal(options.headers['if-match'], undefined);
});
