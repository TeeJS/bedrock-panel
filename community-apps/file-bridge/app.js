'use strict';
// FileBridge panel app. External file (not inline) because the panel serves apps with
// CSP script-src 'self'. Full-screen VIEW navigation (main / edit / result / log), no modals.

// Follow the host panel's theme: the served URL carries _accent=<color>.
// Surfaces: '' = panel (1920×480 touch), 'editor' = embedded in the editor (dense layout +
// an "Open in window" escape hatch), 'window' = the pop-out job-manager window (same dense
// layout, no escape hatch — it IS the window).
const qs = new URLSearchParams(location.search);
const surface = qs.get('_surface') || '';
if (surface === 'editor' || surface === 'window') document.documentElement.dataset.surface = 'editor';
const accent = qs.get('_accent');
if (accent && /^#?[0-9a-f]{3,8}$/i.test(accent)) {
  document.documentElement.style.setProperty('--accent', accent.startsWith('#') ? accent : '#' + accent);
}

const $ = s => document.querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function requestJson(url, opts) {
  const response = await fetch(url, opts);
  let result = null;
  try { result = await response.json(); } catch {}
  if (result) return result;
  throw new Error(response.ok ? 'The host returned an empty response' : `The host returned HTTP ${response.status}`);
}
function api(action, body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined;
  return requestJson('/app-api/' + action, opts);
}
function msg(t, cls) { const m = $('#msg'); m.textContent = t || ''; m.className = cls || ''; }

let jobs = [];
let grand = null;
let logCatsState = null; // which per-file categories get written to the activity log (from `list`)
let rules = [], sessions = [];
let driveInfo = null; // host OAuth status for the Google Drive API ({available, configured, connected})
let paused = false;   // global scheduler pause (manual runs still work)
function renderPause() {
  const b = $('#pauseToggle');
  if (!b) return;
  b.textContent = paused ? '▶ Schedules paused' : 'Pause schedules';
  b.classList.toggle('paused', paused);
}
// Smoothed transfer rate (bytes/sec) from cumulative bytes over wall-clock; resets per run
// (keyed by the run's startedAt) and recomputes at most a few times a second to stay steady.
let _rate = { key: 0, bytes: 0, t: 0, ema: 0 };
function transferRate(runKey, bytes) {
  const now = performance.now();
  if (runKey !== _rate.key) { _rate = { key: runKey, bytes, t: now, ema: 0 }; return 0; }
  const dt = (now - _rate.t) / 1000;
  if (dt >= 0.3) {
    const inst = Math.max(0, (bytes - _rate.bytes) / dt);
    _rate.ema = _rate.ema ? _rate.ema * 0.6 + inst * 0.4 : inst;
    _rate.bytes = bytes; _rate.t = now;
  }
  return _rate.ema;
}
let current = null, queueIds = [], lastResults = {};
let pendingPreview = null; // job id whose preview should auto-open when it finishes
// Row selection for "Run selected" (Karen's Run Highlighted) — page-local, distinct from a
// job's Enabled flag: a hand-selected disabled job still runs, like Karen's highlighting.
const selected = new Set();

