function $(id) { return document.getElementById(id); }

// theme + options — host passes _dark=1/0, _accent=#hex, defaultPlatform=zoom|teams.
var Q = new URLSearchParams(location.search);
var QUERY_DEFAULT_PLATFORM = 'zoom';
(function () {
  try {
    document.body.classList.toggle('light', Q.get('_dark') === '0');
    var a = Q.get('_accent') || '';
    if (/^#[0-9a-fA-F]{6}$/.test(a)) document.documentElement.style.setProperty('--accent', a);
    // contrast-safe foreground for anything sitting on the accent (runtime accents vary):
    // relative luminance decides dark-on-accent vs light-on-accent.
    var hex = /^#[0-9a-fA-F]{6}$/.test(a) ? a : '#7CFFB2';
    var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.style.setProperty('--accent-fg', lum > 0.45 ? '#04121f' : '#f2f7fc');
    var dp = Q.get('defaultPlatform');
    if (dp === 'zoom' || dp === 'teams') QUERY_DEFAULT_PLATFORM = dp;
  } catch (e) {}
})();

var ICON = {
  mic:    '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"/><path d="M17 11a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 6h11a2 2 0 0 1 2 2v1.5l4-2.5v10l-4-2.5V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/></svg>',
  phone:  '<svg viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1z"/></svg>',
  exit:   '<svg viewBox="0 0 24 24"><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v-2H5V5h5V3z"/><path d="M17.7 12l-3.6-3.6L15.5 7l6 5-6 5-1.4-1.4 3.6-3.6H8v-2z"/></svg>',
  plus:   '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  minus:  '<svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>',
  open:   '<svg viewBox="0 0 24 24"><path d="M14 3v2h3.6l-9 9 1.4 1.4 9-9V10h2V3h-7zM5 5h5V3H3v18h18v-7h-2v5H5V5z"/></svg>',
  speaker:'<svg viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zm-2.5-8.8v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  share:  '<svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-6v2h2v2H8v-2h2v-2H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm8 3l-4 4h2.5v3h3v-3H16l-4-4z"/></svg>',
  gear:   '<svg viewBox="0 0 24 24"><path d="M19.4 13c.04-.33.07-.66.07-1s-.03-.67-.07-1l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.03 7.03 0 0 0-1.73-1l-.38-2.65A.5.5 0 0 0 13.93 2h-4a.5.5 0 0 0-.5.43l-.37 2.65c-.63.26-1.21.6-1.74 1l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46c-.13.22-.08.5.12.64L4.46 11c-.04.33-.07.66-.07 1s.03.67.07 1l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.22.38.31.6.22l2.49-1c.53.4 1.11.74 1.74 1l.37 2.65c.05.24.25.43.5.43h4c.25 0 .46-.19.5-.43l.37-2.65c.63-.26 1.21-.6 1.73-1l2.49 1c.23.09.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64L19.4 13zM11.93 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>',
};

// AUDIO & VIDEO controls are constant. CALL controls are per-platform. cls drives the semantic
// treatment: accept = green ring/icon, decline = red ring/icon, end = the one solid-red button.
var AV = [
  { action: 'mute',  icon: 'mic',    label: 'Mute' },
  { action: 'video', icon: 'camera', label: 'Camera' },
];
var CALL = {
  zoom: [
    { action: 'accept',  icon: 'phone',  label: 'Accept',  cls: 'accept' },
    { action: 'decline', icon: 'phone',  label: 'Decline', cls: 'decline', rot: true },
    { action: 'leave',   icon: 'phone',  label: 'Leave',   cls: 'end',     rot: true },
  ],
  teams: [
    { action: 'acceptAudio', icon: 'phone',  label: 'Accept audio', cls: 'accept' },
    { action: 'acceptVideo', icon: 'camera', label: 'Accept video', cls: 'accept' },
    { action: 'decline',     icon: 'phone',  label: 'Decline',      cls: 'decline', rot: true },
    { action: 'hangup',      icon: 'phone',  label: 'Hang up',      cls: 'end',     rot: true },
  ],
};
var PLATFORM_LABEL = { zoom: 'Zoom', teams: 'Teams' };
var platform = CALL[QUERY_DEFAULT_PLATFORM] ? QUERY_DEFAULT_PLATFORM : 'zoom';

// ---- status (readiness / real outcomes only; never a filename) ----
var statusT = null;
function statusReady() { var el = $('status'); el.textContent = PLATFORM_LABEL[platform] + ' ready'; el.style.color = 'var(--dim)'; }
function statusShow(msg, isError) {
  var el = $('status');
  el.textContent = msg;
  el.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  clearTimeout(statusT);
  statusT = setTimeout(statusReady, 3000);
}
function fireAction(plat, action, label) {
  return fetchJson('/meeting-action/' + encodeURIComponent(plat) + '/' + encodeURIComponent(action))
    .then(function (r) {
      if (r && r.ok) statusShow('Sent: ' + label); else statusShow((r && r.error) || 'Failed: ' + label, true);
      return r;
    })
    .catch(function () { statusShow('Request failed', true); });
}

// ---- deck ----
function buildCtl(a) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'ctl press foc' + (a.cls ? ' ' + a.cls : '') + (a.rot ? ' rot' : '');
  b.innerHTML = '<span class="btn"><span class="ic">' + ICON[a.icon] + '</span></span><span class="lab">' + a.label + '</span>';
  b.onclick = function () { fireAction(platform, a.action, a.label); };
  return b;
}
// Optional big Record button, shown beside Hang Up only when Settings → Meeting → "Large record button"
// is on. Toggles the recording directly; the top-right record indicator is separate and untouched.
var bigRecBtn = document.createElement('button');
bigRecBtn.type = 'button';
bigRecBtn.id = 'bigRec';
bigRecBtn.className = 'ctl press foc rec';
bigRecBtn.onclick = function () { if (curState.recording) doStop(); else doStart(); };
function syncBigRec() {
  var on = !!(curState && curState.largeRecord);
  bigRecBtn.style.display = on ? '' : 'none';
  if (!on) return;
  var live = !!(curState && curState.recording);
  bigRecBtn.classList.toggle('on', live);
  bigRecBtn.innerHTML = live
    ? '<span class="btn"><span class="sq"></span></span><span class="lab">Stop</span>'
    : '<span class="btn"><span class="dot"></span></span><span class="lab">Record</span>';
}
function renderDeck() {
  var av = $('avRow'); av.innerHTML = ''; AV.forEach(function (a) { av.appendChild(buildCtl(a)); });
  var call = $('callRow'); call.innerHTML = ''; (CALL[platform] || []).forEach(function (a) { call.appendChild(buildCtl(a)); });
  call.appendChild(bigRecBtn);   // right of Hang Up; syncBigRec hides it unless enabled
  syncBigRec();
  document.querySelectorAll('.seg').forEach(function (b) { b.classList.toggle('active', b.dataset.platform === platform); });
}
document.querySelectorAll('.seg').forEach(function (b) {
  b.onclick = function () { platform = b.dataset.platform; renderDeck(); statusReady(); };
});

// ---- utility rail ----
$('volDown').innerHTML = '<span class="ic">' + ICON.minus + '</span>';
$('volUp').innerHTML = '<span class="ic">' + ICON.plus + '</span>';
$('ic-settings').innerHTML = ICON.mic;   // the row opens the mic picker — a gear next to "Mic" reads as app settings
$('ic-share').innerHTML = ICON.share;
$('volDown').onclick = function () { fireAction('system', 'voldown', 'Volume down').then(pollState); };
$('volUp').onclick = function () { fireAction('system', 'volup', 'Volume up').then(pollState); };
$('settingsRow').onclick = function () { openMicPicker(); };
$('shareScreen').onclick = function () { fireAction(platform, 'share', 'Share screen'); };

// =====================================================================================
// Recording — remote for the hidden recorder window owned by main. Record opens a popover;
// once recording starts the popover collapses to a header pill. Filenames live only in the
// popover's recording details, never in the header status.
// =====================================================================================
var wrap = $('wrap');
var recHost = $('recHost');
recHost.innerHTML =
  '<button id="recToggle" class="press foc" type="button"><span class="dot"></span>Record</button>' +
  '<div id="pill" style="display:none"><span class="dot"></span><span class="txt">Recording</span>' +
  '<span class="t" id="pillDur">00:00</span>' +
  '<button class="stop press foc" id="pillStop" type="button"><span class="sq"></span>Stop</button></div>';

var drawerManual = false;
var curState = { recording: false, startedAt: null, mic: '', file: null, volume: null };
var micInitialized = false;

