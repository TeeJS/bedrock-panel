'use strict';

// Macro Deck Surface — the panel acts as a Macro Deck *client*. It connects to a
// Macro Deck host over the client WebSocket (ws://<host>:8191), renders the host's
// current button page, and sends taps / long-presses / releases back.
//
// Protocol verified live against a Macro Deck host (Kestrel + Angular build):
//   - Method values are STRING enum names.
//   - CONNECTED handshake; the host stays silent until the user ACCEPTS this device.
//   - GET_CONFIG carries the grid (Rows/Columns/spacing/radius) and gates buttons.
//   - GET_BUTTONS -> Buttons[{Position_X, Position_Y, IconBase64, LabelBase64,
//     BackgroundColorHex}]; either image may be empty; images are raw base64.
//   - Press: {Method, Message:"<row>_<col>"}.

(function () {
  var q = new URLSearchParams(location.search);

  // Theme (host passes _dark=0 for light, _accent=#rrggbb).
  document.body.classList.toggle('light', q.get('_dark') === '0');
  var accent = q.get('_accent') || '';
  if (/^#[0-9a-fA-F]{6}$/.test(accent)) {
    document.documentElement.style.setProperty('--accent', accent);
  }

  var HOST_RAW = (q.get('host') || '127.0.0.1:8191').trim();
  var CLIENT_ID = q.get('clientId') || 'Bedrock Panel';
  var LONG_MS = parseInt(q.get('longPressMs'), 10);
  if (!(LONG_MS > 0)) LONG_MS = 1000;

  var deck = document.getElementById('deck');
  var overlay = document.getElementById('overlay');
  var ovTitle = document.getElementById('ovTitle');
  var ovMsg = document.getElementById('ovMsg');

  var ws = null;
  var cfg = null;              // last GET_CONFIG payload (grid + display config)
  var initialConfig = false;   // host gate: ignore buttons until first GET_CONFIG
  var tiles = {};              // "row_col" -> { el, icon, label }
  var wantOpen = true;
  var backoff = 1000;
  var reconnectTimer = null;

  // ---- helpers ------------------------------------------------------------

  function wsUrl(hostText) {
    var t = String(hostText || '').trim();
    t = t.replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!t) t = '127.0.0.1:8191';
    if (!/:\d+$/.test(t)) t += ':8191';   // default Macro Deck port
    return 'ws://' + t;
  }

  // The host's client hardcodes a data:image/jpg URI, but payloads are raw base64
  // of whatever format the host rendered (PNG observed). Sniff the signature.
  function mimeFor(b64) {
    if (!b64) return 'image/png';
    if (b64.charAt(0) === '/') return 'image/jpeg';       // /9j/...  JPEG
    if (b64.slice(0, 5) === 'iVBOR') return 'image/png';  // PNG
    if (b64.slice(0, 6) === 'R0lGOD') return 'image/gif'; // GIF
    return 'image/png';
  }
  function dataUri(b64) { return b64 ? 'data:' + mimeFor(b64) + ';base64,' + b64 : ''; }

  function keyId(x, y) { return y + '_' + x; }

  function showOverlay(state, title, msg) {
    overlay.className = 'overlay state-' + state;
    ovTitle.textContent = title || '';
    ovMsg.textContent = msg || '';
  }
  function hideOverlay() { overlay.className = 'overlay hidden'; }

  // ---- layout & rendering -------------------------------------------------

  function layout() {
    if (!cfg) return;
    var rows = cfg.Rows > 0 ? cfg.Rows : 3;
    var cols = cfg.Columns > 0 ? cfg.Columns : 5;
    var gap = (typeof cfg.ButtonSpacing === 'number') ? cfg.ButtonSpacing : 10;
    var pad = 24;
    var W = window.innerWidth, H = window.innerHeight;
    var maxH = (H - pad * 2 - gap * (rows - 1)) / rows;
    var maxW = (W - pad * 2 - gap * (cols - 1)) / cols;
    var size = Math.max(48, Math.floor(Math.min(maxH, maxW)));  // square keys, ≥48px

    deck.style.gridTemplateColumns = 'repeat(' + cols + ', ' + size + 'px)';
    deck.style.gridTemplateRows = 'repeat(' + rows + ', ' + size + 'px)';
    deck.style.gap = gap + 'px';

    var radius = (typeof cfg.ButtonRadius === 'number')
      ? Math.min(cfg.ButtonRadius, size / 2)
      : Math.round(size * 0.12);
    document.documentElement.style.setProperty('--tile-radius', radius + 'px');
  }

  function rebuildGrid() {
    deck.textContent = '';
    tiles = {};
    layout();
  }

  function ensureTile(x, y) {
    var id = keyId(x, y);
    if (tiles[id]) return tiles[id];
    var el = document.createElement('div');
    el.className = 'tile';
    el.style.gridColumn = (x + 1);
    el.style.gridRow = (y + 1);
    var icon = document.createElement('img'); icon.className = 'ic'; icon.alt = '';
    var label = document.createElement('img'); label.className = 'lb'; label.alt = '';
    el.appendChild(icon);
    el.appendChild(label);
    wirePress(el, id);
    deck.appendChild(el);
    var t = { el: el, icon: icon, label: label };
    tiles[id] = t;
    return t;
  }

  function setImg(img, b64) {
    if (b64) { img.src = dataUri(b64); img.style.display = 'block'; }
    else { img.removeAttribute('src'); img.style.display = 'none'; }
  }

  function applyButton(b) {
    if (!b) return;
    var t = ensureTile(b.Position_X, b.Position_Y);
    t.el.style.background = (cfg && cfg.ButtonBackground === false)
      ? 'transparent'
      : (b.BackgroundColorHex || '#000');
    setImg(t.icon, b.IconBase64);
    setImg(t.label, b.LabelBase64);
  }

  function renderButtons(list) {
    rebuildGrid();
    if (Array.isArray(list)) list.forEach(applyButton);
  }

  // ---- input --------------------------------------------------------------

  function wirePress(el, id) {
    var timer = null, longFired = false, active = false;

    function down(ev) {
      if (active) return;
      active = true; longFired = false;
      el.classList.add('pressed');
      send({ Method: 'BUTTON_PRESS', Message: id });
      timer = setTimeout(function () {
        longFired = true;
        send({ Method: 'BUTTON_LONG_PRESS', Message: id });
      }, LONG_MS);
      if (ev.pointerId != null && el.setPointerCapture) {
        try { el.setPointerCapture(ev.pointerId); } catch (e) {}
      }
    }
    function up() {
      if (!active) return;
      active = false;
      el.classList.remove('pressed');
      if (timer) { clearTimeout(timer); timer = null; }
      send({ Method: longFired ? 'BUTTON_LONG_PRESS_RELEASE' : 'BUTTON_RELEASE', Message: id });
    }

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  // ---- protocol -----------------------------------------------------------

  function handle(msg) {
    switch (msg.Method) {
      case 'GET_CONFIG':
        cfg = msg;
        initialConfig = true;
        rebuildGrid();
        hideOverlay();
        send({ Method: 'GET_BUTTONS' });
        break;
      case 'GET_BUTTONS':
        if (!initialConfig) return;
        renderButtons(msg.Buttons);
        break;
      case 'UPDATE_BUTTON':
        if (!initialConfig) return;
        if (msg.Buttons && msg.Buttons[0]) applyButton(msg.Buttons[0]);
        break;
      case 'UPDATE_LABEL':
        if (!initialConfig) return;
        if (msg.Buttons && msg.Buttons[0]) {
          var b = msg.Buttons[0];
          var t = tiles[keyId(b.Position_X, b.Position_Y)];
          if (t) setImg(t.label, b.LabelBase64);
        }
        break;
      default:
        break; // ICON_BASE64 / GET_ICONS / plugin listings — not needed by a surface
    }
  }

  // ---- connection lifecycle ----------------------------------------------

  function connect() {
    wantOpen = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    initialConfig = false;
    cfg = null;

    var url = wsUrl(HOST_RAW);
    showOverlay('connecting', 'Connecting…', url);
    try { ws = new WebSocket(url); }
    catch (e) { scheduleReconnect('Bad host address: ' + HOST_RAW); return; }

    ws.onopen = function () {
      backoff = 1000;
      send({ Method: 'CONNECTED', 'Client-Id': CLIENT_ID, 'API': '20', 'Device-Type': 'Web' });
      showOverlay('accept',
        'Accept “' + CLIENT_ID + '” on Macro Deck',
        'Open Macro Deck on ' + HOST_RAW + ' and accept this device to start.');
    };
    ws.onmessage = function (ev) {
      var m = null;
      try { m = JSON.parse(ev.data); } catch (e) {}
      if (m && m.Method) handle(m);
    };
    ws.onerror = function () { /* onclose drives reconnect */ };
    ws.onclose = function () { if (wantOpen) scheduleReconnect(); };
  }

  function scheduleReconnect(reason) {
    showOverlay('reconnect', 'Reconnecting…', reason || ('Lost connection to ' + HOST_RAW));
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, backoff);
    backoff = Math.min(Math.round(backoff * 1.7), 15000);
  }

  window.addEventListener('resize', function () { if (cfg) layout(); });

  connect();
})();
