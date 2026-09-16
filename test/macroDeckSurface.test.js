'use strict';
// Behavioral tests for the Macro Deck Surface drop-in (community-apps/macro-deck-surface/app.js).
// app.js is a browser IIFE, so we install a minimal fake DOM + fake WebSocket + a
// controllable clock, then require it fresh per case and drive real events through the
// delegated listeners. This exercises behavior (exactly-once dispatch, stale-socket
// isolation, orphan-timer teardown, state transitions) rather than matching source text.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'community-apps', 'macro-deck-surface', 'app.js');

function matchesSel(node, sel) {
  if (sel === 'button.tile') return node && node.tagName === 'BUTTON' && node._class.has('tile');
  return false;
}

function makeEl(tag) {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    _class: new Set(),
    _children: [],
    _attrs: {},
    _src: undefined,
    _text: '',
    parentNode: null,
    style: {},
    dataset: {},
    disabled: false,
    hidden: false,
    inert: false,
    type: '',
    alt: '',
    get className() { return Array.from(el._class).join(' '); },
    set className(v) { el._class = new Set(String(v).split(/\s+/).filter(Boolean)); },
    classList: {
      add: (c) => el._class.add(c),
      remove: (c) => el._class.delete(c),
      contains: (c) => el._class.has(c),
      toggle: (c, on) => { const v = on === undefined ? !el._class.has(c) : on; v ? el._class.add(c) : el._class.delete(c); return v; },
    },
    get children() { return el._children; },
    get textContent() { return el._text; },
    set textContent(v) { el._text = String(v); if (v === '') el._children = []; },
    setAttribute: (k, v) => { el._attrs[k] = String(v); },
    getAttribute: (k) => (k in el._attrs ? el._attrs[k] : null),
    removeAttribute: (k) => { delete el._attrs[k]; if (k === 'src') el._src = undefined; },
    hasAttribute: (k) => (k === 'src' ? el._src != null : k in el._attrs),
    get src() { return el._src; },
    set src(v) { el._src = v; },
    appendChild: (c) => { el._children.push(c); c.parentNode = el; return c; },
    addEventListener: (t, fn) => { (listeners[t] || (listeners[t] = [])).push(fn); },
    _fire: (t, ev) => { (listeners[t] || []).slice().forEach((fn) => fn(ev)); },
    contains: (n) => n === el || el._children.includes(n) || el._children.some((c) => c.contains && c.contains(n)),
    closest: (sel) => { let n = el; while (n) { if (matchesSel(n, sel)) return n; n = n.parentNode; } return null; },
    setPointerCapture: () => {},
    querySelectorAll: () => [],
    focus: () => {},
  };
  return el;
}

function loadApp(search) {
  // Fresh module state each load.
  delete require.cache[require.resolve(APP)];

  const ids = {};
  ['deck', 'overlay', 'ovTitle', 'ovMsg', 'ovHost', 'ovRetry', 'live'].forEach((id) => { ids[id] = makeEl(id === 'ovRetry' ? 'button' : 'div'); });

  const body = makeEl('body');
  const docEl = makeEl('html'); docEl.style.setProperty = () => {};

  const win = makeEl('window');
  win.innerWidth = 1920; win.innerHeight = 480;

  // Controllable clock + timers.
  const clock = { now: 0, timers: [], id: 1 };
  const realNow = Date.now;
  global.setTimeout = (fn, ms) => { const id = clock.id++; clock.timers.push({ id, fn, at: clock.now + (ms || 0) }); return id; };
  global.clearTimeout = (id) => { clock.timers = clock.timers.filter((t) => t.id !== id); };
  Date.now = () => clock.now;

  // Fake WebSocket — opened/emitted manually so handlers are attached first.
  const sockets = [];
  class FakeWS {
    constructor(url) {
      // Mirror the real WebSocket: a malformed URL throws (the app relies on this
      // for its invalid-host path).
      if (typeof url !== 'string' || /\s/.test(url) || !/^wss?:\/\/[^/]+$/i.test(url)) {
        throw new SyntaxError('invalid WebSocket URL: ' + url);
      }
      this.url = url; this.readyState = 0; this.sent = []; this.onopen = this.onmessage = this.onerror = this.onclose = null; sockets.push(this);
    }
    send(d) { this.sent.push(JSON.parse(d)); }
    close() { this.readyState = 3; }
    _open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
    _emit(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }
    _drop() { this.readyState = 3; if (this.onclose) this.onclose({}); }
  }

  global.window = win;
  global.document = {
    body, documentElement: docEl,
    getElementById: (id) => ids[id],
    createElement: (t) => makeEl(t),
  };
  global.location = { search: search || '' };
  global.WebSocket = FakeWS;

  require(APP);

  const env = {
    ids, win, sockets, clock,
    advance(ms) {
      clock.now += ms;
      const due = clock.timers.filter((t) => t.at <= clock.now).sort((a, b) => a.at - b.at);
      clock.timers = clock.timers.filter((t) => t.at > clock.now);
      due.forEach((t) => t.fn());
    },
    ws() { return sockets[sockets.length - 1]; },
    tiles() { return ids.deck.children; },
    tile(x, y) { return ids.deck.children.find((t) => t.dataset.k === y + '_' + x); },
    // Bring the app to a ready state with a given button list on a 3x5 grid.
    ready(buttons, cfgOverride) {
      const w = env.ws(); w._open();
      w._emit(Object.assign({ Method: 'GET_CONFIG', Rows: 3, Columns: 5, ButtonSpacing: 10, ButtonRadius: 40, ButtonBackground: true }, cfgOverride || {}));
      w._emit({ Method: 'GET_BUTTONS', Buttons: buttons });
      return w;
    },
    state() { return ids.overlay.className; },
    restore() { Date.now = realNow; },
  };
  return env;
}

