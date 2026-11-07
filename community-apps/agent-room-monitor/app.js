'use strict';

// ---- Config from URL (served mode: non-secret options arrive as query params) ----
const params = new URLSearchParams(location.search);
const PINNED_ROOM = (params.get('room') || '').trim().toUpperCase();

// Apply host theme (served apps receive ?theme=light|dark; host may also set data-theme).
const THEME = (params.get('theme') || '').trim();
if (THEME === 'light' || THEME === 'dark') document.documentElement.dataset.theme = THEME;

const POLL_MS = 2000;
const DISCOVER_MS = 10000;
const RETRY_MAX_MS = 15000;
const DEFAULT_CLOSE_SUMMARY = 'Closed from panel';
const TAP_SWALLOW_MS = 700;
const DISMISS_ARM_MS = 4000;   // how long a 'Confirm dismiss' stays armed before relaxing
// The panel hides a served app by display:none on its <webview> WITHOUT flipping the guest's
// document.visibilityState (verified), but requestAnimationFrame pauses when not composited. So a
// stale rAF heartbeat = the panel isn't showing this app. Presence/seen are gated on a fresh frame.
const HEARTBEAT_STALE_MS = 1500;
// Chime on a new ask: on unless the app option explicitly disables it (a bool option arrives as
// '0'/'false' when off, '1'/'true' or absent when on).
const CHIME_ON = params.get('chime') !== 'false' && params.get('chime') !== '0';
const MODES = ['1', '2', '3'];

// ---- Element refs ----
const $ = (id) => document.getElementById(id);
const els = {
  shell: $('app'), statusDot: $('statusDot'), roomTitle: $('roomTitle'), roomCode: $('roomCode'),
  modeBadge: $('modeBadge'), closedBadge: $('closedBadge'), newRoomBtn: $('newRoomBtn'), roomsBtn: $('roomsBtn'), historyBtn: $('historyBtn'),
  rail: $('rail'), railToggle: $('railToggle'), objective: $('objective'),
  pCount: $('pCount'), participants: $('participants'),
  roomsCount: $('roomsCount'), roomList: $('roomList'),
  transcript: $('transcript'), messages: $('messages'), newPill: $('newPill'), newPillCount: $('newPillCount'),
  composer: $('composer'), viewerName: $('viewerName'), input: $('input'), sendBtn: $('sendBtn'), sendError: $('sendError'),
  modeSeg: $('modeSeg'), needsChip: $('needsChip'), needsN: $('needsN'), needsDock: $('needsDock'),
  focusAsk: $('focusAsk'), focusTranscript: $('focusTranscript'), focusMessages: $('focusMessages'),
  focusComposer: $('focusComposer'), focusInput: $('focusInput'), focusSendBtn: $('focusSendBtn'), focusViewerName: $('focusViewerName'), focusSendError: $('focusSendError'),
  overlay: $('overlay'), overlayKicker: $('overlayKicker'), overlayTitle: $('overlayTitle'),
  overlayBody: $('overlayBody'), overlayCount: $('overlayCount'), overlayList: $('overlayList'), overlayRetry: $('overlayRetry'), overlayHistory: $('overlayHistory'), overlayBack: $('overlayBack'),
  closeDlg: $('closeDlg'), closeDlgTitle: $('closeDlgTitle'), closeDlgBody: $('closeDlgBody'),
  closeSummary: $('closeSummary'), closeCancel: $('closeCancel'), closeConfirm: $('closeConfirm'), closeError: $('closeError'),
};

// ---- Runtime state ----
const state = {
  code: PINNED_ROOM || null,
  pinned: Boolean(PINNED_ROOM),
  cursor: 0,
  status: 'loading',
  viewerName: 'viewer',
  colors: new Map(),   // name -> color
  roles: new Map(),    // name -> role
  atBottom: true,
  newCount: 0,
  pollTimer: null,
  discoverTimer: null,
  retryMs: POLL_MS,
  candidate: null,     // a newer open room to offer without hijacking
  seen: new Set(),     // message ids already rendered (dedupe)
  sending: false,      // guard against double-POST on rapid Enter
  polling: false,      // serialize poll application (scheduled vs post-send)
  rooms: [],           // last known open rooms (rail list)
  closeTarget: null,   // room being closed via the dialog
  closing: false,      // guard against double close
  // ---- Needs-you tray + view modes ----
  mode: '1',           // '1' Classic | '2' 3-Panel | '3' Focus
  asks: [],            // open asks (from hydrate/poll)
  askIdx: 0,           // which ask is shown (one at a time)
  askDrafts: new Map(),// id -> in-progress reply text (preserved across polls/mode switch)
  askSeenMax: null,    // highest ask id seen; a higher one is "new" (chime + auto-open)
  dockOpen: false,     // Classic: is the dock showing
  autoOpenDone: false, // Classic: the dock auto-opens for the FIRST new ask only, then never again
  dismissArm: null,    // ask id armed for the confirm tap
  dismissTimer: null,
  needsError: null,    // { id, msg } shown under the current ask
  needsKey: '',        // last render key, so a poll doesn't clobber a draft mid-type
  answering: false,    // guard against double answer/dismiss
  audio: null,         // lazily-created AudioContext for the chime
  // ---- Presence + seen (Agent Room server 0.11.0) ----
  lastFrameAt: 0,      // timestamp of the last rAF; stale => the webview is display:none (not shown)
  reportedSeen: new Set(), // ask ids already reported seen (retry drops them back out)
  seenUnsupported: false,  // a pre-0.11.0 server 404'd /asks/seen — stop trying
};

// ---- Small helpers ----
async function callApi(action, query, init) {
  const qs = new URLSearchParams(query || {}).toString();
  const url = '/app-api/' + action + (qs ? '?' + qs : '');
  let res;
  try {
    res = await fetch(url, init);
  } catch (error) {
    return { ok: false, error: 'panel bridge unreachable' };
  }
  let json = null;
  try { json = await res.json(); } catch (error) { json = null; }
  if (!json) return { ok: false, error: 'bad response' };
  return json;
}