function fmtDur(ms) {
  var t = Math.max(0, Math.floor(ms / 1000));
  var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  var mm = (m < 10 ? '0' : '') + m, ss = (s < 10 ? '0' : '') + s;
  return h > 0 ? (h + ':' + mm + ':' + ss) : (mm + ':' + ss);
}
function tick() {
  if (curState.recording && curState.startedAt) $('pillDur').textContent = fmtDur(Date.now() - curState.startedAt);
}
// =====================================================================================
// Utility columns (Control / Slide Capture / Highlight) — all opt-in from the top bar and all
// closed on a fresh install. The open set is remembered in the config rather than localStorage:
// the panel server binds an ephemeral port, so web storage is wiped on every app launch.
// =====================================================================================
var PANELS = [
  { key: 'ctl',   btn: 'btnCtlPanel',   cls: 'pctl' },
  { key: 'slide', btn: 'btnSlidePanel', cls: 'pslide' },
  { key: 'hl',    btn: 'btnHlPanel',    cls: 'phl' },
  { key: 'busy',  btn: 'btnBusyPanel',  cls: 'pbusy' },
];
var panelsOpen = {};
var panelsRestored = false;

function syncPanels() {
  PANELS.forEach(function (p) {
    document.body.classList.toggle(p.cls, !!panelsOpen[p.key]);
    $(p.btn).classList.toggle('on', !!panelsOpen[p.key]);
  });
}
function togglePanel(key) {
  panelsOpen[key] = !panelsOpen[key];
  syncPanels();
  var csv = PANELS.filter(function (p) { return panelsOpen[p.key]; }).map(function (p) { return p.key; }).join(',');
  sendCmd('/meeting-set-panels/' + encodeURIComponent(csv));
}
PANELS.forEach(function (p) { $(p.btn).onclick = function () { togglePanel(p.key); }; });

// =====================================================================================
// Busy column — shows why you are showing busy and lets you override it. The page renders only what
// /meeting-state.busy reports; every decision is made in main so the light, HA and the panel can
// never disagree about the current state.
// =====================================================================================
var busyOverride = 'auto';
var busyManualColor = '#a020f0';
// Kept short and high-contrast on purpose: this is picked at arm's length on a touch panel, not in a
// colour dialog. Names matter more than precision here.
var BUSY_SWATCHES = [
  ['#a020f0', 'Purple'], ['#ff0000', 'Red'], ['#ff8000', 'Orange'], ['#ffd000', 'Yellow'],
  ['#00c853', 'Green'], ['#00b8d4', 'Cyan'], ['#2979ff', 'Blue'], ['#ff2d95', 'Pink'],
];

function setBusyOverride(mode) {
  busyOverride = mode;
  syncBusyModes();
  sendCmd('/meeting-busy/' + encodeURIComponent(mode));
}
function syncBusyModes() {
  [['busyAuto', 'auto'], ['busyBusy', 'busy'], ['busyFree', 'free'], ['busyCustom', 'custom']]
    .forEach(function (p) {
      var el = $(p[0]); if (el) el.classList.toggle('on', busyOverride === p[1]);
    });
  var sw = $('busySw'); if (sw) sw.style.background = busyManualColor;
  document.documentElement.style.setProperty('--busycustom', busyManualColor);
}
$('busyAuto').onclick = function () { setBusyOverride('auto'); };
$('busyBusy').onclick = function () { setBusyOverride('busy'); };
$('busyFree').onclick = function () { setBusyOverride('free'); };
// Tap Custom to switch to it using the colour you already chose; tap it AGAIN, while it is already
// active, to change that colour. Opening the picker on every tap would mean picking a colour you have
// already picked each time you toggle custom on.
$('busyCustom').onclick = function () {
  if (busyOverride === 'custom') openBusyPicker();
  else setBusyOverride('custom');
};

function openBusyPicker() {
  var grid = $('bpGrid');
  grid.innerHTML = '';
  BUSY_SWATCHES.forEach(function (c) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'bpsw press foc' + (c[0].toLowerCase() === busyManualColor.toLowerCase() ? ' on' : '');
    var dot = document.createElement('span');
    dot.className = 'dot'; dot.style.background = c[0];
    b.appendChild(dot);
    b.appendChild(document.createTextNode(c[1]));
    b.onclick = function () { pickBusyColor(c[0]); };
    grid.appendChild(b);
  });
  document.body.classList.add('bpicking');
}
function closeBusyPicker() { document.body.classList.remove('bpicking'); }
$('bpCancel').onclick = closeBusyPicker;
$('bpick').onclick = function (e) { if (e.target === $('bpick')) closeBusyPicker(); };

function pickBusyColor(hex) {
  busyManualColor = hex;
  syncBusyModes();
  closeBusyPicker();
  sendCmd('/meeting-busy-color/' + encodeURIComponent(hex));
}

function busyReasonText(b) {
  if (!b.busy) return b.override === 'free' ? 'Set by you' : 'Not on a call';
  if (b.reason === 'custom' || b.reason === 'manual') return 'Set by you';
  if (b.reason === 'recording') return 'Recording';
  if (b.reason === 'call') return b.app ? b.app.replace(/\.exe$/i, '') : 'On a call';
  return '';
}
// One short line per configured output, so a dead light or broker shows on the panel rather than only
// in the editor. Silent failure is the thing worth surfacing.
function busyOutputText(b) {
  var out = b.outputs || {}, bits = [];
  if (out.light && out.light.status && out.light.status !== 'disabled') {
    bits.push(out.light.connected ? 'Light OK' : ('Light: ' + (out.light.error || 'not found')));
  }
  if (out.wled && out.wled.enabled) bits.push('WLED: ' + (out.wled.status || '…'));
  if (out.mqtt && out.mqtt.enabled) bits.push(out.mqtt.connected ? 'HA OK' : 'HA: offline');
  return bits.join('  ·  ');
}
function renderBusy(b) {
  if (!b) b = { enabled: false };
  document.body.classList.toggle('busyon', !!b.enabled);
  if (!b.enabled) {
    document.body.classList.remove('isbusy', 'iscustom');
    return;
  }
  document.body.classList.toggle('isbusy', !!b.busy);
  document.body.classList.toggle('iscustom', b.reason === 'custom');
  var word = $('busyWord'); if (word) word.textContent = b.busy ? 'Busy' : 'Free';
  var why = $('busyWhy'); if (why) why.textContent = busyReasonText(b) || ' ';
  var stat = $('busyStat'); if (stat) stat.textContent = busyOutputText(b);
  // Main owns both, so adopt rather than trust the local copy — a restart or an editor change must
  // show here instead of the two drifting apart.
  if (b.override && b.override !== busyOverride) busyOverride = b.override;
  if (b.manualColor && b.manualColor !== busyManualColor) busyManualColor = b.manualColor;
  syncBusyModes();
}

// =====================================================================================
// Highlight column — tap to open a span, tap again to close it. Offsets are measured against the
// recording's start in main; the page only renders what /meeting-state.highlight reports.
// =====================================================================================
var hlState = { enabled: false, canHighlight: false, highlighting: false, spanMs: 0, count: 0 };
function applyHighlight(h) {
  hlState = h || hlState;
  document.body.classList.toggle('hlon', !!hlState.enabled);
  if (!hlState.enabled) return;
  document.body.classList.toggle('highlighting', !!hlState.highlighting);
  var live = !!hlState.highlighting;
  $('hlToggle').querySelector('.hlbl').textContent = live ? 'Stop highlighting' : 'Start highlighting';
  // Nothing recording = nothing to flag; the button stays visible but inert (matches slide capture).
  $('hlToggle').classList.toggle('sdis', !hlState.canHighlight && !live);
  $('hlClear').classList.toggle('sdis', !live);
  var st = $('hlStat');
  if (live) st.innerHTML = 'Highlighting · <b>' + fmtDur(hlState.spanMs) + '</b>';
  else if (!hlState.canHighlight) st.textContent = 'Start a recording to add highlights';
  else if (hlState.count) st.innerHTML = '<b>' + hlState.count + '</b> highlight' + (hlState.count === 1 ? '' : 's') + ' this meeting';
  else st.textContent = 'Ready · flags moments for the notes';
}
function hlCmd(path) {
  return fetchJson(path)
    .then(function (r) { if (r && r.error) statusShow(r.error, true); if (r && r.state) applyHighlight(r.state); return r; })
    .catch(function () { statusShow('Highlight command failed', true); });
}
$('hlToggle').onclick = function () { if ($('hlToggle').classList.contains('sdis')) return; hlCmd(hlState.highlighting ? '/highlight/stop' : '/highlight/start'); };
$('hlClear').onclick = function () { if ($('hlClear').classList.contains('sdis')) return; hlCmd('/highlight/cancel'); };

