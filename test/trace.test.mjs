import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  traceRows,
  backgroundCalls,
  inputSummary,
  outputSummary,
  compactText,
} from '../public/trace.js';
import { Conversation } from '../public/state.js';

const text = (text) => ({ type: 'text', text });
const event = (cursor, payload) => ({ cursor, status: 'settled', payload });
const call = (id, input = { path: 'public/render.js' }, is_async = false) => ({
  type: 'tool_call',
  id,
  tool: 'read',
  input,
  is_async,
});
const response = (cursor, output) => event(cursor, { type: 'model_response', output });
const result = (cursor, call_id, is_error = false, content = [text('Done')]) =>
  event(cursor, {
    type: 'tool_result',
    call_id,
    output: { is_error, content, structured_content: null },
  });
const pending = (id, is_async = false) => ({ id, tool: 'read', status: 'pending', is_async });
const end = (cursor, reason = 'completed') => event(cursor, { type: 'turn_end', reason });
const preview = (input_cursor, output) => ({ status: 'streaming', input_cursor, output });

test('splits model output in block order and attaches results to individual calls', () => {
  const a = result('4', 'a');
  const b = result('3', 'b', true, [text('Not found')]);
  const model = response('2', [
    { type: 'reasoning', content: 'Inspect files' },
    text('Checking'),
    call('a'),
    call('b'),
    text('Waiting'),
  ]);
  const rows = traceRows([model, b, a]);

  assert.deepEqual(
    rows.map((row) => row.kind),
    ['reasoning', 'text', 'tool', 'tool', 'text'],
  );
  assert.equal(rows[2].result, a);
  assert.equal(rows[3].result, b);
  assert.equal(rows[2].status, 'complete');
  assert.equal(rows[3].status, 'error');
  assert.equal(rows[2].event, model);
});

test('results take precedence over stale pending snapshots', () => {
  const rows = traceRows([response('1', [call('a')]), result('2', 'a')], [pending('a')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'complete');
});

test('the same tool key survives preview, pending, and result transitions', () => {
  const partial = preview('1', [
    { index: 0, type: 'tool_call', id: 'a', tool: 'read', input: '{"path":"pub' },
  ]);
  const generating = traceRows([], [], partial)[0];
  const model = response('2', [call('a')]);
  const awaiting = traceRows([model], [pending('a')], partial)[0];
  const completed = traceRows([model, result('3', 'a')], [], partial)[0];

  assert.equal(generating.status, 'generating');
  assert.equal(generating.summary, '{"path":"pub');
  assert.equal(awaiting.status, 'pending');
  assert.equal(completed.status, 'complete');
  assert.equal(generating.key, awaiting.key);
  assert.equal(awaiting.key, completed.key);
  assert.equal(traceRows([model], [pending('a')], partial).length, 1);
});

test('text and reasoning rows identify the preview they replace', () => {
  const input = event('10', { type: 'input', content: [text('Hello')] });
  const output = [{ type: 'reasoning', content: 'Consider' }, text('Hi')];
  const live = traceRows(
    [input],
    [],
    preview(
      '10',
      output.map((block, index) => ({ ...block, index })),
    ),
  );
  const settled = traceRows([input, response('11', output)]);

  assert.equal(settled[1].previewKey, live[1].key);
  assert.equal(settled[2].previewKey, live[2].key);
  assert.equal(settled[1].key, 'event:11:0');
});

test('orphan results merge into calls loaded later without changing identity', () => {
  const output = result('9', 'call:with/slashes');
  const orphan = traceRows([output])[0];
  const rows = traceRows([response('3', [call('call:with/slashes')]), end('4'), output]);

  assert.equal(orphan.kind, 'tool');
  assert.equal(orphan.status, 'complete');
  assert.equal(orphan.result, output);
  assert.match(orphan.summary, /earlier call not loaded/);
  assert.equal(rows[0].key, orphan.key);
  assert.equal(rows[0].event.cursor, '3');
  assert.equal(rows.length, 2);
});

test('pending calls outside history remain visible without fabricated arguments', () => {
  const row = traceRows([], [pending('a')])[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.name, 'read');
  assert.equal(row.call.input, undefined);
  assert.match(row.summary, /earlier call not loaded/);
  assert.equal(traceRows([], [{ id: 'a', status: 'resolved' }]).length, 0);
});

test('async calls outside history are left to the running list', () => {
  assert.deepEqual(traceRows([], [pending('a', true)]), []);
  assert.equal(backgroundCalls([], [pending('a', true)])[0].loaded, false);
});

test('pending calls show a stop of their own or of the turn', () => {
  const events = [response('1', [call('a'), call('b', {}, true), call('c', {}, true)])];
  const tools = [
    pending('a'),
    pending('b', true),
    { ...pending('c', true), interrupt_pending: true },
  ];
  const statuses = (activity) =>
    traceRows(events, tools, null, [], activity).map((row) => row.status);

  assert.deepEqual(statuses(), ['pending', 'pending', 'stopping']);
  assert.deepEqual(statuses({ interrupt_pending: true }), ['stopping', 'pending', 'stopping']);
  assert.deepEqual(
    statuses({ interrupt_pending: true, interrupt_includes_async_tool_calls: true }),
    ['stopping', 'stopping', 'stopping'],
  );
});

test('missing results are not presented as still running', () => {
  const row = traceRows([response('1', [call('a')]), end('2')])[0];
  assert.equal(row.status, 'unavailable');
});

test('async calls remain pending across turn boundaries and resolve in place', () => {
  const events = [
    response('1', [call('a', {}, true)]),
    end('2'),
    response('3', [text('Next turn')]),
  ];
  const rows = traceRows(events, [pending('a')]);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].call.is_async, true);
  assert.equal(rows[1].reason, 'completed');
  const resolved = traceRows([...events, result('4', 'a')]);
  assert.equal(resolved[0].key, rows[0].key);
  assert.equal(resolved[0].status, 'complete');
  assert.equal(resolved.length, rows.length);
});

