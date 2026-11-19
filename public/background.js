import { icon, node } from './render.js';
import { renderAgentLinks } from './trace-render.js';

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function createCall() {
  const item = node('li', 'background-call');
  item.link = node('a', 'trace-line background-line');
  const symbol = node('span', 'trace-symbol');
  symbol.setAttribute('aria-hidden', 'true');
  symbol.append(icon('clock'));
  item.name = node('span', 'trace-name');
  item.summary = node('span', 'trace-summary');
  const show = node('span', 'background-show');
  show.setAttribute('aria-hidden', 'true');
  show.append(icon('arrow-up'));
  item.link.append(symbol, item.name, item.summary, show);
  item.agents = node('ul', 'trace-agent-list');
  item.append(item.link, item.agents);
  return item;
}

/** Trace's index of async calls still running. Rows are keyed so focus survives updates. */
export function renderBackground(container, calls, agentId, agentTitle) {
  container.hidden = !calls.length;
  const list = container.querySelector('.background-list');
  const old = new Map([...list.children].map((item) => [item.dataset.id, item]));
  const keep = new Set();
  let position = list.firstElementChild;
  for (const call of calls) {
    const item = old.get(call.id) || createCall();
    item.dataset.id = call.id;
    item.classList.toggle('unloaded', !call.loaded);
    setText(item.name, call.name);
    // Agents' titles often repeat the arguments. Their links say enough on their own.
    const repeated =
      call.children.length && call.children.every((agent) => agentTitle(agent) === call.summary);
    const summary =
      repeated || (!call.summary && call.children.length)
        ? ''
        : call.summary || (call.loaded ? 'No arguments' : 'Earlier call not loaded');
    setText(item.summary, summary);
    item.link.href = `#agent/${agentId}?call=${encodeURIComponent(call.id)}`;
    item.link.dataset.call = call.id;
    item.link.title = 'Show call';
    item.link.setAttribute('aria-label', [call.name, summary, 'Show call'].filter(Boolean).join(' · '));
    renderAgentLinks(item.agents, call.children, agentTitle);
    item.agents.hidden = !call.children.length;
    keep.add(item);
    if (item !== position) list.insertBefore(item, position);
    position = item.nextElementSibling;
  }
  for (const item of [...list.children]) if (!keep.has(item)) item.remove();
}