function applyState(st) {
  curState = st || curState;
  globalMicLabel = curState.micDef || '';   // keep the inherited-default label fresh for the picker + row
  if (!micInitialized) { savedMicLabel = curState.mic || ''; micInitialized = true; syncMic(); }
  else if (!savedMicLabel) { syncMic(); }   // inheriting: reflect a changed app-wide default in the row
  var live = !!curState.recording;
  // volume level (real, from main; when unreadable show a calm "System volume" label, no meter)
  var v = curState.volume;
  var known = (v != null);
  if (known) $('volPct').textContent = Math.round(v) + '%';
  else $('volPct').innerHTML = '<span class="ic">' + ICON.speaker + '</span>';   // centered icon, no awkward wrap
  $('volPct').classList.toggle('unknown', !known);
  $('volTrack').style.display = known ? '' : 'none';
  $('volFill').style.width = (known ? Math.max(0, Math.min(100, v)) : 0) + '%';
  // header: Record button vs live pill (top-right indicator — unchanged by the big button)
  $('recToggle').style.display = live ? 'none' : 'flex';
  $('pill').style.display = live ? 'flex' : 'none';
  syncBigRec();   // optional big Record button beside Hang Up mirrors the same live state
  // popover open + mode
  wrap.classList.toggle('drawer-open', drawerManual);
  $('recPanel').classList.toggle('details', live);
  if (curState.slide) applySlide(curState.slide);
  if (curState.highlight) applyHighlight(curState.highlight);
  renderBusy(curState.busy);   // always called: it also clears body.busyon when the feature is off
  // Restore the remembered column set once, from the first poll that carries it — after that
  // the buttons own the state and a later poll must not undo a tap just made.
  if (!panelsRestored && typeof curState.panelsOpen === 'string') {
    panelsRestored = true;
    curState.panelsOpen.split(',').forEach(function (k) { if (k) panelsOpen[k] = true; });
    syncPanels();
  }
  $('recFile').textContent = curState.file ? ('Saving ' + curState.file) : ' ';
  tick();
}
function pollState() {
  return fetchJson('/meeting-state')
    .then(function (st) { applyState(st); }).catch(function () {});
}
recHost.querySelector('#recToggle').onclick = function () { drawerManual = true; applyState(curState); };
$('recClose').onclick = function () { drawerManual = false; applyState(curState); };
$('pill').onclick = function (e) { if (e.target.closest('#pillStop')) return; drawerManual = true; applyState(curState); };
$('pillStop').onclick = function () { doStop(); };
$('recStopBig').onclick = function () { doStop(); };
function doStart() {
  fetchJson('/meeting-record/start')
    .then(function (r) { if (r && r.error) statusShow(r.error, true); drawerManual = false; if (r && r.state) applyState(r.state); pollState(); })
    .catch(function () { statusShow('Could not start recording', true); });
}
$('recStart').onclick = function () { doStart(); };
function doStop() {
  fetchJson('/meeting-record/stop')
    .then(function (r) { drawerManual = false; if (r && r.state) applyState(r.state); pollState(); })
    .catch(function () { statusShow('Could not stop recording', true); });
}

// ---- microphone picker (label-based; full-screen overlay) ----
var savedMicLabel = '';       // this page's own pick; '' = inherit the app-wide default
var globalMicLabel = '';      // Settings > General > Audio default (from meeting state); '' = OS system default
var allDevices = [];
function syncMic() { $('micVal').textContent = savedMicLabel || ('Default — ' + (globalMicLabel || 'System default')); }
// Announce a mic swap (incl. live panel swaps) via a lazily-created visually-hidden aria-live region.
function announceMic(msg) {
  var el = $('a11yLive');
  if (!el) {
    el = document.createElement('div');
    el.id = 'a11yLive'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    el.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0';
    document.body.appendChild(el);
  }
  el.textContent = '';
  setTimeout(function () { el.textContent = msg; }, 30);
}
function ensureDeviceIds() {
  return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (tmp) {
    return navigator.mediaDevices.enumerateDevices().then(function (devs) {
      tmp.getTracks().forEach(function (t) { t.stop(); });
      allDevices = devs || [];
    });
  }).catch(function () { allDevices = []; });
}
function renderDevList() {
  var el = $('devList'); el.innerHTML = '';
  function addRow(label, value, current) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'devRow foc' + (current ? ' current' : '');
    b.textContent = label; b.title = label;
    b.onclick = function () { pickMic(value); };
    el.appendChild(b);
  }
  var devs = allDevices.filter(function (d) { return d.kind === 'audioinput' && d.label; });
  var matched = !!savedMicLabel && devs.some(function (d) { return d.label === savedMicLabel; });
  addRow('App-wide default — ' + (globalMicLabel || 'System default'), '', !matched);
  devs.forEach(function (d) { addRow(d.label, d.label, matched && d.label === savedMicLabel); });
}
// Shared by the popover's Microphone row and the rail's Settings row — the picker IS the panel's
// settings window (the only panel-side setting is which mic gets recorded).
function openMicPicker() { renderDevList(); $('devOverlay').classList.add('show'); ensureDeviceIds().then(renderDevList); }
$('micRow').onclick = function () { openMicPicker(); };
$('devCancel').onclick = function () { $('devOverlay').classList.remove('show'); };
function pickMic(label) {
  $('devOverlay').classList.remove('show');
  savedMicLabel = label || ''; syncMic();
  announceMic(savedMicLabel ? ('Microphone set to ' + savedMicLabel + ' for this page')
                            : ('Microphone now using the app-wide default (' + (globalMicLabel || 'system default') + ')'));
  fetchJson('/meeting-set-mic/' + encodeURIComponent(savedMicLabel))
    .then(function (r) { if (r && r.state) applyState(r.state); })
    .catch(function () { statusShow('Could not set microphone', true); });
}

// =====================================================================================
// Slide capture — column shown only when enabled (body.slides). Select is always usable;
// Start/Manual are greyed unless a recording is live. State rides in /meeting-state.slide.
// =====================================================================================
ICON.target = '<svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16z"/></svg>';
$('ic-slide-target').innerHTML = ICON.target;
$('ic-slide-cam').innerHTML = ICON.camera;

var slideState = { enabled: false, target: '', capturing: false, slides: 0, canCapture: false };
function applySlide(s) {
  slideState = s || slideState;
  document.body.classList.toggle('slides', !!slideState.enabled);
  if (!slideState.enabled) return;
  if (slideState.openPicker && $('winOverlay') && !$('winOverlay').classList.contains('show')) openWinPicker();   // select-window hotkey
  document.body.classList.toggle('capturing', !!slideState.capturing);
  // target row
  var tv = $('slideTargetVal');
  tv.textContent = slideState.target || 'No window selected';
  tv.classList.toggle('none', !slideState.target);
  // Start/Stop label + Manual enablement (capture needs a live recording)
  $('slideToggle').querySelector('.slbl').textContent = slideState.capturing ? 'Stop capture' : 'Start capture';
  var lockable = !slideState.canCapture && !slideState.capturing;   // no recording -> capture controls inert
  $('slideToggle').classList.toggle('sdis', lockable);
  $('slideManual').classList.toggle('sdis', lockable);
  // status line
  var st = $('slideStat');
  if (slideState.capturing) { st.className = 'sstat'; st.innerHTML = '<b>' + slideState.slides + '</b> slide' + (slideState.slides === 1 ? '' : 's') + ' captured'; }
  else if (!slideState.canCapture) { st.className = 'sstat'; st.textContent = 'Start a recording to capture slides'; }
  else if (slideState.slides) { st.className = 'sstat'; st.innerHTML = '<b>' + slideState.slides + '</b> captured'; }
  else { st.className = 'sstat'; st.textContent = 'Ready · captures into this meeting'; }
}
function slideCmd(path) {
  return fetchJson(path)
    .then(function (r) { if (r && r.error) statusShow(r.error, true); if (r && r.state) applySlide(r.state); return r; })
    .catch(function () { statusShow('Slide command failed', true); });
}
$('slideToggle').onclick = function () { if ($('slideToggle').classList.contains('sdis')) return; slideCmd(slideState.capturing ? '/slide/stop' : '/slide/start').then(pollState); };
$('slideManual').onclick = function () { if ($('slideManual').classList.contains('sdis')) return; slideCmd('/slide/manual'); };
$('slideSelect').onclick = function () { openWinPicker(); };
function closeWinPicker() { $('winOverlay').classList.remove('show'); }   // Cancel/Escape leave the current selection untouched
$('winCancel').onclick = closeWinPicker;
$('winClear').onclick = function () { pickWindow('', ''); };              // "Clear selection" — a header action, not a list row
$('winRetry').onclick = function () { openWinPicker(); };
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('winOverlay').classList.contains('show')) closeWinPicker(); });

