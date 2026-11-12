import { blobUrl } from './uploads.js';
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

const paths = {
  fleet: '<path d="m4 17 6-13v13H4Zm8 0V7l8 10h-8ZM3 20h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  'arrow-up': '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  'arrow-down': '<path d="M12 5v14m-6-6 6 6 6-6"/>',
  'arrow-right': '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  conversation:
    '<path d="M20 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1v-9.5A8.5 8.5 0 0 1 20 11.5Z"/><path d="M7 9h9M7 13h6"/>',
  code: '<path d="m7 7-5 5 5 5m10-10 5 5-5 5m-4-13-2 16"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-3 5-5 3 3-5 5-3Z"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  edit: '<path d="m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14v6Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  sliders:
    '<path d="M4 7h8m4 0h4M4 17h3m4 0h9"/><circle cx="14" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  sunrise: '<path d="M3 17h18M5 21h14M7 17a5 5 0 0 1 10 0M12 2v7m-3-3 3-3 3 3M3 10l2 2m14 0 2-2"/>',
};

export function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function icon(name) {
  const span = node('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.conversation}</svg>`;
  return span.firstElementChild;
}

export function populateIcons() {
  for (const element of document.querySelectorAll('[data-icon]'))
    element.replaceChildren(icon(element.dataset.icon));
}

export function markdown(text) {
  const element = node('div', 'markdown');
  element.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: false, async: false }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['img', 'input', 'form', 'button', 'video', 'audio', 'style'],
    FORBID_ATTR: ['style', 'id', 'name'],
  });
  for (const link of element.querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  for (const pre of element.querySelectorAll('pre')) {
    const block = node('div', 'code-block');
    pre.replaceWith(block);
    block.append(pre, copyButton(pre.textContent, 'Copy code', 'code-copy'));
  }
  return element;
}

export function copyButton(text, label, className = '') {
  const button = node('button', `icon-button ${className}`);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon('copy'));
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
      button.replaceChildren(icon('check'));
      button.setAttribute('aria-label', 'Copied');
      setTimeout(() => {
        button.replaceChildren(icon('copy'));
        button.setAttribute('aria-label', label);
      }, 1500);
    } catch {
      button.title = 'Copy unavailable. Select the text to copy it.';
    }
  });
  return button;
}

export function contentText(content = []) {
  return content
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n\n');
}

export function contentImages(content = []) {
  return content
    .filter((block) => block.type === 'image')
    .flatMap((block) => {
      let url;
      try {
        url = blobUrl(block.blob_id);
      } catch {
        return [];
      }
      const link = node('a', 'message-image');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const image = node('img');
      image.src = url;
      image.alt = 'Attached image';
      image.loading = 'lazy';
      image.onerror = () => link.replaceChildren(node('span', '', 'Image unavailable'));
      link.append(image);
      return [link];
    });
}

function userMessage(text, content = []) {
  const element = node('article', 'message user');
  element.setAttribute('aria-label', 'Your message');
  element.append(node('div', 'message-body', text), ...contentImages(content));
  return element;
}

function assistantMessage(output, label, streaming = false) {
  const element = node('article', 'message assistant');
  element.setAttribute('aria-label', streaming ? 'Agent response in progress' : 'Agent response');
  if (label) element.append(node('div', 'message-label', label));
  let hasContent = false;
  for (const block of output) {
    if (block.type === 'text' && block.text) {
      element.append(markdown(block.text));
      hasContent = true;
    }
  }
  if (!hasContent) return null;
  if (!streaming) {
    const text = output
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n');
    if (text) {
      const actions = node('div', 'message-actions');
      actions.append(copyButton(text, 'Copy response'));
      element.append(actions);
    }
  }
  return element;
}

function renderEvent(event, label) {
  const payload = event.payload;
  switch (payload.type) {
    case 'input':
      return userMessage(
        contentText(payload.content.filter((block) => block.type !== 'image')),
        payload.content,
      );
    case 'model_response':
      return assistantMessage(payload.output, label);
    case 'tool_result': {
      const images = contentImages(payload.output.content);
      if (!images.length) return null;
      const element = node('article', 'message assistant');
      element.append(node('div', 'message-label', 'Tool images'), ...images);
      return element;
    }
    case 'compaction':
      return node('div', 'turn-marker', 'Context compacted');
    case 'turn_end':
      return payload.reason === 'interrupted' ? node('div', 'turn-marker', 'Interrupted') : null;
    default:
      return null;
  }
}

/** Renders chat events and returns the model of the newest response, if any. */
export function renderEvents(container, events) {
  if (container.dataset.view !== 'chat') {
    container.replaceChildren();
    container.dataset.view = 'chat';
  }
  const old = new Map([...container.children].map((element) => [element.dataset.cursor, element]));
  const keep = new Set();
  let position = container.firstElementChild;
  let model;
  for (const event of events) {
    // Name the model only where it changes, including the first response in view.
    let label;
    if (event.payload.type === 'model_response') {
      const current = event.payload.provenance?.model_id || 'Agent';
      if (current !== model) label = current;
      model = current;
    }
    const signature = `${label}:${JSON.stringify(event)}`;
    let element = old.get(event.cursor);
    if (element?.signature !== signature) {
      element = renderEvent(event, label);
      if (!element) continue;
      element.signature = signature;
      element.dataset.cursor = event.cursor;
    }
    keep.add(element);
    if (element !== position) container.insertBefore(element, position);
    position = element.nextElementSibling;
  }
  for (const element of [...container.children]) if (!keep.has(element)) element.remove();
  return model;
}