// Touch on the panel does not arrive as touch events: the host turns each finger frame into
// synthesized mouse events on the webview (mouseDown on the first frame, mouseMove per frame,
// mouseUp on lift), and a click only forms if that sequence stays on one element. Activate on
// pointerdown instead — the first frame, before any jitter — the way the panel's own tiles arm on
// first touch, and swallow the click that follows so a mouse never fires twice. Keyboard and
// programmatic activation (knob press) still arrive as a bare click and run normally.
function tap(el, fn) {
  let armedAt = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || el.disabled) return;
    armedAt = Date.now();
    fn(e);
  });
  el.addEventListener('click', (e) => {
    e.preventDefault();
    if (Date.now() - armedAt < TAP_SWALLOW_MS) return;
    fn(e);
  });
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function setStatus(status) {
  state.status = status;
  els.shell.dataset.status = status;
  els.closedBadge.hidden = status !== 'closed';
  els.statusDot.dataset.state = (status === 'open' || status === 'closed' || status === 'error') ? status : 'loading';
  const closed = status === 'closed';
  els.input.disabled = closed;
  els.sendBtn.disabled = closed || !els.input.value.trim();
  els.focusInput.disabled = closed;
  els.focusSendBtn.disabled = closed || !els.focusInput.value.trim();
}

// ---- Overlay state screens ----
// Background regions made inert while any overlay is up, so keyboard focus can't sit behind it.
const bgRegions = [document.querySelector('.topbar'), document.querySelector('.body')];
function setInertBackground(on) { for (const el of bgRegions) { if (el) el.inert = on; } }

// The overlay is a 1920x480 workspace: a fixed 320px context rail (kicker, title, copy, count, Back /
// Retry) and a four-column grid of 64px room cards that is the only thing allowed to scroll. Every
// control is a normal <button>: tap, click, Tab, Enter and Space all work with no knob present; the
// knob (when there is one) merely moves the same selection.
function showOverlay(title, body, opts = {}) {
  if (els.overlay.hidden) state.prevFocus = document.activeElement;   // capture only on hidden -> shown
  els.overlay.dataset.kind = opts.kind || '';
  els.overlayKicker.textContent = opts.kicker || (opts.kind === 'history' ? 'History' : 'Agent Room Monitor');
  els.overlayList.setAttribute('aria-label', opts.kind === 'history' ? 'Closed room history' : 'Open rooms');
  els.overlayTitle.textContent = title;
  els.overlayBody.textContent = body || '';
  els.overlayRetry.hidden = !opts.retry;
  els.overlayBack.hidden = !opts.back;   // offered when there is somewhere to go back to
  els.overlayHistory.hidden = !opts.history;   // rail action on the waiting screen
  state.overlayOnBack = opts.onBack || null;   // Back returns here; default hides the overlay
  els.overlayList.hidden = !opts.list;
  els.overlayList.textContent = '';
  els.overlayList.scrollTop = 0;
  const rooms = opts.list || [];
  if (opts.list) {
    const noun = opts.kind === 'history' ? 'closed room' : 'open room';
    els.overlayCount.textContent = rooms.length + ' ' + noun + (rooms.length === 1 ? '' : 's');
    els.overlayCount.hidden = false;
    for (const room of rooms) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      const title = document.createElement('span');
      title.className = 'room-opt-title';
      title.textContent = room.title || room.code;
      const meta = document.createElement('span');
      meta.className = 'room-opt-meta';
      const count = Number(room.latest_message_id) || 0;
      meta.textContent = room.status === 'closed'
        ? room.code + ' · ' + fmtDate(room.updated_at) + ' · ' + count + ' message' + (count === 1 ? '' : 's')
        : room.code + ' · ' + (room.active_agents || 0) + ' agent' + ((room.active_agents === 1) ? '' : 's');
      btn.append(title, meta);
      // Plain click: works for tap (after the drag-scroll guard), mouse, keyboard and the knob's press.
      btn.addEventListener('click', () => { hideOverlay(); attach(room.code); });
      li.append(btn);
      els.overlayList.append(li);
    }
  } else {
    els.overlayCount.hidden = true;
  }
  // Interactive overlays (picker / retry / back) are modal dialogs; passive ones (loading / waiting) are status.
  const interactive = Boolean(opts.list || opts.retry || opts.back || opts.history);
  els.overlay.setAttribute('role', interactive ? 'dialog' : 'status');
  if (interactive) els.overlay.setAttribute('aria-modal', 'true'); else els.overlay.removeAttribute('aria-modal');
  els.overlay.setAttribute('aria-live', interactive ? 'off' : 'polite');
  els.overlay.hidden = false;
  setInertBackground(true);
  // Initial selection: the first card; with no cards, Back; failing that, Retry.
  const order = overlayButtons();
  let start = 0;
  if (!rooms.length) {
    const hist = order.indexOf(els.overlayHistory), back = order.indexOf(els.overlayBack), retry = order.indexOf(els.overlayRetry);
    start = hist >= 0 ? hist : (back >= 0 ? back : (retry >= 0 ? retry : 0));
  }
  if (order.length) selectOverlay(start);
  else { try { els.overlay.focus(); } catch (e) {} }
}

// Explicit logical order of the overlay's controls: cards row-major (newest first), then Retry, then
// Back as the boundary sentinel. Used for the initial selection and for the knob; the DOM order is
// rail-before-grid for screen readers and Tab, which is fine because Tab has its own rules.
function overlayButtons() {
  if (els.overlay.hidden) return [];
  const btns = Array.from(els.overlayList.querySelectorAll('button'));
  if (!els.overlayRetry.hidden) btns.push(els.overlayRetry);
  if (!els.overlayHistory.hidden) btns.push(els.overlayHistory);
  if (!els.overlayBack.hidden) btns.push(els.overlayBack);
  return btns;
}
function markSelected(i) {
  const btns = overlayButtons();
  state.knobFocus = i;
  btns.forEach((b, j) => b.classList.toggle('is-selected', j === i && b.matches('.overlay-list button')));
}
function selectOverlay(i) {
  const btns = overlayButtons();
  if (!btns.length) return;
  i = Math.max(0, Math.min(btns.length - 1, i));
  markSelected(i);
  const target = btns[i];
  try { target.focus({ preventScroll: true }); } catch (e) {}
  if (target.matches('.overlay-list button')) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });   // only the grid moves
}
// Touch, mouse and keyboard focus keep the selection in sync so a later knob turn continues from there.
document.getElementById('overlay').addEventListener('focusin', (e) => {
  const i = overlayButtons().indexOf(e.target);
  if (i >= 0) markSelected(i);
});

