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
  var ovHost = document.getElementById('ovHost');
  var ovRetry = document.getElementById('ovRetry');
  var live = document.getElementById('live');

  var ws = null;
  var cfg = null;              // last GET_CONFIG payload (grid + display config)
  var initialConfig = false;   // host gate: ignore buttons until first GET_CONFIG
  var dispatchReady = false;   // no action dispatch until the first GET_BUTTONS
  var tiles = {};              // "row_col" -> { el, icon, label }
  var wantOpen = true;
  var backoff = 1000;
  var reconnectTimer = null;
  var reconnectAdviceTimer = null;
  var loadingTimer = null;     // bounds the wait for GET_BUTTONS after GET_CONFIG
  var outageStart = 0;         // when the current outage began (persists across retries)

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

  function announce(text) { if (live) live.textContent = text || ''; }

  // Single source of truth for readiness. When not 'ready' the deck is made inert
  // (non-focusable, hidden from AT) so Tab and screen readers never reach keys
  // under the overlay.
  function setState(state) {
    if (reconnectAdviceTimer) { clearTimeout(reconnectAdviceTimer); reconnectAdviceTimer = null; }
    var ready = (state === 'ready');
    deck.inert = !ready;
    if (ready) {
      outageStart = 0;   // usable recovery ends the outage
      deck.removeAttribute('aria-hidden');
      overlay.className = 'overlay hidden';
      announce('Ready');
      return;
    }
    deck.setAttribute('aria-hidden', 'true');

    overlay.className = 'overlay state-' + state;
    ovRetry.hidden = true;
    ovHost.textContent = '';
    ovMsg.textContent = '';
    switch (state) {
      case 'connecting':
        ovTitle.textContent = 'Connecting to Macro Deck';
        ovHost.textContent = HOST_RAW;
        break;
      case 'accept':
        ovTitle.textContent = 'Accept “' + CLIENT_ID + '” in Macro Deck';
        ovMsg.textContent = 'Open Macro Deck on the host computer and accept this device to start.';
        ovHost.textContent = HOST_RAW;
        break;
      case 'loading':
        ovTitle.textContent = 'Loading buttons';
        break;
      case 'empty':
        outageStart = 0;   // a valid empty page is successful recovery, like ready
        ovTitle.textContent = 'No buttons on this page';
        ovMsg.textContent = 'Add buttons to this page in Macro Deck.';
        break;
      case 'loadfail':
        ovTitle.textContent = 'Couldn’t load buttons';
        ovMsg.textContent = 'Macro Deck didn’t send this page. Retry to reload.';
        ovHost.textContent = HOST_RAW;
        ovRetry.hidden = false;
        break;
      case 'reconnect':
        ovTitle.textContent = 'Connection lost';
        ovHost.textContent = HOST_RAW;
        // Advice + Retry appear after SUSTAINED failure measured across retries
        // (outageStart), not from a per-attempt timer that resets each reconnect.
        var remaining = Math.max(0, 10000 - (outageStart ? (Date.now() - outageStart) : 0));
        if (remaining === 0) { showReconnectAdvice(); }
        else { reconnectAdviceTimer = setTimeout(showReconnectAdvice, remaining); }
        break;
      case 'invalid':
        ovTitle.textContent = 'Check the host address';
        // The address is immutable here, so Retry can't help — send them to edit it.
        ovMsg.textContent = 'Edit the host address in the Bedrock editor.';
        ovHost.textContent = HOST_RAW;
        break;
    }
    announce(ovTitle.textContent);
  }

  function showReconnectAdvice() {
    ovMsg.textContent = 'Check that Macro Deck is running and the host address is correct.';
    ovRetry.hidden = false;
    announce('Connection lost. Check that Macro Deck is running and the host address is correct.');
  }

  // Count keys the host has assigned (a real button lives in the cell).
  function countAssigned() {
    var n = 0;
    for (var k in tiles) { if (tiles[k] && !tiles[k].el.classList.contains('empty')) n++; }
    return n;
  }
  // After an incremental change, re-decide ready vs empty (so the first button
  // added to a previously-empty page becomes usable, and vice versa).
  function reconcileReady() {
    if (!dispatchReady) return;
    setState(countAssigned() > 0 ? 'ready' : 'empty');
  }

  // ---- layout & rendering -------------------------------------------------

  function gridDims() {
    return {
      rows: (cfg && cfg.Rows > 0) ? cfg.Rows : 3,
      cols: (cfg && cfg.Columns > 0) ? cfg.Columns : 5,
      gap: (cfg && typeof cfg.ButtonSpacing === 'number') ? cfg.ButtonSpacing : 10
    };
  }

  function layout() {
    if (!cfg) return;
    var d = gridDims();
    var outer = 24;    // screen edge -> deck panel
    var deckPad = 18;  // deck panel -> keys (matches #deck padding in CSS)
    var W = window.innerWidth, H = window.innerHeight;
    var availW = W - outer * 2 - deckPad * 2 - d.gap * (d.cols - 1);
    var availH = H - outer * 2 - deckPad * 2 - d.gap * (d.rows - 1);
    var size = Math.max(48, Math.floor(Math.min(availH / d.rows, availW / d.cols)));

    deck.style.gridTemplateColumns = 'repeat(' + d.cols + ', ' + size + 'px)';
    deck.style.gridTemplateRows = 'repeat(' + d.rows + ', ' + size + 'px)';
    deck.style.gap = d.gap + 'px';

    var radius = (cfg && typeof cfg.ButtonRadius === 'number')
      ? Math.min(cfg.ButtonRadius, size / 2)
      : Math.round(size * 0.14);
    document.documentElement.style.setProperty('--tile-radius', radius + 'px');
  }

  // Draw the FULL grid (every Rows x Columns cell) so it reads as a deck. Cells
  // with no button are visible inactive slots; buttons fill their own cell.
  function rebuildGrid() {
    cancelPress();            // close any held gesture before its element is torn down
    deck.textContent = '';
    tiles = {};
    if (!cfg) return;
    layout();
    var d = gridDims();
    for (var y = 0; y < d.rows; y++) {
      for (var x = 0; x < d.cols; x++) {
        var id = keyId(x, y);
        // Native button semantics. Empty slots start disabled: inert, skipped by
        // Tab, no pointer/click, and send nothing. applyButton() enables real keys.
        var el = document.createElement('button');
        el.type = 'button';
        el.className = 'tile empty';
        el.disabled = true;
        el.setAttribute('aria-hidden', 'true');
        el.dataset.k = id;
        el.style.gridColumn = (x + 1);
        el.style.gridRow = (y + 1);
        var icon = document.createElement('img'); icon.className = 'ic'; icon.alt = '';
        var label = document.createElement('img'); label.className = 'lb'; label.alt = '';
        el.appendChild(icon);
        el.appendChild(label);
        deck.appendChild(el);
        tiles[id] = { el: el, icon: icon, label: label };
      }
    }
  }

  function setImg(img, b64) {
    if (b64) { img.src = dataUri(b64); img.style.display = 'block'; }
    else { img.removeAttribute('src'); img.style.display = 'none'; }
  }

  function applyButton(b) {
    if (!b) return;
    var t = tiles[keyId(b.Position_X, b.Position_Y)];
    if (!t) return;  // outside the declared grid
    t.el.classList.remove('empty');
    t.el.disabled = false;
    t.el.removeAttribute('aria-hidden');
    // The label is a host-rendered image, not text, so there is no verified
    // accessible name. Honest positional fallback — it does NOT claim to describe
    // the action the key performs.
    t.el.setAttribute('aria-label', 'Macro key, row ' + (b.Position_Y + 1) + ', column ' + (b.Position_X + 1));
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

  // ---- input: one centralized, socket-bound press controller ---------------
  // A single active gesture at a time, bound to its originating pointer/key AND
  // the socket it started on. Releases go only to that socket, and every timer is
  // cancelled on teardown, so a held key can never orphan a long-press or release
  // against a replacement session.

  var press = null;         // { id, source, pointerId, key, longFired, timer, btn, sock }

  function normKey(k) { return (k === 'Spacebar') ? ' ' : k; }   // legacy Space name

  function tileButton(target) {
    var b = (target && target.closest) ? target.closest('button.tile') : null;
    return (b && !b.disabled && deck.contains(b)) ? b : null;
  }

  // Send only if this is still the live socket (never a replacement session).
  function sendTo(sock, obj) {
    if (sock && sock === ws && sock.readyState === 1) {
      try { sock.send(JSON.stringify(obj)); } catch (e) {}
    }
  }
  function send(obj) { sendTo(ws, obj); }

  function startPress(btn, source, pointerId, key) {
    if (press) return;              // one gesture at a time
    if (!dispatchReady) return;     // no dispatch until the first GET_BUTTONS
    press = {
      id: btn.dataset.k, source: source,
      pointerId: (pointerId == null ? null : pointerId),
      key: (key == null ? null : normKey(key)),
      longFired: false, timer: null, btn: btn, sock: ws
    };
    btn.classList.add('pressed');
    sendTo(press.sock, { Method: 'BUTTON_PRESS', Message: press.id });
    press.timer = setTimeout(function () {
      if (!press) return;
      press.longFired = true;
      sendTo(press.sock, { Method: 'BUTTON_LONG_PRESS', Message: press.id });
    }, LONG_MS);
  }

  // Close out the current gesture: clear its timer, drop the pressed state, and send
  // the matching release on the ORIGINATING socket only (a no-op if it already
  // closed), so the host is never left with a stuck-down key.
  function finishPress() {
    if (!press) return;
    if (press.timer) { clearTimeout(press.timer); press.timer = null; }
    if (press.btn) press.btn.classList.remove('pressed');
    sendTo(press.sock, { Method: press.longFired ? 'BUTTON_LONG_PRESS_RELEASE' : 'BUTTON_RELEASE', Message: press.id });
    press = null;
  }

  function endPress(source, pointerId, key) {
    if (!press || press.source !== source) return;
    if (source === 'pointer' && pointerId != null && press.pointerId !== pointerId) return;
    if (source === 'key' && press.key != null && normKey(key) !== press.key) return;  // only the initiating key releases
    finishPress();
  }

  // Teardown on disconnect / grid rebuild / blur.
  function cancelPress() { finishPress(); }

  function setupInput() {
    deck.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;   // primary button / touch only
      var b = tileButton(e.target); if (!b) return;
      startPress(b, 'pointer', e.pointerId, null);
      if (press && e.pointerId != null && b.setPointerCapture) { try { b.setPointerCapture(e.pointerId); } catch (_) {} }
    });
    deck.addEventListener('pointerup', function (e) { endPress('pointer', e.pointerId, null); });
    deck.addEventListener('pointercancel', function (e) { endPress('pointer', e.pointerId, null); });
    deck.addEventListener('lostpointercapture', function (e) { endPress('pointer', e.pointerId, null); });

    deck.addEventListener('keydown', function (e) {
      var k = normKey(e.key);
      if (k !== 'Enter' && k !== ' ') return;
      var b = tileButton(e.target); if (!b) return;
      e.preventDefault();               // no page scroll on Space, no synthetic click
      if (e.repeat) return;             // suppress auto-repeat -> a single press
      startPress(b, 'key', null, k);
    });
    deck.addEventListener('keyup', function (e) {
      var k = normKey(e.key);
      if (k !== 'Enter' && k !== ' ') return;
      var b = tileButton(e.target); if (!b) return;
      e.preventDefault();
      endPress('key', null, k);
    });

    // A real pointer click has detail>=1 and was already handled by the pointer
    // path above, so ignore it. Assistive tech / programmatic activation dispatches
    // a click with detail===0 -> treat that as one short press+release. Keying on
    // detail (not a time window) means an AT re-activation of the same key right
    // after a pointer tap still fires.
    deck.addEventListener('click', function (e) {
      if (e.detail !== 0) return;                       // trailing physical click
      if (e.button != null && e.button !== 0) return;
      var b = tileButton(e.target); if (!b) return;
      if (!dispatchReady) return;
      send({ Method: 'BUTTON_PRESS', Message: b.dataset.k });
      send({ Method: 'BUTTON_RELEASE', Message: b.dataset.k });
    });

    deck.addEventListener('focusout', function () { if (press && press.source === 'key') cancelPress(); });
    window.addEventListener('blur', function () { if (press) cancelPress(); });

    ovRetry.addEventListener('click', function () {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (reconnectAdviceTimer) { clearTimeout(reconnectAdviceTimer); reconnectAdviceTimer = null; }
      if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
      outageStart = 0;   // explicit retry resets the outage -> fresh connect
      backoff = 1000;
      connect();
    });
  }

  // ---- protocol -----------------------------------------------------------

  function handle(msg) {
    switch (msg.Method) {
      case 'GET_CONFIG':
        cfg = msg;
        initialConfig = true;
        dispatchReady = false;      // buttons not ready yet — gate dispatch
        rebuildGrid();
        setState('loading');        // don't imply buttons are ready
        // Bound the wait: if GET_BUTTONS never arrives, surface a retryable failure
        // rather than spinning forever.
        if (loadingTimer) clearTimeout(loadingTimer);
        loadingTimer = setTimeout(function () { loadingTimer = null; setState('loadfail'); }, 10000);
        send({ Method: 'GET_BUTTONS' });
        break;
      case 'GET_BUTTONS':
        if (!initialConfig) return;
        if (!Array.isArray(msg.Buttons)) return;   // malformed — not a valid empty page
        if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
        renderButtons(msg.Buttons);
        dispatchReady = true;       // a valid (even empty) response completes loading
        // Use actually-rendered keys, not raw list length, so an all-invalid /
        // out-of-grid list can't look ready.
        setState(countAssigned() > 0 ? 'ready' : 'empty');
        break;
      case 'UPDATE_BUTTON':
        if (!initialConfig) return;
        if (msg.Buttons && msg.Buttons[0]) applyButton(msg.Buttons[0]);
        reconcileReady();           // first button on an empty page becomes usable
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

  // Detach and close a socket so its late callbacks can never touch a new session.
  function retireSocket() {
    if (!ws) return;
    try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; ws.close(); } catch (e) {}
    ws = null;
  }

  function connect() {
    wantOpen = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    retireSocket();            // never leave an old socket live alongside the new one
    initialConfig = false;
    dispatchReady = false;
    cfg = null;

    // Mid-outage retries keep the stable 'reconnect' overlay instead of flapping
    // back to 'connecting'/'accept' on every attempt.
    var reconnecting = outageStart > 0;

    var url = wsUrl(HOST_RAW);
    if (!url) { wantOpen = false; setState('invalid'); return; }   // malformed address: no loop
    if (!reconnecting) setState('connecting');
    var sock;
    try { sock = new WebSocket(url); }
    catch (e) { wantOpen = false; setState('invalid'); return; }   // syntactically bad URL
    ws = sock;

    // Every handler ignores events unless `sock` is still the current socket, so a
    // straggling message/close from a retired connection cannot mutate this one.
    sock.onopen = function () {
      if (sock !== ws) return;
      backoff = 1000;
      send({ Method: 'CONNECTED', 'Client-Id': CLIENT_ID, 'API': '20', 'Device-Type': 'Web' });
      if (!reconnecting) setState('accept');   // during an outage, wait for GET_CONFIG
    };
    sock.onmessage = function (ev) {
      if (sock !== ws) return;
      var m = null;
      try { m = JSON.parse(ev.data); } catch (e) {}
      if (m && m.Method) handle(m);
    };
    sock.onerror = function () { /* onclose drives reconnect */ };
    sock.onclose = function () { if (sock === ws && wantOpen) scheduleReconnect(); };
  }

  function scheduleReconnect() {
    cancelPress();   // a dropped connection ends any held gesture (no orphan timer)
    if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
    if (!outageStart) outageStart = Date.now();   // mark the outage start once
    setState('reconnect');
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, backoff);
    backoff = Math.min(Math.round(backoff * 1.7), 15000);
  }

  window.addEventListener('resize', function () { if (cfg) layout(); });

  setupInput();
  connect();
})();
