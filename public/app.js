import { Attachments } from './attachments.js';
import { Resume, findStalled, isStalled, stallNotice } from './stalled.js';
import { composerAction } from './composer.js';
import { Connectivity } from './connectivity.js';
import { enableDeliveryChoice } from './delivery.js';
import { enableMenu } from './menu.js';
import { dismissNotifications, enableNotifications } from './notifications.js';
import { request, prepareWrite, write, subscribe, newId } from './api.js';
import { AgentList, Conversation, compare, minimum } from './state.js';
import { RolePicker } from './roles.js';
import { RoleEdit } from './role-editor.js';
import { renderRole, renderRoleEditor, renderRoleError, renderRoleList } from './role-view.js';
import { distanceFromEnd, followPosition } from './scroll.js';
import { enableSidebarSwipe } from './sidebar.js';
import { TitleEdit, agentTitle, initialTitle, newestMetadata } from './titles.js';
import { backgroundCalls, traceRows } from './trace.js';
import { renderTrace } from './trace-render.js';
import { renderBackground } from './background.js';
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
let viewError = null;
let settledNext;
let settledLoaded = false;
let settledLoading = false;
let focused = null;
const bookmarks = new Map();
let roleView = null;
let trace = false;
let sending = false;
const interrupting = new Set();
const stoppingBackground = new Set();
const resumes = new Map();
let inboxWriting = false;
let titleEdit = null;
let frame;
let eventsChanged = false;
let pendingWrite = readLocal('pending-write', null);
const drafts = readLocal('drafts', {});
const roleDrafts = readLocal('role-drafts', {});
const inboxMenu = enableMenu({
  button: $('inbox-button'),
  menu: $('inbox-menu'),
  available: canChangeStatus,
});
const connectivity = new Connectivity(renderStatus);
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
function isSubagent() {
  return !!(focused?.log.metadata?.parent || list.agents.get(focused?.id)?.parent);
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

function showError(message, retry) {
  viewError = message ? { message, retry } : null;
  renderStatus();
}

function reconnect() {
  void connectList();
  if (focused && !focused.ready) void openAgent(focused.id, focused.targetCall);
}

/** Connection problems stay quiet until they last. Errors that need the user show at once. */
function viewStatus(stage) {
  if (viewError) return { tone: 'error', text: viewError.message, action: 'Retry' };
  if (focused?.slow && !focused.ready && stage !== 'lost' && stage !== 'offline')
    return { tone: 'quiet', text: 'Loading…' };
  const problem = true;
  if (stage === 'offline')
    return { tone: 'alert', text: 'You’re offline. Waiting for network…', problem };
  if (stage === 'lost') {
    const action = listStatus === 'live' ? undefined : 'Retry now';
    return { tone: 'alert', text: 'Can’t reach Fleet. Retrying…', action, problem };
  }
  if (stage === 'slow') {
    const text = connectivity.connected ? 'Reconnecting…' : 'Connecting…';
    return { tone: 'quiet', text, problem };
  }
  return null;
}

function renderStatus() {
  const stage = connectivity.stage;
  const state =
    stage === 'live' || (stage === 'grace' && connectivity.connected)
      ? 'live'
      : stage === 'lost' || stage === 'offline'
        ? 'offline'
        : 'connecting';
  $('connection').dataset.state = state;
  $('connection-text').textContent =
    state === 'live'
      ? 'Connected'
      : stage === 'offline'
        ? 'Offline'
        : connectivity.connected
          ? 'Reconnecting…'
          : 'Connecting…';
  const container = $('view-status');
  const hadFocus = container.contains(document.activeElement);
  renderViewStatus(container, viewStatus(stage), stage);
  // Keep keyboard focus nearby when the button it was on goes away.
  if (hadFocus && !container.contains(document.activeElement))
    (
      container.querySelector('button') ||
      ($('header-title').hidden ? $('header-roles') : $('header-title'))
    ).focus({ preventScroll: true });
}

function renderViewStatus(container, status, stage) {
  if (!status) {
    // After a reported connection problem, say once that it is over.
    if (container.problem && stage === 'live') {
      container.problem = false;
      container.replaceChildren(node('span', 'sr-only', 'Reconnected'));
    } else if (container.signature) container.replaceChildren();
    container.signature = undefined;
    return;
  }
  const signature = JSON.stringify(status);
  if (container.signature === signature) return;
  container.signature = signature;
  container.problem = !!status.problem;
  const pill = node('div', 'status-pill');
  pill.dataset.tone = status.tone;
  pill.append(
    node('span', status.tone === 'quiet' ? 'spinner' : 'status-dot'),
    node('span', 'status-text', status.text),
  );
  if (status.action) {
    const button = node('button', 'status-action', status.action);
    button.type = 'button';
    button.onclick = () => (viewError ? viewError.retry() : reconnect());
    pill.append(button);
  }
  container.replaceChildren(pill);
}

function updateConnection() {
  connectivity.set(listStatus === 'live' && (!focused?.ready || focused.status === 'live'));
  renderStatus();
}

function renderSidebar() {
  const none = !list.agents.values().some((agent) => !agent.parent);
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
  return !!focused && !isSubagent() && !!list.agents.get(focused.id) && !inboxWriting;
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
  const active = document.activeElement;
  $('pin').textContent = pinned ? 'Unpin' : 'Pin';
  $('pin').hidden = summary.inbox === 'settled';
  $('stop-background').hidden =
    !hasBackgroundWork() ||
    focused.log.activity.interrupt_includes_async_tool_calls ||
    stoppingBackground.has(focused.id);
  $('inbox-actions').hidden = summary.inbox === 'busy';
  $('pin-separator').hidden = $('pin').hidden || $('inbox-actions').hidden;
  $('stop-separator').hidden =
    $('stop-background').hidden || ($('pin').hidden && $('inbox-actions').hidden);
  $('inbox-restore').textContent = summary.inbox === 'snoozed' ? 'Wake now' : 'Restore';
  for (const item of document.querySelectorAll('[data-inbox]'))
    item.hidden = item.dataset.inbox === summary.inbox;
  if ($('inbox-menu').contains(active) && active.closest('[hidden]')) {
    inboxMenu.close();
    $('inbox-button').focus({ preventScroll: true });
  }
}

function renderHeader() {
  const summary = focused && list.agents.get(focused.id);
  const known = !!focused?.log.metadata;
  const parent = focused?.log.metadata?.parent || summary?.parent;
  $('header-parent').hidden = !parent;
  $('header-parent').parentElement.classList.toggle('inspecting', !!parent);
  if (parent) {
    const name = title(list.agents.get(parent.agent) || { id: parent.agent, role: 'Parent agent' });
    $('header-parent').href = `#agent/${parent.agent}?call=${encodeURIComponent(parent.call)}`;
    $('header-parent-name').textContent = name;
    $('header-parent').title = `Back to the creating call in ${name}`;
    $('header-parent').setAttribute('aria-label', `Back to ${name}'s trace`);
  }
  $('composer-form').hidden = !!focused && (!focused.ready || !!parent);
  $('main').classList.toggle('inspecting', !!parent);
  $('header-title').textContent = focused
    ? title(summary || focused.log.metadata || { id: focused.id, role: 'Agent' })
    : roleView?.title || 'New agent';
  document.title = focused || roleView ? `${$('header-title').textContent} · Fleet` : 'Fleet';
  $('header-title').title = $('header-title').textContent;
  $('header-title').hidden = !!roleView && roleView.page !== 'list';
  $('header-roles').hidden = !roleView || roleView.page === 'list';
  $('new-role').hidden = roleView?.page !== 'list';
  $('edit-role').hidden = roleView?.page !== 'role';
  if (roleView?.page === 'role')
    $('edit-role').href = `#roles/${encodeURIComponent(roleView.name)}/edit`;
  if (roleView) $('roles-link').setAttribute('aria-current', 'page');
  else $('roles-link').removeAttribute('aria-current');
  $('edit-title').hidden = !known || !!parent;
  $('trace').hidden = !known;
  $('trace').setAttribute('aria-pressed', String(trace));
  renderInboxStatus(parent ? null : summary);
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
    canSend: !isSubagent() && !attachments.pending() && (focused ? known : !!rolePicker.name),
    canInterrupt: canInterrupt(),
    interruptPending:
      !!focused?.log.activity.interrupt_pending ||
      interrupting.has(focused?.id) ||
      stoppingBackground.has(focused?.id),
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

function rememberView() {
  if (!focused?.positioned) return;
  const active = document.activeElement?.closest('.trace-agent');
  const link = active && $('events').contains(active) ? active : null;
  const running = active && $('background').contains(active) ? active : null;
  const element = link || traceAnchor()[0]?.element;
  bookmarks.set(focused.id, {
    trace,
    expanded: new Set(focused.traceExpanded),
    oldest: focused.hasOlder ? focused.oldest : '0',
    top: scrollArea.scrollTop,
    focusAgent: (link || running)?.dataset.agent,
    focusRunning: !!running,
    anchor: element && {
      key: element.dataset.key,
      cursor: element.dataset.cursor,
      agent: element.dataset.agent,
      offset: element.getBoundingClientRect().top - scrollArea.getBoundingClientRect().top,
    },
  });
}

function restoreView(view) {
  const saved = view.restore;
  if (saved) {
    const links = [...$('events').querySelectorAll('.trace-agent')];
    const rows = [...$('events').children];
    const anchor = saved.anchor;
    const element =
      saved.call != null
        ? rows.find((row) => row.dataset.key === `tool:${saved.call}`)
        : anchor?.agent
          ? links.find((link) => link.dataset.agent === anchor.agent)
          : rows.find(
              (row) =>
                anchor &&
                (trace ? row.dataset.key === anchor.key : row.dataset.cursor === anchor.cursor),
            );
    const top = element
      ? scrollArea.scrollTop +
        element.getBoundingClientRect().top -
        scrollArea.getBoundingClientRect().top -
        // Leave room for the connection status above the call.
        (saved.call != null
          ? parseFloat(getComputedStyle(scrollArea).getPropertyValue('--status-space'))
          : anchor.offset)
      : saved.top || 0;
    scrollArea.scrollTo({ top, behavior: 'instant' });
    following = seekingEnd = false;
    lastScrollTop = scrollArea.scrollTop;
    updateJump();
    const focus = (
      saved.focusRunning ? [...$('background').querySelectorAll('.trace-agent')] : links
    ).find((link) => link.dataset.agent === saved.focusAgent);
    if (focus) focus.focus({ preventScroll: true });
    else if (saved.focusCall && element) element.firstElementChild.focus({ preventScroll: true });
  } else {
    toLatest();
  }
  if (!document.activeElement || document.activeElement === document.body)
    $('header-title').focus({ preventScroll: true });
}

function renderHistory(view) {
  if (trace) {
    view.traceRows = traceRows(
      view.events || [],
      view.log.tools.values(),
      view.log.preview,
      list.children(view.id),
      view.log.activity,
    );
    renderTrace($('events'), view.traceRows, view.traceExpanded, title);
  } else {
    renderEvents($('events'), view.events || []);
  }
}

/** Running async calls, listed in Trace only. */
function renderBackgroundCalls(view) {
  const calls = backgroundCalls(view.events || [], view.log.tools.values(), list.children(view.id));
  const section = $('background');
  const active = section.contains(document.activeElement) ? document.activeElement : null;
  renderBackground(section, trace ? calls : [], view.id, title);
  // Moving a row drops its focus, and a finished call takes its links with it.
  if (active && (document.activeElement !== active || section.hidden)) {
    const target = section.hidden
      ? $('header-title')
      : active.isConnected
        ? active
        : section.querySelector('a');
    target.focus({ preventScroll: true });
  }
  return calls;
}

/** Opens a loaded call in place. Calls outside the loaded history navigate. */
function showCall(event) {
  const link = event.target.closest('a[data-call]');
  const call = link?.dataset.call;
  const modified = event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey;
  if (!call || modified || event.altKey || event.defaultPrevented) return;
  if (!focused?.ready || !focused.log.hasToolCall(call)) return;
  event.preventDefault();
  const key = `tool:${call}`;
  focused.traceExpanded.add(key);
  const row = [...$('events').children].find((element) => element.dataset.key === key);
  if (row) row.open = true;
  focused.restore = { call, focusCall: true };
  focused.positioned = false;
  scheduleRender();
}

function scheduleRender(updateEvents = true) {
  eventsChanged ||= updateEvents;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    if (!focused?.ready) return;
    const anchor = trace && !following ? traceAnchor() : null;
    const log = focused.log;
    if (eventsChanged) focused.events = log.orderedEvents();
    if (trace || eventsChanged) renderHistory(focused);
    eventsChanged = false;
    const events = focused.events || [];
    renderPreview($('preview'), trace ? null : log.preview);
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
    // Async calls can outlive the turn, so they do not keep its spinner.
    const tools = log.tools.values().filter((tool) => !tool.is_async);
    const compacting = log.preview?.status === 'compacting';
    const working =
      log.activity.turn === 'active' ||
      tools.length ||
      log.preview ||
      log.activity.interrupt_pending;
    const visibleActivity = trace
      ? focused.traceRows.some(
          (row) =>
            row.streaming ||
            ['generating', 'streaming'].includes(row.status) ||
            (['pending', 'stopping'].includes(row.status) && !row.call.is_async),
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
    // A stalled agent isn't working; the notice takes the indicator's place.
    const notice = stallNotice(log.activity, stalledDescendant(focused));
    if (notice) $('working-indicator').hidden = true;
    renderStall(focused, notice);
    const background = renderBackgroundCalls(focused);
    // Chat only hints that work continues after the turn, without saying what it is.
    $('background-hint').hidden = trace || !!working || !background.length;
    $('conversation-empty').hidden =
      !focused.ready ||
      !!events.length ||
      !!pending.length ||
      !!working ||
      !!background.length ||
      !!notice;
    renderHeader();
    $('subagents-notice').hidden = !trace || !focused.childrenError;
    if (!focused.positioned) {
      focused.positioned = true;
      restoreView(focused);
    } else if (following) keepFollowing();
    else {
      restoreTraceAnchor(anchor);
      lastScrollTop = scrollArea.scrollTop;
      updateJump();
    }
  });
}

async function read(path, { signal }) {
  return request(path, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
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
    if (focused && trace) void loadChildren(focused);
    if (isStalled(focused?.log.activity)) scheduleRender(false);
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
        // Subagent summaries carry their status in Trace and a stall reason in chat.
        if (trace || isStalled(focused?.log.activity)) scheduleRender(false);
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
  } catch (error) {
    if (controller.signal.aborted) return;
    listStatus = 'offline';
    updateConnection();
    setTimeout(() => {
      if (!controller.signal.aborted) void connectList();
    }, 5000);
  }
}

/** Merges every page of an agent's children. False when the collection was replaced. */
async function readChildren(parent, collection, signal) {
  let next;
  do {
    const page = await read(
      `/agents?parent=${parent}&limit=100${next ? `&from=${encodeURIComponent(next)}` : ''}`,
      { signal },
    );
    if (signal.aborted || collection !== list) return false;
    collection.page(page.data);
    next = page.data.next;
    scheduleRender(false);
  } while (next);
  return true;
}

function loadChildren(view) {
  if (!listController) return Promise.resolve();
  if (view.childrenCollection === list && !view.childrenError) return view.childrenPromise;
  const collection = list;
  view.childrenController?.abort();
  const controller = new AbortController();
  view.childrenController = controller;
  const signal = AbortSignal.any([
    view.controller.signal,
    listController.signal,
    controller.signal,
  ]);
  view.childrenCollection = collection;
  view.childrenError = false;
  scheduleRender(false);
  view.childrenPromise = (async () => {
    try {
      await readChildren(view.id, collection, signal);
    } catch {
      if (!signal.aborted && collection === list) view.childrenError = true;
    } finally {
      if (!signal.aborted && collection === list) scheduleRender(false);
    }
  })();
  return view.childrenPromise;
}

/** A stalled agent below the view's agent, once found for its current activity. */
function stalledDescendant(view) {
  const activity = view.log.activity;
  const search = view.stallSearch;
  if (activity.stalled || !(activity.stalled_descendants > 0)) {
    search?.controller.abort();
    view.stallSearch = null;
    return null;
  }
  if (search?.revision !== view.log.activityRevision || search.collection !== list) {
    // A new stall starts general rather than naming an agent that may have recovered.
    search?.controller.abort();
    searchStalled(view);
    return null;
  }
  const found = search.found && list.agents.get(search.found);
  return found?.stalled ? found : null;
}

/** Descends through stalled branches. A failure or a race with a cleared stall finds nothing. */
function searchStalled(view) {
  if (!listController) return;
  const collection = list;
  const controller = new AbortController();
  const search = { revision: view.log.activityRevision, collection, controller, found: null };
  view.stallSearch = search;
  const signal = AbortSignal.any([
    view.controller.signal,
    listController.signal,
    controller.signal,
  ]);
  void findStalled(view.id, async (parent) => {
    if (!(await readChildren(parent, collection, signal))) throw new Error('Search replaced');
    return collection.children(parent);
  })
    .then((found) => {
      search.found = found?.id;
    })
    .catch(() => {
      // The notice keeps its general line.
    })
    .finally(() => {
      if (!signal.aborted) scheduleRender(false);
    });
}

function renderStall(view, notice) {
  const container = $('stall-notice');
  const hadFocus = container.contains(document.activeElement);
  container.hidden = !notice;
  if (!notice) {
    if (hadFocus) {
      $('header-title').focus({ preventScroll: true });
      view.retryFocus = performance.now();
    }
    return;
  }
  const reason = $('stall-reason');
  if ($('stall-title').textContent !== notice.title) $('stall-title').textContent = notice.title;
  if (reason.textContent !== notice.reason) reason.textContent = notice.reason;
  reason.hidden = !notice.reason;
  const waiting = !!resumes.get(view.id)?.waiting(view.log.activityRevision);
  const button = $('retry-stall');
  const label = waiting ? 'Retrying…' : 'Retry';
  if (button.textContent !== label) button.textContent = label;
  button.setAttribute('aria-disabled', String(waiting));
  // A retry that stalls again shows the notice once more. Return focus that it took away.
  if (performance.now() - view.retryFocus < 5000 && document.activeElement === $('header-title'))
    button.focus({ preventScroll: true });
  view.retryFocus = undefined;
}

/** Resumes the agent and everything stalled below it. Live activity decides what shows next. */
async function resumeStalled() {
  const view = focused;
  if (!view?.ready || !isStalled(view.log.activity)) return;
  if (!resumes.has(view.id)) resumes.set(view.id, new Resume(view.id));
  const resume = resumes.get(view.id);
  const revision = view.log.activityRevision;
  if (resume.waiting(revision)) return;
  const sent = resume.send(revision);
  scheduleRender(false);
  try {
    await sent;
    // Offer Retry again if Fleet's update never arrives, such as while disconnected.
    setTimeout(() => {
      if (resume.awaiting !== revision) return;
      resume.awaiting = null;
      scheduleRender(false);
    }, 10_000);
  } catch (error) {
    if (focused?.id === view.id)
      toast(resume.operation ? 'Could not confirm the retry. Try again.' : error.message);
  } finally {
    scheduleRender(false);
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

async function openAgent(id, call) {
  rememberView();
  saveDraft();
  focused?.controller.abort();
  let saved = bookmarks.get(id);
  if (call != null && (!saved?.trace || !saved.expanded.has(`tool:${call}`))) {
    saved = {
      ...saved,
      trace: true,
      expanded: new Set([...(saved?.expanded || []), `tool:${call}`]),
      call,
    };
  }
  trace = saved?.trace ?? false;
  const controller = new AbortController();
  const view = {
    id,
    targetCall: call,
    controller,
    log: new Conversation(),
    status: 'connecting',
    ready: false,
    oldest: null,
    traceExpanded: new Set(saved?.expanded),
    restore: saved,
    positioned: false,
  };
  focused = view;
  following = false;
  dismissNotifications(id);
  $('jump-latest').hidden = true;
  showView('conversation');
  $('events').replaceChildren();
  $('preview').replaceChildren();
  $('preview').signature = undefined;
  $('pending-messages').replaceChildren();
  $('pending-messages').signature = undefined;
  renderQueue($('queued-messages'), []);
  $('working-indicator').hidden = true;
  $('stall-notice').hidden = true;
  $('background-hint').hidden = true;
  renderBackground($('background'), [], id, title);
  $('conversation-empty').hidden = true;
  $('older-events').hidden = true;
  $('older-events').disabled = false;
  $('subagents-notice').hidden = true;
  $('composer').value = drafts[id] || '';
  $('composer').placeholder = 'Send a message…';
  viewError = null;
  // Only mention loading when it is slow enough to notice.
  setTimeout(() => {
    view.slow = true;
    if (focused === view) renderStatus();
  }, 1000);
  renderSidebar();
  updateConnection();
  try {
    const base = `/agents/${id}`;
    const children = trace ? loadChildren(view) : Promise.resolve();
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
    view.oldest = events.data.at(-1)?.cursor;
    view.hasOlder = events.data.length === 100;
    while (
      view.hasOlder &&
      ((saved?.oldest && compare(view.oldest, saved.oldest) > 0) ||
        (call != null && !log.hasToolCall(call)))
    ) {
      const cursor = view.oldest;
      const page = await read(
        `${base}/events?direction=backward&limit=100&from=${cursor}`,
        controller,
      );
      if (controller.signal.aborted) return;
      log.eventPage(page.data, page.revision, cursor);
      view.oldest = page.data.at(-1)?.cursor;
      view.hasOlder = page.data.length === 100;
    }
    await children;
    await view.childrenPromise;
    if (controller.signal.aborted) return;
    view.ready = true;
    $('older-events').hidden = !view.hasOlder;
    if (isSubagent()) $('composer').value = '';
    updateConnection();
    scheduleRender();
    renderSidebar();
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
        if (!controller.signal.aborted) void openAgent(id, call);
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
    showError(
      error.status === 404 ? 'This agent could not be found.' : 'Could not load this conversation.',
      () => openAgent(id, call),
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
    renderPreview($('preview'), trace ? null : view.log.preview);
    // Earlier results can finish background calls, but never start them.
    if (!renderBackgroundCalls(view).length) $('background-hint').hidden = true;
    view.hasOlder = page.data.length === 100;
    $('older-events').hidden = !view.hasOlder;
    if (!restoreTraceAnchor(anchor)) scrollArea.scrollTop = top + scrollArea.scrollHeight - height;
  } catch (error) {
    if (!view.controller.signal.aborted)
      toast('Could not load earlier messages.', { label: 'Retry', run: loadOlder });
  } finally {
    if (focused === view) $('older-events').disabled = false;
  }
}

function saveDraft() {
  if (isSubagent()) return;
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

async function openRoles(page, name, from) {
  const view = { page, name, title: name || 'Roles', controller: new AbortController() };
  roleView = view;
  const container = $('roles-view');
  showView('roles');
  showError('');
  container.replaceChildren();
  scrollArea.scrollTop = 0;
  setTimeout(() => {
    if (roleView === view && !container.childElementCount)
      container.append(node('p', 'role-notice', 'Loading…'));
  }, 500);
  try {
    const { data } =
      page === 'edit' && !name
        ? {}
        : await request(name ? `/roles/${encodeURIComponent(name)}` : '/roles', {
            signal: view.controller.signal,
          });
    if (roleView !== view) return;
    let target;
    if (page === 'edit') {
      view.title = name ? `Edit ${data.title || data.name}` : 'New role';
      target = editRole(view, data);
    } else if (name) {
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
      openRoles(page, name, from),
    );
  }
  renderHeader();
}

function editRole(view, role) {
  const draft = roleDrafts[role?.name || ''];
  const edit = new RoleEdit(role, draft);
  const discard = () => {
    delete roleDrafts[edit.key];
    saveLocal('role-drafts', roleDrafts);
  };
  view.edit = edit;
  view.editor = renderRoleEditor($('roles-view'), edit, {
    restored: !!draft,
    cancel: edit.name ? `#roles/${encodeURIComponent(edit.name)}` : '#roles',
    onCancel: discard,
    onDiscard: () => {
      discard();
      void openRoles('edit', edit.name);
    },
    onInput: () => saveRoleDraft(edit),
    onReload: () => reloadRole(view),
    onSubmit: (event) => saveRole(event, view),
  });
  return view.editor.title;
}

function saveRoleDraft(edit) {
  if (edit.changed) roleDrafts[edit.key] = edit.draft;
  else delete roleDrafts[edit.key];
  saveLocal('role-drafts', roleDrafts);
}

function renderRoleEdit(view, message) {
  if (roleView !== view) return;
  view.editor.update(message);
  if (!document.activeElement || document.activeElement === document.body)
    (view.edit.conflict ? view.editor.reload : view.editor.save).focus({ preventScroll: true });
}

async function reloadRole(view) {
  const edit = view.edit;
  edit.saving = true;
  renderRoleEdit(view);
  let message;
  try {
    await edit.refresh();
    saveRoleDraft(edit);
    message =
      'This role changed while you were editing. Your changes are kept. Save again to replace it, or cancel to keep the current version.';
  } catch (error) {
    message =
      error.status === 404
        ? 'This role was deleted while you were editing.'
        : 'Could not load the current role. Your changes are kept. Load it before saving again.';
  } finally {
    edit.saving = false;
  }
  renderRoleEdit(view, message);
}

async function saveRole(event, view) {
  event.preventDefault();
  const edit = view.edit;
  if (edit.saving || edit.conflict) return;
  edit.saving = true;
  renderRoleEdit(view);
  let message = '';
  try {
    const name = await edit.save();
    delete roleDrafts[edit.key];
    saveLocal('role-drafts', roleDrafts);
    void rolePicker.load().then(renderSidebar);
    if (roleView === view) location.hash = `#roles/${encodeURIComponent(name)}`;
    return;
  } catch (error) {
    if (error.status === 412 && edit.conflict) {
      edit.saving = false;
      await reloadRole(view);
      return;
    }
    message =
      error.status === 412
        ? 'A role with this name already exists. Choose another name.'
        : edit.operation
          ? 'Could not confirm the save. Your changes are kept. Retry to confirm it.'
          : error.message;
  } finally {
    edit.saving = false;
  }
  renderRoleEdit(view, message);
}

function route() {
  closeSidebar();
  $('title-dialog').close();
  $('event-dialog').close();
  titleEdit = null;
  const from = roleView?.name;
  roleView?.controller.abort();
  roleView = null;
  const match = /^#agent\/(\d{1,39})(?:\?(.*))?$/.exec(location.hash);
  if (match) {
    void openAgent(match[1], new URLSearchParams(match[2]).get('call'));
    return;
  }
  rememberView();
  saveDraft();
  focused?.controller.abort();
  focused = null;
  renderQueue($('queued-messages'), []);
  $('composer').value = drafts.new || '';
  $('composer').placeholder = 'Describe your task…';
  $('jump-latest').hidden = true;
  const roles = /^#roles(?:\/([^/]+)(\/edit)?)?$/.exec(location.hash);
  if (location.hash === '#new-role') {
    void openRoles('edit');
  } else if (roles) {
    let name = roles[1];
    try {
      name &&= decodeURIComponent(name);
    } catch {
      /* Keep a malformed name as written. */
    }
    void openRoles(roles[2] ? 'edit' : name ? 'role' : 'list', name, from);
  } else {
    showView('welcome');
    viewError = null;
  }
  renderSidebar();
  updateConnection();
}

// Async calls can outlive the turn, so stopping the turn leaves them running.
function canInterrupt() {
  return (
    !!focused?.log.metadata &&
    (focused.log.activity.turn === 'active' ||
      focused.log.tools.values().some((tool) => !tool.is_async))
  );
}

function hasBackgroundWork() {
  return (
    !!focused?.log.metadata &&
    backgroundCalls(focused.events || [], focused.log.tools.values()).length > 0
  );
}

async function interruptAgent() {
  if (
    !canInterrupt() ||
    focused.log.activity.interrupt_pending ||
    interrupting.has(focused.id) ||
    stoppingBackground.has(focused.id)
  )
    return;
  await requestInterrupt(interrupting, false);
}

async function stopBackground() {
  if (
    !hasBackgroundWork() ||
    focused.log.activity.interrupt_includes_async_tool_calls ||
    stoppingBackground.has(focused.id)
  )
    return;
  await requestInterrupt(stoppingBackground, true);
}

async function requestInterrupt(requests, includeAsyncToolCalls) {
  const id = focused.id;
  const operation = prepareWrite(`/agents/${id}/interrupts`, {
    include_async_tool_calls: includeAsyncToolCalls,
  });
  requests.add(id);
  renderHeader();
  try {
    await write(operation);
  } catch (error) {
    toast(error.message);
  } finally {
    requests.delete(id);
    renderHeader();
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const text = $('composer').value.trim();
  const role = rolePicker.name;
  const images = attachments.content();
  if (
    sending ||
    isSubagent() ||
    attachments.pending() ||
    (!text && !images.length) ||
    (focused && !focused.ready)
  )
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
  if (!focused?.log.metadata || isSubagent()) return;
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
  if (!summary || isSubagent() || inboxWriting) return;
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
  if (!summary || isSubagent() || inboxWriting) return;
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
$('retry-stall').onclick = () => void resumeStalled();
$('retry-subagents').onclick = () => {
  if (focused) void loadChildren(focused);
};
$('more-settled').onclick = loadSettled;
document.querySelector('[data-section=settled]').addEventListener('toggle', (event) => {
  if (event.target.open) void loadSettled();
});
$('background').addEventListener('click', showCall);
$('trace').onclick = () => {
  trace = !trace;
  if (trace && focused) void loadChildren(focused);
  scheduleRender();
};
function chooseInbox(choice) {
  inboxMenu.close();
  $('inbox-button').focus({ preventScroll: true });
  choice();
}
$('stop-background').onclick = () => chooseInbox(() => void stopBackground());
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
    const input = $('snooze-time');
    const nextHour = new Date();
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    input.min = localDateTime(new Date());
    input.value = localDateTime(nextHour);
    input.setCustomValidity('');
    $('snooze-dialog').showModal();
    input.focus();
    try {
      input.showPicker?.();
    } catch {
      // The field stays usable when the browser cannot open its picker.
    }
  });
function localDateTime(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
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
  connectivity.restart();
  updateConnection();
  reconnect();
});
window.addEventListener('offline', updateConnection);
window.addEventListener('pagehide', saveDraft);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Returning to the page reconnects; give it a fresh chance before reporting a problem.
  connectivity.restart();
  if (focused) dismissNotifications(focused.id);
});
enableNotifications($('notifications'), $('notifications-toggle'), $('notifications-note'));
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
setInterval(() => {
  renderSidebar();
  // Agent links show how long each agent has been in its state.
  if (trace) scheduleRender(false);
}, 60_000);
route();
void connectList();