test('background calls list running async calls oldest first, including unloaded ones', () => {
  const events = [
    response('5', [call('b', { title: 'Review auth' }, true), call('c', {}, true)]),
    end('6'),
    response('7', [call('d'), call('e', { command: 'sleep 60' }, true)]),
  ];
  const tools = ['e', 'c', 'b', 'old', 'd'].map((id) => pending(id, id !== 'd'));
  const calls = backgroundCalls(events, tools);

  assert.deepEqual(
    calls.map((call) => [call.id, call.summary, call.loaded]),
    [
      ['old', '', false],
      ['b', 'Review auth', true],
      ['c', '{}', true],
      ['e', 'sleep 60', true],
    ],
  );
  assert.equal(calls[0].name, 'read');
});

test('background calls leave as soon as the server or a loaded result resolves them', () => {
  const events = [response('1', [call('a', {}, true), call('b', {}, true)])];
  const running = [pending('a', true), pending('b', true)];
  assert.equal(backgroundCalls(events, running).length, 2);
  assert.deepEqual(
    backgroundCalls([...events, result('2', 'a')], running).map((call) => call.id),
    ['b'],
  );
  assert.equal(backgroundCalls(events, [{ id: 'a', status: 'resolved' }, running[1]]).length, 1);
  assert.deepEqual(backgroundCalls(events, []), []);
});

test('background calls carry the agents they created, by creating call', () => {
  const children = [
    { id: '12', parent: { agent: '1', call: 'a' } },
    { id: '9', parent: { agent: '1', call: 'a' } },
    { id: '13', parent: { agent: '1', call: 'other' } },
  ];
  const [running] = backgroundCalls([], [pending('a', true)], children);
  assert.deepEqual(
    running.children.map((agent) => agent.id),
    ['9', '12'],
  );
});

test('compaction does not replay retained inputs or pending calls as new activity', () => {
  const compaction = event('4', {
    type: 'compaction',
    last_event: '3',
    input: [{ type: 'assistant', output: [call('a')] }],
    pending_tool_calls: [call('a')],
  });
  const rows = traceRows([response('1', [call('a')]), compaction, result('5', 'a')]);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['tool', 'compaction'],
  );
  assert.equal(rows[1].event, compaction);
  assert.match(rows[1].text, /1 retained inputs/);
});

