import { node, icon, copyButton, contentText, contentImages } from './render.js';
import { outputSummary } from './trace.js';

const statuses = {
  generating: ['Generating arguments', 'clock'],
  streaming: ['Streaming', 'clock'],
  pending: ['Awaiting result', 'clock'],
  complete: ['Completed', 'check'],
  error: ['Tool error', 'close'],
  unavailable: ['Result unavailable', 'code'],
  provider: ['Handled by provider', 'code'],
};
const kinds = {
  input: ['Your message', 'arrow-up'],
  text: ['Agent response', 'spark'],
  reasoning: ['Reasoning', 'compass'],
  tool: ['Tool call', 'code'],
  provider_tool: ['Provider tool', 'code'],
  compaction: ['Context compacted', 'compass'],
  turn_end: ['Turn ended', 'check'],
  unknown: ['Event', 'code'],
};
const excerptLength = 12_000;

function setText(element, text) {
  if (element.textContent === text) return;
  // Appending streamed text keeps existing selections intact.
  const child = element.firstChild;
  if (child?.nodeType === 3 && element.childNodes.length === 1 && text.startsWith(child.data))
    child.appendData(text.slice(child.length));
  else element.textContent = text;
}

function rawEvents(row) {
  return [row.event, row.result].filter(Boolean);
}

function metadata(row) {
  const parts = [];
  if (row.call) {
    parts.push(`Call ${row.call.id}`);
    if (row.call.is_async) parts.push('Async');
  }
  if (row.kind === 'provider_tool') parts.push(`Provider call ${row.block.call_id}`);
  const model = row.event?.payload.provenance?.model_id;
  if (model) parts.push(model);
  const events = rawEvents(row);
  if (events.length) parts.push(`Events ${events.map((event) => event.cursor).join(', ')}`);
  return parts.join(' · ');
}

function sections(row) {
  if (row.kind === 'tool') {
    const input = row.call.input;
    const result = row.result?.payload.output;
    const values = [
      {
        key: 'arguments',
        label: row.status === 'generating' ? 'Arguments · generating' : 'Arguments',
        text:
          input === undefined
            ? 'Call arguments are not in the loaded history. Load earlier to see them.'
            : typeof input === 'string'
              ? input
              : JSON.stringify(input, null, 2),
        copy: input !== undefined,
      },
    ];
    if (result) {
      const images = result.content.filter((block) => block.type === 'image');
      const content = contentText(result.content.filter((block) => block.type !== 'image'));
      if (content || images.length || result.structured_content == null)
        values.push({
          key: 'result',
          label: result.is_error ? 'Error' : 'Result',
          text: content || (images.length ? '' : 'No output'),
          copy: !!content,
          images,
        });
      if (result.structured_content != null)
        values.push({
          key: 'structured',
          label: 'Structured output',
          text: JSON.stringify(result.structured_content, null, 2),
          copy: true,
        });
    } else {
      values.push({ key: 'result', label: 'Result', text: statuses[row.status][0], copy: false });
    }
    return values;
  }
  const label = kinds[row.kind][0];
  const content = row.kind === 'input' ? row.event.payload.content : [];
  const text =
    row.kind === 'input'
      ? contentText(content.filter((block) => block.type !== 'image'))
      : row.text || row.summary;
  return [
    {
      key: 'content',
      label,
      text,
      copy: row.kind === 'input' ? !!text : !!row.text,
      prose: ['input', 'text', 'reasoning'].includes(row.kind),
      images: content.filter((block) => block.type === 'image'),
    },
  ];
}

function updateSection(section) {
  const text = section.full ? section.text : section.text.slice(0, excerptLength);
  setText(section.pre, text);
  section.more.hidden = section.full || section.text.length <= excerptLength;
  section.more.textContent = `Show all ${section.text.length.toLocaleString()} characters`;
}

