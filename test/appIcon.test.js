'use strict';
// app/appIcon.js policy, with every platform call faked: which path each platform takes, and above
// all that a Mac never asks Electron for the 'large' icon (issue #67: SIGTRAP on macOS 26+).
const test = require('node:test');
const assert = require('node:assert/strict');
const { getAppIconDataUrl, MAC_ICON_PX } = require('../app/appIcon');
const { macAppName, hasPathSeparator } = require('../app/actionRunner');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_URL = 'data:image/png;base64,' + PNG.toString('base64');

function fakeDeps(over = {}) {
  const calls = { execFile: [], getFileIcon: [] };
  const deps = {
    platform: 'darwin',
    helper: '/fake/app-icon',
    execFile: (file, args, opts, cb) => { calls.execFile.push({ file, args, opts }); cb(null, PNG); },
    resolveAppPath: async v => (hasPathSeparator(v) ? v : null),
    getFileIcon: async (p, opts) => { calls.getFileIcon.push({ p, opts }); return { isEmpty: () => false, toDataURL: () => 'data:electron:' + opts.size }; },
    macAppName,
    hasPathSeparator,
    ...over,
  };
  return { deps, calls };
}

test('macOS with the helper: PNG bytes from the helper become a data URL, Electron is not asked', async () => {
  const { deps, calls } = fakeDeps();
  assert.equal(await getAppIconDataUrl('/Applications/Microsoft Outlook.app', deps), PNG_URL);
  assert.equal(calls.execFile.length, 1);
  assert.deepEqual(calls.execFile[0].args, ['/Applications/Microsoft Outlook.app', String(MAC_ICON_PX)]);
  assert.equal(calls.execFile[0].opts.encoding, 'buffer');
  assert.equal(calls.getFileIcon.length, 0);
});

test('macOS bare name goes to the helper as the `open -a` name, so a by-name tile gets its icon', async () => {
  const { deps, calls } = fakeDeps();
  assert.equal(await getAppIconDataUrl('outlook', deps), PNG_URL);
  assert.deepEqual(calls.execFile[0].args, ['Microsoft Outlook', String(MAC_ICON_PX)]);
  assert.equal(calls.getFileIcon.length, 0);
});

test('macOS helper failure falls back to Electron at "normal" — never "large"', async () => {
  const { deps, calls } = fakeDeps({ execFile: (f, a, o, cb) => cb(new Error('exit 1'), Buffer.alloc(0)) });
  assert.equal(await getAppIconDataUrl('/Applications/Foo.app', deps), 'data:electron:normal');
  assert.equal(calls.getFileIcon.length, 1);
  assert.equal(calls.getFileIcon[0].opts.size, 'normal');
});

test('macOS without a built helper uses Electron at "normal" — never "large"', async () => {
  const { deps, calls } = fakeDeps({ helper: null, execFile: () => { throw new Error('must not run'); } });
  assert.equal(await getAppIconDataUrl('/Applications/Foo.app', deps), 'data:electron:normal');
  assert.equal(calls.getFileIcon[0].opts.size, 'normal');
  for (const c of calls.getFileIcon) assert.notEqual(c.opts.size, 'large');
});

test('Windows and Linux keep Electron at "large" and never spawn the helper', async () => {
  for (const platform of ['win32', 'linux']) {
    const { deps, calls } = fakeDeps({ platform, execFile: () => { throw new Error('must not run'); } });
    assert.equal(await getAppIconDataUrl('C:\\Apps\\x.exe', deps), 'data:electron:large');
    assert.equal(calls.getFileIcon[0].opts.size, 'large');
  }
});

test('null for a missing value, an unresolved path, an empty icon, or a throwing dependency', async () => {
  assert.equal(await getAppIconDataUrl('', fakeDeps().deps), null);
  assert.equal(await getAppIconDataUrl(42, fakeDeps().deps), null);
  const unresolved = fakeDeps({ platform: 'win32', resolveAppPath: async () => null });
  assert.equal(await getAppIconDataUrl('nope', unresolved.deps), null);
  const empty = fakeDeps({ platform: 'win32', getFileIcon: async () => ({ isEmpty: () => true }) });
  assert.equal(await getAppIconDataUrl('C:\\x.exe', empty.deps), null);
  const throwing = fakeDeps({ platform: 'win32', getFileIcon: async () => { throw new Error('boom'); } });
  assert.equal(await getAppIconDataUrl('C:\\x.exe', throwing.deps), null);
  const helperThrows = fakeDeps({ execFile: () => { throw new Error('spawn EACCES'); } });
  assert.equal(await getAppIconDataUrl('/Applications/Foo.app', helperThrows.deps), 'data:electron:normal');
});