test('compaction activity does not invent trace output or hide pending async tools', () => {
  const events = [response('1', [call('a', {}, true)]), end('2')];
  const compacting = { status: 'compacting', input_cursor: '2' };
  const rows = traceRows(events, [pending('a')], compacting);

  assert.deepEqual(rows.map((row) => row.kind), ['tool', 'turn_end']);
  assert.equal(rows[0].status, 'pending');
});

test('provider tools do not wait for Fleet results or expose opaque payloads in summaries', () => {
  const provider = {
    type: 'provider_tool_call',
    call_id: 'a',
    name: 'web_search',
    content: 'Found references',
    payload: 'opaque-provider-data',
  };
  const rows = traceRows([response('2', [call('a'), provider])], [pending('a')]);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[1].status, 'provider');
  assert.equal(rows[1].summary, 'Found references');
  assert.notEqual(rows[0].key, rows[1].key);
  const live = traceRows([], [], preview('1', [{ ...provider, index: 0, content: '' }]))[0];
  assert.equal(live.status, 'running');
  assert.equal(live.summary, '');
  assert.equal(live.key, rows[1].key);
});

test('reasoning retains readable content without rendering opaque data as text', () => {
  const rows = traceRows([
    response('1', [
      {
        type: 'reasoning',
        content: null,
        redacted_content: 'secret-opaque',
        attestation: 'signature',
      },
    ]),
  ]);
  assert.equal(rows[0].summary, 'Reasoning hidden by provider');
  assert.equal(rows[0].text, '');
  assert.equal(rows[0].block.redacted_content, 'secret-opaque');
});

test('reasoning without text yet reads as in progress while it streams', () => {
  const live = traceRows([], [], preview('1', [{ index: 0, type: 'reasoning', text: '' }]))[0];
  assert.equal(live.summary, 'Thinking…');
  assert.equal(live.streaming, true);
});

test('newer response, compaction, and turn end events each suppress obsolete previews', () => {
  const stale = preview('1', [{ index: 0, ...text('Old preview') }]);
  for (const committed of [
    response('2', []),
    end('2'),
    event('2', { type: 'compaction', last_event: '1', input: [] }),
  ]) {
    assert.equal(traceRows([committed], [], stale).length, 1);
  }
});

test('preview blocks are sorted by index without modifying the preview', () => {
  const live = preview('1', [
    { index: 9, ...text('Later') },
    { index: 2, ...text('Earlier') },
  ]);
  const before = structuredClone(live);
  assert.deepEqual(
    traceRows([], [], live).map((row) => row.summary),
    ['Earlier', 'Later'],
  );
  assert.deepEqual(live, before);
});

test('ordering and preview replacement preserve cursors beyond number precision', () => {
  const first = '340282366920938463463374607431768211454';
  const second = '340282366920938463463374607431768211455';
  const rows = traceRows(
    [response(second, [text('Second')]), response(first, [text('First')])],
    [],
    preview(first, [{ index: 0, ...text('Old preview') }]),
  );
  assert.deepEqual(
    rows.map((row) => row.summary),
    ['First', 'Second'],
  );
});

test('unknown events and blocks remain inspectable', () => {
  const unknown = event('1', { type: 'future_event', data: 'value' });
  const rows = traceRows([
    unknown,
    response('2', [{ type: 'future_block', data: 'value' }]),
    response('3', []),
  ]);
  assert.equal(rows[0].kind, 'unknown');
  assert.equal(rows[0].event, unknown);
  assert.equal(rows[1].kind, 'unknown');
  assert.match(rows[1].text, /future_block/);
  assert.equal(rows[2].summary, 'No visible output');
});

test('revised and deleted events update derived rows without stale result status', () => {
  const log = new Conversation();
  const model = response('1', [call('a')]);
  log.eventPage([model, result('2', 'a')], '3');
  log.update({ events: [result('2', 'a', true)] }, '4');
  assert.equal(traceRows(log.orderedEvents())[0].status, 'error');
  log.update({ events: [{ cursor: '2', status: 'deleted' }] }, '5');
  log.eventPage([result('2', 'a')], '3');
  assert.equal(traceRows(log.orderedEvents())[0].status, 'unavailable');
  log.update({ events: [{ cursor: '1', status: 'deleted' }] }, '6');
  assert.deepEqual(traceRows(log.orderedEvents()), []);
});

