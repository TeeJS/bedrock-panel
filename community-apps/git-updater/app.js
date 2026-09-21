'use strict';
// External file (not inline) because the panel serves apps with CSP script-src 'self'.
// Full-screen VIEW navigation (main / add / scan / settings) — no modal dialogs.

// Follow the host panel's theme: the served URL carries _accent=<color>.
const q = new URLSearchParams(location.search);
const accent = q.get('_accent');
if (accent && /^#?[0-9a-f]{3,8}$/i.test(accent)) {
  document.documentElement.style.setProperty('--accent', accent.startsWith('#') ? accent : '#' + accent);
}

const $ = s => document.querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let apps = null;
let status = {};       // key -> {ph, pct, from, to, reason}
let running = false;
let pollTimer = null;
let portableRoot = '';

function api(action, body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined;
  return fetch('/app-api/' + action, opts).then(r => r.json());
}
function msg(t, cls) { const m = $('#msg'); m.textContent = t || ''; m.className = cls || ''; }

// ── View switching: exactly one opaque full-screen view active ────────────────
const VIEWS = ['Main', 'Add', 'Scan', 'Settings'];
let activeView = 'Main';
function showView(name) {
  activeView = name;
  VIEWS.forEach(v => $('#view' + v).classList.toggle('active', v === name));
  if (name === 'Add') { $('#mRepo').focus(); validateAdd(); }
  if (name === 'Settings') { $('#mRoot').value = portableRoot || ''; $('#setErr').textContent = ''; }
}
// Back / Cancel / Escape return to the main list without changing data.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && activeView !== 'Main') showView('Main'); });

// ── Main list ─────────────────────────────────────────────────────────────────
// Status cell: dot + explicit words (no bare dashes).
function stHtml(a) {
  const s = status[a.key] || {};
  const st = (cls, txt, title) =>
    '<span class="st ' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="dot"></span><span class="txt">' + esc(txt) + '</span></span>';
  const ph = s.ph;
  if (ph === 'queued') return st('c-muted', 'Queued');
  if (ph === 'checking') return st('c-work', 'Checking…');
  if (ph === 'downloading') return st('c-work', 'Downloading ' + (s.pct != null ? s.pct + '%' : '…'));
  if (ph === 'verifying') return st('c-work', 'Verifying…');
  if (ph === 'installing') return st('c-work', 'Installing…');
  if (ph === 'updated') return st('c-ok', a.present ? 'Updated' : 'Installed');
  if (ph === 'current') return st('c-ok', 'Up to date');
  if (ph === 'available') return st('c-up', 'Update to ' + (s.to || ''));
  if (ph === 'failed') return st('c-bad', s.reason || 'Failed', s.reason);
  return st('c-muted', 'Not checked');
}
// Current: after a check the engine's `from` is scheme-aligned (Brave 152.x -> 1.x).
function curHtml(a) {
  const s = status[a.key] || {};
  const cur = s.from || a.current;
  if (cur) return '<span class="ver">' + esc(cur) + '</span>';
  return '<span class="ver none">' + (a.present ? '?' : 'not installed') + '</span>';
}
function availHtml(a) {
  const s = status[a.key] || {};
  return s.to ? '<span class="ver avail">' + esc(s.to) + '</span>' : '<span class="ver none">—</span>';
}
function actHtml(a) {
  if (running) return '';
  const s = status[a.key] || {};
  const kebab = '<button class="kebab" data-kebab="' + esc(a.key) + '" aria-label="More actions">⋯</button>';
  if (s.ph === 'available') return '<button class="primary" data-act="update" data-key="' + esc(a.key) + '">' + (a.present ? 'Update' : 'Install') + '</button>' + kebab;
  if (s.ph === 'failed') return '<button data-act="update" data-key="' + esc(a.key) + '">Retry</button>' + kebab;
  return '<button data-act="check" data-key="' + esc(a.key) + '">Check</button>' + kebab;
}
function rowHtml(a) {
  return '<div class="app-row">' +
    '<span class="app-name" title="' + esc(a.owner + '/' + a.repo) + '">' + esc(a.repo) + '</span>' +
    '<span><span class="badge">' + (a.type === 'installer' ? 'Installer' : 'Portable') + '</span></span>' +
    curHtml(a) + availHtml(a) + stHtml(a) +
    '<span class="act">' + actHtml(a) + '</span>' +
  '</div>';
}
const HEAD = '<div class="app-table-header"><span>App</span><span>Type</span><span>Current</span><span>Available</span><span>Status</span><span></span></div>';

