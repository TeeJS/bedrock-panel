'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { helperPath, HELPERS } = require('../app/nativeHelpers');

test('helperPath resolves the platform binary next to app/native and rewrites the asar path', () => {
  const win = helperPath('sysvolume', 'win32', '/x/app.asar/app/native');
  assert.equal(win, path.join('/x/app.asar.unpacked/app/native', 'sysvolume.exe'));
  const mac = helperPath('sysvolume', 'darwin', '/x/app.asar/app/native');
  assert.equal(mac, path.join('/x/app.asar.unpacked/app/native', 'mac', 'sysvolume'));
});

test('helperPath is null where a platform has no helper for the feature', () => {
  assert.equal(helperPath('outlookMeeting', 'linux'), null);   // macOS has calendar-meeting for it since 2026-09
  assert.equal(helperPath('nowplayingArt', 'darwin'), null);
  // Linux gained sysvolume with the PipeWire helper; what it still has nothing for is anything that
  // needs to see or move another application's windows.
  assert.equal(helperPath('reservedDisplay', 'linux'), null);
  assert.equal(helperPath('foregroundWatch', 'linux'), null);
  assert.equal(helperPath('nowplayingArt', 'linux'), null);   // MPRIS carries the art URL itself
  assert.equal(helperPath('no-such-helper', 'win32'), null);
});

test('every Windows helper in the table matches a build-smtc.js target', () => {
  const fs = require('fs');
  const build = fs.readFileSync(path.join(__dirname, '..', 'build-smtc.js'), 'utf8');
  for (const [name, entry] of Object.entries(HELPERS)) {
    if (entry.win32) assert.ok(build.includes(entry.win32), name + ': ' + entry.win32 + ' is not built by build-smtc.js');
  }
});

test('every macOS helper in the table matches a build-mac-helpers.js target and has a Swift source', () => {
  const fs = require('fs');
  const build = fs.readFileSync(path.join(__dirname, '..', 'build-mac-helpers.js'), 'utf8');
  for (const [name, entry] of Object.entries(HELPERS)) {
    if (!entry.darwin) continue;
    const base = path.basename(entry.darwin);
    assert.ok(build.includes("name: '" + base + "'"), name + ': ' + base + ' is not built by build-mac-helpers.js');
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'native', 'mac', base + '.swift')), name + ': native/mac/' + base + '.swift missing');
  }
});