// ── formatting ────────────────────────────────────────────────────────────────
function fmtAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
function fmtIn(ms) {
  const s = (ms - Date.now()) / 1000;
  if (s <= 45) return 'now';
  if (s < 3600) return 'in ' + Math.round(s / 60) + ' min';
  if (s < 86400) return 'in ' + Math.round(s / 3600) + ' h';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function fmtBytes(n) {
  if (!(n > 0)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log2(n) / 10));
  return (n / 2 ** (10 * i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fmtDur(ms) {
  const s = ms / 1000;
  if (s < 90) return Math.round(s) + ' s';
  if (s < 5400) return (s / 60).toFixed(1) + ' min';
  return (s / 3600).toFixed(1) + ' h';
}
function schedText(j) {
  const sc = j.schedule || {};
  if (!sc.type || sc.type === 'manual') return 'Manual';
  if (sc.type === 'cron') return sc.expr;
  if (sc.type === 'every') {
    const units = [[sc.months, 'mo'], [sc.weeks, 'wk'], [sc.days, 'd'], [sc.hours, 'h'], [sc.mins, 'min']]
      .filter(u => u[0] > 0).map(u => u[0] + ' ' + u[1]).join(' ');
    const skip = (sc.skipDays || []).length ? ' (not ' + sc.skipDays.map(d => DAY_NAMES[d]).join('/') + ')' : '';
    return 'Every ' + units + skip;
  }
  // pre-v1.1 schedules, shown until the job is next edited (which converts them)
  if (sc.type === 'interval') return 'Every ' + sc.every + ' min';
  if (sc.type === 'daily') return 'Daily ' + sc.at;
  return (sc.days || []).map(d => DAY_NAMES[d]).join(' ') + ' ' + sc.at;
}
// Editing a pre-v1.1 job prefills the closest cron equivalent.
function toCron(sc) {
  if (!sc || !sc.type || sc.type === 'manual') return '';
  if (sc.type === 'cron') return sc.expr || '';
  const [h, m] = (sc.at || '03:00').split(':').map(Number);
  if (sc.type === 'interval') {
    const n = Math.max(1, sc.every | 0);
    return n < 60 ? `*/${n} * * * *` : `0 */${Math.max(1, Math.round(n / 60))} * * *`;
  }
  if (sc.type === 'daily') return `${m} ${h} * * *`;
  return `${m} ${h} * * ${(sc.days || []).join(',') || '*'}`;
}

// ── view switching ────────────────────────────────────────────────────────────
const VIEWS = ['Main', 'Edit', 'Result', 'Log', 'Filters', 'Recipes', 'Guide'];
let activeView = 'Main';
function showView(name) {
  activeView = name;
  VIEWS.forEach(v => $('#view' + v).classList.toggle('active', v === name));
  // Navigating away disarms any two-tap confirm mid-arm, so a stale "Really …?" can't
  // fire from a single tap days later.
  for (const id of ['resetGrand', 'resResetStats']) {
    const b = $('#' + id);
    if (b && b.dataset.armed) { delete b.dataset.armed; b.textContent = id === 'resetGrand' ? 'Reset totals' : 'Reset lifetime stats'; }
  }
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && activeView !== 'Main') showView('Main'); });

// ── main list ─────────────────────────────────────────────────────────────────
function stHtml(j) {
  const st = (cls, txt) => '<span class="st ' + cls + '"><span class="dot"></span><span class="txt">' + esc(txt) + '</span></span>';
  if (current && current.id === j.id) {
    const p = current.progress || {};
    if (current.kind === 'web') {
      const c = current.webCounts || {};
      return st('c-work', (current.dryRun ? 'Previewing… ' : 'Fetching… ') + (p.webPhase || '') +
        (c.downloaded != null ? ' — ' + c.downloaded + ' downloaded' : ''));
    }
    if (current.phase === 'scan' || current.phase === 'mirror') {
      const ec = p.errCount || 0;
      return st('c-work', (current.dryRun ? 'Previewing… ' : 'Scanning… ') +
        (p.listing ? (p.foldersScanned || 0) + ' folders' : (p.scanned || 0) + ' files') +
        (ec ? ' · ' + ec + ' errors' : ''));
    }
    const pct = p.phase === 'run' && p.total ? Math.round(p.done / p.total * 100) + '%' : '…';
    return st('c-work', (p.phase === 'run' && p.op !== 'copy' ? 'Deleting ' : 'Copying ') + pct);
  }
  if (queueIds.includes(j.id)) return st('c-muted', 'Queued');
  const r = lastResults[j.id];
  if (r) {
    if (r.needsLogin) return st('c-up', 'Needs sign-in');
    if (r.fatal) return st('c-bad', r.fatal);
    if (r.dryRun) return st('c-up', r.kind === 'web'
      ? 'Preview: ' + r.planCopies + ' new, ' + (r.skippedSeen || 0) + ' seen'
      : 'Preview: ' + r.planCopies + ' copy, ' + r.planDeletes + ' delete');
    if (r.stopped) return st('c-bad', 'Stopped');
    if (r.errorCount) return st('c-bad', r.errorCount + ' errors');
    if (r.warningCount) return st('c-warn', 'Done · ' + r.warningCount + ' warnings');
    return st('c-ok', 'Done — ' + r.copied + (r.kind === 'web' ? ' downloaded' : ' copied' + (r.deleted ? ', ' + r.deleted + ' deleted' : '')));
  }
  if (j.enabled === false) return st('c-muted', 'Disabled');
  return st('c-muted', 'Idle');
}
function lastHtml(j) {
  const lr = j.lastRun;
  if (!lr) return '<span class="cell">Never run</span>';
  const what = lr.needsLogin ? '<b style="color:var(--amber)">needs sign-in</b>'
    : lr.errors ? '<b style="color:var(--red)">' + lr.errors + ' errors</b>'
    : lr.warnings ? '<b style="color:var(--amber)">' + lr.warnings + ' warnings</b>'
    : '<b>' + lr.copied + (j.kind === 'web' ? ' downloaded</b>' : ' copied</b>' + (lr.deleted ? ', ' + lr.deleted + ' del' : ''));
  return '<span class="cell">' + what + ' · ' + esc(fmtAgo(lr.at)) + '</span>';
}
function badges(j) {
  let b = '';
  if (j.enabled === false) b += '<span class="badge off">Off</span> ';
  if (j.kind === 'web') return b + '<span class="badge" style="color:var(--blue);border-color:#2a4a6e">' + esc(j.site) + '</span> ';
  if (j.mirror) b += '<span class="badge mirror">Mirror</span> ';
  const cmpMode = (j.compare && j.compare.mode) || (j.changedOnly === false ? 'all' : 'changed');
  if (cmpMode === 'all') b += '<span class="badge">All files</span> ';
  else if (j.compare && j.compare.content) b += '<span class="badge">Content check</span> ';
  if ((j.include && j.include.length) || (j.exclude && j.exclude.length)) b += '<span class="badge">Filtered</span> ';
  if (j.subfolders === false) b += '<span class="badge">Top level only</span> ';
  return b;
}
function actHtml(j) {
  const kebab = '<button class="kebab" data-kebab="' + esc(j.id) + '" aria-label="More actions">⋯</button>';
  if (current && current.id === j.id) return '<button data-act="stop">Stop</button>' + kebab;
  if (queueIds.includes(j.id)) return kebab;
  return '<button data-act="preview" data-id="' + esc(j.id) + '">Preview</button>' +
         '<button class="primary" data-act="run" data-id="' + esc(j.id) + '">Run</button>' + kebab;
}
function buildRows() {
  return jobs.map(j =>
    '<div class="job-row' + (j.enabled === false ? ' off' : '') + (selected.has(j.id) ? ' selected' : '') + '">' +
      '<label class="sel"><input type="checkbox" data-sel="' + esc(j.id) + '"' + (selected.has(j.id) ? ' checked' : '') + ' aria-label="Select ' + esc(j.name) + '"></label>' +
      '<div class="jmain"><div class="jname">' + esc(j.name) + ' ' + badges(j) + '</div>' +
        '<div class="jpaths">' + (j.kind === 'web'
          ? esc(j.url) + ' <span class="arrow">→</span> ' + esc(j.dest)
          : esc(j.resolvedSource || j.source) + ' <span class="arrow">→</span> ' + esc(j.resolvedDest || j.dest)) + '</div></div>' +
      '<span class="cell">' + esc(schedText(j)) + '</span>' +
      lastHtml(j) +
      '<span class="cell">' + (j.nextRunAt && j.enabled !== false ? esc(fmtIn(j.nextRunAt)) : '—') + '</span>' +
      stHtml(j) +
      '<span class="act">' + actHtml(j) + '</span>' +
      '<span class="brk"></span>' + // editor-surface line break; display:none in the panel
    '</div>').join('');
}
// The list re-renders on a 1 s poll — rewrite the DOM only when the markup actually
// changed, or an idle rebuild can eat a tap that straddles it and steals keyboard focus.
let rowsHtml = null;
function render() {
  const html = buildRows();
  if (html !== rowsHtml) { rowsHtml = html; $('#rows').innerHTML = html; }
  renderListChrome();
}
function renderListChrome() {
  $('#empty').style.display = jobs.length ? 'none' : 'block';
  $('#joblist').style.display = jobs.length ? 'block' : 'none';
  $('#count').textContent = jobs.length ? jobs.length + (jobs.length === 1 ? ' job' : ' jobs') : '';
  $('#selAll').hidden = !jobs.length;
  $('#selAll').textContent = selected.size ? 'Clear selection' : 'Select all';
  $('#runSel').hidden = !jobs.length;
  $('#runSel').disabled = !selected.size;
  $('#runSel').textContent = selected.size ? 'Run selected (' + selected.size + ')' : 'Run selected';
}

async function refreshList() {
  const r = await api('list').catch(() => null);
  if (!r || !r.ok) { msg('Cannot reach the sync service', 'bad'); return; }
  jobs = r.jobs || [];
  grand = r.grand || null;
  if (r.logCats) { logCatsState = r.logCats; renderLogCats(); }
  rules = r.rules || []; sessions = r.sessions || [];
  driveInfo = r.drive || null;
  paused = !!r.paused; renderPause();
  current = r.current; queueIds = r.queue || []; lastResults = r.lastResults || {};
  for (const id of [...selected]) if (!jobs.some(j => j.id === id)) selected.delete(id); // drop deleted jobs
  $('#dataDir').textContent = r.dataDir || '';
  render();
  renderGrand();
  renderLastBand();
  renderSites();
}

// ── accounts strip (web-site sign-ins + Google Drive) ─────────────────────────
// Lives at the BOTTOM of the main view and stays HIDDEN while everything is healthy —
// it only surfaces the item(s) that need attention (a dropped session, a Drive job with
// no connection). The header "Accounts" button reveals the full set on demand.
let sitesHtml = null;
let showAllAccounts = false;
// The Google Drive row is relevant once any job touches Drive (link source or API mode)
// or a connection already exists — other users never see it.
function driveRelevant() {
  if (!driveInfo || !driveInfo.available) return false;
  return jobs.some(j => j.kind !== 'web' && (j.driveApi || /https?:\/\/(drive|docs)\.google\.com\//i.test(j.source || '')))
    || driveInfo.connected || driveInfo.configured;
}
function driveChipHtml() {
  const state = driveInfo.connected ? '<span class="sess-ok">connected</span>'
    : driveInfo.configured ? '<span class="sess-none">not connected</span>'
      : '<span class="sess-none">not set up</span>';
  const btn = driveInfo.connected ? '<button data-drive-act="disconnect">Disconnect</button>'
    : driveInfo.configured ? '<button data-drive-act="connect">Connect</button>'
      : '<button data-drive-act="setup">Set up…</button>';
  return '<span><b>Google Drive API</b> — ' + state + '</span>' + btn;
}
function renderSites() {
  const el = $('#sites');
  const dRelevant = driveRelevant();
  const driveNeeds = dRelevant && !driveInfo.connected;      // relevant but not connected
  const anythingToManage = sessions.length > 0 || dRelevant;
  // Header button reveals the strip when it's hidden-because-healthy; hidden entirely when
  // there's nothing to manage (no web jobs and Drive not in use).
  const accBtn = $('#openAccounts');
  if (accBtn) {
    accBtn.hidden = !anythingToManage;
    accBtn.classList.toggle('needs', sessions.some(s => !s.cookies) || driveNeeds);
  }
  const needsAttention = sessions.some(s => !s.cookies) || driveNeeds;
  el.hidden = !anythingToManage || !(needsAttention || showAllAccounts);
  if (el.hidden) { sitesHtml = null; return; }
  const items = [];
  for (const s of sessions) {
    if (s.cookies && !showAllAccounts) continue;             // healthy + not expanded -> omit
    const j = jobs.find(x => x.kind === 'web' && x.site === s.site);
    items.push('<span><b>' + esc(s.name || s.site) + '</b> — ' +
      (s.cookies ? '<span class="sess-ok">session saved</span>' : '<span class="sess-none">not signed in</span>') +
      '</span><button data-login-url="' + esc(j ? j.url : '') + '">Open sign-in window</button>');
  }
  if (dRelevant && (driveNeeds || showAllAccounts)) items.push(driveChipHtml());
  const html = items.join('');
  if (html !== sitesHtml) { sitesHtml = html; el.innerHTML = html; }
}
// Header Accounts button: reveal the full accounts strip on demand (it's otherwise hidden
// while healthy). Toggling off collapses back to attention-only (usually nothing).
$('#openAccounts').addEventListener('click', () => { showAllAccounts = !showAllAccounts; renderSites(); if (!$('#sites').hidden) $('#sites').scrollIntoView({ block: 'nearest' }); });
$('#sites').addEventListener('click', async e => {
  const d = e.target.closest('button[data-drive-act]');
  if (d) {
    const act = d.dataset.driveAct;
    if (act === 'setup') { const box = $('#driveSetup'); box.hidden = !box.hidden; if (!box.hidden) $('#driveClientId').focus(); return; }
    if (act === 'connect') {
      const r = await api('driveConnect', {});
      msg(r.ok ? 'Approve access in the browser window that opened — the chip turns green once connected.' : r.error, r.ok ? 'info' : 'bad');
      if (r.ok) setTimeout(refreshList, 8000);
      return;
    }
    if (act === 'disconnect') {
      const r = await api('driveDisconnect', {});
      msg(r.ok ? 'Google Drive disconnected.' : r.error, r.ok ? 'info' : 'bad');
      refreshList();
      return;
    }
  }
  const b = e.target.closest('button[data-login-url]');
  if (!b) return;
  const r = await api('openLogin', { url: b.dataset.loginUrl });
  msg(r.ok ? 'Sign in on the window that opened, then close it — the session sticks.' : r.error, r.ok ? 'info' : 'bad');
  if (r.ok) setTimeout(refreshList, 10000); // pick up the fresh session chip after they sign in
});
$('#driveConnectBtn').addEventListener('click', async () => {
  const clientId = $('#driveClientId').value.trim(), clientSecret = $('#driveClientSecret').value.trim();
  if (!clientId) { msg('paste the Google OAuth client ID first', 'bad'); return; }
  const r = await api('driveConnect', { clientId, clientSecret });
  msg(r.ok ? 'Approve access in the browser window that opened — the chip turns green once connected.' : r.error, r.ok ? 'info' : 'bad');
  if (r.ok) { $('#driveSetup').hidden = true; $('#driveClientSecret').value = ''; setTimeout(refreshList, 8000); }
});

// Clicks on the list (event delegation — rows rerender constantly).
$('#rows').addEventListener('click', async e => {
  const cb = e.target.closest('input[data-sel]');
  if (cb) {
    if (cb.checked) selected.add(cb.dataset.sel); else selected.delete(cb.dataset.sel);
    // Update in place (no innerHTML rebuild — that would blur the checkbox just toggled)
    // and sync the markup cache so the next poll doesn't rebuild either.
    cb.closest('.job-row').classList.toggle('selected', cb.checked);
    rowsHtml = buildRows();
    renderListChrome();
    return;
  }
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.kebab) return openMenu(b, b.dataset.kebab);
  const act = b.dataset.act, id = b.dataset.id;
  if (act === 'stop') { await api('stop', {}); return; }
  if (act === 'run' || act === 'preview') {
    const j = jobs.find(x => x.id === id);
    if (act === 'preview') pendingPreview = id;
    const r = await api('run', { id, dryRun: act === 'preview' });
    if (!r.ok) { msg(r.error, 'bad'); pendingPreview = null; }
    else msg((act === 'preview' ? 'Previewing ' : 'Running ') + j.name + '…', 'info');
    poll();
  }
});

// ── per-row menu ──────────────────────────────────────────────────────────────
let menuId = null;
function openMenu(btn, id) {
  menuId = id;
  const j = jobs.find(x => x.id === id);
  const idx = jobs.findIndex(x => x.id === id); // position controls run-all + same-tick order
  const m = $('#rowMenu');
  m.innerHTML =
    '<button data-m="edit">Edit job</button>' +
    '<button data-m="duplicate">Duplicate job</button>' +
    (idx > 0 ? '<button data-m="up">Move up</button>' : '') +
    (idx >= 0 && idx < jobs.length - 1 ? '<button data-m="down">Move down</button>' : '') +
    '<button data-m="result">View last result</button>' +
    '<button data-m="toggle">' + (j.enabled === false ? 'Enable' : 'Disable') + '</button>' +
    (j.kind === 'web' ? '<button data-m="ledger" class="danger">Reset seen ledger</button>' : '') +
    '<button data-m="delete" class="danger">Delete job</button>';
  m.classList.add('show');
  const r = btn.getBoundingClientRect();
  m.style.top = Math.min(window.innerHeight - m.offsetHeight - 8, r.bottom + 4) + 'px';
  m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';
}
document.addEventListener('click', e => {
  const m = $('#rowMenu');
  if (!m.classList.contains('show')) return;
  const item = e.target.closest('#rowMenu button');
  if (!item) { if (!e.target.closest('[data-kebab]')) m.classList.remove('show'); return; }
  const j = jobs.find(x => x.id === menuId);
  if (!j) { m.classList.remove('show'); return; }
  if ((item.dataset.m === 'delete' || item.dataset.m === 'ledger') && !item.dataset.armed) {
    item.dataset.armed = '1';
    item.textContent = item.dataset.m === 'delete' ? 'Really delete "' + j.name + '"?' : 'Really forget all downloaded items?';
    return; // second tap confirms
  }
  m.classList.remove('show');
  if (item.dataset.m === 'edit') openEdit(j);
  if (item.dataset.m === 'duplicate') api('duplicate', { id: j.id }).then(async r => {
    // Create a disabled clone, then land in the editor on it so the user can tweak
    // source/dest and enable when ready (the copy never auto-runs meanwhile).
    if (!r.ok) { msg(r.error, 'bad'); return; }
    await refreshList();
    const copy = jobs.find(x => x.id === r.id);
    if (copy) openEdit(copy);
    else msg('Duplicated — disabled until you review it.', 'ok');
  });
  if (item.dataset.m === 'up' || item.dataset.m === 'down') api('moveJob', { id: j.id, dir: item.dataset.m }).then(r => { if (!r.ok) msg(r.error, 'bad'); refreshList(); });
  if (item.dataset.m === 'result') openResult(j.id);
  if (item.dataset.m === 'toggle') api('save', { job: { ...j, enabled: j.enabled === false } }).then(r => { if (!r.ok) msg(r.error, 'bad'); refreshList(); });
  if (item.dataset.m === 'ledger') api('resetLedger', { id: j.id }).then(r => msg(r.ok ? 'Seen ledger reset — the next run treats everything as new.' : r.error, r.ok ? 'ok' : 'bad'));
  if (item.dataset.m === 'delete') api('remove', { id: j.id }).then(r => { if (!r.ok) msg(r.error, 'bad'); refreshList(); });
});

// ── edit view ─────────────────────────────────────────────────────────────────
let editId = null;
let schedType = 'manual';
function setSchedType(t) {
  schedType = t;
  document.querySelectorAll('#fSched button').forEach(b => b.classList.toggle('active', b.dataset.s === t));
  const cron = t === 'cron', every = t === 'every';
  $('#fCron').hidden = !cron;
  $('#cronPresets').hidden = !cron;
  $('#everyWrap').hidden = !every;
  $('#everyHelp').hidden = !every;
  $('#everyWrap2').hidden = !every;
  $('#missedWrap').hidden = !cron && !every;
  $('#cronNext').hidden = !cron && !every;
  if (cron || every) schedPreview();
}
$('#fSched').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setSchedType(b.dataset.s); });
$('#cronPresets').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) { $('#fCron').value = b.dataset.c; schedPreview(); }
});
// The schedule object exactly as it will be saved — the preview and Save share this.
function uiSchedule() {
  if (schedType === 'cron') return { type: 'cron', expr: $('#fCron').value.trim() };
  if (schedType === 'every') return {
    type: 'every',
    mins: +$('#fEvMins').value || 0, hours: +$('#fEvHours').value || 0,
    days: +$('#fEvDays').value || 0, weeks: +$('#fEvWeeks').value || 0,
    months: +$('#fEvMonths').value || 0,
    start: $('#fEvStart').value ? new Date($('#fEvStart').value).getTime() : 0,
    skipDays: [...document.querySelectorAll('#fSkipDays button.active')].map(b => +b.dataset.d),
  };
  return { type: 'manual' };
}
// Live "next runs" preview — the server validates with the same code the scheduler
// uses, so what the preview accepts is exactly what will run. Works for cron and every.
let schedTimer = null;
const schedPreviewSoon = () => { clearTimeout(schedTimer); schedTimer = setTimeout(schedPreview, 300); };
$('#fCron').addEventListener('input', schedPreviewSoon);
$('#everyWrap').addEventListener('input', schedPreviewSoon);
$('#fEvStart').addEventListener('input', schedPreviewSoon);
$('#fSkipDays').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) { b.classList.toggle('active'); schedPreview(); }
});
async function schedPreview() {
  const el = $('#cronNext');
  const sc = uiSchedule();
  if (sc.type === 'cron' && !sc.expr) { el.className = 'fhelp'; el.textContent = 'Enter a cron expression or tap a preset.'; return; }
  const r = await api('sched', { schedule: sc }).catch(() => null);
  if (!r) return;
  if (!r.ok) { el.className = 'fhelp bad'; el.textContent = r.error; return; }
  el.className = 'fhelp';
  el.innerHTML = r.next.length
    ? '<b>Next runs:</b> ' + r.next.map(t => esc(new Date(t).toLocaleString(undefined,
        { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))).join('  ·  ')
    : 'This schedule never matches.';
}
function syncMirrorUi() {
  const on = $('#fMirror').checked;
  $('#mirrorWarn').hidden = !on;
  $('#mirrorOpts').hidden = !on;
  $('#mirrorOptsHelp').hidden = !on;
}
$('#fMirror').addEventListener('change', syncMirrorUi);

// Compare section: "Only changed" gates the criteria; "time differs" gates "source is newer".
function syncCompareUi() {
  const changed = $('#fChanged').checked;
  $('#compareOpts').hidden = !changed;
  $('#allFilesHint').hidden = changed;
  const newer = $('#fNewerWrap');
  newer.style.opacity = $('#fCmpTime').checked ? '' : '.4';
  $('#fNewer').disabled = !$('#fCmpTime').checked;
}
$('#fChanged').addEventListener('change', syncCompareUi);
$('#fCmpTime').addEventListener('change', syncCompareUi);

// Generic served-app capability. The native picker discloses only the directory the user
// explicitly chooses; paths stay in the POST body and never enter a URL or app option.
document.querySelectorAll('.pickFolder').forEach(button => button.addEventListener('click', async () => {
  const input = $('#' + button.dataset.target);
  if (!input) return;
  button.disabled = true;
  $('#editErr').textContent = '';
  try {
    const result = await requestJson('/app-host/pick-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultPath: input.value.trim() }),
    });
    if (result.ok && typeof result.path === 'string') input.value = result.path;
    else if (!result.canceled) $('#editErr').textContent = result.error || 'The folder picker could not be opened.';
  } catch (error) {
    $('#editErr').textContent = 'Folder picker unavailable — update Bedrock Panel to a version that supports served-app folder selection.';
  } finally {
    button.disabled = false;
  }
}));

