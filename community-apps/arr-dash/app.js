'use strict';

const query = new URLSearchParams(location.search);
const refreshSeconds = Math.max(5, Math.min(60, parseInt(query.get('refreshSeconds'), 10) || 10));

const SERVICES = [
  { key: 'sonarr', name: 'Sonarr', missingWord: 'missing' },
  { key: 'radarr', name: 'Radarr', missingWord: 'missing' },
  { key: 'lidarr', name: 'Lidarr', missingWord: 'wanted' },
  { key: 'sabnzbd', name: 'SABnzbd' },
  { key: 'youtarr', name: 'Youtarr' },
  { key: 'lidatube', name: 'LidaTube' },
];

// Disk-used thresholds, same as Kha-kis/arr-dashboard's Pulse feed
const DISK_WARNING_PERCENT = 80;
const DISK_CRITICAL_PERCENT = 90;
const MAX_ATTENTION_CARDS = 4;

const $ = selector => document.querySelector(selector);

// selected = one service key to focus the right column on, or null for combined
const state = { selected: null, lastServices: null };

function applyTheme() {
  document.documentElement.dataset.theme = query.get('_dark') === '0' ? 'light' : 'dark';
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e12) return (n / 1e12).toFixed(1) + ' TB';
  if (n >= 1e9) return Math.round(n / 1e9) + ' GB';
  return Math.round(n / 1e6) + ' MB';
}

function formatCount(value) {
  const n = Number(value) || 0;
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
}

function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return time;
  return 'Tomorrow ' + time;
}

// ── Rail ─────────────────────────────────────────────────────────────────────
function railRow(service, slice) {
  let headline;
  if (!slice) {
    headline = '<span class="hd state idle">…</span>';
  } else if (slice.up === false) {
    headline = '<span class="hd state bad">Down</span>';
  } else if (service.key === 'sabnzbd') {
    if (slice.paused) headline = '<span class="hd state idle">paused</span>';
    else if (slice.kbpersec > 50) headline = '<span class="hd">' + esc((slice.kbpersec / 1024).toFixed(1)) + '<span class="sub">MB/s</span></span>';
    else headline = '<span class="hd state idle">idle</span>';
  } else if (service.key === 'youtarr') {
    headline = '<span class="hd">' + slice.jobCount + '<span class="sub">' + (slice.jobCount === 1 ? 'job running' : 'jobs') + '</span></span>';
  } else if (service.key === 'lidatube') {
    headline = '<span class="hd state ok">Up</span>';
  } else {
    headline = '<span class="hd">' + (slice.queueCount || 0)
      + '<span class="sub">&#8595; &#183; ' + formatCount(slice.missing) + ' ' + service.missingWord
      + (slice.cutoffUnmet ? '<br>' + formatCount(slice.cutoffUnmet) + ' upgrades' : '') + '</span></span>';
  }
  // dot carries the app's brand color (via b-* text color + currentColor background); red X when down
  const down = slice && slice.up === false;
  return '<button type="button" class="svc' + (state.selected === service.key ? ' sel' : '') + '" data-svc="' + service.key + '">'
    + '<span class="dot b-' + service.key + (down ? ' down' : '') + '"></span><span class="nm b-' + service.key + '">' + service.name + '</span>' + headline + '</button>';
}

// ── Center list ──────────────────────────────────────────────────────────────
function statusIsWarning(status) {
  return /stalled|warning|failed|error|paused/i.test(String(status || ''));
}

function mergedItems(services) {
  const rows = [];
  for (const service of focusedServices()) {
    const slice = services[service.key];
    if (!slice || !slice.configured || !Array.isArray(slice.items)) continue;
    for (const item of slice.items) rows.push(Object.assign({ service: service.key }, item));
  }
  rows.sort((a, b) => (b.progress != null ? b.progress : -1) - (a.progress != null ? a.progress : -1));
  return rows;
}

function itemRow(item) {
  const problem = item.problem;
  const warn = !!problem || statusIsWarning(item.status);
  const level = problem && problem.state === 'failed' ? 'err' : (warn ? 'warn' : '');
  const eta = problem ? problem.label : (warn ? item.status : (item.timeleft || item.status || ''));
  const bar = item.progress != null
    ? '<div class="bar"><i' + (level ? ' class="' + level + '"' : '') + ' style="width:' + Math.max(0, Math.min(100, item.progress)) + '%"></i></div>'
    : '';
  return '<div class="dl"><div class="top">'
    + '<span class="badge b-' + item.service + '">' + item.service.toUpperCase().replace('NZBD', '') + '</span>'
    + '<span class="ttl">' + esc(item.title) + '</span>'
    + '<span class="eta' + (level ? ' ' + level : '') + '">' + esc(eta) + '</span>'
    + '</div>' + bar + '</div>';
}