// Finger-drag scrolling for the room grid. The panel delivers touch as synthesized mouse events, which
// never scroll a container by themselves; this is the same pattern the Music Assistant app uses. A
// drag past the threshold scrolls the grid and swallows the click that would otherwise open a card.
function attachDragScroll(element, threshold = 8) {
  let gesture = null, suppressClick = false, clearSuppression = null;
  element.addEventListener('pointerdown', (e) => {
    if (e.isPrimary === false || (e.button !== undefined && e.button !== 0)) return;
    gesture = { pointerId: e.pointerId, startY: e.clientY, startScrollTop: element.scrollTop, dragged: false };
  });
  element.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const delta = e.clientY - gesture.startY;
    if (!gesture.dragged && Math.abs(delta) < threshold) return;
    if (!gesture.dragged) { gesture.dragged = true; try { element.setPointerCapture(e.pointerId); } catch (err) {} }
    element.scrollTop = gesture.startScrollTop - delta;
    if (e.cancelable) e.preventDefault();
  });
  const finish = (e) => {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    if (gesture.dragged) {
      suppressClick = true;
      clearTimeout(clearSuppression);
      clearSuppression = setTimeout(() => { suppressClick = false; }, 0);
    }
    try { element.releasePointerCapture(e.pointerId); } catch (err) {}
    gesture = null;
  };
  element.addEventListener('pointerup', finish);
  element.addEventListener('pointercancel', finish);
  element.addEventListener('pointerleave', (e) => { if (gesture && !gesture.dragged && e.pointerId === gesture.pointerId) gesture = null; });
  element.addEventListener('lostpointercapture', (e) => { if (gesture && e.pointerId === gesture.pointerId) gesture = null; });
  element.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    clearTimeout(clearSuppression);
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}
attachDragScroll(document.getElementById('overlayList'));

function hideOverlay() {
  els.overlay.hidden = true;
  if (els.closeDlg.hidden) setInertBackground(false);   // keep inert while the close dialog is up
  const prev = state.prevFocus;
  state.prevFocus = null;
  if (prev && document.contains(prev) && typeof prev.focus === 'function') { try { prev.focus(); } catch (e) {} }
}

// ---- Rendering ----
function colorFor(name) { return state.colors.get(name) || 'var(--faint)'; }

function applyRoster(participants) {
  state.colors.clear();
  state.roles.clear();
  for (const p of participants || []) {
    if (p && p.name) { state.colors.set(p.name, p.color || 'var(--faint)'); state.roles.set(p.name, p.role || 'agent'); }
  }
  els.pCount.textContent = String((participants || []).length);
  els.participants.textContent = '';
  for (const p of participants || []) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'p-dot';
    dot.style.background = p.color || 'var(--faint)';
    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = p.name;
    const role = document.createElement('span');
    role.className = 'p-role';
    role.textContent = p.role || 'agent';
    li.append(dot, name, role);
    els.participants.append(li);
  }
}

// Rail list of open rooms: tap a room to monitor it, or close it with a summary.
function renderRoomList(open) {
  state.rooms = Array.isArray(open) ? open : [];
  els.roomsCount.textContent = String(state.rooms.length);
  els.roomList.textContent = '';
  if (!state.rooms.length) {
    const li = document.createElement('li');
    li.className = 'room-row-empty';
    li.textContent = 'No open rooms';
    els.roomList.append(li);
    return;
  }
  for (const room of state.rooms) {
    const li = document.createElement('li');
    li.className = 'room-row' + (room.code === state.code ? ' is-current' : '');
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'room-open';
    openBtn.setAttribute('aria-label', 'Monitor room ' + (room.title || room.code));
    const title = document.createElement('span');
    title.className = 'room-row-title';
    title.textContent = room.title || room.code;
    const meta = document.createElement('span');
    meta.className = 'room-row-meta';
    meta.textContent = room.code + ' · ' + (room.active_agents || 0) + ' agent' + ((room.active_agents === 1) ? '' : 's');
    openBtn.append(title, meta);
    tap(openBtn, () => { if (room.code !== state.code) attach(room.code); });
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'room-close';
    closeBtn.textContent = 'Close';
    closeBtn.setAttribute('aria-label', 'Close room ' + (room.title || room.code));
    tap(closeBtn, () => openCloseDialog(room));
    li.append(openBtn, closeBtn);
    els.roomList.append(li);
  }
}

// Fetch the open rooms and redraw the rail list. Returns the open list, or null when the
// server could not be reached (callers keep their last state in that case).
async function refreshRooms() {
  const res = await callApi('list', {});
  if (!res.ok) return null;
  const open = (res.rooms || []).filter((r) => r.status === 'open');
  renderRoomList(open);
  return open;
}

function messageEl(m) {
  const li = document.createElement('li');
  li.className = 'msg msg-' + (m.kind || 'agent');
  const rail = document.createElement('div');
  rail.className = 'msg-rail';
  rail.style.background = colorFor(m.sender);
  const main = document.createElement('div');
  main.className = 'msg-main';
  const head = document.createElement('div');
  head.className = 'msg-head';
  const name = document.createElement('span');
  name.className = 'msg-name';   // name stays in --ink; color is carried by the rail + roster dot
  name.textContent = m.sender;
  const role = document.createElement('span');
  role.className = 'msg-role';
  role.textContent = m.kind === 'ask'
    ? ('Ask #' + m.id)
    : (state.roles.get(m.sender) || (m.kind === 'human' ? 'human' : (m.kind === 'agent' ? 'agent' : '')));
  head.append(name, role);
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = m.content;              // text only — never innerHTML
  main.append(head, body);
  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = fmtTime(m.created_at);
  li.append(rail, main, time);
  return li;
}

function appendMessages(list) {
  // Dedupe by id so a scheduled poll and a post-send poll can't render a message twice.
  const fresh = [];
  for (const m of (list || [])) {
    if (m && !state.seen.has(m.id)) { state.seen.add(m.id); fresh.push(m); }
  }
  if (!fresh.length) return;
  const frag = document.createDocumentFragment();
  for (const m of fresh) frag.append(messageEl(m));
  els.messages.append(frag);
  // Mirror into the Focus-mode room feed (separate DOM, so build fresh nodes).
  const ffrag = document.createDocumentFragment();
  for (const m of fresh) ffrag.append(messageEl(m));
  els.focusMessages.append(ffrag);
  els.focusTranscript.scrollTop = els.focusTranscript.scrollHeight;
  if (state.atBottom) {
    scrollToBottom();
  } else {
    state.newCount += fresh.length;
    els.newPillCount.textContent = String(state.newCount);
    els.newPill.hidden = false;
  }
}