// Live "where does this land" preview under Source/Dest — Drive links resolve through the
// server with the same code the runs use, and the destination preview folds in the
// source-named subfolder option, so what you see is exactly what a run will target.
const isDriveLink = v => /drive\.google\.com|docs\.google\.com/i.test(v);
async function pathPreviews() {
  const resolve = async v => {
    if (!isDriveLink(v)) return { path: v };
    const r = await api('resolveLink', { url: v }).catch(() => null);
    return r && r.ok ? { path: r.path } : { error: (r && r.error) || 'could not resolve the link' };
  };
  const srcV = $('#fSource').value.trim();
  const src = await resolve(srcV);
  const sEl = $('#srcResolved');
  if (isDriveLink(srcV)) {
    sEl.hidden = false;
    sEl.className = 'fhelp' + (src.error ? ' warn' : '');
    sEl.textContent = src.error || ('→ ' + src.path);
  } else sEl.hidden = true;
  const dstV = $('#fDest').value.trim();
  const sub = $('#fSrcSub').checked;
  const dEl = $('#dstResolved');
  if (!isDriveLink(dstV) && !(sub && dstV)) { dEl.hidden = true; return; }
  const dst = await resolve(dstV);
  if (dst.error) { dEl.hidden = false; dEl.className = 'fhelp warn'; dEl.textContent = dst.error; return; }
  let target = dst.path;
  if (sub && !src.error) {
    const base = String(src.path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    if (base) target = target.replace(/[\\/]+$/, '') + '\\' + base;
  }
  dEl.hidden = false; dEl.className = 'fhelp'; dEl.textContent = '→ ' + target;
}
let pathTimer = null;
const pathPreviewsSoon = () => { clearTimeout(pathTimer); pathTimer = setTimeout(pathPreviews, 400); };
$('#fSource').addEventListener('input', pathPreviewsSoon);
$('#fDest').addEventListener('input', pathPreviewsSoon);
$('#fSrcSub').addEventListener('change', pathPreviews);

// ── job kind (folder sync vs web drops) ───────────────────────────────────────
let jobKind = 'folder';
function setKind(k) {
  jobKind = k;
  document.querySelectorAll('#fKind button').forEach(b => b.classList.toggle('active', b.dataset.k === k));
  document.querySelectorAll('.folderOnly').forEach(el => { el.hidden = k === 'web'; });
  document.querySelectorAll('.webOnly').forEach(el => { el.hidden = k !== 'web'; });
  $('#kindHelp').textContent = k === 'web' ? 'Downloads new releases from a subscription site into the folder below.' : '';
  $('#fDest').placeholder = k === 'web' ? 'D:\\Drops\\SiteName' : '\\\\server\\share\\Documents';
  if (k === 'folder') { syncMirrorUi(); syncCompareUi(); pathPreviews(); } // re-apply their own hidden states
}
$('#fKind').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setKind(b.dataset.k); });
$('#fLogin').addEventListener('click', async () => {
  // Feedback must land IN the edit view — the Main header's #msg is hidden here.
  const r = await api('openLogin', { url: $('#fUrl').value.trim() });
  if (!r.ok) { $('#editErr').textContent = r.error; return; }
  $('#editErr').textContent = '';
  const el = $('#ruleMatch');
  el.hidden = false; el.className = 'fhelp webOnly';
  el.textContent = 'Sign in on the window that opened, then close it — the session sticks.';
  setTimeout(refreshList, 10000); // pick up the fresh session chip after they sign in
});
// Live "which rule file handles this URL" feedback under the Site page field.
let ruleTimer = null;
async function ruleMatchPreview() {
  const el = $('#ruleMatch');
  const url = $('#fUrl').value.trim();
  if (jobKind !== 'web' || !/^https:\/\//i.test(url)) { el.hidden = true; return; }
  const r = await api('resolveRule', { url }).catch(() => null);
  if (!r) return;
  el.hidden = false;
  if (r.ok) { el.className = 'fhelp webOnly'; el.textContent = '→ handled by your "' + r.name + '" rule'; }
  else { el.className = 'fhelp warn webOnly'; el.textContent = r.error; }
}
$('#fUrl').addEventListener('input', () => { clearTimeout(ruleTimer); ruleTimer = setTimeout(ruleMatchPreview, 400); });

function openEdit(j) {
  // Editor embed: forms are unusable inside nested scrollbars — edit in the real window.
  if (LAUNCHER) { winOpen({ edit: j ? j.id : 'new' }); return; }
  editId = j ? j.id : null;
  $('#editTitle').textContent = j ? 'Edit job' : 'Add a job';
  $('#fName').value = j ? j.name : '';
  $('#fEnabled').checked = !j || j.enabled !== false;
  $('#fSource').value = j ? j.source : '';
  $('#fDest').value = j ? j.dest : '';
  $('#fSrcSub').checked = !!(j && j.subfolderFromSource);
  $('#fDriveApi').checked = !!(j && j.driveApi);
  $('#fExportNative').checked = !!(j && j.exportNative);
  pathPreviews();
  // Resolve the job's compare model (new `compare` object, or map an old changedOnly bool).
  const cmp = (j && j.compare) || (j && j.changedOnly === false ? { mode: 'all' } : { mode: 'changed', time: true, size: true });
  $('#fChanged').checked = cmp.mode !== 'all';
  $('#fCmpTime').checked = !!cmp.time;
  $('#fNewer').checked = !!cmp.newerOnly;
  $('#fCmpSize').checked = !!cmp.size;
  $('#fCmpContent').checked = !!cmp.content;
  syncCompareUi();
  $('#fSub').checked = !j || j.subfolders !== false;
  $('#fDelBefore').checked = !!(j && j.deleteBeforeCopy);
  $('#fFollowLnk').checked = !!(j && j.followShortcuts);
  $('#fMirrorMeta').checked = !!(j && j.mirrorMeta);
  $('#fMirror').checked = !!(j && j.mirror);
  $('#fRecycle').checked = !j || j.recycle !== false;
  $('#fTestSrc').checked = !j || j.testSource !== false;
  syncMirrorUi();
  $('#fInclude').value = j && j.include ? j.include.join('; ') : '';
  $('#fExclude').value = j && j.exclude ? j.exclude.join('; ') : '';
  editIncludeGroups = j && Array.isArray(j.includeGroups) ? j.includeGroups.slice() : [];
  editExcludeGroups = j && Array.isArray(j.excludeGroups) ? j.excludeGroups.slice() : [];
  renderGroupChips();
  const sc = (j && j.schedule) || { type: 'manual' };
  $('#fCron').value = toCron(sc);
  // 'every' prefill — a legacy pre-v1.1 interval maps to it losslessly (every N min).
  const ev = sc.type === 'every' ? sc : (sc.type === 'interval' ? { mins: Number(sc.every) || 0 } : {});
  $('#fEvMins').value = ev.mins || 0; $('#fEvHours').value = ev.hours || 0;
  $('#fEvDays').value = ev.days || 0; $('#fEvWeeks').value = ev.weeks || 0;
  $('#fEvMonths').value = ev.months || 0;
  const p2 = n => String(n).padStart(2, '0');
  const st = new Date(sc.type === 'every' && sc.start ? sc.start : Date.now());
  $('#fEvStart').value = st.getFullYear() + '-' + p2(st.getMonth() + 1) + '-' + p2(st.getDate()) +
    'T' + p2(st.getHours()) + ':' + p2(st.getMinutes());
  document.querySelectorAll('#fSkipDays button').forEach(b =>
    b.classList.toggle('active', (ev.skipDays || []).includes(+b.dataset.d)));
  setSchedType(sc.type === 'every' || sc.type === 'interval' ? 'every'
    : !sc.type || sc.type === 'manual' ? 'manual' : 'cron');
  $('#fMissed').checked = !j || j.runIfMissed !== false;
  $('#fDelete').hidden = !j;
  $('#fDelete').textContent = 'Delete job';
  delete $('#fDelete').dataset.armed;
  $('#editErr').textContent = '';
  // web-job fields — the pasted URL picks the rule file by hostname
  if (j && j.kind === 'web') {
    $('#fUrl').value = j.url || '';
    $('#fBackfill').value = j.backfill == null ? 'all' : String(j.backfill);
    $('#fWebPattern').value = j.pathPattern || '';
  } else {
    $('#fUrl').value = '';
    $('#fBackfill').value = '4';
    $('#fWebPattern').value = '';
  }
  setKind(j && j.kind === 'web' ? 'web' : 'folder');
  ruleMatchPreview();
  showView('Edit');
  if (!j) $('#fName').focus();
}
const splitGlobs = v => v.split(';').map(s => s.trim()).filter(Boolean);
$('#fSave').addEventListener('click', async () => {
  const sc = uiSchedule();
  const old = jobs.find(x => x.id === editId);
  let job;
  if (jobKind === 'web') {
    const bf = $('#fBackfill').value.trim().toLowerCase();
    job = {
      ...(old || {}), id: editId || undefined, kind: 'web',
      name: $('#fName').value, url: $('#fUrl').value.trim(), dest: $('#fDest').value,
      enabled: $('#fEnabled').checked,
      backfill: bf === 'all' || bf === '' ? 'all' : Number(bf),
      pathPattern: $('#fWebPattern').value.trim() || undefined,
      schedule: sc, runIfMissed: $('#fMissed').checked,
    };
    // folder-only fields have no meaning on a web job (e.g. after switching the type)
    for (const k of ['source', 'mirror', 'include', 'exclude', 'includeGroups', 'excludeGroups', 'compare', 'subfolders', 'subfolderFromSource', 'driveApi', 'exportNative', 'deleteBeforeCopy', 'followShortcuts', 'mirrorMeta', 'recycle', 'testSource', 'changedOnly']) delete job[k];
  } else {
    job = {
      ...(old || {}), id: editId || undefined,
      name: $('#fName').value, source: $('#fSource').value, dest: $('#fDest').value,
      enabled: $('#fEnabled').checked,
      compare: $('#fChanged').checked
        ? { mode: 'changed', time: $('#fCmpTime').checked, newerOnly: $('#fCmpTime').checked && $('#fNewer').checked, size: $('#fCmpSize').checked, content: $('#fCmpContent').checked }
        : { mode: 'all' },
      subfolders: $('#fSub').checked, mirror: $('#fMirror').checked,
      subfolderFromSource: $('#fSrcSub').checked,
      driveApi: $('#fDriveApi').checked,
      exportNative: $('#fExportNative').checked,
      deleteBeforeCopy: $('#fDelBefore').checked,
      followShortcuts: $('#fFollowLnk').checked,
      mirrorMeta: $('#fMirrorMeta').checked,
      recycle: $('#fRecycle').checked, testSource: $('#fTestSrc').checked,
      include: splitGlobs($('#fInclude').value), exclude: splitGlobs($('#fExclude').value),
      includeGroups: editIncludeGroups.slice(), excludeGroups: editExcludeGroups.slice(),
      schedule: sc, runIfMissed: $('#fMissed').checked,
    };
    delete job.changedOnly; // superseded by `compare`
    for (const k of ['kind', 'site', 'url', 'backfill', 'stopAfterSeen', 'pathPattern']) delete job[k];
  }
  const r = await api('save', { job });
  if (!r.ok) { $('#editErr').textContent = r.error; return; }
  msg('Saved ' + job.name, 'ok');
  showView('Main');
  refreshList();
});
$('#fDelete').addEventListener('click', async e => {
  const b = e.currentTarget;
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Really delete this job?'; return; }
  const r = await api('remove', { id: editId });
  if (!r.ok) { $('#editErr').textContent = r.error; return; }
  showView('Main');
  refreshList();
});
$('#addJob').addEventListener('click', () => openEdit(null));
// One toggle: nothing selected -> select every ENABLED job (what "Run all" covered);
// anything selected -> clear. When every job is disabled, fall back to selecting them all
// (they're hand-checkable anyway) so the button is never a silent no-op.
$('#selAll').addEventListener('click', () => {
  if (selected.size) selected.clear();
  else {
    const pool = jobs.some(j => j.enabled !== false) ? jobs.filter(j => j.enabled !== false) : jobs;
    pool.forEach(j => selected.add(j.id));
  }
  render();
});
$('#runSel').addEventListener('click', async () => {
  const ids = jobs.filter(j => selected.has(j.id)).map(j => j.id); // stored order = run order
  if (!ids.length) return;
  const r = await api('runMany', { ids }).catch(() => null);
  if (!r || !r.ok) { msg((r && r.error) || 'Cannot reach the sync service', 'bad'); return; }
  msg(r.queued ? 'Running ' + r.queued + (r.queued === 1 ? ' job' : ' jobs') + '…' : 'Selected jobs are already running or queued.', 'info');
  poll();
});
$('#editBack').addEventListener('click', () => showView('Main'));
$('#editCancel').addEventListener('click', () => showView('Main'));

// ── filter groups ─────────────────────────────────────────────────────────────
let filterGroups = [];
async function loadGroups() {
  const r = await api('filters').catch(() => null);
  if (r && r.ok) filterGroups = r.groups || [];
  if (activeView === 'Edit') renderGroupChips(); // groups may have arrived/changed after the edit view opened
}
// + Group attaches a group as a LIVE reference (chip) to the job's Copy-only or Skip list —
// editing the group later updates every job that links it. The text fields stay for one-off
// patterns. editIncludeGroups/editExcludeGroups hold the ids for the job being edited.
let editIncludeGroups = [], editExcludeGroups = [];
function grpById(id) { return filterGroups.find(g => g.id === id) || { id, name: '(missing group)', missing: true }; }
function chipHtml(g, removable) {
  return '<span class="gchip' + (g.missing ? ' missing' : removable ? '' : ' auto') + '">' + esc(g.name) +
    (removable ? '<button class="gchip-x" data-gid="' + esc(g.id) + '" aria-label="Remove ' + esc(g.name) + '">×</button>' : ' · global') + '</span>';
}
function renderGroupChips() {
  const inc = editIncludeGroups.map(grpById);
  const exc = editExcludeGroups.map(grpById);
  // Global groups apply to every job as a skip — show them as read-only "auto" chips so the
  // user sees they're active (unless already linked explicitly, to avoid a duplicate chip).
  const globals = filterGroups.filter(g => g.global && !editExcludeGroups.includes(g.id));
  const ie = $('#fIncludeGroups'), ee = $('#fExcludeGroups');
  ie.innerHTML = inc.map(g => chipHtml(g, true)).join('');
  ee.innerHTML = exc.map(g => chipHtml(g, true)).join('') + globals.map(g => chipHtml(g, false)).join('');
  ie.hidden = !inc.length;
  ee.hidden = !exc.length && !globals.length;
}
function attachGroup(targetId, gid) {
  const list = targetId === 'fInclude' ? editIncludeGroups : editExcludeGroups;
  if (!list.includes(gid)) list.push(gid);
  renderGroupChips();
}
$('#fIncludeGroups').addEventListener('click', e => { const x = e.target.closest('.gchip-x'); if (x) { editIncludeGroups = editIncludeGroups.filter(id => id !== x.dataset.gid); renderGroupChips(); } });
$('#fExcludeGroups').addEventListener('click', e => { const x = e.target.closest('.gchip-x'); if (x) { editExcludeGroups = editExcludeGroups.filter(id => id !== x.dataset.gid); renderGroupChips(); } });
document.querySelectorAll('.insertGroup').forEach(btn => btn.addEventListener('click', e => {
  e.stopPropagation();
  const menu = $('#groupMenu');
  // Global groups are skip-only — don't offer them for the Copy-only (include) slot.
  const choices = btn.dataset.target === 'fInclude' ? filterGroups.filter(g => !g.global) : filterGroups;
  menu.innerHTML = choices.map(g => '<button data-gid="' + esc(g.id) + '"><span class="gm-n">' + esc(g.name) + (g.global ? ' · global' : '') +
      '</span><span class="gm-w">' + esc(g.wildcards.join('; ')) + '</span></button>').join('') +
    '<div class="sep"></div><button data-manage="1"><span class="gm-n">New or edit groups…</span></button>';
  menu.classList.add('show');
  const r = btn.getBoundingClientRect();
  menu.style.top = Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4) + 'px';
  menu.style.left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.left)) + 'px';
  menu._target = btn.dataset.target;
}));
document.addEventListener('click', e => {
  const menu = $('#groupMenu');
  if (!menu.classList.contains('show')) return;
  const item = e.target.closest('#groupMenu button');
  if (item) {
    if (item.dataset.manage) { menu.classList.remove('show'); openFilters(); return; }
    if (item.dataset.gid) attachGroup(menu._target, item.dataset.gid);
  }
  if (!e.target.closest('.insertGroup')) menu.classList.remove('show');
});
$('#manageFilters').addEventListener('click', e => { e.preventDefault(); openFilters(); });

