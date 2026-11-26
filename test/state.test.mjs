import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentList, Conversation, compare } from '../public/state.js';

const input = (cursor, messageId = cursor) => ({
  status: 'settled',
  cursor,
  payload: { type: 'input', message_id: messageId, content: [] },
});
const summary = (version, inbox = 'pending') => ({
  id: '7',
  version,
  inbox,
  role: 'test',
  position: `${inbox}:10:7`,
});

test('merges collection pages without replacing newer updates', () => {
  const list = new AgentList();
  list.update({ agents: [summary('12', 'settled')] }, '12');
  list.page({ agents: [summary('8')] });

  assert.equal(list.section('pending').length, 0);
  assert.equal(list.section('settled').length, 1);

  list.update({ removed: ['7'] }, '13');
  list.page({ agents: [summary('12')] });

  assert.equal(list.agents.values().length, 0);
});

test('pinned agents leave their section in pin order until snoozed', () => {
  const list = new AgentList();
  list.page({
    agents: [
      { ...summary('1'), id: '1', pinned: 20 },
      { ...summary('2', 'busy'), id: '2', pinned: 10 },
      { ...summary('3'), id: '3' },
      { ...summary('4', 'snoozed'), id: '4', pinned: 5 },
    ],
  });

  assert.deepEqual(list.pinned().map((agent) => agent.id), ['2', '1']);
  assert.deepEqual(list.section('pending').map((agent) => agent.id), ['3']);
  assert.deepEqual(list.section('busy'), []);
  assert.deepEqual(list.section('snoozed').map((agent) => agent.id), ['4']);
});

test('snapshots reject replayed messages, including ones absent from the snapshot', () => {
  const log = new Conversation();
  log.messages.snapshot([], '10');
  log.update({ messages: [{ id: '2', status: 'pending' }] }, '9');
  log.update({ messages: [{ id: '3', status: 'pending' }] }, '10');

  assert.deepEqual(log.pendingMessages(), []);

  log.update({ messages: [{ id: '4', status: 'pending', position: '1' }] }, '11');

  assert.equal(log.pendingMessages()[0].id, '4');
});

test('committed inputs replace queued messages even when their streams arrive separately', () => {
  const log = new Conversation();
  log.messages.snapshot([{ id: '5', position: '1', status: 'pending' }], '2');
  log.update({ events: [input('8', '5')] }, '3');

  assert.deepEqual(log.pendingMessages(), []);
});

test('merges overlapping history and preserves later edits and deletions', () => {
  const log = new Conversation();
  log.eventPage([input('20'), input('19')], '8');
  log.update({ events: [{ cursor: '19', status: 'deleted' }] }, '12');
  log.eventPage([input('19'), input('18')], '10', '20');
  log.update({ events: [input('19')] }, '9');

  assert.deepEqual(
    log.orderedEvents().map((event) => event.cursor),
    ['18', '20'],
  );
});

test('appends preview fragments and ignores previews already committed', () => {
  const log = new Conversation();
  const preview = {
    status: 'streaming',
    input_cursor: '4',
    output: [{ index: 0, type: 'text', text: 'Hello' }],
  };
  log.previewEvent({ type: 'preview', data: JSON.stringify(preview) });
  log.previewEvent({ type: 'preview_block', data: '{"index":0}' });
  log.previewEvent({ type: 'preview_text', data: ', world\n' });

  assert.equal(log.preview.output[0].text, 'Hello, world\n');

  log.update(
    {
      events: [{ status: 'settled', cursor: '5', payload: { type: 'model_response', output: [] } }],
    },
    '6',
  );
  log.previewEvent({ type: 'preview', data: JSON.stringify(preview) });

  assert.equal(log.preview, null);
});

test('compaction replaces response previews without accumulating output or history', () => {
  const log = new Conversation();
  const streaming = {
    status: 'streaming',
    input_cursor: '4',
    output: [{ index: 0, type: 'text', text: 'Hello' }],
  };
  const compacting = { status: 'compacting', input_cursor: '4' };
  log.previewEvent({ type: 'preview', data: JSON.stringify(streaming) });
  log.previewEvent({ type: 'preview_block', data: '{"index":0}' });
  log.previewEvent({ type: 'preview', data: JSON.stringify(compacting) });
  log.previewEvent({ type: 'preview_block', data: '{"index":0,"type":"text"}' });
  log.previewEvent({ type: 'preview_text', data: 'Ignored' });

  assert.deepEqual(log.preview, compacting);
  assert.equal(log.previewBlock, null);
  assert.equal(log.activity.turn, 'idle');
  assert.deepEqual(log.orderedEvents(), []);

  log.previewEvent({ type: 'preview', data: JSON.stringify(streaming) });
  assert.deepEqual(log.preview, streaming);
  log.previewEvent({ type: 'preview', data: '{"status":"idle"}' });
  assert.equal(log.preview, null);
});

