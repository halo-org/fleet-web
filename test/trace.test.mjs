import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceRows, inputSummary, outputSummary, compactText } from '../public/trace.js';
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
const pending = (id) => ({ id, tool: 'read', status: 'pending', is_async: false });
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
  const live = traceRows([], [], preview('1', [{ ...provider, index: 0 }]))[0];
  assert.equal(live.status, 'streaming');
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
  assert.equal(rows[0].summary, 'Reasoning unavailable');
  assert.equal(rows[0].text, '');
  assert.equal(rows[0].block.redacted_content, 'secret-opaque');
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