// Filter manager view (master-detail)
let fgSelId = null;
let filtersReturnView = 'Edit';
async function openFilters() {
  if (LAUNCHER) { winOpen({ filters: 1 }); return; }
  filtersReturnView = activeView === 'Filters' ? filtersReturnView : activeView;
  await loadGroups();
  fgSelId = null;
  renderFilterList();
  $('#filtEdit').hidden = true;
  showView('Filters');
}
function renderFilterList() {
  $('#filtList').innerHTML = filterGroups.map(g =>
    '<div class="filtrow' + (g.id === fgSelId ? ' sel' : '') + '" data-gid="' + esc(g.id) + '">' +
      '<span class="fn">' + esc(g.name) + (g.global ? ' <span style="color:var(--amber);font-size:12px">· global</span>' : '') + '</span>' +
      '<span class="fw">' + esc(g.wildcards.join('; ')) + '</span></div>').join('') ||
    '<div class="gm-empty" style="padding:20px">No groups yet.</div>';
}
$('#filtList').addEventListener('click', e => {
  const row = e.target.closest('[data-gid]');
  if (row) openFilterEdit(row.dataset.gid);
});
function openFilterEdit(id) {
  const g = filterGroups.find(x => x.id === id);
  fgSelId = id;
  renderFilterList();
  $('#filtEdit').hidden = false;
  $('#fgName').value = g ? g.name : '';
  $('#fgWild').value = g ? g.wildcards.join('\n') : '';
  $('#fgGlobal').checked = !!(g && g.global);
  $('#fgErr').textContent = '';
  $('#fgDelete').hidden = !g;
  $('#fgDelete').textContent = 'Delete group';
  delete $('#fgDelete').dataset.armed;
}
$('#fgNew').addEventListener('click', () => { fgSelId = null; openFilterEdit(null); $('#fgName').focus(); });
$('#fgSave').addEventListener('click', async () => {
  const wildcards = $('#fgWild').value.split(/[;\n]/).map(s => s.trim()).filter(Boolean);
  const r = await api('saveFilter', { group: { id: fgSelId || undefined, name: $('#fgName').value, wildcards, global: $('#fgGlobal').checked } });
  if (!r.ok) { $('#fgErr').textContent = r.error; return; }
  await loadGroups();
  fgSelId = r.id;
  renderFilterList();
  openFilterEdit(r.id);
});
$('#fgDelete').addEventListener('click', async e => {
  const b = e.currentTarget;
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Really delete this group?'; return; }
  await api('removeFilter', { id: fgSelId });
  await loadGroups();
  fgSelId = null;
  renderFilterList();
  $('#filtEdit').hidden = true;
});
// Returning to the editor: re-sync the chips so a group renamed/deleted/globaled in the
// manager reflects immediately (loadGroups already refreshed filterGroups during the edit).
const backFromFilters = () => { showView(filtersReturnView); if (filtersReturnView === 'Edit') renderGroupChips(); };
$('#filtBack').addEventListener('click', backFromFilters);
$('#filtDone').addEventListener('click', backFromFilters);

