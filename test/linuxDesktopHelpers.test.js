'use strict';
// The Linux desktop helpers — now playing, system volume, and which app holds the microphone — as
// the app sees them: the helper table, and the contracts their scripts have to honour. No D-Bus and
// no audio server here, so it runs on any platform.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { helperPath, helperCommand, HELPERS } = require('../app/nativeHelpers');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'app', 'linux', name), 'utf8');

test('Linux supplies the three helpers whose absence left the Music page blank', () => {
  for (const feature of ['nowplayingMonitor', 'nowplayingControl', 'sysvolume', 'micSessionMonitor']) {
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
  assert.equal(helperPath('nowplayingMonitor', 'freebsd'), null, 'unknown platforms get nothing');
});

test('the helpers are executable, since the app runs them directly', () => {
  // Every caller execs the path the table returns. A Python script without the executable bit is a
  // helper that exists and cannot be run.
  for (const feature of ['nowplayingMonitor', 'sysvolume', 'micSessionMonitor']) {
    const p = helperPath(feature, 'linux');
    assert.ok(fs.statSync(p).mode & 0o111, path.basename(p) + ' is not executable');
    assert.match(fs.readFileSync(p, 'utf8').split('\n')[0], /^#!.*python3/, path.basename(p) + ' has no shebang');
  }
});

test('now playing answers both of its argv shapes from one script', () => {
  // The table points two features at one file on purpose: a monitor with no arguments, and a
  // one-shot control with a command. They are two shapes of one idea.
  assert.equal(helperPath('nowplayingMonitor', 'linux'), helperPath('nowplayingControl', 'linux'));
  const src = read('mpris.py');
  assert.match(src, /def monitor\(/);
  assert.match(src, /def control\(/);
  for (const cmd of ['playpause', 'next', 'prev']) assert.ok(src.includes("'" + cmd + "'"), cmd + ' is not handled');
  assert.match(src, /'PlayPause'|'Next'|'Previous'/, 'it has to call the MPRIS methods');
  assert.match(src, /sys\.argv/, 'the two modes are told apart by argv');
});

test('now playing reports the units and fields the app already reads', () => {
  const src = read('mpris.py');
  for (const field of ['title', 'artist', 'album', 'status', 'app', 'position', 'duration']) {
    assert.ok(src.includes("'" + field + "'"), field + ' is missing from the line');
  }
  // The Windows helper reports seconds; a helper reporting microseconds would show a progress bar
  // a million times too long.
  assert.match(src, /\/ 1e6/, 'MPRIS reports microseconds and the app expects seconds');
  assert.ok(src.includes("'art'"), 'MPRIS carries the art URL, which saves a second helper');
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
  for (const name of ['mpris.py', 'sysvolume.py', 'mic-monitor.py']) {
    assert.match(read(name), /sys\.stdin/, name + ' has no parent-death guard');
  }
});

test('a player that cannot be read this instant is not reported as silence', () => {
  // "{}" is defined as "no media session", and the app clears the display when it sees one. Reading
  // a player is three D-Bus round trips into another application, any of which can time out while
  // that application is busy — answering "{}" then tells the app the music stopped.
  const src = read('mpris.py');
  assert.match(src, /return None, True/, 'no players on the bus is the only certain "nothing"');
  assert.match(src, /if not snap and not certain/, 'an unreadable player must leave the last line standing');
  assert.match(src, /certain/, 'choose has to say whether "nothing" is a fact or a guess');
});

test('a Python helper is run as python3 <script>, like every one that works', () => {
  // Executed through its shebang instead, the now-playing helper ran and wrote continuously while
  // the app's stream for it reported readable, flowing, one listener and bytesRead=0 forever. Its
  // siblings, all launched this way in the same process, deliver fine. This also means a lost
  // executable bit cannot break a helper.
  for (const feature of ['nowplayingMonitor', 'nowplayingControl', 'sysvolume', 'micSessionMonitor']) {
    const cmd = helperCommand(feature, 'linux');
    assert.equal(cmd.command, 'python3', feature + ' should be run by the interpreter');
    assert.equal(cmd.args.length, 1);
    assert.match(cmd.args[0], /\.py$/);
  }
  // Windows and macOS helpers are executables and run themselves.
  assert.deepEqual(helperCommand('nowplayingMonitor', 'win32').args, []);
  assert.match(helperCommand('nowplayingMonitor', 'win32').command, /smtc-monitor\.exe$/);
  assert.equal(helperCommand('foregroundWatch', 'linux'), null, 'no helper means no command');
});