test('committed events supersede compaction regardless of subscription ordering', () => {
  const compacting = { status: 'compacting', input_cursor: '4' };
  for (const type of ['input', 'model_response', 'tool_result', 'compaction', 'turn_end']) {
    const log = new Conversation();
    log.previewEvent({ type: 'preview', data: JSON.stringify(compacting) });
    log.eventPage([{ status: 'settled', cursor: '5', payload: { type } }], '6');
    assert.equal(log.preview, null);

    log.previewEvent({ type: 'preview', data: JSON.stringify(compacting) });
    assert.equal(log.preview, null);
  }
});

test('compaction previews survive stale interrupt activity', () => {
  const log = new Conversation();
  const compacting = { status: 'compacting', input_cursor: '5' };

  log.previewEvent({ type: 'preview', data: JSON.stringify(compacting) });
  log.update({ activity: { turn: 'idle', interrupt_pending: true } }, '6');
  assert.deepEqual(log.preview, compacting);

  log.previewEvent({ type: 'preview', data: JSON.stringify(compacting) });
  assert.deepEqual(log.preview, compacting);

  log.update(
    {
      activity: { turn: 'idle', interrupt_pending: false },
      events: [{ status: 'settled', cursor: '5', payload: { type: 'turn_end' } }],
    },
    '7',
  );
  assert.deepEqual(log.preview, compacting);

  log.previewEvent({ type: 'preview', data: '{"status":"idle"}' });
  assert.equal(log.preview, null);
});

test('provider-tool preview fragments append to readable content', () => {
  const log = new Conversation();
  log.previewEvent({
    type: 'preview',
    data: JSON.stringify({ status: 'streaming', input_cursor: '1', output: [] }),
  });
  log.previewEvent({
    type: 'preview_block',
    data: JSON.stringify({
      index: 2,
      type: 'provider_tool_call',
      call_id: 'search',
      name: 'web_search',
    }),
  });
  log.previewEvent({ type: 'preview_text', data: 'Found ' });
  log.previewEvent({ type: 'preview_block', data: '{"index":2}' });
  log.previewEvent({ type: 'preview_text', data: 'references' });
  assert.equal(log.preview.output[0].content, 'Found references');

  log.previewEvent({
    type: 'preview',
    data: JSON.stringify({
      status: 'streaming',
      input_cursor: '1',
      output: [
        {
          index: 2,
          type: 'provider_tool_call',
          call_id: 'search',
          name: 'web_search',
          content: 'Replacement',
        },
      ],
    }),
  });
  log.previewEvent({ type: 'preview_block', data: '{"index":2}' });
  log.previewEvent({ type: 'preview_text', data: ' content' });
  assert.equal(log.preview.output[0].content, 'Replacement content');
});

test('tool preview fragments remain partial JSON until committed', () => {
  const log = new Conversation();
  log.previewEvent({
    type: 'preview',
    data: JSON.stringify({ status: 'streaming', input_cursor: '1', output: [] }),
  });
  log.previewEvent({
    type: 'preview_block',
    data: '{"index":0,"type":"tool_call","id":"a","tool":"read"}',
  });
  log.previewEvent({ type: 'preview_text', data: '{"path":' });
  log.previewEvent({ type: 'preview_text', data: '"file"}' });
  assert.equal(log.preview.output[0].input, '{"path":"file"}');
  assert.equal(log.events.values().length, 0);
});

test('history pages also discard previews superseded by committed events', () => {
  const log = new Conversation();
  log.previewEvent({
    type: 'preview',
    data: JSON.stringify({ status: 'streaming', input_cursor: '1', output: [] }),
  });
  log.eventPage(
    [{ cursor: '2', status: 'settled', payload: { type: 'model_response', output: [] } }],
    '3',
  );
  assert.equal(log.preview, null);
});

test('a tool call is loaded with its model response, not its result', () => {
  const log = new Conversation();
  const output = { is_error: false, content: [], structured_content: null };
  log.eventPage(
    [{ cursor: '9', status: 'settled', payload: { type: 'tool_result', call_id: 'a', output } }],
    '10',
  );
  assert.equal(log.hasToolCall('a'), false);

  const call = { type: 'tool_call', id: 'a', tool: 'agent', input: {}, is_async: true };
  log.eventPage(
    [{ cursor: '2', status: 'settled', payload: { type: 'model_response', output: [call] } }],
    '10',
    '9',
  );
  assert.equal(log.hasToolCall('a'), true);
});