function render() {
  if (apps === null) { $('#colL').innerHTML = ''; $('#colR').innerHTML = ''; return; }
  $('#empty').style.display = apps.length ? 'none' : 'block';
  const midpoint = Math.ceil(apps.length / 2);
  const leftApps = apps.slice(0, midpoint);
  const rightApps = apps.slice(midpoint);
  $('#colL').innerHTML = leftApps.length ? HEAD + leftApps.map(rowHtml).join('') : '';
  $('#colR').innerHTML = rightApps.length ? HEAD + rightApps.map(rowHtml).join('') : '';
  document.querySelectorAll('.app-columns button[data-key]').forEach(b => { b.onclick = () => start(b.dataset.act, b.dataset.key); });
  document.querySelectorAll('.app-columns button[data-kebab]').forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); openRowMenu(b.dataset.kebab, b); };
  });
  const avail = apps.filter(a => (status[a.key] || {}).ph === 'available').length;
  $('#count').textContent = apps.length
    ? apps.length + ' app' + (apps.length === 1 ? '' : 's') + (avail ? ' · ' + avail + ' update' + (avail === 1 ? '' : 's') + ' ready' : '')
    : '';
  $('#checkAll').disabled = running || !apps.length;
  $('#updateAll').disabled = running || !apps.length;
}

async function load() {
  try {
    const r = await api('list');
    if (!r.ok) throw new Error(r.error || 'load failed');
    apps = r.apps; status = r.status || {}; running = !!r.running;
    portableRoot = r.portableRoot || '';
    msg('', '');
    render();
    if (running) poll();
  } catch (e) {
    msg(String(e.message || e), 'bad');
    render();
  }
}

function poll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      const r = await api('status');
      status = r.status || {}; running = !!r.running;
      render();
      if (running) poll();
      else load(); // batch done -> refresh installed versions from the registry
    } catch (e) { poll(); } // transient — keep polling
  }, 1000);
}

async function start(mode, only, force) {
  if (running) return;
  const body = {};
  if (only) body.only = only;
  if (force) body.force = true;
  const r = await api(mode, body);
  if (!r.ok) { msg(r.error || mode + ' failed', 'bad'); return; }
  running = true;
  msg(mode === 'check' ? 'Checking…' : 'Updating…', 'info');
  render();
  poll();
}

// ── Per-row overflow menu (matches standalone: Edit / Force reinstall /
//    Close app & update / View release / Open folder / Stop tracking) ──────────
const menu = $('#rowMenu');
function closeMenu() { menu.classList.remove('show'); menu.innerHTML = ''; }
document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
document.querySelector('#viewMain .list-scroll').addEventListener('scroll', closeMenu);

