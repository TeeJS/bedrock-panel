'use strict';
// BedrockConnector against an injected fake node-hid: the macOS open/write quirks and the one-time
// open-failure reporting. No hardware and no rescan timers (start() is never called; _open() is
// driven directly, exactly as the rescan tick would).
const test = require('node:test');
const assert = require('node:assert/strict');
const BedrockConnector = require('../src/BedrockConnector');

const knob = { vendorId: 0x1209, productId: 0xbed0, usagePage: 0xff00, path: 'bedrock-path' };

function fakeHid({ openThrows = null, writeFailures = 0 } = {}) {
  const state = { opens: [], writes: [], closed: 0, failuresLeft: writeFailures };
  class HID {
    constructor(...args) {
      state.opens.push(args);
      if (openThrows) throw new Error(openThrows);
      this.handlers = {};
    }
    on(ev, fn) { this.handlers[ev] = fn; }
    write(buf) {
      if (state.failuresLeft > 0) { state.failuresLeft--; throw new Error('write failed'); }
      state.writes.push(Array.from(buf));
    }
    close() { state.closed++; }
  }
  return { hid: { devices: () => [knob], HID }, state };
}

test('macOS opens the knob non-exclusively; other platforms use the default open', () => {
  for (const [platform, expected] of [['darwin', ['bedrock-path', { nonExclusive: true }]], ['win32', ['bedrock-path']]]) {
    const { hid, state } = fakeHid();
    const c = new BedrockConnector({ hid, platform });
    c._open();
    assert.deepEqual(state.opens[0], expected, platform);
    assert.ok(c.ctrl, platform);
    c.stop();
  }
});

test('an open refusal is reported once with the macOS hint, kept for diagnostics, and cleared on success', () => {
  const { hid } = fakeHid({ openThrows: 'cannot open device with path bedrock-path' });
  const c = new BedrockConnector({ hid, platform: 'darwin' });
  const errors = [];
  c.on('error', e => errors.push(e));
  c._open(); c._open(); c._open();          // three rescans, one report
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Input Monitoring/);
  assert.equal(errors[0].code, 'HID_OPEN_FAILED');
  assert.match(c.lastOpenError.control, /cannot open device/);
  assert.equal(c.ctrl, null);
  // Permission granted: the next rescan connects and the remembered error clears.
  c.HID = fakeHid().hid;
  const connects = [];
  c.on('connect', i => connects.push(i.iface));
  c._open();
  assert.equal(c.lastOpenError.control, null);
  assert.deepEqual(connects, ['control']);
  c.stop();
});

test('macOS retries a transient write and stays connected', () => {
  const { hid, state } = fakeHid({ writeFailures: 2 });
  const c = new BedrockConnector({ hid, platform: 'darwin' });
  const errors = [];
  c.on('error', e => errors.push(e));
  c._open();                                   // activate() sends the first ping: fails twice, then lands
  assert.equal(errors.length, 0);
  assert.ok(c.ctrl);
  assert.equal(state.writes.length, 1);
  assert.equal(c.ping(), true);
  assert.equal(state.writes.length, 2);
  c.stop();
});

test('persistent write failures drop the device: after three attempts on macOS, one elsewhere', () => {
  for (const [platform, attempts] of [['darwin', 3], ['win32', 1]]) {
    const { hid, state } = fakeHid({ writeFailures: 99 });
    const c = new BedrockConnector({ hid, platform });
    const errors = [], disconnects = [];
    c.on('error', e => errors.push(e));
    c.on('disconnect', i => disconnects.push(i.iface));
    c._open();
    assert.equal(c.ctrl, null, platform);
    assert.equal(errors.length, 1, platform);
    assert.deepEqual(disconnects, ['control'], platform);
    assert.equal(99 - state.failuresLeft, attempts, platform);
    c.stop();
  }
});