// ── Right column ─────────────────────────────────────────────────────────────
function focusedServices() {
  return state.selected ? SERVICES.filter(s => s.key === state.selected) : SERVICES;
}

// Disks deduped across services (several *arrs usually share one array)
function focusedDisks(services) {
  const seen = new Map();
  for (const service of focusedServices()) {
    const slice = services[service.key];
    if (!slice || !Array.isArray(slice.disks)) continue;
    for (const disk of slice.disks) {
      if (!disk.total) continue;
      seen.set(disk.path + '|' + disk.total, disk);
    }
  }
  return Array.from(seen.values());
}

function diskUsedPercent(disk) {
  return Math.round((1 - disk.free / disk.total) * 100);
}

function diskLevel(disk) {
  const used = diskUsedPercent(disk);
  if (used >= DISK_CRITICAL_PERCENT) return 'err';
  if (used >= DISK_WARNING_PERCENT) return 'warn';
  return 'ok';
}

// One "needs attention" feed: services down, *arr health, failed/stuck
// downloads, and disks past the thresholds — errors first.
function attentionHtml(services) {
  const entries = [];
  const add = (err, who, text) => entries.push({ err, who, text });
  for (const service of focusedServices()) {
    const slice = services[service.key];
    if (!slice || !slice.configured) continue;
    if (slice.up === false) {
      add(true, service.name, slice.error || 'Unreachable');
      continue;
    }
    for (const entry of slice.health || []) add(entry.type === 'error', service.name, entry.message);
    for (const item of slice.items || []) {
      if (item.problem) add(item.problem.state === 'failed', service.name, item.problem.label + ' · ' + item.title);
    }
  }
  for (const disk of focusedDisks(services)) {
    const level = diskLevel(disk);
    if (level !== 'ok') add(level === 'err', 'Disk', disk.path + ' is ' + diskUsedPercent(disk) + '% full');
  }
  if (!entries.length) {
    const who = state.selected ? SERVICES.find(s => s.key === state.selected).name : 'All services';
    return '<div class="ok-pill">&#10003;&nbsp; ' + who + ' healthy</div>';
  }
  entries.sort((a, b) => Number(b.err) - Number(a.err));
  // The focused view spends a slot on the Open-web-UI button
  const max = state.selected ? MAX_ATTENTION_CARDS - 1 : MAX_ATTENTION_CARDS;
  const shown = entries.length > max ? entries.slice(0, max - 1) : entries;
  const cards = shown.map(entry =>
    '<div class="hw' + (entry.err ? ' err' : '') + '"><b>' + esc(entry.who) + '</b><span>' + esc(entry.text) + '</span></div>');
  if (entries.length > shown.length) cards.push('<div class="hw-more">+' + (entries.length - shown.length) + ' more need attention</div>');
  return cards.join('');
}

function disksHtml(services) {
  return focusedDisks(services).slice(0, 3).map(disk => {
    const level = diskLevel(disk);
    return '<div class="disk"><div class="lbl"><span>' + esc(disk.path) + '</span>'
      + '<span class="free' + (level !== 'ok' ? ' ' + level : '') + '">' + formatBytes(disk.free) + ' free of ' + formatBytes(disk.total) + '</span></div>'
      + '<div class="bar"><i class="' + level + '" style="width:' + diskUsedPercent(disk) + '%"></i></div></div>';
  }).join('');
}

function calendarHtml(services) {
  const entries = [];
  for (const service of focusedServices()) {
    const slice = services[service.key];
    if (!slice || !Array.isArray(slice.calendar)) continue;
    entries.push(...slice.calendar);
  }
  entries.sort((a, b) => new Date(a.when) - new Date(b.when));
  if (!entries.length) return '<div class="none">Nothing scheduled</div>';
  return entries.slice(0, 5).map(entry =>
    '<div class="it"><span class="nm">' + esc(entry.title) + '</span><span class="when">' + esc(formatWhen(entry.when)) + '</span></div>'
  ).join('');
}

function historyHtml(slice) {
  const rows = (slice && slice.history) || [];
  if (!rows.length) return '<div class="none">No recent history</div>';
  return rows.slice(0, 5).map(entry =>
    '<div class="it"><span class="nm">' + esc(entry.title) + '</span><span class="when">' + esc(entry.status || '') + '</span></div>'
  ).join('');
}