function menuItems(a) {
  const items = [
    { id: 'edit', label: 'Edit' },
    { id: 'force', label: a.present ? 'Force reinstall' : 'Install' },
    { id: 'close', label: 'Close app & update' },
    { sep: true },
    { id: 'release', label: 'View release' },
  ];
  if (a.type === 'portable') items.push({ id: 'folder', label: 'Open folder' });
  items.push({ sep: true }, { id: 'untrack', label: 'Stop tracking', danger: true });
  return items;
}
function renderMenu(a, items, note) {
  menu.innerHTML = (note ? '<div class="mnote">' + esc(note) + '</div>' : '') + items.map(it =>
    it.sep ? '<div class="sep"></div>'
    : '<button data-mi="' + it.id + '"' + (it.danger ? ' class="danger"' : '') + '>' + esc(it.label) + '</button>').join('');
  menu.querySelectorAll('button[data-mi]').forEach(b => { b.onclick = (e) => { e.stopPropagation(); menuAction(a, b.dataset.mi); }; });
}
function openRowMenu(key, btn) {
  const a = (apps || []).find(x => x.key === key);
  if (!a) return;
  renderMenu(a, menuItems(a));
  menu.classList.add('show');
  const r = btn.getBoundingClientRect();
  menu.style.visibility = 'hidden'; menu.style.left = '0px'; menu.style.top = '0px';
  requestAnimationFrame(() => {
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = Math.min(r.right - mw, innerWidth - mw - 8);
    let top = r.bottom + 6;
    if (top + mh > innerHeight - 8) top = r.top - mh - 6; // flip up near the fold
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
    menu.style.visibility = '';
  });
}
async function menuAction(a, id) {
  if (id === 'edit') { closeMenu(); openEdit(a); return; }
  if (id === 'force') { closeMenu(); start('update', a.key, true); return; }
  if (id === 'release') { closeMenu(); fetch('/app-api/openRelease?key=' + encodeURIComponent(a.key)); return; }
  if (id === 'folder') { closeMenu(); api('openFolder', { key: a.key }); return; }
  if (id === 'untrack') { // confirm inside the menu — no native dialogs in the webview
    renderMenu(a, [{ id: 'untrack2', label: 'Stop tracking ' + a.repo, danger: true }, { id: 'nope', label: 'Cancel' }],
      'The app itself is not uninstalled — git-updater just stops tracking it.');
    return;
  }
  if (id === 'untrack2') {
    closeMenu();
    const r = await api('remove', { key: a.key });
    if (!r.ok) return msg(r.error || 'remove failed', 'bad');
    msg(a.repo + ' removed.', 'ok');
    load();
    return;
  }
  if (id === 'close') {
    renderMenu(a, [{ id: 'close2', label: 'Close ' + a.repo + ' & update', danger: true }, { id: 'nope', label: 'Cancel' }],
      'Unsaved work in ' + a.repo + ' may be lost.');
    return;
  }
  if (id === 'close2') {
    const r = await api('closeApp', { key: a.key });
    if (r.ok && !r.stillRunning) { closeMenu(); start('update', a.key); return; }
    renderMenu(a, [{ id: 'close3', label: 'Force close & update', danger: true }, { id: 'nope', label: 'Cancel' }],
      a.repo + ' did not close. Force-closing WILL lose unsaved work.');
    return;
  }
  if (id === 'close3') {
    const r = await api('closeApp', { key: a.key, force: true });
    closeMenu();
    if (r.ok && !r.stillRunning) start('update', a.key);
    else msg(a.repo + ' is still running — close it manually, then Retry.', 'bad');
    return;
  }
  if (id === 'nope') closeMenu();
}