// ── result view ───────────────────────────────────────────────────────────────
let resultId = null;
async function openResult(id) {
  if (LAUNCHER) { winOpen({ result: id }); return; }
  resultId = id;
  const j = jobs.find(x => x.id === id);
  const r = await api('result', { id });
  if (!r.ok) { msg(r.error, 'bad'); return; }
  const d = r.result;
  $('#resTitle').textContent = (d.dryRun ? 'Preview — ' : 'Last run — ') + (j ? j.name : '');
  $('#resStat').textContent = fmtAgo(d.at) + ' · ' + (d.ms / 1000).toFixed(1) + ' s';
  if (d.kind === 'web') {
    const wparts = [];
    if (d.fatal) wparts.push('<span><b style="color:var(--' + (d.needsLogin ? 'blue' : 'red') + ')">' + (d.needsLogin ? 'Needs sign-in:' : 'Failed:') + '</b> ' + esc(d.fatal) + '</span>');
    wparts.push('<span><b>' + (d.collectionsVisited || 0) + '</b> collections visited</span>');
    if (d.dryRun) wparts.push('<span><b>' + (d.wouldDownload || []).length + '</b> would download</span>');
    else wparts.push('<span><b>' + (d.webDownloaded || []).length + '</b> files downloaded (' + fmtBytes(d.bytes) + ')</span>');
    wparts.push('<span><b>' + (d.skippedSeen || 0) + '</b> already seen</span>');
    if (d.errorCount) wparts.push('<span><b style="color:var(--red)">' + d.errorCount + '</b> errors</span>');
    if (d.stopped) wparts.push('<span style="color:var(--amber)">stopped early</span>');
    $('#resSummary').innerHTML = wparts.join('');
    const life = j && j.stats;
    $('#resLife').hidden = !life;
    $('#resResetStats').hidden = !life;
    $('#resResetStats').textContent = 'Reset lifetime stats';
    delete $('#resResetStats').dataset.armed;
    if (life) $('#resLife').innerHTML =
      '<span style="color:var(--faint)">All-time since ' + esc(new Date(life.since).toLocaleDateString()) + ':</span>' +
      '<span><b>' + life.runs + '</b> runs</span>' +
      '<span><b>' + life.copied + '</b> downloaded (' + fmtBytes(life.bytes) + ')</span>' +
      (life.errors ? '<span><b style="color:var(--red)">' + life.errors + '</b> errors</span>' : '') +
      '<span><b>' + fmtDur(life.ms) + '</b> run time</span>';
    const rows = [];
    for (const x of d.errors || []) rows.push('<div class="oprow"><span class="op err">error</span><span class="rel">' + esc((x.path || '') + ' — ' + x.error) + '</span></div>');
    for (const x of d.webDownloaded || []) rows.push('<div class="oprow"><span class="op dl">saved</span><span class="rel">' + esc(x.collection + ' · ' + x.item + ' → ' + x.file) + '</span><span class="sz">' + fmtBytes(x.bytes) + '</span></div>');
    for (const x of d.wouldDownload || []) rows.push('<div class="oprow"><span class="op would">new</span><span class="rel">' + esc(x.collection + ' · ' + x.item) + '</span></div>');
    resActs = []; resShown = 0; resList = $('#resList');
    resList.innerHTML = rows.join('') ||
      '<div class="oprow rnone"><span class="rel" style="color:var(--muted)">' +
      (d.fatal ? esc('Run did not complete: ' + d.fatal) : 'Nothing new — everything here is already in the seen ledger.') +
      '</span></div>';
    $('#resRun').hidden = !d.dryRun;
    showView('Result');
    return;
  }
  const parts = [];
  if (d.fatal) parts.push('<span><b style="color:var(--red)">Failed:</b> ' + esc(d.fatal) + '</span>');
  else {
    parts.push('<span><b>' + d.scanned + '</b> files scanned</span>');
    parts.push('<span><b>' + (d.dryRun ? d.planCopies : d.copied) + '</b> ' + (d.dryRun ? 'to copy (' + fmtBytes(d.totalBytes) + ')' : 'copied (' + fmtBytes(d.bytes) + ')') + '</span>');
    parts.push('<span><b>' + (d.dryRun ? d.planDeletes : d.deleted) + '</b> ' + (d.dryRun ? 'to delete' : (d.recycled ? 'removed (' + d.recycled + ' recycled)' : 'deleted')) + '</span>');
    parts.push('<span><b>' + d.unchanged + '</b> unchanged</span>');
    if (d.foldersScanned) parts.push('<span><b>' + d.foldersScanned + '</b> folders' +
      (d.foldersCreated || d.foldersDeleted ? ' (' + (d.foldersCreated ? d.foldersCreated + ' created' : '') +
        (d.foldersCreated && d.foldersDeleted ? ', ' : '') + (d.foldersDeleted ? d.foldersDeleted + ' deleted' : '') + ')' : '') + '</span>');
    if (d.filtered) parts.push('<span><b>' + d.filtered + '</b> filtered out</span>');
    if (d.mirrorProtected) parts.push('<span><b>' + d.mirrorProtected + '</b> skip-protected from deletion</span>');
    if (d.skippedCount) parts.push('<span><b style="color:var(--amber)">' + d.skippedCount + '</b> skipped</span>');
    if (d.warningCount) parts.push('<span><b style="color:var(--amber)">' + d.warningCount + '</b> warnings</span>');
    if (d.errorCount) parts.push('<span><b style="color:var(--red)">' + d.errorCount + '</b> errors</span>');
    if (d.stopped) parts.push('<span><b style="color:var(--red)">stopped early</b></span>');
  }
  $('#resSummary').innerHTML = parts.join('') +
    (d.mirrorSkipped ? '<span style="flex-basis:100%;color:var(--amber)">⚠ ' + esc(d.mirrorSkipped) + '</span>' : '');
  // Lifetime accumulators (Karen's History tab): totals across every real run of this job.
  const life = j && j.stats;
  $('#resLife').hidden = !life;
  $('#resResetStats').hidden = !life;
  $('#resResetStats').textContent = 'Reset lifetime stats';
  delete $('#resResetStats').dataset.armed;
  if (life) {
    $('#resLife').innerHTML =
      '<span style="color:var(--faint)">All-time since ' + esc(new Date(life.since).toLocaleDateString()) + ':</span>' +
      '<span><b>' + life.runs + '</b> runs</span>' +
      '<span><b>' + life.copied + '</b> copied (' + fmtBytes(life.bytes) + ')</span>' +
      '<span><b>' + life.deleted + '</b> deleted' + (life.recycled ? ' (' + life.recycled + ' recycled)' : '') + '</span>' +
      (life.foldersCreated || life.foldersDeleted ? '<span><b>' + (life.foldersCreated || 0) + '</b> folders created, <b>' + (life.foldersDeleted || 0) + '</b> deleted</span>' : '') +
      (life.errors ? '<span><b style="color:var(--red)">' + life.errors + '</b> errors</span>' : '') +
      '<span><b>' + fmtDur(life.ms) + '</b> run time</span>';
  }
  const oprow = (op, cls, rel, sz) =>
    '<div class="oprow"><span class="op ' + cls + '">' + op + '</span><span class="rel">' + esc(rel) + '</span>' +
    (sz != null ? '<span class="sz">' + fmtBytes(sz) + '</span>' : '') + '</div>';
  // Errors first, then the full action list — rendered in chunks so a million-row preview
  // doesn't build a million DOM nodes at once, while the DATA stays complete (uncapped).
  const errHtml = (d.errors || []).map(x => oprow('error', 'err', x.path + ' — ' + x.error, null)).join('') +
    (d.warnings || []).map(x => oprow('warning', 'skip', x.path + ' — ' + x.warn, null)).join('') +
    (d.skipped || []).map(x => oprow('skipped', 'skip', x.path + ' — ' + x.note, null)).join('');
  const acts = d.actions || [];
  resList = $('#resList');
  if (!errHtml && !acts.length) {
    resList.innerHTML = '<div class="oprow rnone"><span class="rel" style="color:var(--muted)">Nothing to do — destination is up to date.</span></div>';
  } else {
    resList.innerHTML = errHtml;
    resActs = acts; resShown = 0;
    renderMoreActs();
  }
  $('#resRun').hidden = !d.dryRun;
  showView('Result');
}
// Progressive render: append CHUNK rows at a time, more as the user nears the bottom.
const RES_CHUNK = 500;
let resActs = [], resShown = 0, resList = null;
function renderMoreActs() {
  if (resShown >= resActs.length) return;
  const end = Math.min(resShown + RES_CHUNK, resActs.length);
  const sentinel = resList.querySelector('.resmore');
  if (sentinel) sentinel.remove();
  let html = '';
  for (let i = resShown; i < end; i++) {
    const a = resActs[i];
    // WHY this file copied (new file / source newer / size differs / …) — the "all files" reason
    // (compare mode = copy everything) carries no per-file signal, so it's left off.
    const rsn = a.op === 'copy' && a.reason && a.reason !== 'all files'
      ? '<span class="rsn">' + esc(a.reason) + '</span>' : '';
    html += '<div class="oprow"><span class="op ' + (a.op === 'copy' ? 'copy' : 'del') + '">' +
      (a.op === 'copy' ? 'copy' : 'delete') + '</span><span class="rel">' + esc(a.rel) + '</span>' + rsn +
      (a.size != null ? '<span class="sz">' + fmtBytes(a.size) + '</span>' : '') + '</div>';
  }
  resShown = end;
  if (resShown < resActs.length)
    html += '<div class="oprow resmore"><span class="rel" style="color:var(--faint)">showing ' +
      resShown.toLocaleString() + ' of ' + resActs.length.toLocaleString() + ' — scroll for more</span></div>';
  resList.insertAdjacentHTML('beforeend', html);
}
$('#resRun').addEventListener('click', async () => {
  const r = await api('run', { id: resultId });
  if (!r.ok) { msg(r.error, 'bad'); return; }
  showView('Main');
});
$('#resResetStats').addEventListener('click', async e => {
  const b = e.currentTarget;
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Really reset lifetime stats?'; return; }
  const r = await api('resetStats', { id: resultId });
  if (!r.ok) { msg(r.error, 'bad'); return; }
  await refreshList();
  openResult(resultId);
});
$('#resBack').addEventListener('click', () => showView('Main'));
$('#resClose').addEventListener('click', () => showView('Main'));
$('#resList').addEventListener('scroll', e => {
  const el = e.currentTarget;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) renderMoreActs();
});
// Tap a row to expand the cropped path/error to full text (tap again to collapse).
// Skipped while a text selection is active, so drag-selecting to copy never toggles it.
$('#resList').addEventListener('click', e => {
  const rowEl = e.target.closest('.oprow');
  if (!rowEl || rowEl.classList.contains('resmore') || rowEl.classList.contains('rnone')) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  rowEl.classList.toggle('open');
});