// Collect only button-protocol messages a socket received.
function presses(ws) { return ws.sent.filter((m) => /^BUTTON_/.test(m.Method)); }

test('short press sends exactly one PRESS then RELEASE', () => {
  const env = loadApp('');
  const ws = env.ready([{ Position_X: 0, Position_Y: 0, BackgroundColorHex: '#f00' }]);
  const t = env.tile(0, 0);
  env.ids.deck._fire('pointerdown', { target: t, pointerId: 1, button: 0 });
  env.ids.deck._fire('pointerup', { target: t, pointerId: 1 });
  assert.deepEqual(presses(ws).map((m) => m.Method), ['BUTTON_PRESS', 'BUTTON_RELEASE']);
  assert.deepEqual(presses(ws).map((m) => m.Message), ['0_0', '0_0']);
  env.restore();
});

test('long press: PRESS, LONG_PRESS at threshold, LONG_PRESS_RELEASE on up', () => {
  const env = loadApp('?longPressMs=1000');
  const ws = env.ready([{ Position_X: 1, Position_Y: 0, BackgroundColorHex: '#f00' }]);
  const t = env.tile(1, 0);
  env.ids.deck._fire('pointerdown', { target: t, pointerId: 1, button: 0 });
  env.advance(1000);
  env.ids.deck._fire('pointerup', { target: t, pointerId: 1 });
  assert.deepEqual(presses(ws).map((m) => m.Method), ['BUTTON_PRESS', 'BUTTON_LONG_PRESS', 'BUTTON_LONG_PRESS_RELEASE']);
  env.restore();
});

test('Enter down then Space up does not release; Enter up releases once', () => {
  const env = loadApp('');
  const ws = env.ready([{ Position_X: 0, Position_Y: 0, BackgroundColorHex: '#f00' }]);
  const t = env.tile(0, 0);
  env.ids.deck._fire('keydown', { target: t, key: 'Enter', repeat: false, preventDefault() {} });
  env.ids.deck._fire('keyup', { target: t, key: ' ', preventDefault() {} });   // wrong key
  assert.deepEqual(presses(ws).map((m) => m.Method), ['BUTTON_PRESS']);         // no release yet
  env.ids.deck._fire('keyup', { target: t, key: 'Enter', preventDefault() {} });
  assert.deepEqual(presses(ws).map((m) => m.Method), ['BUTTON_PRESS', 'BUTTON_RELEASE']);
  env.restore();
});

test('non-primary pointer button sends nothing', () => {
  const env = loadApp('');
  const ws = env.ready([{ Position_X: 0, Position_Y: 0, BackgroundColorHex: '#f00' }]);
  const t = env.tile(0, 0);
  env.ids.deck._fire('pointerdown', { target: t, pointerId: 1, button: 2 });  // right button
  env.ids.deck._fire('pointerup', { target: t, pointerId: 1 });
  assert.equal(presses(ws).length, 0);
  env.restore();
});

test('AT click (detail 0) activates; trailing physical click (detail 1) does not', () => {
  const env = loadApp('');
  const ws = env.ready([{ Position_X: 0, Position_Y: 0, BackgroundColorHex: '#f00' }]);
  const t = env.tile(0, 0);
  env.ids.deck._fire('click', { target: t, detail: 1, button: 0 });   // trailing physical -> ignored
  assert.equal(presses(ws).length, 0);
  env.ids.deck._fire('click', { target: t, detail: 0, button: 0 });   // AT -> press+release
  assert.deepEqual(presses(ws).map((m) => m.Method), ['BUTTON_PRESS', 'BUTTON_RELEASE']);
  env.restore();
});

test('no dispatch before the first GET_BUTTONS', () => {
  const env = loadApp('');
  const ws = env.ws(); ws._open();
  ws._emit({ Method: 'GET_CONFIG', Rows: 3, Columns: 5, ButtonSpacing: 10, ButtonRadius: 40 });
  // grid exists but no buttons yet; force a tile enabled to prove the gate (shouldn't happen normally)
  const t = env.tile(0, 0);
  t.disabled = false; t.classList.remove('empty');
  env.ids.deck._fire('pointerdown', { target: t, pointerId: 1, button: 0 });
  assert.equal(presses(ws).length, 0, 'dispatch gated until first GET_BUTTONS');
  assert.match(env.state(), /state-loading/);
  env.restore();
});

