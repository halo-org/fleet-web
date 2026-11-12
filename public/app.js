import { Attachments } from './attachments.js';
import { composerAction } from './composer.js';
import { enableDeliveryChoice } from './delivery.js';
import { enableMenu } from './menu.js';
import { request, prepareWrite, write, subscribe, newId } from './api.js';
import { AgentList, Conversation, minimum } from './state.js';
import { RolePicker } from './roles.js';
import { renderRole, renderRoleError, renderRoleList } from './role-view.js';
import { distanceFromEnd, followPosition } from './scroll.js';
import { enableSidebarSwipe } from './sidebar.js';
import { TitleEdit, agentTitle, initialTitle, newestMetadata } from './titles.js';
import { traceRows } from './trace.js';
import { renderTrace } from './trace-render.js';
import {
  node,
  icon,
  populateIcons,
  renderEvents,
  renderPreview,
  renderPending,
  renderQueue,
  renderAgentList,
} from './render.js';

const $ = (id) => document.getElementById(id);
const mobile = matchMedia('(max-width: 760px)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const scrollArea = $('scroll-area');
let following = true;
let seekingEnd = false;
let lastScrollTop = 0;
let list = new AgentList();
let listController;
let listStatus = 'connecting';
let settledNext;
let settledLoaded = false;
let settledLoading = false;
let focused = null;
let roleView = null;
let trace = false;
let sending = false;
const interrupting = new Set();
let inboxWriting = false;
let titleEdit = null;
let frame;
let eventsChanged = false;
let pendingWrite = readLocal('pending-write', null);
const drafts = readLocal('drafts', {});
const inboxMenu = enableMenu({
  button: $('inbox-button'),
  menu: $('inbox-menu'),
  available: canChangeStatus,
});
const attachments = new Attachments($('attachments'), draftKey, renderHeader, toast);
const rolePicker = new RolePicker($('role-picker'), readLocal('role', ''), renderHeader);
const delivery = enableDeliveryChoice({
  button: $('send'),
  menu: $('delivery'),
  composer: $('composer'),
  available: () => $('send').classList.contains('has-options'),
});

function readLocal(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`fleet.${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveLocal(key, value) {
  try {
    localStorage.setItem(`fleet.${key}`, JSON.stringify(value));
  } catch {
    /* Storage may be unavailable. */
  }
}

function roleTitle(name) {
  return rolePicker.roleTitle(name);
}

function title(agent) {
  const metadata = agent.id === focused?.id ? newestMetadata(agent, focused.log.metadata) : agent;
  return agentTitle(metadata, roleTitle(metadata.role));
}
function draftKey() {
  return focused?.id || 'new';
}
function updateJump() {
  $('jump-latest').hidden = !focused || distanceFromEnd(scrollArea) < 80;
}

function newestResponseTop() {
  if (trace) return undefined;
  const last = $('events').lastElementChild;
  const response =
    $('preview').firstElementChild || (last?.matches('.message.assistant') ? last : null);
  if (!response) return undefined;
  const offset = response.getBoundingClientRect().top - scrollArea.getBoundingClientRect().top;
  return Math.round(scrollArea.scrollTop + offset - 16);
}

/** Keeps new content in view until a response fills the screen, then lets it be read. */
function keepFollowing() {
  if (!focused || !following) return;
  const { top, follow, smooth } = followPosition({
    scrollTop: scrollArea.scrollTop,
    scrollHeight: scrollArea.scrollHeight,
    clientHeight: scrollArea.clientHeight,
    responseTop: seekingEnd ? undefined : newestResponseTop(),
  });
  following = follow;
  if (Math.abs(top - scrollArea.scrollTop) >= 1)
    scrollArea.scrollTo({ top, behavior: smooth && !reducedMotion.matches ? 'smooth' : 'instant' });
  lastScrollTop = scrollArea.scrollTop;
  updateJump();
}

/** The keyboard and composer resize the view; stay pinned to the end without motion. */
function keepPinned() {
  if (!focused || !following) return;
  scrollArea.scrollTo({ top: scrollArea.scrollHeight, behavior: 'instant' });
  lastScrollTop = scrollArea.scrollTop;
  updateJump();
}

function toLatest(smooth = false) {
  following = true;
  seekingEnd = true;
  scrollArea.scrollTo({
    top: scrollArea.scrollHeight,
    behavior: smooth && !reducedMotion.matches ? 'smooth' : 'instant',
  });
  lastScrollTop = scrollArea.scrollTop;
  updateJump();
}

function toast(message, action) {
  const element = node('div', 'toast');
  element.append(node('span', '', message));
  if (action) {
    const button = node('button', 'toast-action', action.label);
    button.type = 'button';
    button.onclick = () => {
      action.run();
      element.remove();
    };
    element.append(button);
  }
  const dismiss = node('button', 'toast-dismiss');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Dismiss notification');
  dismiss.append(icon('close'));
  dismiss.onclick = () => element.remove();
  element.append(dismiss);
  $('toasts').replaceChildren(element);
  setTimeout(() => element.remove(), action ? 12_000 : 6500);
}

function notice(message, retry) {
  $('view-notice').replaceChildren();
  $('view-notice').hidden = !message;
  if (!message) return;
  $('view-notice').append(node('span', '', message));
  if (retry) {
    const button = node('button', '', 'Retry');
    button.onclick = retry;
    $('view-notice').append(button);
  }
}

function updateConnection() {
  const state =
    listStatus === 'live' && (!focused || focused.status === 'live')
      ? 'live'
      : listStatus === 'offline' || focused?.status === 'offline'
        ? 'offline'
        : 'connecting';
  $('connection').dataset.state = state;
  $('connection-text').textContent = {
    live: 'Connected',
    connecting: 'Connecting…',
    offline: 'Reconnecting…',
  }[state];
}

function renderSidebar() {
  const none = !list.agents.values().length;
  const pinned = list.pinned();
  $('pinned').hidden = !pinned.length;
  renderAgentList($('list-pinned'), pinned, focused?.id, title, roleTitle);
  for (const inbox of ['pending', 'busy', 'snoozed', 'settled']) {
    const agents = list.section(inbox);
    const empty = inbox === 'pending' && none ? 'No agents yet' : '';
    renderAgentList($(`list-${inbox}`), agents, focused?.id, title, roleTitle, empty);
    if (inbox === 'busy' || inbox === 'snoozed') $(`count-${inbox}`).textContent = agents.length;
  }
  $('more-settled').hidden = !settledNext;
  $('more-settled').disabled = settledLoading;
  renderHeader();
}

function canChangeStatus() {
  return !!focused && !!list.agents.get(focused.id) && !inboxWriting;
}

function renderInboxStatus(summary) {
  const button = $('inbox-button');
  button.hidden = !summary;
  if (!summary) return inboxMenu.close();
  let label = '';
  for (const option of $('inbox-label').children) {
    const current = option.dataset.status === summary.inbox;
    option.classList.toggle('current', current);
    if (current) label = option.textContent;
  }
  const until =
    summary.inbox === 'snoozed' &&
    new Date(summary.until).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  const pinned = newestMetadata(summary, focused.log.metadata).pinned != null;
  $('inbox-dot').className = `state-dot ${summary.inbox}`;
  button.setAttribute(
    'aria-label',
    `${until ? `${label} until ${until}` : label}${pinned ? ', pinned' : ''}`,
  );
  button.title = until ? `Until ${until}` : 'Change status';
  $('inbox-until').textContent = until ? `Until ${until}` : '';
  $('inbox-until').hidden = !until;
  $('pin').textContent = pinned ? 'Unpin' : 'Pin';
  $('pin').hidden = summary.inbox === 'settled';
  $('inbox-actions').hidden = summary.inbox === 'busy';
  $('pin-separator').hidden = $('pin').hidden || $('inbox-actions').hidden;
  $('inbox-restore').textContent = summary.inbox === 'snoozed' ? 'Wake now' : 'Restore';
  for (const item of document.querySelectorAll('[data-inbox]'))
    item.hidden = item.dataset.inbox === summary.inbox;
}

function renderHeader() {
  const summary = focused && list.agents.get(focused.id);
  const known = !!focused?.log.metadata;
  $('header-title').textContent = focused
    ? title(summary || focused.log.metadata || { id: focused.id, role: 'Agent' })
    : roleView?.title || 'New agent';
  document.title = focused || roleView ? `${$('header-title').textContent} · Fleet` : 'Fleet';
  $('header-title').title = $('header-title').textContent;
  $('header-title').hidden = !!roleView?.name;
  $('header-roles').hidden = !roleView?.name;
  if (roleView) $('roles-link').setAttribute('aria-current', 'page');
  else $('roles-link').removeAttribute('aria-current');
  $('edit-title').hidden = !known;
  $('trace').hidden = !known;
  $('trace').setAttribute('aria-pressed', String(trace));
  renderInboxStatus(summary);
  const role = focused?.log.metadata?.role;
  $('composer-role').hidden = !role;
  $('composer-role').textContent = roleTitle(role || '');
  if (role) $('composer-role').href = `#roles/${encodeURIComponent(role)}`;
  $('role-picker').inert = sending;
  $('conversation').classList.toggle('trace-view', trace);
  attachments.render();
  $('attach-image').disabled = sending;
  $('attachments').inert = sending;
  const action = composerAction({
    text: $('composer').value,
    hasAttachments: attachments.entries().length > 0,
    canSend: !attachments.pending() && (focused ? known : !!rolePicker.name),
    canInterrupt: canInterrupt(),
    interruptPending: !!focused?.log.activity.interrupt_pending || interrupting.has(focused?.id),
    sending,
  });
  const button = $('send');
  button.type = action.type;
  button.title = action.label;
  button.setAttribute('aria-label', action.label);
  button.disabled = action.disabled;
  button.classList.toggle('has-options', action.chooseDelivery);
  if (action.chooseDelivery) {
    button.title = 'Send now. Hold for steer or queue.';
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', String(!$('delivery').hidden));
  } else {
    button.removeAttribute('aria-haspopup');
    button.removeAttribute('aria-expanded');
    delivery.close();
  }
  if (button.dataset.icon !== action.icon) {
    button.dataset.icon = action.icon;
    button.replaceChildren(icon(action.icon));
  }
}

function traceAnchor() {
  const bounds = scrollArea.getBoundingClientRect();
  return [...$('events').children]
    .map((element) => ({
      element,
      top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom,
    }))
    .filter((anchor) => anchor.bottom > bounds.top && anchor.top < bounds.bottom);
}

function restoreTraceAnchor(anchors) {
  const anchor = anchors?.find(({ element }) => element.isConnected);
  if (!anchor) return false;
  scrollArea.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
  return true;
}

function renderHistory(view) {
  if (trace) {
    view.traceRows = traceRows(view.events || [], view.log.tools.values(), view.log.preview);
    renderTrace($('events'), view.traceRows, view.traceExpanded);
  } else {
    view.model = renderEvents($('events'), view.events || []);
  }
}

function scheduleRender(updateEvents = true) {
  eventsChanged ||= updateEvents;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    if (!focused) return;
    const anchor = trace && !following ? traceAnchor() : null;
    const log = focused.log;
    if (eventsChanged) focused.events = log.orderedEvents();
    if (trace || eventsChanged) renderHistory(focused);
    eventsChanged = false;
    const events = focused.events || [];
    renderPreview($('preview'), trace ? null : log.preview, !focused.model);
    const pending = log.pendingMessages();
    renderPending(
      $('pending-messages'),
      pending.filter((message) => message.mode !== 'queue'),
      trace,
    );
    renderQueue(
      $('queued-messages'),
      pending.filter((message) => message.mode === 'queue'),
    );
    const tools = log.tools.values();
    const compacting = log.preview?.status === 'compacting';
    const working = log.activity.turn === 'active' || tools.length || log.preview;
    const visibleActivity = trace
      ? focused.traceRows.some(
          (row) => row.streaming || ['pending', 'generating', 'streaming'].includes(row.status),
        )
      : !!$('preview').childElementCount;
    $('working-indicator').hidden =
      !working || (visibleActivity && !log.activity.interrupt_pending && !compacting);
    $('working-indicator').lastElementChild.textContent = log.activity.interrupt_pending
      ? 'Interrupting…'
      : compacting
        ? 'Compacting context…'
        : tools.length
          ? `Running ${tools.length === 1 ? tools[0].tool : `${tools.length} tools`}…`
          : 'Working…';
    $('conversation-empty').hidden =
      !focused.ready || !!events.length || !!pending.length || !!working;
    renderHeader();
    if (following) keepFollowing();
    else {
      restoreTraceAnchor(anchor);
      lastScrollTop = scrollArea.scrollTop;
      updateJump();
    }
  });
}