// ── pop-out window ────────────────────────────────────────────────────────────
// In the editor EMBED (nested inside the editor's own scrolling page), forms are unusable —
// so there, EVERY editing action opens the real window automatically, landed on that task.
// The embed stays a compact live list: run / preview / stop / status only.
const LAUNCHER = surface === 'editor';
async function winOpen(intent) {
  const r = await api('openWindow', { origin: location.origin, accent: accent || '', ...(intent || {}) });
  if (!r.ok) msg(r.error, 'bad');
  else if (r.already) msg('Job manager window is already open — brought it to the front.', 'info');
}
$('#openWin').hidden = !LAUNCHER;
$('#openWin').textContent = 'Open job manager';
$('#openWin').addEventListener('click', () => winOpen());

// Editor embed: report our content height to the host so an embed-autosize-capable host
// can size the iframe to fit instead of leaving dead space below the list (see
// HANDOFF-editor-embed-autosize.md). Harmless no-op on hosts that don't listen.
if (LAUNCHER && window.parent !== window) {
  const reportHeight = () => window.parent.postMessage(
    { type: 'oq-embed-height', app: 'file-bridge', height: document.body.scrollHeight }, '*');
  try { new ResizeObserver(reportHeight).observe(document.body); } catch {}
  window.addEventListener('load', reportHeight);
}

// ── rules view (user-supplied per-site instruction files for web jobs) ────────
// Unsaved edits are kept in recLocal per tab, so switching tabs or leaving the view
// never discards typed-but-unsaved rule JSON. The app ships no rules — a generic
// template seeds the editor so writing the first one is fill-in-the-blanks.
const RULE_TEMPLATE = JSON.stringify({
  site: 'example',
  name: 'Example Site',
  match: ['example.com'],
  auth: { loginUrl: 'https://www.example.com/login', probeSel: "a[href*='/account']", loggedOutUrlIncludes: ['/login'] },
  sources: [{ id: 'releases', mode: 'listing', collectionHrefIncludes: '/release/' }],
  collection: { itemSel: "a[href*='/item/']" },
  item: { nameSel: 'h1', downloadClickText: 'download', downloadTimeoutMs: 180000 },
  delayMs: 4000,
  pathPattern: '{collection}\\{item}',
}, null, 2);
let recFiles = {}, recLocal = {}, recSel = null;
function stashRuleEdit() {
  if (recSel == null) return;
  const v = $('#recText').value;
  if (v !== (recFiles[recSel] || '')) recLocal[recSel] = v;
  else delete recLocal[recSel];
}
async function openRules() {
  if (LAUNCHER) { winOpen({ rules: 1 }); return; }
  const r = await api('rules').catch(() => null);
  if (!r || !r.ok) { msg((r && r.error) || 'Cannot load rules', 'bad'); return; }
  recFiles = r.files || {};
  if (!Object.keys(recFiles).length && recLocal['new'] == null) recLocal['new'] = RULE_TEMPLATE;
  recSel = recSel && (recFiles[recSel] != null || recLocal[recSel] != null) ? recSel
    : Object.keys(recFiles)[0] || (recLocal['new'] != null ? 'new' : null);
  renderRuleTabs();
  $('#recText').value = recSel != null ? (recLocal[recSel] != null ? recLocal[recSel] : recFiles[recSel] || '') : '';
  $('#recErr').textContent = '';
  showView('Recipes');
}
function renderRuleTabs() {
  const keys = [...new Set([...Object.keys(recFiles), ...Object.keys(recLocal)])];
  $('#recTabs').innerHTML = keys.map(k =>
    '<button data-rec="' + esc(k) + '" class="' + (k === recSel ? 'active' : '') + '">' + esc(k) + (recLocal[k] != null ? ' •' : '') + '</button>').join('') +
    '<button data-newrule="1">+ New rule</button>';
}
$('#recTabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  stashRuleEdit();
  if (b.dataset.newrule) { recLocal['new'] = recLocal['new'] != null ? recLocal['new'] : RULE_TEMPLATE; recSel = 'new'; }
  else if (b.dataset.rec) recSel = b.dataset.rec;
  renderRuleTabs();
  $('#recText').value = recLocal[recSel] != null ? recLocal[recSel] : recFiles[recSel] || '';
  $('#recErr').textContent = '';
});
$('#recText').addEventListener('input', () => { stashRuleEdit(); renderRuleTabs(); });
$('#recSave').addEventListener('click', async () => {
  const r = await api('saveRule', { json: $('#recText').value });
  if (!r.ok) { $('#recErr').textContent = r.error; return; }
  delete recLocal[recSel];
  recSel = r.site;
  msg('Rule saved: ' + r.site, 'ok');
  await openRules();
  refreshList();
});
$('#recDelete').addEventListener('click', async e => {
  const b = e.currentTarget;
  if (recSel == null || recFiles[recSel] == null) { $('#recErr').textContent = 'nothing saved to delete on this tab'; return; }
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Really delete "' + recSel + '"?'; return; }
  delete b.dataset.armed; b.textContent = 'Delete rule';
  const r = await api('removeRule', { site: recSel });
  if (!r.ok) { $('#recErr').textContent = r.error; return; }
  delete recLocal[recSel];
  recSel = null;
  msg('Rule deleted.', 'ok');
  await openRules();
  refreshList();
});
$('#openRules').addEventListener('click', openRules);
$('#recBack').addEventListener('click', () => { stashRuleEdit(); showView('Main'); });
$('#recDone').addEventListener('click', () => { stashRuleEdit(); showView('Main'); });