test('orphan timer: a held long-press is torn down (no stray LONG_PRESS) on grid rebuild', () => {
  const env = loadApp('?longPressMs=1000');
  const ws = env.ready([{ Position_X: 0, Position_Y: 0, BackgroundColorHex: '#f00' }]);
  const t = env.tile(0, 0);
  env.ids.deck._fire('pointerdown', { target: t, pointerId: 1, button: 0 });   // starts long timer
  ws._emit({ Method: 'GET_CONFIG', Rows: 3, Columns: 5, ButtonSpacing: 10, ButtonRadius: 40 }); // rebuild -> cancelPress
  env.advance(5000);   // old long-press timer must NOT fire
  const methods = presses(ws).map((m) => m.Method);
  assert.ok(!methods.includes('BUTTON_LONG_PRESS'), 'no orphan long-press after rebuild');
  assert.deepEqual(methods, ['BUTTON_PRESS', 'BUTTON_RELEASE'], 'held press closed with a RELEASE');
  env.restore();
});

test('retired socket: a late message/close from the old socket is ignored after reconnect', () => {
  const env = loadApp('');
  const old = env.ready([{ Position_X: 0, Position_Y: 0, BackgroundColorHex: '#f00' }]);
  assert.match(env.state(), /hidden/);           // ready
  old._drop();                                   // connection lost -> schedule reconnect
  env.advance(2000);                             // retry fires -> new socket created
  const fresh = env.ws();
  assert.notEqual(fresh, old);
  const before = env.state();
  old._emit({ Method: 'GET_BUTTONS', Buttons: [] });   // stale message from retired socket
  old._drop();                                          // stale close from retired socket
  assert.equal(env.state(), before, 'retired socket cannot mutate the new session');
  env.restore();
});

test('states: GET_BUTTONS [] -> empty, then UPDATE_BUTTON -> ready', () => {
  const env = loadApp('');
  const ws = env.ws(); ws._open();
  ws._emit({ Method: 'GET_CONFIG', Rows: 3, Columns: 5, ButtonSpacing: 10, ButtonRadius: 40 });
  ws._emit({ Method: 'GET_BUTTONS', Buttons: [] });
  assert.match(env.state(), /state-empty/);
  ws._emit({ Method: 'UPDATE_BUTTON', Buttons: [{ Position_X: 2, Position_Y: 1, BackgroundColorHex: '#0f0' }] });
  assert.match(env.state(), /hidden/, 'first button makes the page ready');
  assert.equal(env.ids.deck.inert, false);
  env.restore();
});

test('loading times out to a retryable loadfail when GET_BUTTONS never arrives', () => {
  const env = loadApp('');
  const ws = env.ws(); ws._open();
  ws._emit({ Method: 'GET_CONFIG', Rows: 3, Columns: 5, ButtonSpacing: 10, ButtonRadius: 40 });
  assert.match(env.state(), /state-loading/);
  env.advance(10000);
  assert.match(env.state(), /state-loadfail/);
  assert.equal(env.ids.ovRetry.hidden, false);
  env.restore();
});

test('malformed Buttons (not an array) is ignored, not treated as empty', () => {
  const env = loadApp('');
  const ws = env.ws(); ws._open();
  ws._emit({ Method: 'GET_CONFIG', Rows: 3, Columns: 5, ButtonSpacing: 10, ButtonRadius: 40 });
  ws._emit({ Method: 'GET_BUTTONS', Buttons: 'nope' });
  assert.match(env.state(), /state-loading/, 'still loading, not empty');
  env.restore();
});

test('out-of-grid button does not look ready (countAssigned)', () => {
  const env = loadApp('');
  env.ready([{ Position_X: 9, Position_Y: 9, BackgroundColorHex: '#f00' }]);  // outside 3x5
  assert.match(env.state(), /state-empty/);
  env.restore();
});

test('invalid host address goes to invalid with no reconnect loop', () => {
  const env = loadApp('?host=' + encodeURIComponent('has space'));
  // new WebSocket("ws://has space:8191") throws -> invalid
  assert.match(env.state(), /state-invalid/);
  env.restore();
});

test('too many buttons than fit -> toodense explanatory state', () => {
  const env = loadApp('');
  const ws = env.ws(); ws._open();
  const buttons = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) buttons.push({ Position_X: x, Position_Y: y, BackgroundColorHex: '#f00' });
  ws._emit({ Method: 'GET_CONFIG', Rows: 8, Columns: 16, ButtonSpacing: 10, ButtonRadius: 40 });
  ws._emit({ Method: 'GET_BUTTONS', Buttons: buttons });
  assert.match(env.state(), /state-toodense/);
  env.restore();
});