// ── Render ───────────────────────────────────────────────────────────────────
function render(services) {
  state.lastServices = services;
  const configured = SERVICES.filter(s => services[s.key] && services[s.key].configured);
  $('#rail').innerHTML = configured.length
    ? configured.map(s => railRow(s, services[s.key])).join('')
    : '<div class="svc"><span class="nm">No services configured</span></div>';

  const items = mergedItems(services);
  $('#activity-heading').textContent = items.length ? 'Active downloads · ' + items.length : 'Active downloads';
  $('#back-all').hidden = !state.selected;
  let listHtml = items.map(itemRow).join('');
  if (state.selected) {
    if (!items.length) listHtml = '<div class="empty-line">No active downloads</div>';
    const slice = services[state.selected] || {};
    const history = Array.isArray(slice.history) ? slice.history.slice(0, 5) : [];
    if (history.length) {
      listHtml += '<div class="sec hist-sec">Recent history</div>'
        + history.map(entry => itemRow({ service: state.selected, title: entry.title, status: entry.status, progress: null, timeleft: null })).join('');
    }
  } else if (!items.length) {
    listHtml = '<div class="empty">No active downloads</div>';
  }
  $('#dl-list').innerHTML = listHtml;

  const focused = state.selected && SERVICES.find(s => s.key === state.selected);
  $('#open-row').innerHTML = focused
    ? '<button type="button" class="open-btn" id="open-web">Open ' + focused.name + ' web UI&nbsp;&nbsp;&#8599;</button>'
    : '';

  $('#health').innerHTML = attentionHtml(services);
  $('#disks').innerHTML = disksHtml(services);
  if (state.selected === 'sabnzbd') {
    $('#cal-heading').textContent = 'Recent history';
    $('#cal').innerHTML = historyHtml(services.sabnzbd);
  } else {
    $('#cal-heading').textContent = 'Next 24 hours';
    $('#cal').innerHTML = calendarHtml(services);
  }
  syncScrollbar();
}

function renderError(message) {
  $('#health').innerHTML = '<div class="hw err"><b>Dashboard</b><span>' + esc(message) + '</span></div>';
}

// ── Custom finger scrollbar ──────────────────────────────────────────────────
function syncScrollbar() {
  const list = $('#dl-list');
  const bar = $('#sbar');
  const thumb = $('#sbar-thumb');
  const overflow = list.scrollHeight - list.clientHeight;
  bar.hidden = overflow <= 4;
  if (bar.hidden) return;
  const track = bar.clientHeight;
  const size = Math.max(64, track * list.clientHeight / list.scrollHeight);
  thumb.style.height = size + 'px';
  thumb.style.top = (list.scrollTop / overflow * (track - size)) + 'px';
}

function wireScrollbar() {
  const list = $('#dl-list');
  const bar = $('#sbar');
  const thumb = $('#sbar-thumb');
  list.addEventListener('scroll', syncScrollbar, { passive: true });
  window.addEventListener('resize', syncScrollbar);

  let dragStartY = null;
  let dragStartScroll = 0;
  thumb.addEventListener('pointerdown', event => {
    dragStartY = event.clientY;
    dragStartScroll = list.scrollTop;
    thumb.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  thumb.addEventListener('pointermove', event => {
    if (dragStartY == null) return;
    const track = bar.clientHeight - thumb.clientHeight;
    if (track <= 0) return;
    const overflow = list.scrollHeight - list.clientHeight;
    list.scrollTop = dragStartScroll + (event.clientY - dragStartY) / track * overflow;
  });
  const endDrag = () => { dragStartY = null; };
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);

  bar.addEventListener('pointerdown', event => {
    if (event.target === thumb) return;
    const rect = thumb.getBoundingClientRect();
    list.scrollTop += (event.clientY < rect.top ? -1 : 1) * list.clientHeight * 0.9;
  });
}

// ── Data loop ────────────────────────────────────────────────────────────────
async function refresh() {
  try {
    const payload = await fetchSummary();
    render(payload.services);
  } catch (error) {
    renderError(error.message || 'Refresh failed');
  } finally {
    setTimeout(refresh, refreshSeconds * 1000);
  }
}

async function fetchSummary() {
  const response = await fetch('/app-api/summary', { cache: 'no-store' });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch (error) { payload = {}; }
  if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Request failed (' + response.status + ')');
  return payload;
}

$('#open-row').addEventListener('click', async event => {
  if (!event.target.closest('#open-web') || !state.selected) return;
  try {
    const response = await fetch('/app-api/open?svc=' + encodeURIComponent(state.selected), { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Could not open');
  } catch (error) {
    renderError(error.message || 'Could not open');
  }
});

$('#back-all').addEventListener('click', () => {
  state.selected = null;
  if (state.lastServices) render(state.lastServices);
});

$('#rail').addEventListener('click', event => {
  const row = event.target.closest('.svc[data-svc]');
  if (!row) return;
  state.selected = state.selected === row.dataset.svc ? null : row.dataset.svc;
  if (state.lastServices) render(state.lastServices);
});

applyTheme();
wireScrollbar();
refresh();