function winMessage(html) {   // single centered message tile spanning the grid (loading / empty / error)
  $('winList').innerHTML = '<div class="winMsg">' + html + '</div>';
  $('winScrollRail').style.display = 'none';
}
function openWinPicker() {
  $('winOverlay').classList.add('show');
  $('winRetry').style.display = 'none';
  $('winSub').textContent = 'Choose the window being presented';
  winMessage('Finding windows…');
  fetchJson('/slide/windows').then(function (r) {
    if (!r || r.ok === false) return winError();
    renderWins((r && r.windows) || []);
  }).catch(winError);
}
function winError() {
  $('winSub').textContent = '';
  winMessage('Could not list windows.');
  $('winRetry').style.display = '';
}
function renderWins(wins) {
  var el = $('winList'); el.innerHTML = '';
  $('winRetry').style.display = 'none';
  if (!wins.length) {
    $('winSub').textContent = '0 found';
    winMessage('<b>No matching windows</b>Open the window, or change the Slide Capture filter in Settings.');
    return;
  }
  $('winSub').textContent = wins.length + (wins.length === 1 ? ' window found' : ' windows found');
  wins.forEach(function (w) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'winTile foc' + (w.name === slideState.target ? ' current' : '');
    var s = document.createElement('span'); s.textContent = w.name; b.appendChild(s);   // two-line clamp; no title= tooltip on a touchscreen
    if (w.min) { var m = document.createElement('i'); m.className = 'minTag'; m.textContent = 'minimized'; b.appendChild(m); }   // still selectable; capture warns until restored
    b.onclick = function () { pickWindow(w.id, w.name); };
    b.addEventListener('focus', function () { try { b.scrollIntoView({ block: 'nearest' }); } catch (e) {} });   // keep knob/keyboard focus on-screen
    el.appendChild(b);
  });
  $('winScrollRail').style.display = wins.length > 12 ? 'flex' : 'none';   // paging rail only when the grid overflows (4 rows × 3 cols)
}
function pickWindow(id, name) {
  closeWinPicker();   // tap selects and closes immediately
  slideCmd('/slide/select?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name)).then(pollState);
}

// =====================================================================================
// Library / Transcription / Analysis overlays — full-screen, same pattern as the mic picker.
// The transcription and analysis pollers run ONLY while their overlay is on screen.
// =====================================================================================
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtSize(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
function fetchJson(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); }); }
// " · N queued" suffix for the transcription/analysis status lines, or '' when nothing is queued.
function qSuffix(n) { return n ? ' · ' + n + ' queued' : ''; }
// Fire-and-forget command GET (panel/busy toggles); errors are ignored — the next poll re-syncs state.
function sendCmd(url) { fetch(url, { cache: 'no-store' }).catch(function () {}); }
function fileMeta(f) {
  var sub = (f.durationMs != null ? fmtDur(f.durationMs) + ' · ' : '') + fmtSize(f.size);
  var meta = document.createElement('div'); meta.className = 'meta';
  meta.innerHTML = '<div class="fname">' + escHtml(f.name) + '</div><div class="fsub">' + escHtml(sub) + '</div>';
  return meta;
}
function rowBtn(label, extraCls) {
  var b = document.createElement('button');
  b.type = 'button'; b.className = 'rowBtn press foc' + (extraCls ? ' ' + extraCls : '');
  b.textContent = label;
  return b;
}
// ---- shared multi-select (Select all / <action> selected in each overlay header) ----
function selMake(allId, actId) {
  var sel = { set: {}, names: [], boxes: {}, allBtn: $(allId), actBtn: $(actId) };
  sel.allBtn.onclick = function () {
    var all = sel.names.length && selCount(sel) === sel.names.length;
    sel.set = {};
    if (!all) sel.names.forEach(function (n) { sel.set[n] = true; });
    selSync(sel);
  };
  return sel;
}
function selCount(sel) { return Object.keys(sel.set).length; }
function selNames(sel) { return Object.keys(sel.set); }
function selSync(sel) {
  sel.names.forEach(function (n) {
    var b = sel.boxes[n];
    if (b) { b.classList.toggle('on', !!sel.set[n]); b.textContent = sel.set[n] ? '✓' : ''; }
  });
  sel.allBtn.textContent = (sel.names.length && selCount(sel) === sel.names.length) ? 'Clear all' : 'Select all';
  if (!sel.actBtn.classList.contains('confirm')) sel.actBtn.disabled = !selCount(sel);
  if (sel.onSync) sel.onSync();
}
// Reset for a fresh render: keep selections for names still present, drop the rest.
function selReset(sel, names) {
  var kept = {};
  names.forEach(function (n) { if (sel.set[n]) kept[n] = true; });
  sel.set = kept; sel.names = names; sel.boxes = {};
}
function selBox(sel, name) {
  var b = document.createElement('button');
  b.type = 'button'; b.className = 'selBox press foc';
  b.onclick = function () {
    if (sel.set[name]) delete sel.set[name]; else sel.set[name] = true;
    selSync(sel);
  };
  sel.boxes[name] = b;
  return b;
}
// Processed names may carry the Organize-by-date prefix (2026/08/x.json) — show the filename big
// and the folder in the sub line.
function splitRel(name) {
  var i = name.lastIndexOf('/');
  return { base: i < 0 ? name : name.slice(i + 1), folder: i < 0 ? '' : name.slice(0, i) };
}
// ▲/▼ page buttons for scroll regions — tap = one page, hold = keeps paging (claudevoiceview pattern;
// drag-thumbs are unreliable on the physical panel).
function wireScrollButtons(listId, upId, downId) {
  var list = $(listId);
  function step(dir) { list.scrollBy({ top: dir * list.clientHeight * 0.9, behavior: 'smooth' }); }
  [[upId, -1], [downId, 1]].forEach(function (pair) {
    var btn = $(pair[0]);
    var repeat = null;
    btn.addEventListener('pointerdown', function (e) {
      try { btn.setPointerCapture(e.pointerId); } catch (err) {}   // capture is best-effort — never block the scroll
      step(pair[1]);
      repeat = setInterval(function () { step(pair[1]); }, 400);
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      btn.addEventListener(ev, function () { clearInterval(repeat); repeat = null; });
    });
  });
}

