'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { launchApp, macAppName } = require('../app/actionRunner');

function macDeps(calls) {
  return {
    platform: 'darwin',
    execFile: (file, args, opts, cb) => { calls.push([file, ...args]); cb(null); },
    fs: { existsSync: () => false },
    shell: { openPath: async () => '' },
    log: () => {},
  };
}

test('macOS maps Windows program names to their Mac apps and passes real names through', async () => {
  const calls = [];
  const deps = macDeps(calls);
  assert.equal(await launchApp('chrome', deps), true);
  assert.equal(await launchApp('taskmgr.exe', deps), true);
  assert.equal(await launchApp('Calc', deps), true);
  assert.equal(await launchApp('Safari', deps), true);
  assert.deepEqual(calls, [
    ['/usr/bin/open', '-a', 'Google Chrome'],
    ['/usr/bin/open', '-a', 'Activity Monitor'],
    ['/usr/bin/open', '-a', 'Calculator'],
    ['/usr/bin/open', '-a', 'Safari'],
  ]);
  assert.equal(macAppName('Notepad.EXE'), 'TextEdit');
  assert.equal(macAppName('My Custom App'), 'My Custom App');
});

test('a failed open -a is logged instead of vanishing', async () => {
  const logs = [];
  const deps = macDeps([]);
  deps.execFile = (file, args, opts, cb) => cb(new Error('Unable to find application named "Nope"'));
  deps.log = m => logs.push(m);
  await launchApp('nope', deps);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /open -a "nope" failed/);
});