// ── Add-an-app view ───────────────────────────────────────────────────────────
function parseRepo(s) {
  s = String(s || '').trim();
  const m = s.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i) || s.match(/^([^/\s]+)\/([^/\s]+)$/);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/i, '') } : null;
}
function validateAdd() { $('#mAdd').disabled = !parseRepo($('#mRepo').value); }
$('#mRepo').addEventListener('input', validateAdd);
$('#mRepo').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#mAdd').disabled) $('#mAdd').click(); });
$('#mType').querySelectorAll('button').forEach(b => {
  b.onclick = () => { $('#mType').querySelectorAll('button').forEach(x => x.classList.remove('active')); b.classList.add('active'); };
});
// The Add view doubles as the Edit view (standalone's edit flow): editKey set = editing.
let editKey = null;
function setType(t) { $('#mType').querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.t === t)); }
function resetAddForm() {
  editKey = null;
  $('#mRepo').value = ''; $('#mBeta').checked = false; setType('portable');
  $('#addTitle').textContent = 'Add an app'; $('#mAdd').textContent = 'Add app';
  $('#addErr').textContent = ''; $('#addStat').textContent = '';
}
function openAdd() {
  if (editKey) resetAddForm(); // a fresh Add never inherits a stale edit
  showView('Add');
}
function openEdit(a) {
  resetAddForm();
  editKey = a.key;
  $('#mRepo').value = a.owner + '/' + a.repo;
  $('#mBeta').checked = !!a.prerelease;
  setType(a.type);
  $('#addTitle').textContent = 'Edit ' + a.repo;
  $('#mAdd').textContent = 'Save';
  showView('Add');
}
$('#mAdd').onclick = async () => {
  const p = parseRepo($('#mRepo').value);
  if (!p) return;
  const editing = editKey;
  $('#mAdd').disabled = true;
  $('#addStat').textContent = 'Checking ' + p.owner + '/' + p.repo + '…';
  $('#addErr').textContent = '';
  try {
    const payload = {
      owner: p.owner, repo: p.repo,
      type: $('#mType').querySelector('.active').dataset.t,
      prerelease: $('#mBeta').checked,
    };
    const r = editing ? await api('edit', { key: editing, ...payload }) : await api('add', payload);
    if (!r.ok) throw new Error(r.error || (editing ? 'save failed' : 'add failed'));
    resetAddForm(); // clear only after a successful submission
    showView('Main');
    msg(p.owner + '/' + p.repo + (editing ? ' saved.' : ' added.'), 'ok');
    await load();
    start('check', r.key); // populate Available for the new/edited entry
  } catch (e) {
    $('#addErr').textContent = String(e.message || e);
    $('#addStat').textContent = '';
    validateAdd();
  }
};

// ── Scan-this-PC view ─────────────────────────────────────────────────────────
let scanFound = [];
const scanSel = new Set(); // indexes into scanFound

function scanHeaderCount() {
  const fresh = scanFound.filter(f => !f.tracked).length;
  $('#scanStat').textContent = scanFound.length
    ? scanFound.length + ' found · ' + fresh + ' new' + (scanSel.size ? ' · ' + scanSel.size + ' selected' : '')
    : '';
  $('#mAddSel').disabled = scanSel.size === 0;
  $('#mAddSel').textContent = scanSel.size ? 'Add selected (' + scanSel.size + ')' : 'Add selected';
  $('#mAll').disabled = fresh === 0;
}
function renderScan() {
  const host = $('#scanList');
  if (!scanFound.length) { host.innerHTML = '<div class="scanhint">No known apps found in the Windows uninstall registry.</div>'; scanHeaderCount(); return; }
  host.innerHTML = scanFound.map((f, i) =>
    '<div class="scanrow' + (f.tracked ? ' tracked' : '') + (scanSel.has(i) ? ' sel' : '') + '" data-i="' + i + '" data-name="' + esc(f.name.toLowerCase()) + '">' +
      (f.tracked ? '<span style="width:24px;flex:none"></span>' : '<input type="checkbox"' + (scanSel.has(i) ? ' checked' : '') + '>') +
      '<span class="nm2">' + esc(f.name) + '</span>' +
      '<span class="det">' + (f.tracked ? 'Already tracked' : 'Detected') + '</span>' +
      '<span class="repo">' + esc(f.repo) + '</span>' +
      '<span class="v">' + esc(f.version || '') + '</span>' +
    '</div>').join('');
  host.querySelectorAll('.scanrow:not(.tracked)').forEach(row => {
    row.onclick = () => {
      const i = +row.dataset.i;
      if (scanSel.has(i)) scanSel.delete(i); else scanSel.add(i);
      row.classList.toggle('sel', scanSel.has(i));
      row.querySelector('input').checked = scanSel.has(i);
      scanHeaderCount();
    };
  });
  applyScanFilter();
  scanHeaderCount();
}
function applyScanFilter() {
  const f = $('#scanFilter').value.trim().toLowerCase();
  document.querySelectorAll('.scanrow').forEach(r => { r.style.display = !f || r.dataset.name.includes(f) ? '' : 'none'; });
}
$('#scanFilter').addEventListener('input', applyScanFilter);