async function read(path, controller) {
  return request(path, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
  });
}

async function connectList() {
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  listStatus = 'connecting';
  updateConnection();
  try {
    const first = await read('/agents?inbox=unsettled&direction=backward&limit=100', controller);
    if (controller.signal.aborted) return;
    list = new AgentList();
    settledLoaded = false;
    settledNext = undefined;
    list.page(first.data);
    renderSidebar();
    void subscribe('/agents/subscription', {
      after: first.revision,
      signal: controller.signal,
      onStatus: (status) => {
        if (!controller.signal.aborted) {
          listStatus = status;
          updateConnection();
        }
      },
      onEvent: (event) => {
        if (event.type !== 'update') return;
        list.update(JSON.parse(event.data), event.id);
        renderSidebar();
      },
      onReset: connectList,
    });
    let next = first.data.next;
    while (next && !controller.signal.aborted) {
      const page = await read(
        `/agents?inbox=unsettled&direction=backward&limit=100&from=${encodeURIComponent(next)}`,
        controller,
      );
      list.page(page.data);
      renderSidebar();
      next = page.data.next;
    }
    if (document.querySelector('[data-section=settled]').open) void loadSettled();
    if (!focused) notice('');
  } catch (error) {
    if (controller.signal.aborted) return;
    listStatus = 'offline';
    updateConnection();
    if (!focused) notice('Fleet is unavailable.', connectList);
    setTimeout(() => {
      if (!controller.signal.aborted) void connectList();
    }, 5000);
  }
}