function updateDetails(element) {
  if (!element.open) return;
  if (!element.body) {
    element.body = node('div', 'trace-detail');
    element.sections = new Map();
    element.footer = node('div', 'trace-detail-footer');
    element.meta = node('span', 'trace-meta');
    element.raw = node('button', 'text-button', 'Raw events');
    element.raw.type = 'button';
    element.raw.setAttribute('aria-haspopup', 'dialog');
    element.raw.onclick = () => {
      const events = rawEvents(element.row);
      document.getElementById('event-title').textContent =
        `Events ${events.map((event) => event.cursor).join(', ')}`;
      document.getElementById('event-detail').textContent = JSON.stringify(
        events.length === 1 ? events[0] : events,
        null,
        2,
      );
      document.getElementById('event-dialog').showModal();
    };
    element.footer.append(element.meta, element.raw);
    element.body.append(element.footer);
    element.append(element.body);
  }
  const keep = new Set();
  for (const value of sections(element.row)) {
    keep.add(value.key);
    let section = element.sections.get(value.key);
    if (!section) {
      section = node('section', 'trace-section');
      const heading = node('div', 'trace-section-heading');
      section.label = node('span');
      section.copy = copyButton(
        () => section.text,
        `Copy ${value.key === 'structured' ? 'structured output' : value.key}`,
      );
      heading.append(section.label, section.copy);
      section.pre = node('pre');
      section.pre.tabIndex = 0;
      section.more = node('button', 'text-button trace-show-more');
      section.more.type = 'button';
      section.more.onclick = () => {
        section.full = true;
        updateSection(section);
        section.pre.focus({ preventScroll: true });
      };
      section.images = node('div');
      section.append(heading, section.pre, section.more, section.images);
      element.sections.set(value.key, section);
      element.body.insertBefore(section, element.footer);
    }
    section.text = value.text;
    setText(section.label, value.label);
    section.copy.hidden = !value.copy;
    section.pre.hidden = !value.text;
    section.pre.classList.toggle('trace-prose', !!value.prose);
    section.pre.setAttribute('aria-label', value.label);
    const images = value.images || [];
    const signature = JSON.stringify(images);
    if (section.images.signature !== signature) {
      section.images.replaceChildren(...contentImages(images));
      section.images.signature = signature;
    }
    updateSection(section);
  }
  for (const [key, section] of element.sections) {
    if (!keep.has(key)) {
      section.remove();
      element.sections.delete(key);
    }
  }
  setText(element.meta, metadata(element.row));
  element.raw.hidden = !rawEvents(element.row).length;
}

function createRow(expanded) {
  const element = node('details', 'trace-row');
  const summary = node('summary', 'trace-line');
  const chevron = node('span', 'trace-chevron');
  chevron.append(icon('chevron'));
  element.symbol = node('span', 'trace-symbol');
  element.toolName = node('span', 'trace-name');
  element.summary = node('span', 'trace-summary');
  element.outcome = node('span', 'trace-outcome');
  summary.append(chevron, element.symbol, element.toolName, element.summary, element.outcome);
  element.append(summary);
  element.addEventListener('toggle', () => {
    if (!element.isConnected) return;
    if (element.open) expanded.add(element.dataset.key);
    else expanded.delete(element.dataset.key);
    updateDetails(element);
  });
  return element;
}

function updateRow(element, row) {
  element.row = row;
  element.dataset.key = row.key;
  element.dataset.kind = row.kind;
  element.dataset.status = row.status || (row.streaming ? 'streaming' : '');
  element.dataset.reason = row.reason || '';
  element.dataset.cursor = row.event?.cursor || row.result?.cursor || '';
  const [label, kindSymbol] = kinds[row.kind];
  const [status, statusSymbol] = statuses[element.dataset.status] || ['', kindSymbol];
  const symbol = row.reason === 'interrupted' ? 'stop' : statusSymbol;
  if (element.symbol.dataset.icon !== symbol) {
    element.symbol.dataset.icon = symbol;
    element.symbol.replaceChildren(icon(symbol));
  }
  element.symbol.title = [label, status].filter(Boolean).join(' · ');
  element.symbol.setAttribute('aria-hidden', 'true');
  element.firstElementChild.title = element.symbol.title;
  setText(element.toolName, row.name || '');
  element.toolName.hidden = !row.name;
  setText(element.summary, row.summary);
  let outcome = '';
  if (row.kind === 'tool') {
    outcome = row.result ? outputSummary(row.result.payload.output) : status;
    if (row.status === 'error') outcome = `Error · ${outcome}`;
  } else if (row.kind === 'provider_tool') {
    outcome = status;
  }
  setText(element.outcome, outcome);
  element.outcome.hidden = !outcome;
  element.outcome.title = outcome;
  element.firstElementChild.setAttribute(
    'aria-label',
    [label, row.name, status, row.summary, outcome !== status ? outcome : '']
      .filter(Boolean)
      .join(' · '),
  );
  updateDetails(element);
}

export function renderTrace(container, rows, expanded) {
  if (container.dataset.view !== 'trace') {
    container.replaceChildren();
    container.dataset.view = 'trace';
  }
  const active = container.contains(document.activeElement) ? document.activeElement : null;
  const old = new Map([...container.children].map((element) => [element.dataset.key, element]));
  const keep = new Set();
  let position = container.firstElementChild;
  for (const row of rows) {
    let element = old.get(row.key) || old.get(row.previewKey);
    if (!element) {
      element = createRow(expanded);
      element.open = expanded.has(row.key);
    } else if (element.dataset.key !== row.key) {
      // Keep an open preview's DOM and disclosure state when its response commits.
      expanded.delete(element.dataset.key);
      if (element.open) expanded.add(row.key);
    }
    updateRow(element, row);
    keep.add(element);
    if (element !== position) container.insertBefore(element, position);
    position = element.nextElementSibling;
  }
  for (const element of [...container.children]) if (!keep.has(element)) element.remove();
  if (active?.isConnected && document.activeElement !== active)
    active.focus({ preventScroll: true });
}
