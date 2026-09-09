'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const hp = require('../src/hidPlatform');

test('openOptions / openDevice: non-exclusive on macOS only', () => {
  assert.deepEqual(hp.openOptions('darwin'), { nonExclusive: true });
  assert.equal(hp.openOptions('win32'), null);
  assert.equal(hp.openOptions('linux'), null);
  const calls = [];
  const HID = { HID: class { constructor(...a) { calls.push(a); } } };
  hp.openDevice(HID, '/dev/a', 'darwin');
  hp.openDevice(HID, '/dev/b', 'win32');
  hp.openDevice(HID, '/dev/c', 'darwin', { seize: true });   // the touch controller: taken away from macOS's own driver
  hp.openDevice(HID, '/dev/d', 'win32', { seize: true });    // no such notion elsewhere
  assert.deepEqual(calls, [['/dev/a', { nonExclusive: true }], ['/dev/b'], ['/dev/c', { nonExclusive: false }], ['/dev/d']]);
});

test('writeWithRetry: three attempts on macOS, one elsewhere', () => {
  let n = 0;
  const flaky = () => { n++; if (n < 3) throw new Error('transient'); };
  assert.equal(hp.writeWithRetry(flaky, 'darwin'), null);
  assert.equal(n, 3);
  n = 0;
  const err = hp.writeWithRetry(flaky, 'win32');
  assert.match(err.message, /transient/);
  assert.equal(n, 1);
  n = 0;
  const always = () => { n++; throw new Error('dead'); };
  assert.match(hp.writeWithRetry(always, 'darwin').message, /dead/);
  assert.equal(n, 3);
});

test('openError: adds the Input Monitoring hint on macOS for refusals only', () => {
  const e = hp.openError(new Error('cannot open device with path /dev/x'), 'darwin');
  assert.equal(e.code, 'HID_OPEN_FAILED');
  assert.match(e.message, /Input Monitoring/);
  assert.doesNotMatch(hp.openError(new Error('cannot open device'), 'win32').message, /Input Monitoring/);
  assert.doesNotMatch(hp.openError(new Error('something else'), 'darwin').message, /Input Monitoring/);
});

test('OpenErrorGate reports a message once until it changes or is cleared', () => {
  const g = new hp.OpenErrorGate();
  assert.equal(g.shouldReport('control', new Error('a')), true);
  assert.equal(g.shouldReport('control', new Error('a')), false);
  assert.equal(g.shouldReport('control', new Error('b')), true);
  assert.equal(g.shouldReport('touch', new Error('b')), true);   // keys are independent
  g.clear('control');
  assert.equal(g.shouldReport('control', new Error('b')), true);
});

test('stripLeadingReportId drops a leading 0x00 only before an expected marker', () => {
  assert.deepEqual(Array.from(hp.stripLeadingReportId(Buffer.from([0x00, 0xA3, 1]), [0xA3])), [0xA3, 1]);
  assert.deepEqual(Array.from(hp.stripLeadingReportId(Buffer.from([0xA3, 1]), [0xA3])), [0xA3, 1]);
  assert.deepEqual(Array.from(hp.stripLeadingReportId(Buffer.from([0x00, 0x55]), [0xA3])), [0x00, 0x55]);
  assert.deepEqual(hp.stripLeadingReportId([0x00, 0x01, 2], [0x01]), [0x01, 2]);   // plain arrays too
});

test('openDevice: a refused seize falls back to the shared open and tags the handle; a refused shared open throws', () => {
  const calls = [];
  const HID = { HID: class {
    constructor(p, opts) {
      calls.push(opts ? [p, opts] : [p]);
      if (p === '/dev/touch' && opts && opts.nonExclusive === false) throw new Error('cannot open device with path /dev/touch (seize refused)');
      if (p === '/dev/blocked') throw new Error('cannot open device with path /dev/blocked');
    }
  } };
  const seized = hp.openDevice(HID, '/dev/ok', 'darwin', { seize: true });
  assert.equal(seized.hidOpenMode, 'seized');
  assert.equal(seized.hidOpenFallback, undefined);
  const shared = hp.openDevice(HID, '/dev/touch', 'darwin', { seize: true });
  assert.equal(shared.hidOpenMode, 'shared');
  assert.match(shared.hidOpenFallback, /seize refused/);
  assert.equal(hp.openDevice(HID, '/dev/ok', 'darwin').hidOpenMode, 'shared');
  assert.equal(hp.openDevice(HID, '/dev/ok', 'win32', { seize: true }).hidOpenMode, 'default');
  assert.throws(() => hp.openDevice(HID, '/dev/blocked', 'darwin', { seize: true }), /cannot open device/);
  assert.deepEqual(calls.slice(1, 3), [['/dev/touch', { nonExclusive: false }], ['/dev/touch', { nonExclusive: true }]], 'seize first, then the shared open');
  assert.deepEqual(calls.slice(-2), [['/dev/blocked', { nonExclusive: false }], ['/dev/blocked', { nonExclusive: true }]], 'both modes are tried before giving up');
});