/** A first response is labelled like its committed event, so finishing does not shift it. */
export function renderPreview(container, preview, labelled) {
  const signature = `${labelled}:${JSON.stringify(preview)}`;
  if (container.signature === signature) return;
  container.signature = signature;
  const output =
    preview?.status === 'streaming' && [...preview.output].sort((a, b) => a.index - b.index);
  const message = output && assistantMessage(output, labelled && 'Responding…', true);
  container.replaceChildren(...(message ? [message] : []));
}

function tracePending(label, text) {
  const element = node('div', 'trace-line trace-pending');
  element.setAttribute('aria-label', `${label}: ${text}`);
  const symbol = node('span', 'trace-symbol');
  symbol.append(icon('clock'));
  symbol.title = label;
  element.append(
    symbol,
    node('span', 'trace-summary', text.replaceAll(/\s+/g, ' ').slice(0, 400)),
    node('span', 'trace-outcome', label),
  );
  return element;
}

/** Steering messages read as sent; they join the turn at its next step. */
export function renderPending(container, messages, trace) {
  const signature = `${trace}:${JSON.stringify(messages)}`;
  if (container.signature === signature) return;
  container.signature = signature;
  container.replaceChildren(
    ...messages.map((message) =>
      trace
        ? tracePending('Pending', contentText(message.content))
        : userMessage(
            contentText(message.content.filter((block) => block.type !== 'image')),
            message.content,
          ),
    ),
  );
}

function queuedSummary(content) {
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  const images = content.filter((block) => block.type === 'image').length;
  const other = content.filter((block) => !['text', 'image'].includes(block.type)).length;
  const extras = [
    images && (images === 1 ? '1 image' : `${images} images`),
    other && (other === 1 ? '1 attachment' : `${other} attachments`),
  ].filter(Boolean);
  return { text: text.slice(0, 400), extras: extras.join(', ') };
}

/** One line per queued message, keyed by ID so existing rows stay put. */
export function renderQueue(container, messages) {
  const old = new Map([...container.children].map((element) => [element.dataset.id, element]));
  const keep = new Set();
  let position = container.firstElementChild;
  for (const message of messages) {
    const signature = JSON.stringify(message.content);
    let row = old.get(message.id);
    if (row?.signature !== signature) {
      const { text, extras } = queuedSummary(message.content);
      row = node('li', 'queued-message');
      row.dataset.id = message.id;
      row.signature = signature;
      row.title = text || extras;
      row.append(icon('clock'), node('span', 'queued-text', text || extras));
      if (text && extras) row.append(node('span', 'queued-extras', extras));
    }
    keep.add(row);
    if (row !== position) container.insertBefore(row, position);
    position = row.nextElementSibling;
  }
  for (const element of [...container.children]) if (!keep.has(element)) element.remove();
  container.hidden = !keep.size;
}

export function relativeTime(time) {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (Math.abs(minutes) < 1) return 'now';
  if (minutes < 0) {
    const hours = Math.ceil(-minutes / 60);
    return -minutes < 60
      ? `in ${-minutes}m`
      : hours < 24
        ? `in ${hours}h`
        : `in ${Math.ceil(hours / 24)}d`;
  }
  return minutes < 60
    ? `${minutes}m`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)}h`
      : `${Math.floor(minutes / 1440)}d`;
}

export function renderAgentList(container, agents, activeId, title, roleTitle, emptyText) {
  const old = new Map(
    [...container.querySelectorAll('.agent-row')].map((element) => [element.dataset.id, element]),
  );
  container.querySelector('.list-empty')?.remove();
  const keep = new Set();
  let position = container.firstElementChild;
  for (const agent of agents) {
    let element = old.get(agent.id);
    const time = agent.inbox === 'snoozed' ? agent.until : agent.since;
    const role = roleTitle(agent.role);
    const signature = `${JSON.stringify(agent)}:${title(agent)}:${role}:${relativeTime(time)}:${agent.id === activeId}`;
    if (!element) {
      element = node('a', 'agent-row');
      element.dataset.id = agent.id;
      element.href = `#agent/${agent.id}`;
    }
    if (element.signature !== signature) {
      element.signature = signature;
      element.setAttribute('aria-current', String(agent.id === activeId));
      element.title = title(agent);
      const meta = node('span', 'agent-meta');
      meta.append(
        node('span', `state-dot ${agent.inbox}`),
        document.createTextNode(agent.interrupt_pending ? 'Interrupting…' : role),
      );
      const timestamp = node('time', 'agent-time', relativeTime(time));
      timestamp.dateTime = new Date(time).toISOString();
      timestamp.title = new Date(time).toLocaleString();
      element.replaceChildren(node('span', 'agent-title', title(agent)), timestamp, meta);
    }
    keep.add(element);
    if (element !== position) container.insertBefore(element, position);
    position = element.nextElementSibling;
  }
  for (const element of [...container.children]) if (!keep.has(element)) element.remove();
  if (!agents.length && emptyText) container.append(node('p', 'list-empty', emptyText));
}