// ── log view ──────────────────────────────────────────────────────────────────
$('#openLog').hidden = LAUNCHER; // embed is list-only; the log lives in the window
$('#pauseToggle').addEventListener('click', async () => {
  const r = await api('setPaused', { paused: !paused });
  if (!r.ok) { msg(r.error, 'bad'); return; }
  paused = r.paused; renderPause();
  msg(paused ? 'Schedules paused — nothing runs automatically until you resume. Manual Run/Preview still work.' : 'Schedules resumed.', paused ? 'info' : 'ok');
});
$('#openLog').addEventListener('click', () => showView('Log'));
$('#logBack').addEventListener('click', () => showView('Main'));
$('#openData').addEventListener('click', () => api('openData'));
$('#openRulesFolder').addEventListener('click', async () => {
  // Persist a valid in-progress edit first (the server validates and rejects bad JSON),
  // so the folder on disk reflects what's on screen; then open it in Explorer.
  stashRuleEdit();
  const cur = recSel && (recLocal[recSel] != null ? recLocal[recSel] : recFiles[recSel]);
  if (cur != null && cur !== recFiles[recSel]) await api('saveRule', { json: cur }).catch(() => {}); // server validates; bad JSON is left unsaved
  const r = await api('openRulesFolder');
  msg(r.ok ? 'Opened the rules folder — edit any .json, then Save in here or just re-run the job.' : (r.error || 'could not open the folder'), r.ok ? 'info' : 'bad');
});
// In-app rule-authoring guide — reachable from the Rules view, works for any user.
$('#openGuide').addEventListener('click', () => showView('Guide'));
$('#guideBack').addEventListener('click', () => showView('Recipes'));
$('#guideDone').addEventListener('click', () => showView('Recipes'));
$('#copyGuide').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#guideBody').innerText.trim()); msg('Guide copied — paste it into a text editor or any AI assistant.', 'ok'); }
  catch { msg('Could not copy — select the text manually instead.', 'bad'); }
});

// Grand totals (Karen's Grand Totals tab): app-wide lifetime counters, shown above the log.
function renderGrand() {
  $('#grandLine').hidden = !grand;
  $('#resetGrand').hidden = !grand;
  if (!grand) return;
  $('#grandLine').innerHTML =
    '<span style="color:var(--faint)">All jobs since ' + esc(new Date(grand.since).toLocaleDateString()) + ':</span>' +
    '<span><b>' + grand.runs + '</b> runs</span>' +
    '<span><b>' + grand.copied + '</b> copied (' + fmtBytes(grand.bytes) + ')</span>' +
    '<span><b>' + grand.deleted + '</b> deleted' + (grand.recycled ? ' (' + grand.recycled + ' recycled)' : '') + '</span>' +
    (grand.foldersCreated || grand.foldersDeleted ? '<span><b>' + (grand.foldersCreated || 0) + '</b> folders created, <b>' + (grand.foldersDeleted || 0) + '</b> deleted</span>' : '') +
    (grand.errors ? '<span><b style="color:var(--red)">' + grand.errors + '</b> errors</span>' : '') +
    '<span><b>' + fmtDur(grand.ms) + '</b> run time</span>';
}
$('#resetGrand').addEventListener('click', async e => {
  const b = e.currentTarget;
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Really reset totals?'; return; }
  delete b.dataset.armed; b.textContent = 'Reset totals';
  const r = await api('resetGrand');
  if (!r.ok) { msg(r.error, 'bad'); return; }
  refreshList();
});

// ── log detail (Karen parity: choose which per-file events land in the log) ─────
// The checkboxes reflect the server's effective categories (defaults merged with saved
// overrides); toggling one persists via setLogCats. Summaries/errors/warnings/deletions
// default ON; the noisy per-file ones (copies/up-to-date/skips/exclusions) default OFF.
function renderLogCats() {
  if (!logCatsState) return;
  document.querySelectorAll('#logCats input[data-cat]').forEach(cb => {
    cb.checked = !!logCatsState[cb.dataset.cat];
  });
}
document.querySelectorAll('#logCats input[data-cat]').forEach(cb => {
  cb.addEventListener('change', async () => {
    const cat = cb.dataset.cat;
    const prev = logCatsState; // snapshot so a failed save can be rolled back
    logCatsState = { ...(logCatsState || {}), [cat]: cb.checked };
    const r = await api('setLogCats', { cats: { [cat]: cb.checked } }).catch(() => null);
    if (!r || !r.ok) { logCatsState = prev; renderLogCats(); msg((r && r.error) || 'could not save log settings', 'bad'); return; }
    if (r.logCats) { logCatsState = r.logCats; renderLogCats(); }
  });
});
$('#eraseLog').addEventListener('click', async e => {
  const b = e.currentTarget;
  if (b._disarm) { clearTimeout(b._disarm); b._disarm = null; } // never let a stale timer disarm a later cycle
  if (!b.dataset.armed) {
    b.dataset.armed = '1'; b.textContent = 'Really erase log?';
    b._disarm = setTimeout(() => { delete b.dataset.armed; b.textContent = 'Erase log'; b._disarm = null; }, 4000);
    return;
  }
  delete b.dataset.armed; b.textContent = 'Erase log';
  const r = await api('eraseLog');
  if (!r.ok) { msg(r.error || 'could not erase the log', 'bad'); return; }
  $('#logPre').textContent = 'No activity yet.';
  msg('Activity log erased.', 'info');
});

// ── completion alert (Karen parity: beep when a run finishes) ─────────────────
// One shared preference in localStorage (all surfaces share the app's origin; default ON,
// like Karen); the tones are WebAudio so no asset or external fetch is needed. Only a
// VISIBLE, full surface beeps (Karen: alert only when the window is visible) — that also
// keeps the panel and an open pop-out window from chirping in chorus when both are shown.
try { $('#alertSound').checked = localStorage.getItem('fsync-beep') !== '0'; } catch {}
$('#alertSound').addEventListener('change', e => {
  try { localStorage.setItem('fsync-beep', e.target.checked ? '1' : '0'); } catch {}
});
let audioCtx = null;
function beep(ok) {
  if (LAUNCHER || document.hidden) return; // the embed has no toggle; hidden surfaces stay quiet
  if (!$('#alertSound').checked) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const tone = (freq, at, dur) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.1, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.start(at); o.stop(at + dur);
    };
    if (ok) { tone(660, t, 0.12); tone(990, t + 0.14, 0.2); }   // rising chirp: success
    else { tone(330, t, 0.2); tone(220, t + 0.24, 0.3); }       // falling: needs attention
  } catch {}
}
// A real (non-preview) run finished when a job's lastResults timestamp changes.
let seenRunAt = null;
function beepOnFinished() {
  if (seenRunAt) {
    for (const [id, r] of Object.entries(lastResults)) {
      if (!r.dryRun && seenRunAt[id] !== r.at) beep(!!r.ok);
    }
  }
  seenRunAt = {};
  for (const [id, r] of Object.entries(lastResults)) if (!r.dryRun) seenRunAt[id] = r.at;
}

// ── status polling ────────────────────────────────────────────────────────────
let hadCurrent = false;
async function poll() {
  const r = await api('status').catch(() => null);
  if (!r || !r.ok) return;
  if (typeof r.paused === 'boolean' && r.paused !== paused) { paused = r.paused; renderPause(); }
  current = r.current; queueIds = r.queue || []; lastResults = r.lastResults || {};
  beepOnFinished();
  renderLastBand();
  if (activeView === 'Log') {
    const pre = $('#logPre');
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
    pre.textContent = (r.log || []).join('\n') || 'No activity yet.';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
    $('#logStat').textContent = current ? 'Running: ' + current.name : '';
  }
  renderRunbar();
  if (hadCurrent && !current) {
    await refreshList(); // a run just finished — pick up lastRun / nextRun
    if (pendingPreview && lastResults[pendingPreview] && lastResults[pendingPreview].dryRun) {
      const id = pendingPreview; pendingPreview = null;
      // Embed: don't pop the window uninvited — the card status shows the preview summary,
      // and "View last result" in the row menu opens the window on the full detail.
      if (!LAUNCHER) openResult(id);
    }
    msg('', '');
  } else if (activeView === 'Main') {
    render();
  }
  hadCurrent = !!current;
}

