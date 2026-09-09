'use strict';
// Aris68Connector against an injected fake node-hid: independent control/touch opens (macOS usually
// owns the touch digitizer), the macOS open/write quirks, and report-ID tolerance. No hardware and no
// timers (autoActivate off; _open() driven directly as the rescan would).
const test = require('node:test');
const assert = require('node:assert/strict');
const Aris68Connector = require('../src/Aris68Connector');

const control = { vendorId: 16728, productId: 20811, usagePage: 0xff60, path: 'ctrl-path' };
const touch = { vendorId: 1810, productId: 16, usagePage: 0xff73, path: 'touch-path' };

function fakeHid({ failPaths = {}, writeFailures = 0 } = {}) {
  const state = { opens: [], writes: [], failuresLeft: writeFailures };
  class HID {
    constructor(p, opts) {
      state.opens.push(opts ? [p, opts] : [p]);
      const fail = typeof failPaths[p] === 'function' ? failPaths[p](opts) : failPaths[p];   // a function decides per open mode
      if (fail) throw new Error(fail);
      this.handlers = {};
    }
    on(ev, fn) { this.handlers[ev] = fn; }
    removeListener() {}
    write(buf) {
      if (state.failuresLeft > 0) { state.failuresLeft--; throw new Error('write failed'); }
      state.writes.push(Array.from(buf));
    }
    close() {}
  }
  return { hid: { devices: () => [control, touch], HID }, state };
}

test('a touch-digitizer open failure leaves the control interface connected and is reported once', () => {
  const { hid, state } = fakeHid({ failPaths: { 'touch-path': 'cannot open device with path touch-path' } });
  const c = new Aris68Connector({ hid, platform: 'darwin', autoActivate: false });
  const errors = [], connects = [];
  c.on('error', e => errors.push(e));
  c.on('connect', i => connects.push(i.iface));
  c._open(); c._open();
  assert.deepEqual(connects, ['control']);
  assert.ok(c.ctrl);
  assert.equal(c.touch, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Input Monitoring/);
  assert.equal(c.lastOpenError.control, null);
  assert.match(c.lastOpenError.touch, /touch-path/);
  assert.deepEqual(state.opens[0], ['ctrl-path', { nonExclusive: true }]);
  assert.deepEqual(state.opens[1], ['touch-path', { nonExclusive: false }], 'the touch controller is opened with a seize first on macOS, so nothing it emits reaches the OS');
  assert.deepEqual(state.opens[2], ['touch-path', { nonExclusive: true }], 'then with the shared open DK-Suite uses, before the refusal is reported');
  assert.deepEqual(c.openMode, { control: 'shared', touch: null });
  c.stop();
});

test('a refused seize falls back to the shared open; the connect event says which mode the touch controller got', () => {
  const { hid, state } = fakeHid({ failPaths: { 'touch-path': opts => (opts && opts.nonExclusive === false) ? 'cannot open device with path touch-path' : null } });
  const c = new Aris68Connector({ hid, platform: 'darwin', autoActivate: false });
  const errors = [], connects = [];
  c.on('error', e => errors.push(e));
  c.on('connect', i => connects.push(i));
  c._open();
  assert.equal(errors.length, 0, 'a fallback that works is not an error');
  assert.deepEqual(connects.map(i => [i.iface, i.mode]), [['control', 'shared'], ['touch', 'shared']]);
  assert.match(connects[1].fallback, /cannot open device/);
  assert.equal(c.lastOpenError.touch, null);
  assert.deepEqual(c.openMode, { control: 'shared', touch: 'shared' });
  assert.deepEqual(state.opens.slice(1), [['touch-path', { nonExclusive: false }], ['touch-path', { nonExclusive: true }]]);
  c._closeTouch();
  assert.equal(c.openMode.touch, null);
  c.stop();
});

test('a granted seize is reported as such and never retried in shared mode', () => {
  const { hid, state } = fakeHid();
  const c = new Aris68Connector({ hid, platform: 'darwin', autoActivate: false });
  const connects = [];
  c.on('connect', i => connects.push(i));
  c._open();
  assert.deepEqual(connects.map(i => [i.iface, i.mode, i.fallback || null]), [['control', 'shared', null], ['touch', 'seized', null]]);
  assert.equal(state.opens.length, 2);
  c.stop();
});

test('writes retry on macOS, on the short-frame and the VIA paths alike', () => {
  const { hid, state } = fakeHid({ writeFailures: 2 });
  const c = new Aris68Connector({ hid, platform: 'darwin', autoActivate: false });
  const errors = [];
  c.on('error', e => errors.push(e));
  c._open();
  assert.equal(c.ping(), true);              // two transient failures, then the write lands
  assert.equal(errors.length, 0);
  assert.equal(c.setLedEffect(3), true);     // VIA report path
  assert.equal(state.writes.length, 2);
  assert.equal(state.writes[0][0], 0x00);    // report-id 0 prefix unchanged
  assert.equal(state.writes[1].length, 33);  // VIA report size unchanged
  c.stop();
});

test('incoming frames parse the same with or without a leading 0x00 report-id byte', () => {
  const { hid } = fakeHid();
  const c = new Aris68Connector({ hid, platform: 'darwin', autoActivate: false });
  const knob = [], touches = [];
  c.on('knob', e => knob.push(e));
  c.on('touch', p => touches.push(p));
  const rotate = [0xA3, 0x03, 0x03, 0x01, 0x01, 0x05];             // op 3 / cmd 1 (rotate) / dir 1
  c._onCtrl(Buffer.from(rotate));
  c._onCtrl(Buffer.from([0x00, ...rotate]));
  assert.deepEqual(knob, [{ type: 'rotate', dir: 1 }, { type: 'rotate', dir: 1 }]);
  const t = [0xA3, 0x08, 0x03, 0x1A, 0x01, 0x01, 0x10, 0x00, 0x20, 0x00];   // one touch point
  c._onTouch(Buffer.from(t));
  c._onTouch(Buffer.from([0x00, ...t]));
  assert.equal(touches.length, 2);
  assert.deepEqual(touches[0], touches[1]);
  assert.deepEqual(touches[0], [{ action: 1, x: 32, y: 16 }]);
  c.stop();
});