function scrollToBottom() {
  els.transcript.scrollTop = els.transcript.scrollHeight;
  els.focusTranscript.scrollTop = els.focusTranscript.scrollHeight;
  state.atBottom = true;
  state.newCount = 0;
  els.newPill.hidden = true;
}

// ---- Attach / hydrate / poll ----
async function attach(code) {
  stopLoops();
  state.code = code;
  state.candidate = null;
  els.newRoomBtn.hidden = true;
  setStatus('loading');
  showOverlay('Opening room…', code);
  const res = await callApi('hydrate', { room: code });
  if (!res.ok) { showOverlay('Could not open room', res.error || 'unknown error', { retry: true }); state.retryContext = () => attach(code); return; }
  const room = res.room;
  state.viewerName = room.viewer_name || 'viewer';
  els.viewerName.textContent = state.viewerName;
  els.focusViewerName.textContent = state.viewerName;
  els.roomTitle.textContent = room.title || 'Agent Room';
  els.roomCode.textContent = room.code || code;
  els.objective.textContent = room.objective || '—';
  applyRoster(room.participants);
  els.messages.textContent = '';
  els.focusMessages.textContent = '';
  state.seen = new Set();
  state.atBottom = true;
  const msgs = room.messages || [];
  appendMessages(msgs);                              // dedupe path; renders summary message on closed rooms too
  state.cursor = msgs.length ? msgs[msgs.length - 1].id : 0;
  scrollToBottom();
  setMode(room.addressed_only);
  setStatus(room.status || 'open');
  // Needs-you: reset the tray for this room, then load its open asks (no chime on first load).
  state.askSeenMax = null; state.askIdx = 0; state.askDrafts.clear();
  state.dockOpen = false; state.autoOpenDone = false; state.dismissArm = null; state.needsError = null;
  state.reportedSeen.clear(); state.seenUnsupported = false;   // fresh seen-tracking for this room
  els.needsChip.hidden = false;
  setAsks(room.asks || []);
  hideOverlay();
  markSeen();   // the room is now in view (overlay gone) — report the shown ask without waiting a poll
  renderRoomList(state.rooms);                       // re-mark the current room in the rail list
  refreshRooms();                                    // and refresh it in the background
  if (room.status === 'closed') onClosed();          // no synthetic summary — the summary-kind message already rendered
  else { startPolling(); startDiscovery(); }
  els.roomsBtn.hidden = state.pinned;
}

function setMode(addressedOnly) { els.modeBadge.hidden = !addressedOnly; }

// Single point that applies a poll result. Guarded by state.polling so the scheduled tick and
// the immediate post-send poll can't interleave; cursor only advances (monotonic).
async function doPoll() {
  if (state.polling || !state.code) return { skipped: true };
  state.polling = true;
  try {
    // viewer=1 (nameless) marks the human present on a 0.11.0 server — but only when the panel is
    // actually showing the room (composited + no overlay), so a screensaver never fakes presence.
    const q = { room: state.code, after: String(state.cursor) };
    if (isRoomInView()) q.viewer = '1';
    const res = await callApi('poll', q);
    if (!res.ok) return res;
    if (state.status === 'error') hideOverlay();
    setStatus(res.status || 'open');
    if (Array.isArray(res.participants)) applyRoster(res.participants);   // apply even when empty (roster cleared on close)
    setMode(res.addressed_only);
    if (Array.isArray(res.asks)) setAsks(res.asks);   // refresh the Needs-you tray
    if (res.messages && res.messages.length) appendMessages(res.messages);
    state.cursor = Math.max(state.cursor, Number(res.latest_message_id) || 0);
    return res;
  } finally {
    state.polling = false;
  }
}

function startPolling() {
  stopPolling();
  state.retryMs = POLL_MS;
  const tick = async () => {
    const res = await doPoll();
    if (res && res.skipped) { state.pollTimer = setTimeout(tick, POLL_MS); return; }
    if (!res || !res.ok) {
      setStatus('error');
      showOverlay('Reconnecting…', (res && res.error) || 'room server unreachable', {});
      state.retryMs = Math.min(RETRY_MAX_MS, state.retryMs * 2);
      state.pollTimer = setTimeout(tick, state.retryMs);
      return;
    }
    if (res.status === 'closed') { onClosed(); return; }
    state.retryMs = POLL_MS;
    state.pollTimer = setTimeout(tick, POLL_MS);
  };
  state.pollTimer = setTimeout(tick, POLL_MS);
}
function stopPolling() { if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; } }

// On close the server emits a `summary`-kind MESSAGE ("Meeting closed. …") which hydrate/poll
// already render via appendMessages — so we never synthesize a second summary here.
function onClosed() {
  stopPolling();
  setStatus('closed');
  startDiscovery();
}

// ---- Discovery (rail list + non-hijacking "Open new room") ----
function startDiscovery() {
  stopDiscovery();
  const tick = async () => {
    const open = await refreshRooms();
    if (open) {
      const other = open.find((r) => r.code !== state.code);
      if (state.status === 'closed' && open.length === 1 && !state.pinned) {
        // room we were in closed and exactly one open room exists — offer it prominently
        state.candidate = open[0].code;
        els.newRoomBtn.hidden = false;
      } else if (other) {
        state.candidate = other.code;
        els.newRoomBtn.hidden = false;
      } else {
        state.candidate = null;
        els.newRoomBtn.hidden = true;
      }
    }
    state.discoverTimer = setTimeout(tick, DISCOVER_MS);
  };
  state.discoverTimer = setTimeout(tick, DISCOVER_MS);
}
function stopDiscovery() { if (state.discoverTimer) { clearTimeout(state.discoverTimer); state.discoverTimer = null; } }
function stopLoops() { stopPolling(); stopDiscovery(); }

// ---- Initial discovery / selection ----
async function init() {
  setStatus('loading');
  renderRoomList([]);
  if (state.pinned) { attach(state.code); return; }
  showOverlay('Looking for rooms…', 'Discovering open Agent Room meetings on the server.');
  const res = await callApi('list', {});
  if (!res.ok) { showOverlay('Room server unavailable', res.error || 'Could not reach the Agent Room server.', { retry: true }); state.retryContext = init; return; }
  const open = (res.rooms || []).filter((r) => r.status === 'open');
  renderRoomList(open);
  if (open.length === 0) { waitForRoom(); return; }
  if (open.length === 1) { attach(open[0].code); return; }
  showOverlay('Choose a room', 'Several rooms are open. Pick one to monitor.', { list: open });
}