// Live progress band — reflects `current` (the running job) each poll. Shows the FULL
// source and destination path of the file being examined/copied right now (Karen-style),
// during both the scan and the copy phases; counts are secondary.
function renderRunbar() {
  const bar = $('#runbar');
  if (!current) { bar.hidden = true; pauseChoosing = false; pausePending = false; return; } // don't leak pause UI into the next run
  bar.hidden = false;
  renderPauseControls();
  $('#runStopAll').hidden = !queueIds.length; // queued jobs behind this one? offer batch abort
  if (current.kind === 'web') {
    const p = current.progress || {};
    const c = current.webCounts || {};
    $('#runName').textContent = current.name;
    $('#runStop').textContent = current.dryRun ? 'Stop preview' : 'Stop';
    $('#runSrc').textContent = current.source; // the job's URL
    $('#runDst').textContent = current.dest;
    $('#runPhase').textContent = (current.dryRun ? 'Previewing' : 'Fetching') +
      (p.webPhase ? ' — ' + p.webPhase + (p.detail ? ' ' + p.detail : '') : '…');
    $('#runFill').style.width = '100%';
    $('#runOp').textContent = ''; $('#runOp').className = 'runop';
    $('#runReason').textContent = '';
    $('#runCounts').innerHTML = c.downloaded != null
      ? 'Downloaded <b>' + c.downloaded + '</b> · <b>' + (c.skippedSeen || 0) + '</b> already seen' : '';
    const wd = current.disk;
    $('#runDisk').textContent = wd ? fmtBytes(wd.free) + ' free of ' + fmtBytes(wd.total) : '';
    return;
  }
  const p = current.progress || {};
  const rel = p.rel ? String(p.rel).replace(/\//g, '\\') : '';
  const full = (root, r) => String(root || '').replace(/[\\/]+$/, '') + '\\' + (r || '');
  const deleting = p.op === 'del' || p.op === 'deldir';
  $('#runName').textContent = current.name;
  $('#runStop').textContent = current.dryRun ? 'Stop preview' : 'Stop';
  const clearChip = () => {
    $('#runOp').textContent = ''; $('#runOp').className = 'runop';
    $('#runReason').textContent = ''; $('#runCounts').innerHTML = '';
  };
  $('#runSrc').textContent = deleting ? '— (not in source)'
    : p.phase === 'mirror' ? '— (checking destination)' : full(current.source, rel);
  $('#runDst').textContent = full(current.dest, rel);
  if (current.phase === 'run') {
    if (p.phase === 'run' && p.total) {
      // Within-file progress (Drive downloads report streamed bytes) + a byte-based overall
      // bar so a single big file still moves the bar, plus a live MB/s rate.
      const filePct = p.fileTotal ? ' · ' + Math.round(Math.min(1, p.fileBytes / p.fileTotal) * 100) + '% of this file' : '';
      $('#runPhase').textContent = (current.dryRun ? 'Previewing' : 'Copying') + ' — file ' + p.done.toLocaleString() + ' of ' + p.total.toLocaleString() + (deleting ? '' : filePct);
      const bytePct = current.totalBytes ? Math.min(1, (p.bytes || 0) / current.totalBytes) : (p.done / p.total);
      $('#runFill').style.width = Math.round(bytePct * 100) + '%';
      $('#runOp').className = 'runop ' + (deleting ? 'del' : 'copy');
      $('#runOp').textContent = deleting ? 'delete' : 'copy';
      $('#runReason').textContent = p.reason ? '(' + p.reason + ')' : '';
      const rate = transferRate(current.startedAt, p.bytes || 0);
      // Carry the scan's up-to-date count into the copy phase — for a Drive job the compare
      // is a sub-second burst, so this is where "340 recognized as up-to-date" stays visible.
      const st = current.tally || {};
      $('#runCounts').innerHTML = 'Copied <b>' + fmtBytes(p.bytes || 0) + '</b>' + (rate > 0 ? ' · <b>' + fmtBytes(rate) + '/s</b>' : '')
        + (st.same ? ' · <b style="color:var(--green)">' + st.same.toLocaleString() + '</b> up-to-date' : '');
    } else {
      // Scan is done but the first copy hasn't completed yet — don't show a stale verdict.
      $('#runPhase').textContent = 'Copying — starting…';
      $('#runFill').style.width = '0%';
      clearChip();
    }
  } else if (p.phase === 'mirror') {
    $('#runPhase').textContent = (current.dryRun ? 'Previewing' : 'Scanning') + ' — checking the destination for deletions';
    $('#runFill').style.width = '100%';
    clearChip();
  } else {
    // Folder scan OR Drive-API listing. During a Drive listing show folder+file progress
    // (the tree walk precedes the file compare); otherwise the per-file examined count.
    const lead = current.dryRun ? 'Previewing' : 'Scanning';
    $('#runPhase').textContent = p.listing
      ? lead + ' — listing Drive folders · ' + (p.foldersScanned || 0).toLocaleString() + ' folders, ' + (p.scanned || 0).toLocaleString() + ' files'
      : lead + ' — ' + (p.scanned || 0).toLocaleString() + ' files examined';
    $('#runFill').style.width = '100%'; // indeterminate: full accent bar while scanning
    // Live per-item verdict (Karen's status band): up-to-date / copy / filtered / error as it moves.
    const chip = { same: ['same', 'up-to-date'], copy: ['copy', 'copy'], filtered: ['filtered', 'filtered'], error: ['del', 'error'] }[p.op];
    $('#runOp').className = 'runop ' + (chip ? chip[0] : '');
    $('#runOp').textContent = chip ? chip[1] : '';
    // Show the reason for a copy, and the actual error text the moment an error occurs.
    $('#runReason').textContent = p.op === 'error' ? (p.reason ? String(p.reason).slice(0, 90) : '')
      : (p.op === 'copy' && p.reason && p.reason !== 'all files' ? '(' + p.reason + ')' : '');
    // Running verdict tally, climbing live as the scan decides each file (Karen's status
    // counts): up-to-date · copy · filtered — plus errors. Answers "is it recognizing my
    // files as up-to-date, or re-copying them?" without needing to catch sub-second chips.
    const t = current.tally || { copy: 0, same: 0, filtered: 0 };
    const ec = p.errCount || 0;
    const parts = [];
    if (t.same) parts.push('<b style="color:var(--green)">' + t.same.toLocaleString() + '</b> up-to-date');
    if (t.copy) parts.push('<b style="color:var(--blue)">' + t.copy.toLocaleString() + '</b> to copy');
    if (t.filtered) parts.push('<b>' + t.filtered.toLocaleString() + '</b> filtered');
    if (ec) parts.push('<b style="color:var(--red)">' + ec.toLocaleString() + '</b> error' + (ec === 1 ? '' : 's'));
    $('#runCounts').innerHTML = parts.join(' · ');
  }
  // Paused overrides the phase line (the progress freezes at the last file until Resume).
  if (current.paused) {
    $('#runPhase').textContent = current.pausedActive
      ? 'Paused — press Resume to continue'
      : (current.pauseMode === 'now' ? 'Pausing now…' : 'Pausing — finishing the current file…');
  }
  const d = current.disk;
  $('#runDisk').textContent = d ? fmtBytes(d.free) + ' free of ' + fmtBytes(d.total) : '';
}
$('#runStop').addEventListener('click', () => api('stop', {}));
$('#runStopAll').addEventListener('click', () => api('stop', { all: true }));

// ── per-run Pause / Resume (Karen's "Resume Job") ─────────────────────────────
// The "finish current file vs pause now" choice is an inline expander in the run band, not a
// modal (the panel is modal-free). pauseChoosing tracks the expander; the run's paused state
// comes from the server (current.paused / current.pausedActive).
let pauseChoosing = false;
let pausePending = false; // committed a pause locally; hide Pause until the poll reports current.paused
function renderPauseControls() {
  const web = current && current.kind === 'web';       // web-drop jobs run their own engine — no pause
  const paused = !!(current && current.paused);         // pause requested / in effect
  const active = !!(current && current.pausedActive);   // actually parked at the gate (file finished)
  if (paused) pausePending = false;                     // the server has caught up
  $('#runResume').hidden = !active;                     // Resume only once TRULY parked (else it silently cancels)
  $('#runPause').hidden = web || paused || pauseChoosing || pausePending;
  $('#runPauseChoice').hidden = web || paused || !pauseChoosing;
}
$('#runPause').addEventListener('click', () => { pauseChoosing = true; renderPauseControls(); });
$('#runPauseCancel').addEventListener('click', () => { pauseChoosing = false; renderPauseControls(); });
$('#runPauseAfter').addEventListener('click', async () => {
  pauseChoosing = false; pausePending = true; renderPauseControls();
  const r = await api('pauseRun', { mode: 'afterFile' });
  if (!r.ok) { pausePending = false; renderPauseControls(); msg(r.error || 'could not pause', 'bad'); }
});
$('#runPauseNow').addEventListener('click', async () => {
  pauseChoosing = false; pausePending = true; renderPauseControls();
  const r = await api('pauseRun', { mode: 'now' });
  if (!r.ok) { pausePending = false; renderPauseControls(); msg(r.error || 'could not pause', 'bad'); }
});
$('#runResume').addEventListener('click', async () => {
  const r = await api('resumeRun', {});
  if (!r.ok) msg(r.error || 'could not resume', 'bad');
});

// ── last-run results band (Karen's auto-shown Last Run panel) ─────────────────
// Shows the newest finished (non-preview) run's numbers on the main view. Dismiss hides it
// until a NEWER run finishes. The body only rewrites when its markup changes, so the
// buttons never vanish mid-tap.
let bandDismissedAt = '';
let bandHtml = null;
function renderLastBand() {
  const band = $('#lastband');
  let best = null, bestId = null;
  for (const [id, r] of Object.entries(lastResults)) {
    if (r.dryRun) continue;
    if (!best || r.at > best.at) { best = r; bestId = id; }
  }
  if (!best || best.at <= bandDismissedAt) { band.hidden = true; bandHtml = null; return; }
  const j = jobs.find(x => x.id === bestId);
  const n = v => (v || 0).toLocaleString();
  const dot = best.fatal || best.errorCount ? 'c-bad' : best.stopped ? 'c-up' : 'c-ok';
  let counts;
  if (best.needsLogin) counts = '<span><b style="color:var(--blue)">Needs sign-in:</b> ' + esc(best.fatal || '') + '</span>';
  else if (best.fatal) counts = '<span><b style="color:var(--red)">Failed:</b> ' + esc(best.fatal) + '</span>';
  else if (best.kind === 'web') counts =
    '<span><b>' + n(best.copied) + '</b> downloaded (' + fmtBytes(best.bytes) + ')</span>' +
    '<span><b>' + n(best.skippedSeen) + '</b> already seen</span>' +
    '<span><b>' + n(best.collectionsVisited) + '</b> collections</span>' +
    (best.errorCount ? '<span><b style="color:var(--red)">' + n(best.errorCount) + '</b> errors</span>' : '') +
    (best.stopped ? '<span style="color:var(--amber)">stopped early</span>' : '');
  else counts =
    '<span><b>' + n(best.scanned) + '</b> processed</span>' +
    '<span><b>' + n(best.copied) + '</b> copied (' + fmtBytes(best.bytes) + ')</span>' +
    '<span><b>' + n(best.unchanged) + '</b> up-to-date</span>' +
    (best.foldersScanned ? '<span><b>' + n(best.foldersScanned) + '</b> folders' +
      (best.foldersCreated || best.foldersDeleted ? ' (' + (best.foldersCreated ? n(best.foldersCreated) + ' created' : '') +
        (best.foldersCreated && best.foldersDeleted ? ', ' : '') + (best.foldersDeleted ? n(best.foldersDeleted) + ' deleted' : '') + ')' : '') + '</span>' : '') +
    (best.filtered ? '<span><b>' + n(best.filtered) + '</b> filtered</span>' : '') +
    (best.deleted || best.recycled ? '<span><b>' + n(best.deleted) + '</b> deleted' + (best.recycled ? ' (' + n(best.recycled) + ' recycled)' : '') + '</span>' : '') +
    (best.skippedCount ? '<span><b style="color:var(--amber)">' + n(best.skippedCount) + '</b> skipped</span>' : '') +
    (best.warningCount ? '<span><b style="color:var(--amber)">' + n(best.warningCount) + '</b> warnings</span>' : '') +
    (best.errorCount ? '<span><b style="color:var(--red)">' + n(best.errorCount) + '</b> errors</span>' : '') +
    (best.stopped ? '<span style="color:var(--amber)">stopped early</span>' : '');
  const html =
    '<span class="st ' + dot + '"><span class="dot"></span></span>' +
    '<span class="bn">' + esc(j ? j.name : '?') + '</span>' +
    '<span>finished ' + esc(fmtAgo(best.at)) + (best.trigger === 'schedule' ? ' (scheduled)' : '') +
      ' · ' + esc(fmtDur(best.ms || 0)) + '</span>' + counts;
  if (html !== bandHtml) { bandHtml = html; $('#bandBody').innerHTML = html; band.dataset.id = bestId; }
  band.hidden = false;
}
$('#bandDetails').addEventListener('click', () => { if ($('#lastband').dataset.id) openResult($('#lastband').dataset.id); });
$('#bandClose').addEventListener('click', () => {
  let latest = '';
  for (const r of Object.values(lastResults)) if (!r.dryRun && r.at > latest) latest = r.at;
  bandDismissedAt = latest;
  renderLastBand();
});

refreshList().then(() => {
  // Pop-out window: land directly on the task that opened it (_add/_edit/_result/_filters).
  if (surface !== 'window') return;
  if (qs.get('_add')) openEdit(null);
  else if (qs.get('_edit')) { const j = jobs.find(x => x.id === qs.get('_edit')); if (j) openEdit(j); }
  else if (qs.get('_result')) openResult(qs.get('_result'));
  else if (qs.get('_filters')) openFilters();
  else if (qs.get('_rules')) openRules();
});
loadGroups(); // so the "+ Group" menu is populated before the first Add job
setInterval(poll, 1000);
setInterval(refreshList, 30000); // keep session chips / rules / next-run times fresh
