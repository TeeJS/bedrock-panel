'use strict';
// The Linux desktop helpers — system volume, and which app holds the microphone — as the app sees
// them: the helper table, and the contracts their scripts have to honour. Now playing is not here;
// it is read on the session bus in-process (see linuxNowPlaying.test.js). No audio server is
// touched, so this runs on any platform.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { helperPath, helperCommand, HELPERS } = require('../app/nativeHelpers');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'app', 'linux', name), 'utf8');

test('Linux supplies the helpers whose absence left the meeting console blank', () => {
  for (const feature of ['sysvolume', 'micSessionMonitor']) {
    const p = helperPath(feature, 'linux');
    assert.ok(p, feature + ' has no Linux helper');
    assert.ok(fs.existsSync(p), feature + ' points at a file that is not there: ' + p);
  }
});

test('the helper table still says nothing for what Linux genuinely cannot do', () => {
  // A null here is the app's signal to report a feature unavailable. Inventing an entry that then
  // fails at runtime would be worse than admitting it up front.
  for (const feature of ['foregroundWatch', 'reservedDisplay', 'outlookMeeting', 'nowplayingArt']) {
    assert.equal(helperPath(feature, 'linux'), null, feature + ' should have no Linux helper');
  }
  // Now playing is not a helper on Linux at all: MPRIS is read on the session bus inside the app.
  for (const feature of ['nowplayingMonitor', 'nowplayingControl']) {
    assert.equal(helperPath(feature, 'linux'), null, feature + ' is read in-process, not by a helper');
  }
  assert.equal(helperPath('sysvolume', 'freebsd'), null, 'unknown platforms get nothing');
});

test('the helpers say how to run themselves', () => {
  for (const feature of ['sysvolume', 'micSessionMonitor']) {
    const p = helperPath(feature, 'linux');
    assert.match(fs.readFileSync(p, 'utf8').split('\n')[0], /^#!.*python3/, path.basename(p) + ' has no shebang');
  }
});

// Skipped off POSIX rather than rewritten: there is no executable bit on a Windows filesystem, so
// the question has no answer there. This is the mirror of how the DPAPI tests skip off Windows.
test('the helpers carry the executable bit', { skip: process.platform === 'win32' ? 'no executable bit on Windows' : false }, () => {
  // A Python script without it is a helper that exists and cannot be run, and the bit has to survive
  // packaging as well as the repository.
  for (const feature of ['sysvolume', 'micSessionMonitor']) {
    const p = helperPath(feature, 'linux');
    assert.ok(fs.statSync(p).mode & 0o111, path.basename(p) + ' is not executable');
  }
});

test('the audio watchers survive pactl buffering its output', () => {
  // pactl block-buffers into a pipe, so its events arrive in a burst or never. Without this the
  // volume rail never moves and a call never starts a recording — both looked like dead features.
  for (const name of ['sysvolume.py', 'mic-monitor.py']) {
    assert.match(read(name), /stdbuf/, name + ' will not see events until pactl exits');
  }
});

test('the mic monitor reports every capturing app, not a filtered one', () => {
  // The app re-derives its own answer per consumer: the recorder wants the first app on ITS list,
  // the busy light wants to know whether any app on its own list is present. Filtering here makes
  // that impossible, which is a bug class Windows already hit.
  const src = read('mic-monitor.py');
  assert.match(src, /'active'/);
  assert.match(src, /'apps'/);
  assert.match(src, /application\.process\.binary|application\.name/, 'names have to come from the stream');
  assert.match(src, /monitor/, 'a monitor source is loopback of playback, not a microphone');
});

test('every Linux helper dies with the app', () => {
  for (const name of ['sysvolume.py', 'mic-monitor.py']) {
    assert.match(read(name), /sys\.stdin/, name + ' has no parent-death guard');
  }
});

test('a Python helper is run as python3 <script>, not through its shebang', () => {
  // Launching the interpreter means a lost executable bit cannot break a helper, which matters once
  // the scripts have been through asar packing and unpacking.
  for (const feature of ['sysvolume', 'micSessionMonitor']) {
    const cmd = helperCommand(feature, 'linux');
    assert.equal(cmd.command, 'python3', feature + ' should be run by the interpreter');
    assert.equal(cmd.args.length, 1);
    assert.match(cmd.args[0], /\.py$/);
  }
  // Windows and macOS helpers are executables and run themselves.
  assert.deepEqual(helperCommand('nowplayingMonitor', 'win32').args, []);
  assert.match(helperCommand('nowplayingMonitor', 'win32').command, /smtc-monitor\.exe$/);
  assert.equal(helperCommand('foregroundWatch', 'linux'), null, 'no helper means no command');
  assert.equal(helperCommand('nowplayingMonitor', 'linux'), null, 'now playing has no Linux helper to run');
});