async function openScan() {
  scanFound = []; scanSel.clear();
  $('#scanFilter').value = '';
  $('#scanList').innerHTML = '<div class="scanhint">Scanning the Windows uninstall registry…</div>';
  $('#scanStat').textContent = 'Scanning…';
  showView('Scan');
  try {
    const r = await api('scan');
    if (!r.ok) throw new Error(r.error || 'scan failed');
    scanFound = (r.found || []).slice().sort((a, b) => (a.tracked - b.tracked) || a.name.localeCompare(b.name));
    renderScan();
  } catch (e) {
    $('#scanList').innerHTML = '<div class="scanhint" style="color:var(--red)">' + esc(e.message || e) + '</div>';
    $('#scanStat').textContent = '';
  }
}
$('#mAll').onclick = () => {
  scanFound.forEach((f, i) => { if (!f.tracked) scanSel.add(i); });
  renderScan();
};
$('#mAddSel').onclick = async () => {
  const items = [...scanSel].map(i => ({ repo: scanFound[i].repo, type: 'installer' }));
  if (!items.length) return;
  $('#mAddSel').disabled = true;
  try {
    const r = await api('addMany', { items });
    if (!r.ok) throw new Error(r.error || 'add failed');
    showView('Main');
    msg(r.added + ' added.', 'ok');
    load();
  } catch (e) {
    $('#scanStat').textContent = String(e.message || e);
    scanHeaderCount();
  }
};

// ── Settings view ─────────────────────────────────────────────────────────────
// Host-mediated folder picker (app.json hostCapabilities: ["pick-folder"]). A host too old to
// serve the route answers 404/503 — the typed path field still works, so we only say so.
$('#mRootBrowse').onclick = async () => {
  const btn = $('#mRootBrowse'), input = $('#mRoot');
  btn.disabled = true;
  $('#setErr').textContent = '';
  try {
    const r = await fetch('/app-host/pick-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultPath: input.value.trim() }),
    });
    let out = null;
    try { out = await r.json(); } catch {}
    if (out && out.ok && typeof out.path === 'string') input.value = out.path;
    else if (!(out && out.canceled)) {
      $('#setErr').textContent = (out && out.error) || 'Folder picker unavailable — type the path instead.';
    }
  } catch (e) {
    $('#setErr').textContent = 'Folder picker unavailable — type the path instead.';
  } finally { btn.disabled = false; }
};

$('#mSave').onclick = async () => {
  try {
    const r = await api('setRoot', { path: $('#mRoot').value });
    if (!r.ok) throw new Error(r.error || 'save failed');
    showView('Main');
    msg('Saved.', 'ok');
    load();
  } catch (e) { $('#setErr').textContent = String(e.message || e); }
};

// ── Navigation wiring ─────────────────────────────────────────────────────────
$('#addApp').onclick = openAdd;
$('#scanPc').onclick = openScan;
$('#openSettings').onclick = () => showView('Settings');
$('#addBack').onclick = $('#addCancel').onclick = () => showView('Main');
$('#scanBack').onclick = $('#scanCancel').onclick = () => showView('Main');
$('#setBack').onclick = $('#setCancel').onclick = () => showView('Main');
$('#checkAll').onclick = () => start('check');
$('#updateAll').onclick = () => start('update');

load();
setInterval(() => { if (!running && activeView === 'Main') load(); }, 5 * 60 * 1000); // idle refresh
