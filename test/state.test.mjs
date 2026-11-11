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