async function loadSettled() {
  if (settledLoading || (settledLoaded && !settledNext)) return;
  settledLoading = true;
  $('more-settled').disabled = true;
  const controller = listController;
  try {
    const page = await read(
      `/agents?inbox=settled&direction=backward&limit=100${settledNext ? `&from=${encodeURIComponent(settledNext)}` : ''}`,
      controller,
    );
    if (controller.signal.aborted) return;
    list.page(page.data);
    settledNext = page.data.next;
    settledLoaded = true;
  } catch (error) {
    if (!controller.signal.aborted)
      toast('Could not load settled agents.', { label: 'Retry', run: loadSettled });
  } finally {
    settledLoading = false;
    renderSidebar();
  }
}

async function openAgent(id) {
  saveDraft();
  focused?.controller.abort();
  const controller = new AbortController();
  const view = {
    id,
    controller,
    log: new Conversation(),
    status: 'connecting',
    ready: false,
    oldest: null,
    traceExpanded: focused?.id === id ? focused.traceExpanded : new Set(),
  };
  focused = view;
  following = false;
  $('jump-latest').hidden = true;
  showView('conversation');
  $('events').replaceChildren();
  $('preview').replaceChildren();
  $('preview').signature = undefined;
  $('pending-messages').replaceChildren();
  $('pending-messages').signature = undefined;
  renderQueue($('queued-messages'), []);
  $('working-indicator').hidden = true;
  $('conversation-empty').hidden = true;
  $('older-events').hidden = true;
  $('composer').value = drafts[id] || '';
  $('composer').placeholder = 'Send a message…';
  notice('');
  // Only mention loading when it is slow enough to notice.
  setTimeout(() => {
    if (focused === view && !view.ready && view.status === 'connecting') notice('Loading…');
  }, 500);
  renderSidebar();
  updateConnection();
  try {
    const base = `/agents/${id}`;
    const [agent, events, messages, activity, tools] = await Promise.all([
      read(base, controller),
      read(`${base}/events?direction=backward&limit=100`, controller),
      read(`${base}/messages`, controller),
      read(`${base}/activity`, controller),
      read(`${base}/tool-calls`, controller),
    ]);
    if (controller.signal.aborted) return;
    const log = view.log;
    log.metadata = agent.data;
    log.metadataRevision = agent.revision;
    log.eventPage(events.data, events.revision);
    log.messages.snapshot(messages.data, messages.revision);
    log.activity = activity.data;
    log.activityRevision = activity.revision;
    log.tools.snapshot(tools.data, tools.revision);
    view.ready = true;
    view.oldest = events.data.at(-1)?.cursor;
    $('older-events').hidden = events.data.length < 100;
    notice('');
    scheduleRender();
    renderSidebar();
    requestAnimationFrame(() => {
      if (focused === view) toLatest();
    });
    void subscribe(`${base}/subscription`, {
      after: minimum([
        agent.revision,
        events.revision,
        messages.revision,
        activity.revision,
        tools.revision,
      ]),
      signal: controller.signal,
      onStatus: (status) => {
        if (controller.signal.aborted) return;
        view.status = status;
        updateConnection();
        if (status === 'offline') notice('Reconnecting…');
        if (status === 'live') notice('');
      },
      onEvent: (event) => {
        if (event.type === 'update') {
          const data = JSON.parse(event.data);
          log.update(data, event.id);
          if (data.agent) renderSidebar();
          scheduleRender();
        }
      },
      onReset: () => {
        if (!controller.signal.aborted) void openAgent(id);
      },
    });
    void subscribe(`${base}/preview/subscription`, {
      signal: controller.signal,
      onEvent: (event) => {
        log.previewEvent(event);
        scheduleRender(false);
      },
      onStatus: (status) => {
        if (status === 'offline') {
          log.preview = null;
          scheduleRender(false);
        }
      },
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    view.status = 'offline';
    updateConnection();
    notice(
      error.status === 404 ? 'This agent could not be found.' : 'Could not load this conversation.',
      () => openAgent(id),
    );
  }
}

async function loadOlder() {
  const view = focused;
  if (!view?.oldest) return;
  $('older-events').disabled = true;
  const cursor = view.oldest;
  try {
    const page = await read(
      `/agents/${view.id}/events?direction=backward&limit=100&from=${cursor}`,
      view.controller,
    );
    if (focused !== view) return;
    const height = scrollArea.scrollHeight;
    const top = scrollArea.scrollTop;
    const anchor = trace ? traceAnchor() : null;
    view.log.eventPage(page.data, page.revision, cursor);
    view.oldest = page.data.at(-1)?.cursor;
    view.events = view.log.orderedEvents();
    renderHistory(view);
    renderPreview($('preview'), trace ? null : view.log.preview, !view.model);
    $('older-events').hidden = page.data.length < 100;
    if (!restoreTraceAnchor(anchor)) scrollArea.scrollTop = top + scrollArea.scrollHeight - height;
  } catch (error) {
    if (!view.controller.signal.aborted)
      toast('Could not load earlier messages.', { label: 'Retry', run: loadOlder });
  } finally {
    if (focused === view) $('older-events').disabled = false;
  }
}

function saveDraft() {
  const value = $('composer').value;
  if (value) drafts[draftKey()] = value;
  else delete drafts[draftKey()];
  saveLocal('drafts', drafts);
}

function showView(view) {
  $('main').dataset.view = view;
  $('welcome').hidden = view !== 'welcome';
  $('conversation').hidden = view !== 'conversation';
  $('roles-view').hidden = view !== 'roles';
}

async function openRoles(name, from) {
  const view = { name, title: name || 'Roles', controller: new AbortController() };
  roleView = view;
  const container = $('roles-view');
  showView('roles');
  notice('');
  container.replaceChildren();
  scrollArea.scrollTop = 0;
  setTimeout(() => {
    if (roleView === view && !container.childElementCount)
      container.append(node('p', 'role-notice', 'Loading…'));
  }, 500);
  try {
    const { data } = await request(name ? `/roles/${encodeURIComponent(name)}` : '/roles', {
      signal: view.controller.signal,
    });
    if (roleView !== view) return;
    let target;
    if (name) {
      view.title = data.title || data.name;
      target = renderRole(container, data, () => {
        rolePicker.select(name);
        location.hash = 'new';
      });
    } else {
      renderRoleList(container, data);
      target =
        from &&
        [...container.querySelectorAll('a')].find(
          (link) => link.getAttribute('href') === `#roles/${encodeURIComponent(from)}`,
        );
    }
    const active = document.activeElement;
    if (!active || active === document.body || !active.getClientRects().length) {
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest' });
    }
  } catch (error) {
    if (view.controller.signal.aborted) return;
    const message = !name
      ? 'Could not load roles.'
      : error.status === 404
        ? 'This role could not be found.'
        : 'This role could not be loaded.';
    renderRoleError(container, message, error.status === 404 ? '' : error.message, () =>
      openRoles(name, from),
    );
  }
  renderHeader();
}

function route() {
  closeSidebar();
  $('title-dialog').close();
  titleEdit = null;
  const from = roleView?.name;
  roleView?.controller.abort();
  roleView = null;
  const match = /^#agent\/(\d{1,39})$/.exec(location.hash);
  if (match) {
    void openAgent(match[1]);
    return;
  }
  saveDraft();
  focused?.controller.abort();
  focused = null;
  renderQueue($('queued-messages'), []);
  $('composer').value = drafts.new || '';
  $('composer').placeholder = 'Describe your task…';
  $('jump-latest').hidden = true;
  const roles = /^#roles(?:\/(.+))?$/.exec(location.hash);
  if (roles) {
    let name = roles[1];
    try {
      name &&= decodeURIComponent(name);
    } catch {
      /* Keep a malformed name as written. */
    }
    void openRoles(name, from);
  } else {
    showView('welcome');
    notice(listStatus === 'offline' ? 'Fleet is unavailable.' : '', connectList);
  }
  renderSidebar();
  updateConnection();
}

function canInterrupt() {
  return (
    !!focused?.log.metadata &&
    (focused.log.activity.turn === 'active' || focused.log.tools.values().length > 0)
  );
}

async function interruptAgent() {
  if (!canInterrupt() || focused.log.activity.interrupt_pending || interrupting.has(focused.id))
    return;
  const id = focused.id;
  const operation = prepareWrite(`/agents/${id}/interrupts`, {});
  interrupting.add(id);
  renderHeader();
  try {
    await write(operation);
  } catch (error) {
    toast(error.message);
  } finally {
    interrupting.delete(id);
    renderHeader();
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const text = $('composer').value.trim();
  const role = rolePicker.name;
  const images = attachments.content();
  if (sending || attachments.pending() || (!text && !images.length) || (focused && !focused.ready))
    return;
  if (!focused && !role) {
    $('role-picker').querySelector('input')?.focus();
    return;
  }
  let parameters;
  if (!focused) {
    try {
      parameters = rolePicker.values();
    } catch {
      return;
    }
  }
  const id = focused?.id;
  const key = draftKey();
  // A plain send steers, or retries an unconfirmed send as it was first sent.
  const mode =
    event.submitter?.value ||
    (pendingWrite && JSON.parse(pendingWrite.fingerprint).mode) ||
    'steer';
  const fingerprint = JSON.stringify({
    id,
    text,
    ...(images.length && { images }),
    mode,
    ...(!id && { role, parameters }),
  });
  if (pendingWrite && pendingWrite.fingerprint !== fingerprint) {
    toast('An earlier send is still unconfirmed. Retry it before sending a different message.', {
      label: 'Restore',
      run: () => {
        const previous = JSON.parse(pendingWrite.fingerprint);
        drafts[previous.id || 'new'] = previous.text;
        attachments.restore(previous.id || 'new', previous.images || []);
        saveLocal('drafts', drafts);
        if (draftKey() === (previous.id || 'new')) $('composer').value = previous.text;
        else location.hash = previous.id ? `agent/${previous.id}` : 'new';
        if (!previous.id) {
          rolePicker.restore(previous.role, previous.parameters);
        }
        renderHeader();
      },
    });
    return;
  }
  if (!pendingWrite) {
    const agentId = id || newId();
    const message = {
      id: newId(),
      mode,
      content: [...(text ? [{ type: 'text', text }] : []), ...images],
    };
    const operation = id
      ? prepareWrite(`/agents/${id}/messages`, message)
      : prepareWrite('/agents', {
          id: agentId,
          role,
          parameters,
          title: initialTitle(text || 'Image'),
          message,
        });
    pendingWrite = { fingerprint, agentId, operation };
    saveLocal('pending-write', pendingWrite);
  }
  sending = true;
  renderHeader();
  if (focused) toLatest(true);
  try {
    await write(pendingWrite.operation);
    const agentId = pendingWrite.agentId;
    if (!id) saveLocal('role', role);
    pendingWrite = null;
    saveLocal('pending-write', null);
    attachments.clear(key, images);
    if (drafts[key]?.trim() === text) delete drafts[key];
    saveLocal('drafts', drafts);
    if (draftKey() === key && $('composer').value.trim() === text) $('composer').value = '';
    if (!id && draftKey() === key) location.hash = `agent/${agentId}`;
    else if (focused?.id === id && following) keepFollowing();
  } catch (error) {
    if (error.status && error.status < 500 && error.status !== 409) {
      pendingWrite = null;
      saveLocal('pending-write', null);
    }
    toast(`${error.message} Your draft is kept.`, {
      label: 'Retry',
      run: () => $('composer-form').requestSubmit(),
    });
  } finally {
    sending = false;
    renderHeader();
  }
}

function titleError(message) {
  $('title-error').textContent = message;
  $('title-error').hidden = !message;
}

function renderTitleEditor() {
  const edit = titleEdit;
  if (!edit) return;
  $('title-input').disabled = edit.saving || !!edit.operation;
  $('title-clear').disabled = edit.saving || !!edit.operation;
  $('title-save').disabled = edit.saving || edit.conflict;
  $('title-save').textContent = edit.saving
    ? 'Saving…'
    : edit.operation
      ? 'Retry save'
      : 'Save title';
  $('title-reload').hidden = !edit.conflict;
  $('title-reload').disabled = edit.saving;
  $('title-form').setAttribute('aria-busy', String(edit.saving));
}

function openTitleEditor() {
  if (!focused?.log.metadata) return;
  titleEdit = new TitleEdit(newestMetadata(list.agents.get(focused.id), focused.log.metadata));
  $('title-input').value = titleEdit.value;
  titleError('');
  renderTitleEditor();
  $('title-dialog').showModal();
  $('title-input').focus();
  $('title-input').select();
}

function applyTitleRead(id, response) {
  if (focused?.id !== id) return;
  focused.log.update({ agent: response.data }, response.revision);
  renderSidebar();
}

async function reloadTitle(edit = titleEdit) {
  if (!edit) return;
  edit.saving = true;
  renderTitleEditor();
  try {
    const response = await edit.refresh();
    applyTitleRead(edit.id, response);
    if (titleEdit !== edit) return;
    const current = edit.current ? `“${edit.current}”` : 'no title';
    titleError(
      `The title changed elsewhere to ${current}. Your draft is kept. Review it, then save again.`,
    );
  } catch (error) {
    if (titleEdit === edit)
      titleError(
        'Could not load the current title. Your draft is kept. Load it before saving again.',
      );
  } finally {
    edit.saving = false;
    if (titleEdit === edit) renderTitleEditor();
  }
}

async function saveTitle(event) {
  event.preventDefault();
  const edit = titleEdit;
  if (!edit || edit.saving || edit.conflict) return;
  edit.value = $('title-input').value;
  edit.saving = true;
  titleError('');
  renderTitleEditor();
  try {
    await edit.save();
    if (titleEdit === edit) {
      $('title-dialog').close();
      titleEdit = null;
    }
    // Reads and subscriptions can race. Merge the read instead of optimistically
    // assigning a title with an invented revision or collection version.
    if (focused?.id === edit.id) {
      try {
        applyTitleRead(
          edit.id,
          await request(`/agents/${edit.id}`, {
            signal: AbortSignal.timeout(15_000),
          }),
        );
      } catch {
        /* The agent subscription delivers the saved title. */
      }
    }
  } catch (error) {
    if (titleEdit !== edit) return;
    if (error.status === 412) await reloadTitle(edit);
    else
      titleError(
        edit.operation
          ? 'Could not confirm the change. Your draft is kept; retry this save to confirm it.'
          : `${error.message} Your draft is kept.`,
      );
  } finally {
    edit.saving = false;
    if (titleEdit === edit) renderTitleEditor();
  }
}

async function setInbox(state, until) {
  const summary = focused && list.agents.get(focused.id);
  if (!summary || inboxWriting) return;
  const operation = prepareWrite(
    `/agents/${summary.id}/inbox`,
    { state, ...(until !== undefined && { until }) },
    { method: 'PUT', version: summary.version },
  );
  inboxWriting = true;
  $('snooze-error').hidden = true;
  renderHeader();
  try {
    await write(operation);
    $('snooze-dialog').close();
    if (['settled', 'snoozed'].includes(state) && focused?.id === summary.id) {
      const next = [...list.pinned(), ...list.section('pending')].find(
        (agent) => agent.inbox === 'pending' && agent.id !== summary.id,
      );
      location.hash = next ? `agent/${next.id}` : 'new';
    }
  } catch (error) {
    const message =
      error.status === 412 ? 'This agent changed. Review its state and try again.' : error.message;
    if (state === 'snoozed' && $('snooze-dialog').open) {
      $('snooze-error').textContent = message;
      $('snooze-error').hidden = false;
    } else toast(message);
  } finally {
    inboxWriting = false;
    renderHeader();
  }
}

async function setPinned(pinned) {
  const summary = focused && list.agents.get(focused.id);
  if (!summary || inboxWriting) return;
  const metadata = newestMetadata(summary, focused.log.metadata);
  const operation = prepareWrite(
    `/agents/${summary.id}/pinned`,
    { pinned },
    { method: 'PUT', version: metadata.metadata_version },
  );
  inboxWriting = true;
  renderHeader();
  try {
    await write(operation);
  } catch (error) {
    if (error.status === 412)
      toast('This agent changed.', { label: 'Retry', run: () => void setPinned(pinned) });
    else toast(error.message);
  } finally {
    inboxWriting = false;
    renderHeader();
  }
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  $('open-sidebar').setAttribute('aria-expanded', 'false');
  $('main').inert = false;
  $('sidebar').inert = mobile.matches;
}

function openSidebar() {
  document.body.classList.add('sidebar-open');
  $('open-sidebar').setAttribute('aria-expanded', 'true');
  $('main').inert = mobile.matches;
  $('sidebar').inert = false;
  $('close-sidebar').focus({ preventScroll: true });
}

populateIcons();
void rolePicker.load().then(renderSidebar);
$('composer').value = drafts.new || '';
$('attach-image').onclick = () => $('image-files').click();
$('image-files').onchange = () => {
  attachments.add([...$('image-files').files]);
  $('image-files').value = '';
};
$('composer').addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files || [])].filter((file) =>
    file.type.startsWith('image/'),
  );
  if (sending || !files.length) return;
  event.preventDefault();
  attachments.add(files);
});
$('composer-form').addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
$('composer-form').addEventListener('drop', (event) => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  if (!sending) attachments.add([...event.dataTransfer.files]);
});
$('composer-form').addEventListener('submit', sendMessage);
$('send').onclick = () => {
  if ($('send').type === 'button' && !$('send').disabled) void interruptAgent();
};
$('send').addEventListener('pointerdown', (event) => {
  if (event.isPrimary && event.button === 0 && document.activeElement === $('composer'))
    event.preventDefault();
});
$('composer').addEventListener('input', () => {
  saveDraft();
  renderHeader();
});
$('composer').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.altKey && !event.isComposing && !event.shiftKey) {
    event.preventDefault();
    $('composer-form').requestSubmit($('queue'));
  } else if (
    event.key === 'Enter' &&
    !event.isComposing &&
    !event.shiftKey &&
    (event.metaKey || event.ctrlKey || !matchMedia('(pointer: coarse)').matches)
  ) {
    event.preventDefault();
    $('composer-form').requestSubmit();
  }
});
$('edit-title').onclick = openTitleEditor;
$('title-form').addEventListener('submit', saveTitle);
$('title-clear').onclick = () => {
  $('title-input').value = '';
  $('title-input').focus();
};
$('title-reload').onclick = () => void reloadTitle();
$('title-dialog').addEventListener('close', () => {
  if (!$('title-dialog').open) titleEdit = null;
});
$('older-events').onclick = loadOlder;
$('more-settled').onclick = loadSettled;
document.querySelector('[data-section=settled]').addEventListener('toggle', (event) => {
  if (event.target.open) void loadSettled();
});
$('trace').onclick = () => {
  trace = !trace;
  scheduleRender();
};
function chooseInbox(choice) {
  inboxMenu.close();
  $('inbox-button').focus({ preventScroll: true });
  choice();
}
$('pin').onclick = () =>
  chooseInbox(() => {
    const summary = list.agents.get(focused.id);
    void setPinned(newestMetadata(summary, focused.log.metadata).pinned == null);
  });
