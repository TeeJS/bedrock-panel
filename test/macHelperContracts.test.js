'use strict';
// The JS wrappers drive CAPTURED helper output, so the suite passes even if a Swift helper drifts from
// the contract the JS depends on. These assertions are the only link between the wrappers and the
// macOS helper sources — the same idea as the C# checks in meetingDefaultsSync.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = name => fs.readFileSync(path.join(__dirname, '..', 'native', 'mac', name), 'utf8');

test('mic-session-monitor emits the whole matching set as verbatim allowlist tokens, with no baseline line', () => {
  const s = src('mic-session-monitor.swift');
  assert.match(s, /"apps": apps/, 'the emitted JSON must carry the apps array app/micMonitorRouting.js reads');
  assert.match(s, /allow\.filter \{ matched\.contains\(\$0\.lowercased\(\)\) \}/, 'apps[] must be the caller\'s own tokens, verbatim, in allowlist order');
  assert.match(s, /active != lastActive \|\| now != lastApps/, 'the transition test must compare the whole set, not just the first match');
  assert.match(s, /if active \{ row\["app"\] = apps\[0\] \}/, '"app" stays the first match for older readers only');
  assert.doesNotMatch(s, /Out\.line\(Out\.json\(\["active": false/, 'no synthetic idle baseline: it reads as call-ended and splits recordings');
  assert.match(s, /exitWhenOrphaned/, 'spawned with stdin ignored, so the parent-death guard is the re-parenting check');
});

test('nowplaying-monitor speaks the smtc-monitor contract: status literals, both players, "{}" when idle', () => {
  const s = src('nowplaying-monitor.swift');
  for (const lit of ['"Playing"', '"Paused"', '"Stopped"']) assert.match(s, new RegExp(lit.replace(/"/g, '\\"')), lit + ' is compared verbatim by app/musicview.js');
  assert.match(s, /com\.spotify\.client\.PlaybackStateChanged/);
  assert.match(s, /com\.apple\.Music\.playerInfo/);
  assert.match(s, /com\.apple\.iTunes\.playerInfo/);
  for (const key of ['"title"', '"artist"', '"album"', '"status"', '"app"', '"position"', '"duration"', '"bundleId"']) assert.match(s, new RegExp(key.replace(/"/g, '\\"')), key + ' is a field app/nowplaying.js reads');
  assert.match(s, /var line = "\{\}"/, '"{}" means no media session');
  assert.match(s, /exitOnStdinEOF/, 'spawned with stdin piped');
});

test('sysvolume keeps the integer-line contract and -1 for no control', () => {
  const s = src('sysvolume.swift');
  assert.match(s, /return -1/);
  assert.match(s, /Out\.line\(String\(v\)\)/);
  assert.match(s, /exitOnStdinEOF/);
});

test('foreground-watch keeps the PascalCase rows and OK/NOTFOUND words', () => {
  const s = src('foreground-watch.swift');
  for (const key of ['"Hwnd"', '"ProcessName"', '"MainWindowTitle"', '"Minimized"']) assert.match(s, new RegExp(key.replace(/"/g, '\\"')), key + ' is read by app/desktopFocus.js');
  assert.match(s, /Out\.line\("OK"\)/);
  assert.match(s, /Out\.line\("NOTFOUND"\)/);
});

test('nowplaying-control prints "ok" and only addresses running players', () => {
  const s = src('nowplaying-control.swift');
  assert.match(s, /print\("ok", terminator: ""\)/);
  assert.match(s, /isRunning\(p\.bundleId\) \? p\.bundleId : nil/, 'an AppleScript tell would launch a player that is not running');
});

test('the Windows aliases cover the shipped meeting defaults', () => {
  const s = src('lib/Common.swift');
  const defaults = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8').match(/recordApps: '([^']+)'/)[1].split(',');
  for (const token of defaults) {
    const key = token.replace(/\.exe$/i, '').toLowerCase();
    assert.match(s, new RegExp('"' + key.replace(/[-]/g, '\\-') + '": \\['), 'meeting default ' + token + ' has no macOS bundle-id alias');
  }
});

test('reserved-display takes the Windows helper\'s commands and emits the events the controller logs', () => {
  const s = src('reserved-display.swift');
  for (const field of ['command', 'sequence', 'enabled', 'suspended', 'ownProcessId', 'reserved', 'displays']) assert.match(s, new RegExp('var ' + field), 'configure field ' + field);
  assert.match(s, /c\.command == "stop"/);
  for (const ev of ['"ready"', '"configured"', '"moved"', '"minimized"', '"restored"', '"permission"']) assert.match(s, new RegExp('emit\\(' + ev.replace(/"/g, '\\"')), 'event ' + ev);
  assert.match(s, /"fallback": how/, 'moved events name the placement fallback like the Windows helper');
  assert.match(s, /buttonState\(\.combinedSessionState, button: \.left\)/, 'never moves a window mid-drag');
  assert.match(s, /AXIsProcessTrusted\(\)/, 'reports the Accessibility permission instead of failing silently');
});