test('deleting a call preserves its result as an orphan rather than hiding it', () => {
  const rows = traceRows([{ cursor: '1', status: 'deleted' }, result('2', 'a')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'tool:a');
  assert.equal(rows[0].status, 'complete');
});

test('projection leaves source events and tool records untouched', () => {
  const events = [result('2', 'a'), response('1', [call('a')])];
  const tools = [pending('a')];
  const before = structuredClone({ events, tools });
  traceRows(events, tools);
  assert.deepEqual({ events, tools }, before);
});

test('argument summaries handle common fields, JSON fragments, and generic objects', () => {
  assert.equal(inputSummary({ command: 'npm test', cwd: '/workspace' }), 'npm test');
  assert.equal(
    inputSummary({ file_path: 'public/app.js', content: 'Long content' }),
    'public/app.js',
  );
  assert.equal(inputSummary('{"path":"public/app.js"}'), 'public/app.js');
  assert.equal(inputSummary('{"path":'), '{"path":');
  assert.equal(inputSummary({ arbitrary: 42 }), '{"arbitrary":42}');
  assert.equal(inputSummary({ prompt: 'A long task', title: 'Audit' }), 'Audit');
  assert.equal(inputSummary(undefined), '');
  assert.equal(compactText('first\n  second'), 'first second');
  assert.equal(compactText('x'.repeat(500)).length, 240);
});

test('result summaries support text, structured-only, empty, and error output', () => {
  assert.equal(outputSummary({ content: [text('first\nsecond')] }), 'first second');
  assert.equal(outputSummary({ content: [], structured_content: { count: 2 } }), '{"count":2}');
  assert.equal(outputSummary({ content: [] }), 'No output');
  assert.equal(outputSummary({ content: [], is_error: true }), 'Tool returned an error');
});

test('agents are attached by their creating call, regardless of tool names or results', () => {
  const children = [
    { id: '2', title: 'Check auth', parent: { agent: '1', call: 'a' } },
    { id: '3', title: 'Check queries', parent: { agent: '1', call: 'a' } },
    { id: '4', title: 'Review', parent: { agent: '1', call: 'b' } },
  ];
  const rows = traceRows(
    [response('1', [call('a'), call('b')]), result('2', 'b')],
    [pending('a')],
    null,
    children,
  );

  assert.deepEqual(rows[0].children, children.slice(0, 2));
  assert.equal(rows[0].status, 'pending');
  assert.deepEqual(rows[1].children, children.slice(2));
  assert.equal(rows[1].status, 'complete');
  assert.equal(children[0].parent.call, 'a');
});

test('agents from finished calls outside loaded history wait for their calls to load', () => {
  const finished = { id: '2', parent: { agent: '1', call: 'old:call/1' } };
  const running = { id: '3', parent: { agent: '1', call: 'b' } };
  const latest = [end('9')];

  const rows = traceRows(latest, [pending('b')], null, [finished, running]);
  assert.deepEqual(
    rows.map((row) => [row.key, row.status]),
    [
      ['event:9', undefined],
      ['tool:b', 'pending'],
    ],
  );
  assert.deepEqual(rows[1].children, [running]);

  const loaded = traceRows(
    [response('1', [call('old:call/1')]), result('2', 'old:call/1'), ...latest],
    [pending('b')],
    null,
    [finished, running],
  );
  assert.equal(loaded[0].key, 'tool:old:call/1');
  assert.equal(loaded[0].status, 'complete');
  assert.deepEqual(loaded[0].children, [finished]);
});

test('a child update arriving ahead of the committed call does not obscure its preview', () => {
  const child = { id: '2', parent: { agent: '1', call: 'a' } };
  const rows = traceRows([], [], preview('1', [{ index: 0, ...call('a') }]), [child]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'generating');
  assert.deepEqual(rows[0].children, [child]);
});

test('tool input and structured output do not invent child associations for resumed agents', () => {
  const output = result('3', 'resume');
  output.payload.output.structured_content = { agent: '2' };
  const child = { id: '2', parent: { agent: '1', call: 'create' } };
  const rows = traceRows(
    [response('1', [call('create'), call('resume', { agent: '2' })]), output],
    [],
    null,
    [child],
  );
  assert.deepEqual(rows[0].children, [child]);
  assert.deepEqual(rows[1].children, []);
});