for (const item of document.querySelectorAll('[data-inbox]'))
  item.onclick = () => chooseInbox(() => void setInbox(item.dataset.inbox));
for (const item of document.querySelectorAll('[data-snooze]'))
  item.onclick = () =>
    chooseInbox(() => {
      let until = Date.now() + Number(item.dataset.snooze) * 60_000;
      if (item.dataset.snooze === 'tomorrow') {
        const date = new Date();
        date.setDate(date.getDate() + 1);
        date.setHours(9, 0, 0, 0);
        until = date.getTime();
      }
      void setInbox('snoozed', until);
    });
$('snooze-choose').onclick = () =>
  chooseInbox(() => {
    $('snooze-error').hidden = true;
    $('snooze-time').setCustomValidity('');
    $('snooze-dialog').showModal();
  });
$('snooze-time').oninput = () => $('snooze-time').setCustomValidity('');
$('snooze-custom').onclick = () => {
  const input = $('snooze-time');
  const until = new Date(input.value).getTime();
  input.setCustomValidity(
    !Number.isFinite(until) || until <= Date.now() ? 'Choose a time in the future.' : '',
  );
  if (input.reportValidity()) void setInbox('snoozed', until);
};
for (const button of document.querySelectorAll('[data-close]'))
  button.onclick = () => $(button.dataset.close).close();