// No open room: the waiting screen is just the message plus a History rail button. The tick keeps
// watching for a room and attaches automatically, except while the History picker is up, so browsing
// is never yanked away; Back to the waiting screen lets the next tick attach.
function showWaitingScreen() {
  showOverlay('Waiting for a room', 'No open Agent Room meetings yet. This attaches automatically when one starts.', { history: true });
}
function waitForRoom() {
  stopLoops();
  showWaitingScreen();
  const tick = async () => {
    const open = await refreshRooms();
    const browsing = !els.overlay.hidden && els.overlay.dataset.kind === 'history';
    if (open && !browsing) {
      if (open.length === 1) { attach(open[0].code); return; }
      if (open.length > 1) { showOverlay('Choose a room', 'Several rooms are open. Pick one to monitor.', { list: open }); return; }
    }
    state.discoverTimer = setTimeout(tick, DISCOVER_MS / 2);
  };
  state.discoverTimer = setTimeout(tick, DISCOVER_MS / 2);
}

// ---- Send ----
async function submitMessage(text) {
  if (state.sending) return;                 // guard: rapid Enter can't POST twice
  state.sending = true;
  els.sendError.hidden = true;
  els.sendBtn.disabled = true;
  try {
    const res = await callApi('send', { room: state.code }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) {
      els.sendError.textContent = 'Send failed: ' + (res.error || 'unknown') + ' — your draft is kept.';
      els.sendError.hidden = false;
      return;                                 // draft preserved (input untouched)
    }
    els.input.value = '';
    autoGrow();
    await doPoll();                           // reflect immediately; dedupe + guard prevent double-render
  } finally {
    state.sending = false;
    els.sendBtn.disabled = state.status === 'closed' || !els.input.value.trim();
  }
}

// ---- Close room (dialog with a pre-filled summary) ----
function openCloseDialog(room) {
  state.closeTarget = room;
  els.closeDlgTitle.textContent = 'Close “' + (room.title || room.code) + '”?';
  els.closeDlgBody.textContent = room.code + ' — agents are removed and the summary is posted to the transcript.';
  els.closeSummary.value = DEFAULT_CLOSE_SUMMARY;
  els.closeError.hidden = true;
  els.closeConfirm.disabled = false;
  if (els.closeDlg.hidden) state.prevFocus = document.activeElement;
  els.closeDlg.hidden = false;
  setInertBackground(true);
  state.knobFocus = 1;
  try { els.closeConfirm.focus(); } catch (e) {}
}

function hideCloseDialog() {
  els.closeDlg.hidden = true;
  state.closeTarget = null;
  if (els.overlay.hidden) setInertBackground(false);   // keep inert if the main overlay is still up
  const prev = state.prevFocus;
  state.prevFocus = null;
  if (prev && document.contains(prev) && typeof prev.focus === 'function') { try { prev.focus(); } catch (e) {} }
}

async function confirmClose() {
  const room = state.closeTarget;
  if (!room || state.closing) return;
  state.closing = true;
  els.closeConfirm.disabled = true;
  els.closeError.hidden = true;
  try {
    const summary = els.closeSummary.value.trim() || DEFAULT_CLOSE_SUMMARY;
    const res = await callApi('close', { room: room.code }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary }),
    });
    if (!res.ok) {
      els.closeError.textContent = 'Close failed: ' + (res.error || 'unknown');
      els.closeError.hidden = false;
      els.closeConfirm.disabled = false;
      return;
    }
    hideCloseDialog();
    if (room.code === state.code) await doPoll();   // pulls the summary message and the closed status
    await refreshRooms();
  } finally {
    state.closing = false;
  }
}

// ---- Composer UX ----
function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(160, els.input.scrollHeight) + 'px';
  els.sendBtn.disabled = state.status === 'closed' || !els.input.value.trim();
}

// ---- Events ----
els.transcript.addEventListener('scroll', () => {
  const gap = els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight;
  state.atBottom = gap < 40;
  if (state.atBottom) { state.newCount = 0; els.newPill.hidden = true; }
});
tap(els.newPill, scrollToBottom);
tap(els.railToggle, () => {
  const collapsed = els.shell.dataset.rail === 'collapsed';
  els.shell.dataset.rail = collapsed ? 'expanded' : 'collapsed';
  els.railToggle.setAttribute('aria-expanded', String(collapsed));
});
tap(els.newRoomBtn, () => { if (state.candidate) attach(state.candidate); });
tap(els.roomsBtn, async () => {
  const res = await callApi('list', {});
  const open = res.ok ? (res.rooms || []).filter((r) => r.status === 'open') : [];
  if (res.ok) renderRoomList(open);
  showOverlay('Rooms', open.length ? 'Tap a room to monitor it.' : 'No open rooms right now.', { list: open, back: Boolean(state.code) });
});
// History picker. From an attached room, Back hides the overlay; from the waiting screen, Back
// returns to the waiting screen (onBack).
async function openHistory(opts = {}) {
  const res = await callApi('history', {});
  const rooms = res.ok ? (res.rooms || []) : [];
  const body = !res.ok ? 'Could not load history: ' + (res.error || 'unknown')
    : (rooms.length ? 'Newest first. Tap a room to read its transcript.' : 'No closed rooms yet.');
  showOverlay('History', body, { list: rooms, kind: 'history', back: Boolean(state.code) || Boolean(opts.onBack), onBack: opts.onBack });
}
tap(els.historyBtn, () => openHistory());
tap(els.overlayHistory, () => openHistory({ onBack: showWaitingScreen }));
tap(els.overlayBack, () => { const back = state.overlayOnBack; if (back) back(); else hideOverlay(); });

tap(els.overlayRetry, () => { hideOverlay(); (state.retryContext || init)(); });
tap(els.closeCancel, hideCloseDialog);
tap(els.closeConfirm, confirmClose);
tap(els.sendBtn, () => els.composer.requestSubmit());
els.closeDlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); hideCloseDialog(); } });
els.input.addEventListener('input', autoGrow);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); els.composer.requestSubmit(); }
});
els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || state.status === 'closed') return;
  submitMessage(text);
});

