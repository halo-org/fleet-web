import { compare } from './state.js';

export function compactText(text, limit = 240) {
  const compact = String(text ?? '')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

export function inputSummary(input) {
  if (typeof input === 'string') {
    try {
      return inputSummary(JSON.parse(input));
    } catch {
      return compactText(input);
    }
  }
  if (!input) return '';
  for (const key of [
    'command',
    'cmd',
    'path',
    'file_path',
    'filename',
    'query',
    'url',
    'pattern',
  ]) {
    if (input[key] !== undefined) {
      const value = input[key];
      return compactText(typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  return compactText(JSON.stringify(input));
}

function contentText(content = []) {
  return content
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n\n');
}

export function outputSummary(output) {
  const text = contentText(output.content);
  return (
    compactText(text) ||
    (output.structured_content != null && compactText(JSON.stringify(output.structured_content))) ||
    (output.is_error ? 'Tool returned an error' : 'No output')
  );
}

// A display projection only: never fold results or previews into the durable event cache.
export function traceRows(events, tools = [], preview = null) {
  const ordered = events
    .filter((event) => event.status !== 'deleted')
    .sort((a, b) => compare(a.cursor, b.cursor));
  const pending = new Map(
    tools.filter((tool) => tool.status === 'pending').map((tool) => [tool.id, tool]),
  );
  const calls = new Set();
  const results = new Map();
  for (const event of ordered) {
    if (event.payload.type === 'model_response') {
      for (const block of event.payload.output) if (block.type === 'tool_call') calls.add(block.id);
    } else if (event.payload.type === 'tool_result') {
      results.set(event.payload.call_id, event);
    }
  }

  function toolRow(call, event = null, streaming = false) {
    const id = call.id;
    const result = results.get(id);
    return {
      key: `tool:${id}`,
      kind: 'tool',
      name: call.tool || pending.get(id)?.tool || 'Tool',
      summary:
        inputSummary(call.input) ||
        (event || streaming ? '—' : `Call ${id} · earlier call not loaded`),
      status: result
        ? result.payload.output.is_error
          ? 'error'
          : 'complete'
        : streaming
          ? 'generating'
          : pending.has(id)
            ? 'pending'
            : 'unavailable',
      call,
      event,
      result,
    };
  }

  function outputRows(output, event, inputCursor) {
    return output.map((block, index) => {
      const streaming = !event;
      const previewKey = `preview:${inputCursor}:${block.index ?? index}`;
      const base = {
        key: event ? `event:${event.cursor}:${index}` : previewKey,
        previewKey,
        event,
        block,
        streaming,
      };
      switch (block.type) {
        case 'tool_call':
          return toolRow(block, event, streaming);
        case 'provider_tool_call':
          return {
            ...base,
            key: `provider:${block.call_id}`,
            kind: 'provider_tool',
            name: block.name,
            text: block.content || '',
            summary: compactText(block.content) || 'Provider-managed tool',
            status: streaming ? 'streaming' : 'provider',
          };
        case 'text':
          return {
            ...base,
            kind: 'text',
            text: block.text,
            summary: compactText(block.text) || '…',
          };
        case 'reasoning': {
          const text = block.content || block.text || '';
          return {
            ...base,
            kind: 'reasoning',
            text,
            summary: compactText(text) || 'Reasoning unavailable',
          };
        }
        default:
          return {
            ...base,
            kind: 'unknown',
            text: JSON.stringify(block, null, 2),
            summary: block.type,
          };
      }
    });
  }

  const rows = [];
  let previousCursor = null;
  for (const event of ordered) {
    const payload = event.payload;
    const base = { key: `event:${event.cursor}`, kind: payload.type, event };
    switch (payload.type) {
      case 'model_response':
        if (payload.output.length) rows.push(...outputRows(payload.output, event, previousCursor));
        else rows.push({ ...base, kind: 'text', text: '', summary: 'No visible output' });
        break;
      case 'tool_result':
        // A history page can start between a call and its result. Keep the result visible;
        // the same key will move to the original call's position when it is loaded.
        if (!calls.has(payload.call_id))
          rows.push(toolRow({ ...pending.get(payload.call_id), id: payload.call_id }));
        break;
      case 'input': {
        const text = contentText(payload.content);
        rows.push({ ...base, text, summary: compactText(text) || 'Empty message' });
        break;
      }
      case 'turn_end':
        rows.push({
          ...base,
          reason: payload.reason,
          summary: payload.reason === 'interrupted' ? 'Interrupted' : 'Turn completed',
        });
        break;
      case 'compaction':
        rows.push({
          ...base,
          summary: 'Context compacted',
          text: `Through event ${payload.last_event} · ${payload.input.length} retained inputs`,
        });
        break;
      default:
        rows.push({
          ...base,
          kind: 'unknown',
          summary: payload.type,
          text: JSON.stringify(payload, null, 2),
        });
    }
    previousCursor = event.cursor;
  }

  // Pending calls may predate the loaded history. Do not invent arguments or a start time.
  for (const tool of pending.values()) {
    if (!calls.has(tool.id) && !results.has(tool.id)) rows.push(toolRow(tool));
  }
  const obsolete =
    preview &&
    ordered.some(
      (event) =>
        compare(event.cursor, preview.input_cursor) > 0 &&
        ['model_response', 'compaction', 'turn_end'].includes(event.payload.type),
    );
  if (preview?.status === 'streaming' && !obsolete) {
    const known = new Set(rows.map((row) => row.key));
    for (const row of outputRows(
      [...preview.output].sort((a, b) => a.index - b.index),
      null,
      preview.input_cursor,
    )) {
      if (!known.has(row.key)) rows.push(row);
    }
  }
  return rows;
}