// ---- Unprocessed: list / play / transcribe / delete (the transcription queue lives here) ----
var libAudio = $('libAudio');
var libPlaying = '';        // name whose audio is loaded
var libSyncs = [];          // per-row repaint hooks, rebuilt on each render
function libSyncAll() { libSyncs.forEach(function (fn) { fn(); }); }
libAudio.onplay = libSyncAll; libAudio.onpause = libSyncAll;
libAudio.onended = function () { libPlaying = ''; libAudio.removeAttribute('src'); libSyncAll(); };
function stopPlayback() { try { libAudio.pause(); } catch (e) {} libPlaying = ''; libAudio.removeAttribute('src'); }
function libMsg(msg, isError) { var n = $('libNote'); n.textContent = msg || ''; n.classList.toggle('err', !!isError); }
var libSel = selMake('libSelAll', 'libGoSel');
libSel.onSync = function () { $('libMergeSel').style.display = selCount(libSel) >= 2 ? '' : 'none'; };   // Merge needs 2+ ticked
var libTimer = null, txState = null, txLastFinished = 0;
var libTxRows = {};         // name -> { btn, sub } for transcription-state repaints
function libPoll() {
  fetchJson('/meeting-transcribe/state').then(function (st) {
    txState = st;
    var s = $('txStatus');
    var queued = (st.queue || []).length;
    if (st.phase === 'pre' || st.phase === 'waiting') {
      s.classList.remove('err');
      s.textContent = (st.phase === 'pre' ? 'Starting transcription server…' : 'Waiting for transcription server…') + qSuffix(queued);
    } else if (st.phase === 'post') {
      s.classList.remove('err'); s.textContent = 'Stopping transcription server…';
    } else if (st.current) {
      s.classList.remove('err');
      s.innerHTML = 'Transcribing ' + escHtml(st.current.name) + ' — <span class="t">' + fmtDur(Date.now() - st.current.startedAt) + '</span>' +
        '&nbsp;&nbsp;(takes about ⅓ of the recording length)' + qSuffix(queued);
    } else if (queued) {
      s.classList.remove('err'); s.textContent = queued + ' queued';
    } else if (st.health === 'down') {
      // With hooks on, a stopped server at idle is the NORMAL state, not an error.
      s.classList.toggle('err', !st.hooksEnabled);
      s.textContent = st.hooksEnabled ? 'Transcription server starts on demand' : 'Transcription server unreachable';
    } else {
      s.classList.remove('err');
      s.textContent = st.health === 'ok' ? 'Transcription server connected' : '';
    }
    // a finished job moves files — refresh the list once per completion, not every second
    var fin = (st.recent && st.recent.length) ? st.recent[0].finishedAt : 0;
    if (fin && fin !== txLastFinished) { txLastFinished = fin; renderLibrary(); }
    else updateLibTxButtons();
  }).catch(function () {});
}
function renderLibrary() {
  var keepScroll = $('libList').scrollTop;   // completions re-render the list — keep the view put
  fetchJson('/meeting-files?kind=unprocessed').then(function (r) {
    var el = $('libList'); el.innerHTML = ''; libSyncs = []; libTxRows = {};
    var files = ((r && r.files) || []).filter(function (f) { return /\.wav$/i.test(f.name); });
    libMsg(files.length ? files.length + ' recording' + (files.length === 1 ? '' : 's') : '');
    selReset(libSel, files.map(function (f) { return f.name; }));
    if (!files.length) { el.innerHTML = '<div class="ovEmpty">No unprocessed recordings.</div>'; selSync(libSel); return; }
    files.forEach(function (f) { el.appendChild(buildLibRow(f)); });
    updateLibTxButtons();
    selSync(libSel);
    el.scrollTop = keepScroll;
  }).catch(function () { libMsg('Could not load recordings', true); });
}
function buildLibRow(f) {
  var row = document.createElement('div'); row.className = 'fileRow';
  row.appendChild(selBox(libSel, f.name));
  var meta = fileMeta(f);
  row.appendChild(meta);
  function setSub(msg, isError) { var s2 = meta.querySelector('.fsub'); s2.textContent = msg; s2.classList.toggle('err', !!isError); }
  var tx = rowBtn('Transcribe', 'primary');
  tx.onclick = function () {
    tx.disabled = true;
    fetchJson('/meeting-transcribe/start?name=' + encodeURIComponent(f.name))
      .then(function (r2) {
        if (r2 && r2.ok === false) { setSub(r2.error || 'Could not queue', true); tx.disabled = false; }
        libPoll();
      })
      .catch(function () { setSub('Could not queue', true); tx.disabled = false; });
  };
  var play = rowBtn('Play');
  play.onclick = function () {
    if (libPlaying === f.name) {
      if (libAudio.paused) libAudio.play().catch(function () { libMsg('Playback failed', true); });
      else libAudio.pause();
    } else {
      libPlaying = f.name;
      libAudio.src = '/meeting-audio?kind=unprocessed&name=' + encodeURIComponent(f.name);
      libAudio.play().catch(function () { libPlaying = ''; libMsg('Playback failed', true); libSyncAll(); });
    }
    libSyncAll();
  };
  var del = rowBtn('Delete', 'danger');
  var confirmT = null;
  del.onclick = function () {
    if (!del.classList.contains('confirm')) {   // two-tap confirm: first tap arms for 3 s
      del.classList.add('confirm'); del.textContent = 'Confirm?';
      confirmT = setTimeout(function () { del.classList.remove('confirm'); del.textContent = 'Delete'; }, 3000);
      return;
    }
    clearTimeout(confirmT);
    if (libPlaying === f.name) stopPlayback();
    fetchJson('/meeting-file-delete?kind=unprocessed&name=' + encodeURIComponent(f.name))
      .then(function (r) {
        if (r && r.ok) { libMsg('Deleted ' + f.name); renderLibrary(); }
        else libMsg((r && r.error) || 'Delete failed', true);
      })
      .catch(function () { libMsg('Delete failed', true); });
  };
  libSyncs.push(function () {
    row.classList.toggle('playing', libPlaying === f.name);
    play.textContent = (libPlaying === f.name && !libAudio.paused) ? 'Pause' : 'Play';
  });
  libTxRows[f.name] = { btn: tx, del: del, sub: meta.querySelector('.fsub') };
  row.appendChild(tx); row.appendChild(play); row.appendChild(del);
  return row;
}
// Per-row Transcribe button states from the shared queue; a running/queued file also can't be
// deleted out from under the diarizer, so Delete disables alongside.
function updateLibTxButtons() {
  if (!txState) return;
  Object.keys(libTxRows).forEach(function (name) {
    var r = libTxRows[name];
    var busy = (txState.current && txState.current.name === name) || (txState.queue || []).indexOf(name) >= 0;
    if (txState.current && txState.current.name === name) {
      r.btn.textContent = 'Transcribing…'; r.btn.disabled = true; r.btn.classList.remove('primary');
    } else if (busy) {
      r.btn.textContent = 'Queued'; r.btn.disabled = true; r.btn.classList.remove('primary');
    } else {
      var err = (txState.recent || []).find(function (j) { return j.name === name && j.status === 'error'; });
      r.btn.textContent = err ? 'Retry' : 'Transcribe'; r.btn.disabled = false; r.btn.classList.add('primary');
      if (err) { r.sub.textContent = err.error || 'failed'; r.sub.classList.add('err'); }
    }
    r.del.disabled = busy;   // can't delete a file the diarizer is using / about to use
  });
}
// Wire a "queue selected" button: enqueue every selected name via urlBase (server FIFO dedupes
// anything already queued/running), then clear the selection and re-poll.
function wireEnqueue(btnId, sel, urlBase, poll) {
  $(btnId).onclick = function () {
    var names = selNames(sel);
    if (!names.length) return;
    $(btnId).disabled = true;
    Promise.all(names.map(function (n) {
      return fetchJson(urlBase + encodeURIComponent(n)).catch(function () { return null; });
    })).then(function () { sel.set = {}; selSync(sel); poll(); });
  };
}
wireEnqueue('libGoSel', libSel, '/meeting-transcribe/start?name=', libPoll);
$('libMergeSel').onclick = function () {
  var btn = $('libMergeSel');
  var names = selNames(libSel);
  if (names.length < 2) return;
  if (names.indexOf(libPlaying) >= 0) stopPlayback();
  btn.disabled = true; libMsg('Merging ' + names.length + ' recordings…');
  fetchJson('/meeting-merge?names=' + encodeURIComponent(JSON.stringify(names)))
    .then(function (r) {
      btn.disabled = false;
      if (r && r.ok) { libSel.set = {}; renderLibrary(); libMsg('Merged into ' + r.name + ' (originals kept in .backups)'); }
      else libMsg((r && r.error) || 'Merge failed', true);
    })
    .catch(function () { btn.disabled = false; libMsg('Merge failed', true); });
};
var libDelT = null;
$('libDelSel').onclick = function () {
  var btn = $('libDelSel');
  var names = selNames(libSel);
  if (!names.length) return;
  if (!btn.classList.contains('confirm')) {   // two-tap confirm, same as the per-row Delete
    btn.classList.add('confirm'); btn.textContent = 'Confirm delete ' + names.length + '?';
    clearTimeout(libDelT);
    libDelT = setTimeout(function () { btn.classList.remove('confirm'); btn.textContent = 'Delete selected'; selSync(libSel); }, 3000);
    return;
  }
  clearTimeout(libDelT); btn.classList.remove('confirm'); btn.textContent = 'Delete selected';
  if (names.indexOf(libPlaying) >= 0) stopPlayback();
  Promise.all(names.map(function (n) {
    return fetchJson('/meeting-file-delete?kind=unprocessed&name=' + encodeURIComponent(n)).catch(function () { return { ok: false }; });
  })).then(function (rs) {
    var fails = rs.filter(function (r) { return !(r && r.ok); }).length;
    libSel.set = {};
    renderLibrary();
    libMsg(fails ? (names.length - fails) + ' deleted, ' + fails + ' failed' : 'Deleted ' + names.length + ' recording' + (names.length === 1 ? '' : 's'), !!fails);
  });
};
$('btnUnprocessed').onclick = function () {
  $('libOverlay').classList.add('show');
  renderLibrary(); libPoll();
  if (!libTimer) libTimer = setInterval(libPoll, 1000);   // drives the status strip + row states while shown
};
$('libClose').onclick = function () {
  $('libOverlay').classList.remove('show');
  stopPlayback();
  clearInterval(libTimer); libTimer = null;
};