// ---- Panel knob (optional): context-aware ----
// Close dialog up -> rotate moves between Cancel / Close, press activates.
// Picker overlay up -> rotate moves the selection through the cards, with Back as the boundary
// sentinel (CW past the last card lands on Back, CCW before the first card lands on Back; from Back,
// CW goes to the first card and CCW to the last). With no Back shown, rotation clamps at the edges.
// Retry overlay up -> press retries. Otherwise -> rotate scrolls transcript, press jumps to newest.
window.oqKnob = function (ev) {
  if (!els.closeDlg.hidden) {
    const btns = [els.closeCancel, els.closeConfirm];
    if (ev.type === 'rotate') {
      state.knobFocus = Math.max(0, Math.min(btns.length - 1, (state.knobFocus || 0) + ev.dir));
      btns[state.knobFocus].focus();
      return true;
    }
    if (ev.type === 'press') {
      const target = btns.includes(document.activeElement) ? document.activeElement : btns[state.knobFocus || 0];
      target.click();
      return true;
    }
    return false;
  }
  const btns = overlayButtons();
  if (btns.length) {
    if (ev.type === 'rotate') {
      const n = btns.length;
      const i = state.knobFocus || 0;
      const next = els.overlayBack.hidden
        ? Math.max(0, Math.min(n - 1, i + ev.dir))
        : (((i + ev.dir) % n) + n) % n;
      selectOverlay(next);
      return true;
    }
    if (ev.type === 'press') {
      const target = btns.includes(document.activeElement) ? document.activeElement : btns[state.knobFocus || 0];
      target.click();
      return true;
    }
    return false;
  }
  if (!els.overlay.hidden) return false;
  // A visible Needs-you question captures the knob: rotate scrolls the question, press jumps the
  // transcript to newest. Falls through to plain transcript scroll when no question is shown.
  const nb = activeNeedsBody();
  if (nb) {
    if (ev.type === 'rotate') { nb.scrollTop += ev.dir * 120; return true; }
    if (ev.type === 'press') { scrollToBottom(); return true; }
  }
  if (ev.type === 'rotate') { els.transcript.scrollTop += ev.dir * 120; return true; }
  if (ev.type === 'press') { scrollToBottom(); return true; }
  return false;
};

// ========================= Needs-you tray + view modes =========================
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function loadMode() { try { const m = localStorage.getItem('agentroom.mode'); if (MODES.includes(m)) return m; } catch (e) {} return '1'; }

// Switch layout. In 3-Panel/Focus the dock is permanent, so "open" only applies to Classic.
function applyMode(mode, persist) {
  if (!MODES.includes(mode)) mode = '1';
  state.mode = mode;
  if (persist !== false) { try { localStorage.setItem('agentroom.mode', mode); } catch (e) {} }
  els.shell.dataset.mode = mode;
  for (const b of els.modeSeg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === mode);
  els.shell.dataset.dock = (mode !== '1') ? 'open' : (state.dockOpen ? 'open' : 'closed');
  renderNeeds(true);
  markSeen();   // switching to a mode that shows the ask puts it in front — report it now, not next poll
}

// One short chime on a genuinely new ask. Web Audio only; silent if blocked or disabled.
function chimeOnce() {
  if (!CHIME_ON) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = state.audio || (state.audio = new AC());
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.start(t); o.stop(t + 0.36);
  } catch (e) {}
}

function updateChip() {
  const n = state.asks.length;
  els.needsN.textContent = String(n);
  els.needsChip.classList.toggle('is-hot', n > 0);
}

// Apply a fresh open-asks list. A higher ask id than we've seen is "new": chime once and, in
// Classic, auto-open the dock — but never move the visible card or wipe a draft (no index change).
function setAsks(asks) {
  const list = Array.isArray(asks) ? asks : [];
  const curId = state.asks[state.askIdx] ? state.asks[state.askIdx].id : null;   // the question in view
  const maxId = list.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0);
  const isNew = state.askSeenMax !== null && list.some((a) => Number(a.id) > state.askSeenMax);
  state.asks = list;
  // Keep the SAME question under the user by id, not by position: an ask removed out of band (e.g.
  // answered from the web viewer) must not slide a different question into its place.
  let idx = curId != null ? list.findIndex((a) => a.id === curId) : -1;
  if (idx < 0) idx = Math.min(state.askIdx, Math.max(0, list.length - 1));
  state.askIdx = Math.max(0, idx);
  if (isNew) {
    chimeOnce();
    // Classic: auto-open the dock for the first new ask only; afterwards (or once the human has
    // closed it) a new ask only re-lights the chip — never re-opens or yanks the card.
    if (state.mode === '1' && !state.dockOpen && !state.autoOpenDone) {
      state.dockOpen = true; state.autoOpenDone = true; els.shell.dataset.dock = 'open';
    }
  }
  // Classic: when the last question clears, close the empty dock (it never sits open empty).
  if (state.mode === '1' && list.length === 0 && state.dockOpen) {
    state.dockOpen = false; els.shell.dataset.dock = 'closed';
  }
  state.askSeenMax = state.askSeenMax === null ? maxId : Math.max(state.askSeenMax, maxId);
  const ids = new Set(list.map((a) => a.id));
  for (const id of Array.from(state.askDrafts.keys())) if (!ids.has(id)) state.askDrafts.delete(id);
  if (state.dismissArm && !ids.has(state.dismissArm)) state.dismissArm = null;
  if (state.needsError && !ids.has(state.needsError.id)) state.needsError = null;
  updateChip();
  // Non-force: the key guard leaves the textarea (and its focus/caret) untouched on a 2s poll
  // when the ask set is unchanged; it rebuilds only when something actually changed.
  renderNeeds();
  markSeen();   // report the selected ask seen when it's actually in front of him
}