test('metadata edits respect snapshot watermarks and preserve explicit title clears', () => {
  const log = new Conversation();
  log.metadata = { id: '7', title: 'Snapshot', metadata_version: '9' };
  log.metadataRevision = '12';
  log.update({ agent: { id: '7', title: 'Stale', metadata_version: '9' } }, '9');
  assert.equal(log.metadata.title, 'Snapshot');
  log.update({ agent: { id: '7', title: null, metadata_version: '13' } }, '13');
  log.update({ agent: { id: '7', title: 'Old title', metadata_version: '11' } }, '11');
  assert.equal(log.metadata.title, null);
  assert.equal(log.metadata.metadata_version, '13');
  assert.equal(log.metadataRevision, '13');
});

test('bootstrap can receive activity before the current metadata version', () => {
  const log = new Conversation();
  log.update({ activity: { turn: 'idle', interrupt_pending: false } }, '1');
  assert.equal(log.metadata, null);
  log.update({ agent: { id: '7', title: 'Renamed', metadata_version: '5' } }, '5');
  assert.equal(log.metadata.title, 'Renamed');
  assert.equal(log.activityRevision, '1');
});

test('orders cursors beyond JavaScript number precision', () => {
  assert.equal(
    compare('340282366920938463463374607431768211454', '340282366920938463463374607431768211455'),
    -1,
  );
});

test('child summaries stay out of every sidebar section and pins', () => {
  const list = new AgentList();
  const children = ['pending', 'busy', 'snoozed', 'settled'].map((inbox, i) => ({
    ...summary('10', inbox),
    id: String(i + 2),
    pinned: 1,
    parent: { agent: '1', call: 'delegate' },
  }));
  list.page({ agents: [summary('1')] });
  list.update({ agents: children }, '10');

  assert.deepEqual(list.pinned(), []);
  assert.deepEqual(
    list.section('pending').map((agent) => agent.id),
    ['7'],
  );
  for (const inbox of ['busy', 'snoozed', 'settled']) assert.deepEqual(list.section(inbox), []);
  assert.deepEqual(list.children('1'), children);
  assert.deepEqual(list.children('7'), []);
});

test('child pages cannot replace newer collection updates or resurrect removed children', () => {
  const list = new AgentList();
  const child = { ...summary('8'), parent: { agent: '1', call: 'a' } };
  const current = { ...child, version: '12', inbox: 'busy', title: 'Working' };
  list.update({ agents: [current] }, '12');
  list.page({ agents: [child] });
  assert.deepEqual(list.children('1'), [current]);

  list.update({ removed: [child.id] }, '13');
  list.page({ agents: [current] });
  assert.deepEqual(list.children('1'), []);
});

test('child lists include only direct children and order large IDs without loss of precision', () => {
  const list = new AgentList();
  const small = '340282366920938463463374607431768211454';
  const large = '340282366920938463463374607431768211455';
  list.page({
    agents: [
      { ...summary('1'), id: large, parent: { agent: '1', call: 'a' } },
      { ...summary('1'), id: '3', parent: { agent: large, call: 'a' } },
      { ...summary('1'), id: small, parent: { agent: '1', call: 'b' } },
    ],
  });
  assert.deepEqual(
    list.children('1').map((agent) => agent.id),
    [small, large],
  );
  assert.deepEqual(
    list.children(large).map((agent) => agent.id),
    ['3'],
  );
});

test('a deleted agent and its subagents stay gone after stale pages and updates', () => {
  const list = new AgentList();
  const child = { ...summary('8'), id: '9', parent: { agent: '7', call: 'a' } };
  const grandchild = { ...summary('8'), id: '10', parent: { agent: '9', call: 'b' } };
  list.page({ agents: [summary('8'), child, grandchild, { ...summary('8'), id: '11' }] });

  assert.deepEqual(list.delete('7'), ['7', '9', '10']);
  assert.deepEqual(list.delete('7'), []);
  list.page({ agents: [summary('8'), child] });
  list.update({ agents: [summary('12', 'busy')] }, '12');
  assert.deepEqual(
    list.agents.values().map((agent) => agent.id),
    ['11'],
  );

  // The collection reports the deletion later, and only what it hadn't reported counts as new.
  assert.deepEqual(list.update({ removed: ['7', '9', '10', '11'] }, '13'), ['11']);
  assert.deepEqual(list.agents.values(), []);

  const reloaded = new AgentList(list.deleted);
  reloaded.page({ agents: [summary('8'), { ...summary('8'), id: '11' }] });
  assert.deepEqual(reloaded.agents.values(), []);
});

test('late subagent summaries under a deleted parent stay gone', () => {
  const list = new AgentList();
  list.page({ agents: [summary('8')] });
  list.delete('7');
  list.update({ agents: [{ ...summary('9'), id: '8', parent: { agent: '7', call: 'a' } }] }, '9');
  list.page({ agents: [{ ...summary('9'), id: '10', parent: { agent: '8', call: 'b' } }] });

  assert.deepEqual(list.agents.values(), []);
  assert.deepEqual([...list.deleted], ['7', '8', '10']);
});