// ---- Batch: transcribe everything unprocessed, then analyze every unanalyzed transcript ----
// The coordinator lives in the main process (meetingBatch.js), so a reload, a page switch, or a
// batch started from another panel just shows up here: batchPoll rides the global 1 s poll loop.
// The Batch page is the coordinator's ledger on screen: one status strip (the batch's own state)
// over one list of every file in order, the file being worked ringed; after the batch ends the
// strip holds the summary until the next batch starts.
var batchStarting = false;   // a start or cancel is in flight — a stale state fetch must not overwrite its result
var batchRev = 0;            // bumped per poll and per request: a poll answered after a later request is discarded
var batchState = null;
var batchStripText = '';     // what the strip (the live region) last said — rewritten only when the words change
var batchListSig = '';       // ledger signature — the list is rebuilt only when a row changes
var batchNowName = '';       // the ringed row — the list scrolls to it only when it changes
var batchNowT = null;        // the ringed row's clock element
var batchStepSince = 0;      // when the current server step (starting / waiting / stopping) began
var batchStep = '';
var batchArm = null;         // Cancel's two-tap confirm: armed until this timer or any other tap
var batchWasRunning = false;
function batchName(stage, name) {   // transcript rows are <base>-diarizer-response.json; the base is the meeting
  return stage === 'analyze' ? String(name).replace(/-diarizer-response\.json$/i, '') : name;
}
function batchWord(it, isNext) {   // the outcome as text, naming the operation
  var a = it.stage === 'analyze';
  if (it.status === 'done') return { w: a ? 'Analyzed' : 'Transcribed', c: 'ok' };
  if (it.status === 'failed') return { w: a ? 'Analyze failed' : 'Transcribe failed', c: 'err' };
  if (it.status === 'running') return { w: a ? 'Analyzing' : 'Transcribing', c: 'now' };
  if (it.status === 'notStarted') return { w: 'Not started', c: '' };
  return isNext ? { w: 'Next', c: 'next' } : { w: 'Queued', c: '' };
}
function batchCounts(st) {
  var t = st.counts.transcribe, a = st.counts.analyze;
  var warnings = (st.items || []).filter(function (it) { return it.status === 'done' && it.note; }).length;
  return { done: t.done + a.done, failed: t.failed + a.failed, notStarted: t.notStarted + a.notStarted, warnings: warnings };
}
function batchSummary(st) {   // the final strip, per stage: "Transcribed 3 of 4 · Analyzed 2 of 3 · 2 failed · …"
  var t = st.counts.transcribe, a = st.counts.analyze, c = batchCounts(st), parts = [];
  if (t.total) parts.push('<b>Transcribed ' + t.done + ' of ' + t.total + '</b>');
  if (a.total) parts.push('<b>Analyzed ' + a.done + ' of ' + a.total + '</b>');
  if (!parts.length) parts.push('Nothing to process');
  if (c.failed) parts.push('<span class="err">' + c.failed + ' failed</span>');
  if (c.notStarted || st.phase === 'cancelled') parts.push(c.notStarted + ' not started');
  if (c.warnings) parts.push('<span class="err">' + c.warnings + ' with warnings</span>');
  return parts.join(' &nbsp;·&nbsp; ');
}
function batchProgressHtml(st) {   // the running strip: stage, processed count, failures, what follows
  var analyzing = st.phase === 'analyzing' || (st.phase === 'cancelling' && !!(st.now && st.now.stage === 'analyze'));
  var c = analyzing ? st.counts.analyze : st.counts.transcribe;
  var verb = analyzing ? 'Analyzing' : 'Transcribing';
  var n = st.now, head = '';
  // A job started by hand from a screen holds the queue: say so, with its clock, without counting it.
  if (n && n.name && !n.mine) head = 'Waiting for ' + escHtml(batchName(n.stage, n.name)) + ', started by hand';
  else if (n && !n.name && n.step) head = n.step === 'starting server' ? 'Starting the transcription server' : n.step === 'waiting for server' ? 'Waiting for the transcription server' : 'Stopping the transcription server';
  var parts = [];
  if (head) parts.push(head);
  else if (!c.total) parts.push(analyzing ? 'Nothing to analyze' : 'Nothing to transcribe');
  else parts.push(verb + ' &nbsp;<b>' + (c.done + c.failed) + ' of ' + c.total + '</b>&nbsp; processed');
  if (head && c.total) parts.push('<b>' + (c.done + c.failed) + ' of ' + c.total + '</b>&nbsp; processed');
  if (c.failed) parts.push('<span class="err">' + c.failed + ' failed</span>');
  if (!analyzing) parts.push('then analyzing');
  return parts.join(' &nbsp;·&nbsp; ');
}
function batchText(st) {   // topbar, left of the Batch button
  if (!st.counts) return '';
  if (st.phase === 'cancelling') return 'Cancelling…';
  if (st.running) {
    var analyzing = st.phase === 'analyzing', c = analyzing ? st.counts.analyze : st.counts.transcribe;
    return c.total ? (analyzing ? 'Analyzing ' : 'Transcribing ') + (c.done + c.failed) + ' of ' + c.total + '…' : 'Batching…';
  }
  if (st.phase === 'error') return (st.halted ? 'Batch stopped: ' : 'Batch failed: ') + (st.error || 'unknown error');
  if (st.phase === 'done' || st.phase === 'cancelled') {
    var k = batchCounts(st), s = st.phase === 'done' ? 'Batch completed' : 'Batch cancelled';
    return k.failed ? s + ' (' + k.failed + ' failed)' : s;
  }
  return '';
}
function batchDisarm() {
  clearTimeout(batchArm); batchArm = null;
  var b = $('batchCancel'); b.textContent = 'Cancel batch'; b.classList.remove('confirm');
}
function renderBatchPage(st) {
  var running = !!st.running;
  $('batchTitle').textContent = st.phase === 'cancelling' ? 'Cancelling batch' : st.phase === 'done' ? 'Batch completed'
    : st.phase === 'cancelled' ? 'Batch cancelled' : st.phase === 'error' ? (st.halted ? 'Batch stopped' : 'Batch failed') : 'Batch';
  var cancelBtn = $('batchCancel');
  var cancellable = st.phase === 'transcribing' || st.phase === 'analyzing';
  cancelBtn.style.display = cancellable ? '' : 'none';
  if (!cancellable) batchDisarm();

  // The strip is the live region: its words change at item and phase boundaries only; the
  // server-step clock sits in an aria-hidden span and never re-announces.
  var html, stripErr = false, n = st.now;
  if (st.phase === 'cancelling') html = 'Cancelling &nbsp;·&nbsp; finishing ' + (n && n.name ? escHtml(batchName(n.stage, n.name)) : 'the current file');
  else if (running) html = batchProgressHtml(st);
  else if (st.phase === 'error') { html = escHtml(st.error || 'unknown error'); stripErr = true; }
  else if (st.phase === 'done' || st.phase === 'cancelled') { html = batchSummary(st); stripErr = !!(batchCounts(st).failed || batchCounts(st).warnings); }
  else html = 'No batch has run yet';
  if (html !== batchStripText) { batchStripText = html; $('batchStripText').innerHTML = html; }
  $('batchStrip').classList.toggle('err', stripErr);
  var foreign = running && n && n.name && !n.mine;
  var step = running && n && !n.name && n.step ? n.step : (foreign ? 'foreign:' + n.name : '');
  if (step !== batchStep) { batchStep = step; batchStepSince = Date.now(); }
  $('batchStripT').textContent = !step ? '' : fmtDur(Date.now() - (foreign && n.startedAt ? n.startedAt : batchStepSince));

  // The list: every file in scheduled order with its outcome as text; errors in full. Rebuilt
  // only when a row changes; the ringed row's clock ticks in place.
  var items = st.items || [];
  var nextName = '';
  for (var i = 0; i < items.length; i++) if (items[i].status === 'queued') { nextName = items[i].stage + ':' + items[i].name; break; }
  var sig = st.phase + '|' + nextName + '|' + items.map(function (it) { return it.name + ':' + it.stage + ':' + it.status + ':' + (it.error || '') + ':' + (it.note || ''); }).join('|');
  var list = $('batchList');
  if (sig !== batchListSig) {
    batchListSig = sig;
    var keepTop = list.scrollTop;
    list.innerHTML = ''; batchNowT = null;
    var nowRow = null, nowName = '';
    if (!items.length) {
      var empty = document.createElement('div'); empty.className = 'ovEmpty';
      empty.textContent = running ? 'Nothing to do' : (st.phase === 'idle' ? 'Tap Batch on the meetings page to start one' : 'Nothing was processed');
      list.appendChild(empty);
    }
    items.forEach(function (it) {
      var w = batchWord(it, it.stage + ':' + it.name === nextName);
      var row = document.createElement('div'); row.className = 'fileRow bItem' + (it.status === 'running' ? ' now' : '');
      var st_ = document.createElement('div'); st_.className = 'st' + (w.c ? ' ' + w.c : ''); st_.textContent = w.w;
      var meta = document.createElement('div'); meta.className = 'meta';
      var nm = document.createElement('div'); nm.className = 'fname'; nm.textContent = batchName(it.stage, it.name);
      meta.appendChild(nm);
      if (it.error || it.note) {
        var sub = document.createElement('div'); sub.className = 'fsub' + (it.error ? ' err' : ''); sub.textContent = it.error || it.note;
        meta.appendChild(sub);
      }
      row.appendChild(st_); row.appendChild(meta);
      if (it.status === 'running') {
        var t = document.createElement('div'); t.className = 't'; t.setAttribute('aria-hidden', 'true');
        row.appendChild(t); batchNowT = t; nowRow = row; nowName = it.stage + ':' + it.name;
      }
      list.appendChild(row);
    });
    // Keep the ringed row in view when it changes — never on a tick, so a scroll to read an error holds.
    if (nowRow && nowName !== batchNowName) nowRow.scrollIntoView({ block: 'center' });
    else if (nowRow) list.scrollTop = keepTop;   // same file still working: a scroll to read an error holds
    else list.scrollTop = 0;                     // no ringed row (server step, summary): read from the top
    batchNowName = nowName;
    // ▲/▼ only when there is something to scroll
    $('batchRail').style.display = list.scrollHeight > list.clientHeight + 1 ? '' : 'none';
  }
  if (batchNowT) batchNowT.textContent = n && n.name && n.startedAt ? fmtDur(Date.now() - n.startedAt) : '';
  // A batch that just ended while the page is open: the summary is the new context — focus its heading.
  if (batchWasRunning && !running && $('batchOverlay').classList.contains('show')) $('batchTitle').focus();
  batchWasRunning = running;
}
function renderBatch(st) {
  batchState = st;
  var el = $('batchStatus');
  el.textContent = batchText(st);
  el.classList.toggle('err', st.phase === 'error' || !!(st.transcribeErrors || st.analyzeErrors));
  $('btnBatch').disabled = batchStarting;
  if ($('batchOverlay').classList.contains('show')) renderBatchPage(st);
}
function openBatchPage() {
  $('batchOverlay').classList.add('show');
  if (batchState) renderBatchPage(batchState);
  $('wrap').inert = true;   // the console under the opaque page is out of reach for keyboard and knob
  $('batchTitle').focus();
}
function batchPoll() {
  if (batchStarting) return;   // a poll straddling a request would read the pre-request state
  var rev = ++batchRev;
  fetchJson('/meeting-batch/state').then(function (st) { if (st && st.ok && !batchStarting && rev === batchRev) renderBatch(st); }).catch(function () {});
}
$('btnBatch').onclick = function () {
  if (batchStarting) return;
  if (batchState && batchState.running) { openBatchPage(); return; }   // a running batch: just show it
  batchStarting = true; batchRev++; $('btnBatch').disabled = true;
  fetchJson('/meeting-batch/start')
    .then(function (st) {
      batchStarting = false;
      if (!st || st.ok === false) { statusShow((st && st.error) || 'Could not start batch', true); $('btnBatch').disabled = false; return; }
      renderBatch(st);
      openBatchPage();
      if (st.empty) statusShow('Nothing to batch: no recordings or transcripts are waiting');
    })
    .catch(function () { batchStarting = false; statusShow('Could not start batch', true); $('btnBatch').disabled = false; });
};
$('batchBack').onclick = function () {
  batchDisarm();
  $('batchOverlay').classList.remove('show');
  $('wrap').inert = false;
  $('btnBatch').focus();
};
$('batchCancel').onclick = function () {
  var b = $('batchCancel');
  if (!batchArm) {   // first tap arms; the name changes so the second tap is not colour alone
    b.textContent = 'Really cancel?'; b.classList.add('confirm');
    batchArm = setTimeout(batchDisarm, 6000);
    return;
  }
  batchDisarm();
  b.disabled = true;
  batchStarting = true; batchRev++;   // same guard as start: a poll answered before the cancel must not overwrite its result
  fetchJson('/meeting-batch/cancel')
    .then(function (st) { batchStarting = false; b.disabled = false; if (st && st.ok) renderBatch(st); else statusShow((st && st.error) || 'Could not cancel', true); })
    .catch(function () { batchStarting = false; b.disabled = false; statusShow('Could not cancel', true); });
};
['batchUp', 'batchDown'].forEach(function (id) { $(id).addEventListener('pointerdown', batchDisarm); });
wireScrollButtons('batchList', 'batchUp', 'batchDown');
batchPoll();   // a batch started before this page loaded keeps showing its state