$('help').onclick = $('connection').onclick = () => {
  $('connection-detail').textContent =
    'Waiting for Fleet. Start the backend on port 1337, or set FLEET_API_URL when starting this app.';
  $('connection-detail').hidden = listStatus === 'live';
  $('help-dialog').showModal();
};
$('open-sidebar').onclick = openSidebar;
$('close-sidebar').onclick = $('backdrop').onclick = () => {
  closeSidebar();
  $('open-sidebar').focus();
};
enableSidebarSwipe(openSidebar, $('close-sidebar').onclick);
mobile.addEventListener('change', closeSidebar);
$('jump-latest').onclick = () => toLatest(true);
scrollArea.addEventListener(
  'scroll',
  () => {
    const top = scrollArea.scrollTop;
    // Scrolling up stops following; returning to the end resumes it.
    if (distanceFromEnd(scrollArea) <= 2) {
      following = true;
      seekingEnd = false;
    } else if (top < lastScrollTop - 1) following = seekingEnd = false;
    lastScrollTop = top;
    updateJump();
  },
  { passive: true },
);
// Keyboard, composer growth and late images change the space without a render.
new ResizeObserver(keepPinned).observe(scrollArea);
$('conversation').addEventListener('load', keepFollowing, true);
window.addEventListener('hashchange', route);
window.addEventListener('online', () => {
  void connectList();
  if (focused && !focused.ready) void openAgent(focused.id);
});
window.addEventListener('pagehide', saveDraft);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
    closeSidebar();
    $('open-sidebar').focus();
  }
  if (document.querySelector('dialog[open]')) return;
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    location.hash = 'new';
  }
  if (event.key === 'Tab' && mobile.matches && document.body.classList.contains('sidebar-open')) {
    const items = [...$('sidebar').querySelectorAll('a, button, input, summary')].filter(
      (element) => !element.disabled && element.getClientRects().length,
    );
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      items.at(-1).focus();
    } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
      event.preventDefault();
      items[0].focus();
    }
  }
});
setInterval(renderSidebar, 60_000);
route();
void connectList();
