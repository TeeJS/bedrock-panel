'use strict';
// app/displayArrange.js against a fake execFile standing in for native/mac/display-arrange: check first,
// fix only on the helper's fixable exit codes, serialized runs, and a no-op without a helper.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDisplayArrange, EXIT } = require('../app/displayArrange');

// `script[cmd]` = { code, out } or a function returning one (per call).
function fakeExec(script) {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push([file, ...args]);
    const spec = typeof script[args[0]] === 'function' ? script[args[0]]() : script[args[0]];
    if (spec.throw) throw new Error(spec.throw);
    const err = spec.code === 0 ? null : Object.assign(new Error('exit ' + spec.code), { code: spec.code });
    setImmediate(() => cb(err, spec.out || '', spec.err || ''));
  };
  return { calls, execFile };
}
const status = (code, extra) => JSON.stringify(Object.assign({ code, valid: code === 0, mirrored: code === 2, panelIsMain: false, farRight: code !== 3 }, extra)) + '\n';

test('without a helper (other platforms) everything is a no-op', async () => {
  const fake = fakeExec({});
  const d = createDisplayArrange({ platform: 'win32', execFile: fake.execFile, helperPath: null });
  assert.equal(d.available, false);
  d.setEnabled(true);
  d.request('x');
  assert.deepEqual(await d.runNow('x'), { code: null, skipped: true });
  assert.deepEqual(fake.calls, []);
});

test('a valid arrangement is checked and left alone; disabled means not even checked', async () => {
  const fake = fakeExec({ check: { code: 0, out: status(0) } });
  const logs = [];
  const d = createDisplayArrange({ platform: 'darwin', execFile: fake.execFile, helperPath: '/x/display-arrange', log: m => logs.push(m) });
  assert.equal(d.available, true);
  assert.deepEqual(await d.runNow('boot'), { code: null, skipped: true });   // not enabled yet
  d.setEnabled(true);
  const r = await d.runNow('boot');
  assert.equal(r.code, EXIT.VALID);
  assert.equal(r.fixed, false);
  assert.equal(r.info.valid, true);
  assert.deepEqual(fake.calls, [['/x/display-arrange', 'check']]);
  assert.deepEqual(logs, []);
});

test('a mis-arranged or mirrored panel display is fixed, logged, and reported through onFixed', async () => {
  for (const code of [EXIT.FIXABLE, EXIT.MIRRORED]) {
    const fake = fakeExec({ check: { code, out: status(code) }, fix: { code: 0, out: status(0, { changed: ['panel-to-3648,0'] }) } });
    const logs = [], fixed = [];
    const d = createDisplayArrange({ platform: 'darwin', execFile: fake.execFile, helperPath: '/x/display-arrange', log: m => logs.push(m), onFixed: (res, chk) => fixed.push([res.changed, chk]) });
    d.setEnabled(true);
    const r = await d.runNow('display added');
    assert.equal(r.fixed, true);
    assert.equal(r.code, EXIT.VALID);
    assert.deepEqual(fake.calls.map(c => c[1]), ['check', 'fix']);
    assert.deepEqual(fixed, [[['panel-to-3648,0'], code]]);
    assert.match(logs[0], code === EXIT.MIRRORED ? /mirrored/ : /far right/);
    assert.match(logs[1], /arrangement fixed: \["panel-to-3648,0"\]/);
  }
});

test('no panel display, a failing check, and a failing fix are logged, never retried in a loop', async () => {
  const none = fakeExec({ check: { code: EXIT.NO_PANEL, out: status(4) } });
  const d = createDisplayArrange({ platform: 'darwin', execFile: none.execFile, helperPath: '/x/display-arrange' });
  d.setEnabled(true);
  assert.equal((await d.runNow('x')).code, EXIT.NO_PANEL);
  assert.equal(none.calls.length, 1);

  const bad = fakeExec({ check: { code: 1, out: '', err: 'CGGetOnlineDisplayList failed' } });
  const logs = [];
  const e = createDisplayArrange({ platform: 'darwin', execFile: bad.execFile, helperPath: '/x/display-arrange', log: m => logs.push(m) });
  e.setEnabled(true);
  assert.equal((await e.runNow('x')).code, 1);
  assert.match(logs[0], /check failed \(x\): exit 1 CGGetOnlineDisplayList failed/);

  const fixFails = fakeExec({ check: { code: EXIT.FIXABLE, out: status(3) }, fix: { code: 1, out: status(3), err: 'CGCompleteDisplayConfiguration failed: 1000' } });
  const logs2 = [], fixed = [];
  const f = createDisplayArrange({ platform: 'darwin', execFile: fixFails.execFile, helperPath: '/x/display-arrange', log: m => logs2.push(m), onFixed: () => fixed.push(1) });
  f.setEnabled(true);
  const r = await f.runNow('x');
  assert.equal(r.fixed, false);
  assert.equal(r.code, 1);
  assert.deepEqual(fixed, []);
  assert.match(logs2[1], /fix failed: exit 1 CGCompleteDisplayConfiguration failed/);

  const spawnFails = fakeExec({ check: { throw: 'ENOENT' } });
  const logs3 = [];
  const g = createDisplayArrange({ platform: 'darwin', execFile: spawnFails.execFile, helperPath: '/x/display-arrange', log: m => logs3.push(m) });
  g.setEnabled(true);
  assert.equal((await g.runNow('x')).code, EXIT.ERROR);
  assert.match(logs3[0], /check failed \(x\): exit 1 ENOENT/);
});

test('request debounces a burst into one check, runs are serialized, and stop cancels a pending request', async () => {
  let checks = 0;
  const fake = fakeExec({ check: () => { checks++; return { code: 0, out: status(0) }; } });
  const d = createDisplayArrange({ platform: 'darwin', execFile: fake.execFile, helperPath: '/x/display-arrange', debounceMs: 5 });
  d.setEnabled(true);
  d.request('a'); d.request('b'); d.request('c');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(checks, 1, 'three requests in a burst = one check');
  const p1 = d.runNow('one'), p2 = d.runNow('two');
  await Promise.all([p1, p2]);
  assert.equal(checks, 3);
  d.request('pending');
  d.stop();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(checks, 3, 'stop drops the pending request');
  assert.equal(d.isEnabled(), false);
});