// ---- Analysis: run the AI over a transcript, read the result ----
var anTimer = null, anState = null, anLastFinished = 0;
var anRows = {};            // json name -> { btnA, btnV, sub, analyzed }
function anPoll() {
  fetchJson('/meeting-analyze/state').then(function (st) {
    anState = st;
    var n = $('anNote');
    var queued = (st.queue || []).length;
    if (st.running) { n.textContent = 'Analyzing ' + splitRel(st.name).base + ' — ' + fmtDur(Date.now() - st.startedAt) + qSuffix(queued); n.classList.remove('err'); }
    else if (st.error) { n.textContent = splitRel(st.error.name).base + ': ' + st.error.error; n.classList.add('err'); }
    else if (st.joplin && st.joplin.ok === false) { n.textContent = 'Joplin note failed (' + st.joplin.name + '): ' + st.joplin.error; n.classList.add('err'); }
    else if (st.obsidian && st.obsidian.ok === false) { n.textContent = 'Obsidian export (' + st.obsidian.name + '): ' + st.obsidian.error; n.classList.add('err'); }
    else if (st.lastDone && st.lastDone.warning) { n.textContent = splitRel(st.lastDone.name).base + ': ' + st.lastDone.warning; n.classList.remove('err'); }   // e.g. committed, with leftovers in transcribed
    else { n.textContent = ''; n.classList.remove('err'); }
    var fin = (st.lastDone && st.lastDone.finishedAt) || 0;
    var finErr = (st.error && st.error.finishedAt) || 0;
    var latest = Math.max(fin, finErr);
    if (latest && latest !== anLastFinished) { anLastFinished = latest; renderAnList(); }
    else updateAnButtons();
  }).catch(function () {});
}
var anSel = selMake('anSelAll', 'anGoSel');
// The screen has two roots. 'transcribed': the flat waiting room — every row is a transcript to
// analyze (or delete). 'processed': the Completed Meetings folder browser — finished files to view,
// re-analyze, review a proposal, apply. The Completed button toggles; every request names the root.
var anKind = 'transcribed';
var anDir = '';   // current subfolder inside completed ('' = root); one folder shown at a time
var anAutoDate = false;   // set on entering Completed: auto-descend to the current YYYY/MM when Organize-by-date is on
// Every listing is a generation: a response for an older root or folder is dropped, and each row's
// handlers close over the root they were listed from, so a toggle mid-fetch can never send a
// waiting transcript's Analyze with the other root's kind.
var anGen = 0;
function anSetKind(kind) {
  anGen++;
  $('anList').innerHTML = ''; anRows = {}; selReset(anSel, []); selSync(anSel);   // the old root's rows go at once
  anKind = kind === 'processed' ? 'processed' : 'transcribed';
  var completed = anKind === 'processed';
  $('anTitle').textContent = completed ? 'Completed' : 'Analysis';
  $('anCompleted').textContent = completed ? 'Transcribed' : 'Completed';
  $('anSelAll').style.display = completed ? 'none' : '';
  $('anGoSel').style.display = completed ? 'none' : '';
  $('anNav').style.display = completed ? '' : 'none';
  anDir = ''; anAutoDate = completed;
  $('anList').scrollTop = 0;
}
function renderAnList() {
  var kind = anKind, dir = anDir, gen = ++anGen;
  var url = '/meeting-files?kind=' + kind + (kind === 'processed' && dir ? '&dir=' + encodeURIComponent(dir) : '');
  var keepScroll = $('anList').scrollTop;   // batch completions re-render every so often — don't yank the view
  fetchJson(url).then(function (r) {
    if (gen !== anGen) return;   // a newer listing (other root or folder) superseded this one
    if (r && r.ok === false) {   // e.g. the three folders overlap: say so, list nothing
      var n0 = $('anNote'); n0.textContent = r.error || 'Could not list'; n0.classList.add('err');
      $('anList').innerHTML = '<div class="ovEmpty">' + escHtml(r.error || 'Could not list') + '</div>'; anRows = {}; selReset(anSel, []); selSync(anSel);
      return;
    }
    if (kind === 'processed' && anAutoDate && !dir && r && r.byDate) {   // Organize-by-date: open straight into <completed>/YYYY/MM
      anAutoDate = false;
      var now = new Date();
      anDir = now.getFullYear() + '/' + ('0' + (now.getMonth() + 1)).slice(-2);
      renderAnList();
      return;
    }
    anAutoDate = false;
    var el = $('anList'); el.innerHTML = ''; anRows = {};
    $('anPath').textContent = 'Completed' + (dir ? ' › ' + dir.split('/').join(' › ') : '');
    $('anUp').disabled = !dir;
    var files = (r && r.files) || [];
    var dirs = (r && r.dirs) || [];
    // Only diarizer transcripts are analyzable — plain .json files here are Outlook meeting-info
    // sidecars (or other data), not transcripts. The server computes `analyzed` (it knows the
    // details-folder layout where the .md sits one level up).
    // New library contract: `meetings` = logical meeting rows ({ name: the .md, base, jsonName,
    // analyzed, status, legacy, readOnly, warning }); older servers only send `files`, so fall
    // back to filtering transcripts. Either way each row is keyed by the name Analyze/View take.
    var jsons = Array.isArray(r && r.meetings)
      ? r.meetings.map(function (m) { return { name: m.name, base: m.base, jsonName: m.jsonName || null, analyzed: !!m.analyzed, status: m.status || '', readOnly: !!m.readOnly, proposed: !!m.proposed, warning: m.warning || '', durationMs: m.durationMs || 0 }; })
      : files.filter(function (f) { return /-diarizer-response\.json$/i.test(f.name); });
    selReset(anSel, jsons.map(function (f) { return f.name; }));
    // details/ holds sources and revisions, _system/ holds migration and export bookkeeping — neither is a place with meetings
    dirs = dirs.filter(function (d) { return !/^(details|_system)$/i.test(d) && d[0] !== '.' && d[0] !== '_'; });
    if (kind !== 'processed') dirs = [];   // the waiting room is flat: no folders, ever
    dirs.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'fileRow folder press foc';
      b.innerHTML = '<div class="meta"><div class="fname">&#128193; ' + escHtml(d) + '</div></div><span class="chev">&rsaquo;</span>';
      b.onclick = function () { anDir = dir ? dir + '/' + d : d; $('anList').scrollTop = 0; renderAnList(); };
      el.appendChild(b);
    });
    if (!jsons.length) {
      if (!dirs.length) el.innerHTML = '<div class="ovEmpty">' + (kind === 'processed'
        ? 'No completed meetings here' + (dir ? '.' : ' yet.')
        : 'Nothing waiting for analysis — transcribe a recording first.') + '</div>';
      selSync(anSel); return;
    }
    jsons.forEach(function (f) {
      // Raw transcripts are <base>-diarizer-response.json (legacy plain .json accepted);
      // the meeting file is <base>.md (legacy <base>-analysis.md), so match/display on the stripped base.
      var base = f.base || f.name.replace(/(-diarizer-response)?\.json$/i, '').replace(/(-analysis)?\.md$/i, '');
      var rel = splitRel(base);
      var analyzed = !!f.analyzed;
      var waiting = kind !== 'processed';
      var subText = f.warning ? f.warning
        : f.proposed ? 'New analysis awaiting your review'
        : waiting || f.status === 'processing' ? 'Transcribed, not analyzed' + (f.durationMs ? ' · ' + fmtDur(f.durationMs) : '')
        : analyzed ? 'Analyzed' : 'Not analyzed';
      var row = document.createElement('div'); row.className = 'fileRow';
      if (waiting) row.appendChild(selBox(anSel, f.name));
      var meta = document.createElement('div'); meta.className = 'meta';
      meta.innerHTML = '<div class="fname">' + escHtml(rel.base) + '</div><div class="fsub' + (f.warning ? ' err' : '') + '">' + escHtml(subText) + '</div>';
      var btnA = rowBtn(analyzed ? 'Re-analyze' : 'Analyze', analyzed ? '' : 'primary');
      // view-only: a file the app must not rewrite (unreadable frontmatter, protected), or a row the
      // library found no transcript for (nothing to analyze)
      var noSource = f.jsonName === null && f.base !== undefined;
      btnA.disabled = !!f.readOnly || noSource;
      btnA.onclick = function () {
        btnA.disabled = true;
        fetchJson('/meeting-analyze/start?kind=' + kind + '&name=' + encodeURIComponent(f.name))
          .then(function (r2) {
            if (r2 && r2.ok === false) {
              var s2 = meta.querySelector('.fsub'); s2.textContent = r2.error || 'Could not start'; s2.classList.add('err');
              btnA.disabled = false;
            }
            anPoll();
          })
          .catch(function () { btnA.disabled = false; });
      };
      row.appendChild(meta); row.appendChild(btnA);
      var btnV = null;
      if (waiting) {
        // A bad transcription can be removed here (exact set: transcript, WAV, sidecars, captions,
        // screenshots). Two-tap confirm like Unprocessed; refused while the row is analyzing or queued.
        var btnD = rowBtn('Delete', 'danger');
        var confirmT = null;
        btnD.onclick = function () {
          if (!btnD.classList.contains('confirm')) {
            btnD.classList.add('confirm'); btnD.textContent = 'Confirm?';
            confirmT = setTimeout(function () { btnD.classList.remove('confirm'); btnD.textContent = 'Delete'; }, 3000);
            return;
          }
          clearTimeout(confirmT);
          btnD.disabled = true;
          fetchJson('/meeting-file-delete?kind=transcribed&name=' + encodeURIComponent(f.jsonName || f.name))
            .then(function (r2) {
              if (r2 && r2.ok) { renderAnList(); return; }
              var s2 = meta.querySelector('.fsub'); s2.textContent = (r2 && r2.error) || 'Delete failed'; s2.classList.add('err');
              btnD.disabled = false; btnD.classList.remove('confirm'); btnD.textContent = 'Delete';
            })
            .catch(function () { btnD.disabled = false; btnD.classList.remove('confirm'); btnD.textContent = 'Delete'; });
        };
        row.appendChild(btnD);
      } else {
        btnV = rowBtn('View');
        btnV.disabled = !analyzed;
        btnV.onclick = function () { openAnalysisView(f.name, rel.base, false, kind); };
        row.appendChild(btnV);
        if (f.proposed) {   // a re-analysis kept aside because the notes had been edited by hand: review it, then apply from the viewer
          var btnP = rowBtn('Review new', 'primary');
          btnP.onclick = function () { openAnalysisView(f.name, rel.base, true, kind); };
          row.appendChild(btnP);
        }
      }
      anRows[f.name] = { btnA: btnA, btnV: btnV, analyzed: analyzed, jsonName: f.jsonName || null, readOnly: !!f.readOnly || noSource, kind: kind };
      el.appendChild(row);
    });
    updateAnButtons();
    selSync(anSel);
    el.scrollTop = keepScroll;
  }).catch(function () {});
}
wireEnqueue('anGoSel', anSel, '/meeting-analyze/start?kind=transcribed&name=', anPoll);   // Select all exists only in the waiting room
function updateAnButtons() {
  if (!anState) return;
  Object.keys(anRows).forEach(function (name) {
    var r = anRows[name];
    // The analyzer reports the TRANSCRIPT it is working on, and the ROOT it came from (the same
    // name may exist in both); a completed row is keyed by its meeting .md, so match on the row's
    // transcript name when the library gave us one, within this screen's root only.
    var key = r.jsonName || name;
    var active = anState.running && (anState.kind || 'processed') === r.kind && (anState.name === key || anState.name === name);
    var queued = (anState.queue || []).some(function (q) {
      var qn = (q && typeof q === 'object') ? q.name : q, qk = (q && typeof q === 'object' && q.kind) || 'processed';
      return qk === r.kind && (qn === key || qn === name);
    });
    if (active) { r.btnA.textContent = 'Analyzing…'; r.btnA.disabled = true; }
    else if (queued) { r.btnA.textContent = 'Queued'; r.btnA.disabled = true; }
    else { r.btnA.textContent = r.analyzed ? 'Re-analyze' : 'Analyze'; r.btnA.disabled = !!r.readOnly; }
  });
}
// Minimal markdown treatment (escape-first, matching the voice panel's renderContent discipline):
// code fences become <pre>, #-headings and **bold** become <b>. Everything else is plain text.
function renderMarkdown(src) {
  var parts = String(src || '').split('```');
  var out = '';
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 1) { out += '<pre>' + escHtml(parts[i].replace(/^[a-zA-Z0-9]*\n/, '')) + '</pre>'; continue; }
    out += escHtml(parts[i]).split('\n').map(function (l) {
      if (/^#{1,6}\s/.test(l)) return '<b>' + l.replace(/^#{1,6}\s+/, '') + '</b>';
      return l.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    }).join('\n');
  }
  return out;
}
// Meeting files start with a YAML frontmatter block (machine-readable facts for other tools); the
// panel shows the human sections only. Only a leading block delimited by '---' lines is removed.
function stripFrontmatter(md) {
  var m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(String(md || ''));
  return m && m.index === 0 ? String(md).slice(m[0].length) : String(md || '');
}
var anViewProposalFor = null;   // the row name whose PROPOSED analysis is on screen (Apply shows only then)
function openAnalysisView(jsonName, title, proposed, kind) {
  fetchJson('/meeting-analysis?kind=' + (kind || anKind) + '&name=' + encodeURIComponent(jsonName) + (proposed ? '&proposed=1' : '')).then(function (r) {
    if (!r || !r.ok) { var n = $('anNote'); n.textContent = (r && r.error) || 'Could not load analysis'; n.classList.add('err'); return; }
    anViewProposalFor = proposed ? jsonName : null;
    $('anViewTitle').textContent = title + (proposed ? ' — new analysis (review)' : '');
    $('anViewNote').textContent = proposed ? 'Your edited notes are kept until you apply this version' : '';
    $('anViewApply').style.display = proposed ? '' : 'none';
    $('anViewApply').disabled = false;
    $('anView').innerHTML = renderMarkdown(stripFrontmatter(r.markdown));
    $('anView').scrollTop = 0;
    $('anViewOverlay').classList.add('show');
  }).catch(function () {});
}
$('anViewApply').onclick = function () {
  if (!anViewProposalFor) return;
  $('anViewApply').disabled = true;
  fetchJson('/meeting-analyze/apply-proposed?name=' + encodeURIComponent(anViewProposalFor))
    .then(function (r) {
      if (!r || r.ok === false) { $('anViewNote').textContent = (r && r.error) || 'Could not apply'; $('anViewApply').disabled = false; return; }
      $('anViewOverlay').classList.remove('show');
      anViewProposalFor = null;
      renderAnList();
    })
    .catch(function () { $('anViewApply').disabled = false; });
};
$('anUp').onclick = function () {
  if (!anDir) return;
  var parts = anDir.split('/'); parts.pop();
  anDir = parts.join('/');
  $('anList').scrollTop = 0;
  renderAnList();
};
$('btnAnalysis').onclick = function () {
  $('anOverlay').classList.add('show');
  anSetKind('transcribed');   // always opens on the waiting room; Completed is one tap away
  renderAnList(); anPoll();
  if (!anTimer) anTimer = setInterval(anPoll, 1000);
};
$('anCompleted').onclick = function () {
  anSetKind(anKind === 'processed' ? 'transcribed' : 'processed');   // entering Completed lands on the current month when Organize-by-date is on
  renderAnList(); anPoll();
};
$('anClose').onclick = function () {
  $('anOverlay').classList.remove('show');
  clearInterval(anTimer); anTimer = null;
};
$('anViewBack').onclick = function () { $('anViewOverlay').classList.remove('show'); };

wireScrollButtons('libList', 'libUp', 'libDown');
wireScrollButtons('anList', 'anScrollUp', 'anScrollDown');
wireScrollButtons('anView', 'anViewUp', 'anViewDown');
wireScrollButtons('winList', 'winUp', 'winDown');

renderDeck();
statusReady();
syncMic();
$('volPct').innerHTML = '<span class="ic">' + ICON.speaker + '</span>';   // boot state: volume not yet read
pollState();
setInterval(function () { tick(); pollState(); batchPoll(); }, 1000);