// Build one Needs-you panel (dock or focus) for the current ask. Text/names use textContent only.
function renderNeedsPanel(panel, ask, idx, n) {
  const isDock = panel.dataset.role === 'dock';
  panel.textContent = '';
  const head = mk('div', 'needs-head');
  head.append(mk('span', 'needs-title', 'Needs you'));
  if (ask) {
    const who = mk('div', 'needs-who');
    const dot = mk('span', 'needs-wdot'); dot.style.background = colorFor(ask.sender);
    who.append(dot, mk('span', 'needs-wname', ask.sender),
      mk('span', 'needs-tag', ask.implicit ? 'mentioned you' : 'ask #' + ask.id),
      mk('span', 'needs-wtime', fmtTime(ask.created_at)));
    head.append(who);
  }
  head.append(mk('span', 'needs-spacer'));
  if (n > 1) {
    head.append(mk('span', 'needs-count', (idx + 1) + ' of ' + n));
    const prev = mk('button', 'needs-nav', '‹'); prev.type = 'button'; prev.dataset.act = 'prev'; prev.setAttribute('aria-label', 'Previous'); prev.disabled = idx <= 0;
    const next = mk('button', 'needs-nav', '›'); next.type = 'button'; next.dataset.act = 'next'; next.setAttribute('aria-label', 'Next'); next.disabled = idx >= n - 1;
    head.append(prev, next);
  }
  if (isDock) {
    const x = mk('button', 'needs-nav needs-x', '✕'); x.type = 'button'; x.dataset.act = 'close'; x.setAttribute('aria-label', 'Close Needs you');
    head.append(x);
  }
  panel.append(head);

  const body = mk('div', 'needs-body');
  if (ask) body.append(mk('p', 'needs-text', ask.content));
  else body.append(mk('p', 'needs-empty', 'Nothing needs you right now.'));
  if (ask && state.needsError && state.needsError.id === ask.id) body.append(mk('p', 'needs-error', state.needsError.msg));
  panel.append(body);

  if (ask) {
    const reply = mk('div', 'needs-reply');
    const ta = mk('textarea', 'composer-input'); ta.rows = 1; ta.maxLength = 20000;
    ta.placeholder = 'Reply to ' + ask.sender + '…'; ta.dataset.askId = String(ask.id);
    ta.disabled = state.status === 'closed';
    if (state.askDrafts.has(ask.id)) ta.value = state.askDrafts.get(ask.id);
    const armed = state.dismissArm === ask.id;
    const dismiss = mk('button', 'needs-btn dismiss' + (armed ? ' armed' : ''), armed ? 'Confirm dismiss' : 'Dismiss');
    dismiss.type = 'button'; dismiss.dataset.act = 'dismiss';
    const send = mk('button', 'needs-btn primary', 'Send'); send.type = 'button'; send.dataset.act = 'send';
    send.disabled = state.status === 'closed' || !ta.value.trim();
    reply.append(ta, dismiss, send);
    panel.append(reply);
  }
}

// Rebuild both panels when the ask set / index / mode / arm / error changes. Guarded by a key so a
// 2s poll never tears down the textarea the human is typing in.
function renderNeeds(force) {
  const n = state.asks.length;
  if (state.askIdx >= n) state.askIdx = Math.max(0, n - 1);
  const idx = state.askIdx;
  const ask = n ? state.asks[idx] : null;
  const key = [state.mode, state.asks.map((a) => a.id).join(','), idx,
    state.status === 'closed' ? 'c' : 'o', state.dismissArm || '', state.needsError ? state.needsError.id : ''].join('|');
  if (!force && key === state.needsKey) return;
  state.needsKey = key;
  // A new ask changes the key (count/nav must update), but the human may be mid-reply. Carry the
  // focused textarea's focus, caret and scroll across the rebuild so typing is never interrupted.
  const active = document.activeElement;
  const focusAskId = (active && active.matches && active.matches('textarea[data-ask-id]')) ? active.dataset.askId : null;
  const selStart = focusAskId ? active.selectionStart : 0;
  const selEnd = focusAskId ? active.selectionEnd : 0;
  const scrollTop = focusAskId ? active.scrollTop : 0;
  renderNeedsPanel(els.needsDock, ask, idx, n);
  renderNeedsPanel(els.focusAsk, ask, idx, n);
  if (focusAskId) {
    const panel = state.mode === '3' ? els.focusAsk : els.needsDock;
    const ta = panel.querySelector('textarea[data-ask-id="' + focusAskId + '"]');
    if (ta) { try { ta.focus(); ta.setSelectionRange(selStart, selEnd); ta.scrollTop = scrollTop; } catch (e) {} }
  }
}

async function submitAnswer(ask, text) {
  if (!ask || state.answering || !text) return;
  state.answering = true; state.needsError = null;
  try {
    const res = await callApi('answer', { room: state.code, id: String(ask.id) }, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: text }),
    });
    if (!res.ok) { state.needsError = { id: ask.id, msg: 'Send failed: ' + (res.error || 'unknown') + ' — your reply is kept.' }; renderNeeds(true); return; }
    state.askDrafts.delete(ask.id); state.dismissArm = null;
    setAsks(Array.isArray(res.asks) ? res.asks : state.asks.filter((a) => a.id !== ask.id));
    await doPoll();   // pull the human reply + any status change into the transcript
  } finally { state.answering = false; }
}

function onDismiss(ask) {
  if (state.dismissArm !== ask.id) {
    state.dismissArm = ask.id; renderNeeds(true);
    clearTimeout(state.dismissTimer);
    state.dismissTimer = setTimeout(() => { if (state.dismissArm === ask.id) { state.dismissArm = null; renderNeeds(true); } }, DISMISS_ARM_MS);
    return;
  }
  clearTimeout(state.dismissTimer); state.dismissArm = null;
  doDismiss(ask);
}

async function doDismiss(ask) {
  if (state.answering) return;
  state.answering = true; state.needsError = null;
  try {
    const res = await callApi('dismiss', { room: state.code, id: String(ask.id) }, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!res.ok) { state.needsError = { id: ask.id, msg: 'Dismiss failed: ' + (res.error || 'unknown') }; renderNeeds(true); return; }
    state.askDrafts.delete(ask.id);
    setAsks(Array.isArray(res.asks) ? res.asks : state.asks.filter((a) => a.id !== ask.id));
  } finally { state.answering = false; }
}

// Run a panel button's action. Called from a delegated pointerdown (touch) and click (mouse/keyboard).
function runNeedsAct(btn) {
  const act = btn.dataset.act;
  // A manual close latches the auto-open: later asks only re-light the chip, never re-open.
  if (act === 'close') { state.dockOpen = false; state.autoOpenDone = true; if (state.mode === '1') els.shell.dataset.dock = 'closed'; return; }
  if (act === 'prev') { if (state.askIdx > 0) { state.askIdx--; state.dismissArm = null; renderNeeds(true); markSeen(); } return; }
  if (act === 'next') { if (state.askIdx < state.asks.length - 1) { state.askIdx++; state.dismissArm = null; renderNeeds(true); markSeen(); } return; }
  const ask = state.asks[state.askIdx];
  if (!ask) return;
  if (act === 'dismiss') { onDismiss(ask); return; }
  if (act === 'send') { const ta = btn.closest('.needs-reply').querySelector('textarea'); submitAnswer(ask, (ta.value || '').trim()); return; }
}

