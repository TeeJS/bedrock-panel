'use strict';
// LucidType dictation must never sit on DICTATING over an empty box without saying why. Drives the
// controller with fake capture windows: start confirmation + rebuild of a silent window, the capture
// window's health reports, speech-server failures, and a crashed renderer. No electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLucidDictation } = require('../app/lucidtypeDictation');

function fakeWindow(id) {
  const wcHandlers = {};
  const w = {
    id, sent: [], destroyed: false,
    isDestroyed() { return this.destroyed; },
    destroy() { this.destroyed = true; },
    on() {},
    webContents: {
      id,
      isLoading: () => false,
      send(channel, msg) { w.sent.push(msg.type); },
      on(name, fn) { wcHandlers[name] = fn; },
      once() {},
    },
    emit(name, ...args) { wcHandlers[name]({}, ...args); },
  };
  return w;
}

function make(o) {
  o = o || {};
  const windows = [];
  const logs = [];
  const c = createLucidDictation({
    createWindow: () => { const w = fakeWindow(windows.length + 1); windows.push(w); return w; },
    resolveSettings: () => ({ micDevice: 'Jabra', silenceMs: 400, startMode: 'clear' }),
    resolveEndpoints: () => ({ sttHost: '10.0.0.5', sttPort: '10300' }),
    transcribe: o.transcribe || (async () => 'hello there'),
    onState: () => {},
    log: m => logs.push(m),
    ackTimeoutMs: 1000,
  });
  return { c, windows, logs };
}

test('a capture window that never confirms is rebuilt once, then the failure is shown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, windows } = make();
  c.start();
  assert.deepEqual(windows[0].sent, ['start']);
  t.mock.timers.tick(1000);
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(windows[1].sent, ['start']);       // fresh window, start resent
  assert.equal(c.state().dictating, true);
  t.mock.timers.tick(1000);
  const st = c.state();
  assert.equal(st.dictating, false);
  assert.equal(st.noticeLevel, 'error');
  assert.match(st.notice, /isn't responding/);
});

test('a confirmed start disarms the watchdog and only the live window is listened to', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, windows } = make();
  c.start();
  assert.equal(c.ownsSender(windows[0].webContents), true);
  c.onCaptureStatus({ type: 'started', mic: 'Jabra', wanted: 'Jabra', matched: true, context: 'running', rate: 16000 });
  t.mock.timers.tick(5000);
  assert.equal(windows.length, 1);
  assert.equal(c.state().dictating, true);
  assert.equal(c.state().notice, '');
  assert.equal(c.ownsSender({ id: 99 }), false);
});

test('a saved mic that is missing, or a stalled audio context, is reported', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c } = make();
  c.start();
  c.onCaptureStatus({ type: 'started', mic: 'Laptop Mic', wanted: 'Jabra', matched: false, context: 'running', rate: 16000 });
  assert.equal(c.state().noticeLevel, 'warn');
  assert.match(c.state().notice, /Couldn't find "Jabra" — listening on Laptop Mic/);
  c.stop(); c.start();
  assert.equal(c.state().notice, '');                 // a new start clears the old notice
  c.onCaptureStatus({ type: 'started', mic: 'Jabra', wanted: '', matched: true, context: 'suspended', rate: 16000 });
  assert.equal(c.state().noticeLevel, 'error');
  assert.match(c.state().notice, /suspended/);
});

test('a mic that fails to open ends dictation with the reason', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c } = make();
  c.start();
  c.onCaptureStatus({ type: 'error', message: 'NotReadableError' });
  assert.equal(c.state().dictating, false);
  assert.match(c.state().notice, /failed to open: NotReadableError/);
  c.onCaptureStatus({ type: 'silent', mic: 'Jabra', peak: 0 });   // stale once stopped: ignored
  assert.match(c.state().notice, /NotReadableError/);
});

test('"nothing heard yet" clears as soon as a clip arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c } = make();
  c.start();
  c.onCaptureStatus({ type: 'silent', mic: 'Jabra', peak: 0.004 });
  assert.equal(c.state().noticeLevel, 'warn');
  assert.match(c.state().notice, /Nothing heard from Jabra/);
  await c.onUtterance(Buffer.alloc(32000));
  assert.equal(c.state().notice, '');
  assert.equal(c.state().transcript, 'hello there');
});

test('a speech-server failure is shown and clears on the next good transcript', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fail = true;
  const { c, logs } = make({ transcribe: async () => { if (fail) throw new Error('connect ECONNREFUSED'); return 'ok'; } });
  c.start();
  await c.onUtterance(Buffer.alloc(32000));
  assert.equal(c.state().noticeLevel, 'error');
  assert.match(c.state().notice, /10\.0\.0\.5:10300 failed: connect ECONNREFUSED/);
  fail = false;
  await c.onUtterance(Buffer.alloc(16000));
  assert.equal(c.state().notice, '');
  assert.ok(logs.some(l => l === 'clip 500 ms -> 2 chars'));
});

test('a crashed capture renderer is rebuilt and the running dictation resent to it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, windows } = make();
  c.start();
  c.onCaptureStatus({ type: 'started', mic: 'Jabra', matched: true, context: 'running', rate: 16000 });
  windows[0].emit('render-process-gone', { reason: 'crashed' });
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(windows[1].sent, ['start']);
  assert.equal(c.ownsSender(windows[0].webContents), false);
  assert.equal(c.ownsSender(windows[1].webContents), true);
});

test('a page that fails to load is replaced on the next command', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, windows } = make();
  c.ensureWindow();
  windows[0].emit('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1/lucidtype-dictate', true);
  assert.equal(windows[0].destroyed, true);
  c.start();
  assert.deepEqual(windows[1].sent, ['start']);
});