// Wire a (stable) panel: buttons activate on pointerdown because the panel delivers touch as
// synthesized mouse events and a click may never form; the trailing click is swallowed so a real
// mouse doesn't double-fire. Same pattern as tap(), but delegated so rebuilt children stay live.
function wireNeedsPanel(panel) {
  let armedAt = 0;
  panel.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const btn = e.target.closest && e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    armedAt = Date.now();
    runNeedsAct(btn);
  });
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button[data-act]');
    if (!btn) return;
    e.preventDefault();
    if (Date.now() - armedAt < TAP_SWALLOW_MS) return;   // pointerdown already handled it
    if (btn.disabled) return;
    runNeedsAct(btn);
  });
  panel.addEventListener('input', onNeedsInput);
  panel.addEventListener('keydown', onNeedsKeydown);
}

// The visible Needs-you question body (if one is shown), so the knob can scroll it.
function activeNeedsBody() {
  let panel = null;
  if (state.mode === '3') panel = els.focusAsk;
  else if (state.mode === '2') panel = els.needsDock;
  else if (state.mode === '1' && state.dockOpen) panel = els.needsDock;
  if (!panel) return null;
  const body = panel.querySelector('.needs-body');
  return (body && body.querySelector('.needs-text')) ? body : null;
}
function onNeedsInput(e) {
  const ta = e.target;
  if (!ta.matches || !ta.matches('textarea[data-ask-id]')) return;
  state.askDrafts.set(Number(ta.dataset.askId), ta.value);
  const send = ta.closest('.needs-reply').querySelector('.needs-btn.primary');
  if (send) send.disabled = state.status === 'closed' || !ta.value.trim();
  ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
}
function onNeedsKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey && e.target.matches && e.target.matches('textarea[data-ask-id]')) {
    e.preventDefault();
    const ask = state.asks[state.askIdx];
    if (ask) submitAnswer(ask, (e.target.value || '').trim());
  }
}

// Focus-mode general composer: a normal room message (not an ask answer).
async function submitFocusMessage(text) {
  if (state.sending || !text || state.status === 'closed') return;
  state.sending = true; els.focusSendBtn.disabled = true; els.focusSendError.hidden = true;
  try {
    const res = await callApi('send', { room: state.code }, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }),
    });
    if (!res.ok) {
      els.focusSendError.textContent = 'Send failed: ' + (res.error || 'unknown') + ' — your draft is kept.';
      els.focusSendError.hidden = false;
      return;                                 // draft preserved (input untouched)
    }
    els.focusInput.value = ''; els.focusInput.style.height = 'auto'; await doPoll();
  } finally { state.sending = false; els.focusSendBtn.disabled = state.status === 'closed' || !els.focusInput.value.trim(); }
}

// ---- Presence + "seen" (Agent Room server 0.11.0) ----
// Fresh rAF = the panel is compositing this app (see HEARTBEAT_STALE_MS). A display:none webview
// (tile page / tile-grid screensaver) stalls rAF, so this reads false and presence/seen stop.
function isComposited() { return (performance.now() - state.lastFrameAt) < HEARTBEAT_STALE_MS; }
// The room content is actually on his screen: composited and no picker/History/close overlay over it.
function isRoomInView() { return isComposited() && els.overlay.hidden && els.closeDlg.hidden; }
// The selected ask is in front of him: room in view AND a panel that shows it (3-Panel/Focus always,
// Classic only when the dock is open).
function seenEligible() {
  if (!isRoomInView()) return false;
  if (state.mode === '2' || state.mode === '3') return true;
  return state.mode === '1' && state.dockOpen;
}
// Report the selected ask seen — once per id, retry next tick on failure, stop silently on a 404.
function markSeen() {
  if (state.seenUnsupported || !state.code || !seenEligible()) return;
  const ask = state.asks[state.askIdx];
  if (!ask || state.reportedSeen.has(ask.id)) return;
  if (ask.seen_at) { state.reportedSeen.add(ask.id); return; }   // server already recorded it
  const id = ask.id;
  const room = state.code;               // pin the room; a stale response after a switch must be ignored
  state.reportedSeen.add(id);
  callApi('seen', { room }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) })
    .then((res) => {
      if (state.code !== room) return;                                // switched rooms — drop this reply
      if (res && res.unsupported) state.seenUnsupported = true;        // old server: give up quietly
      else if (!res || !res.ok) state.reportedSeen.delete(id);         // transient: let a later tick retry
    })
    .catch(() => { if (state.code === room) state.reportedSeen.delete(id); });
}
function startHeartbeat() {
  const tick = () => { state.lastFrameAt = performance.now(); requestAnimationFrame(tick); };
  state.lastFrameAt = performance.now();
  requestAnimationFrame(tick);
}

// ---- Wiring ----
for (const b of els.modeSeg.querySelectorAll('button')) tap(b, () => applyMode(b.dataset.m));
tap(els.needsChip, () => { state.dockOpen = !state.dockOpen; if (state.mode === '1') els.shell.dataset.dock = state.dockOpen ? 'open' : 'closed'; markSeen(); });
wireNeedsPanel(els.needsDock);
wireNeedsPanel(els.focusAsk);
els.focusComposer.addEventListener('submit', (e) => { e.preventDefault(); submitFocusMessage(els.focusInput.value.trim()); });
els.focusInput.addEventListener('input', () => {
  els.focusInput.style.height = 'auto'; els.focusInput.style.height = Math.min(120, els.focusInput.scrollHeight) + 'px';
  els.focusSendBtn.disabled = state.status === 'closed' || !els.focusInput.value.trim();
  els.focusSendError.hidden = true;   // clear a prior failure when the human edits the draft
});
els.focusInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); els.focusComposer.requestSubmit(); } });
tap(els.focusSendBtn, () => els.focusComposer.requestSubmit());

startHeartbeat();
applyMode(loadMode(), false);
init();
