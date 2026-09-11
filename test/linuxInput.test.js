'use strict';
// The Linux keystroke and pointer backend: the pure name/char -> evdev mapping, the pure pixel ->
// absolute mapping, and the helper wrapper with an injected spawn. Nothing here touches /dev/uinput,
// so it runs on any platform.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const keymap = require('../app/linuxKeymap');
const pointer = require('../app/linuxPointer');
const { createLinuxInput, helperScript } = require('../app/linuxInput');
const { createMediaKeys } = require('../app/mediaKeys');

// ---- keymap -------------------------------------------------------------------------------

test('the key names main.js actually sends all have codes', () => {
  // These are the literal strings app/main.js and the robotjs backend pass in. A null here is a
  // macro or a media key that silently does nothing.
  for (const name of ['audio_play', 'audio_next', 'audio_prev', 'audio_stop',
                      'audio_mute', 'audio_vol_up', 'audio_vol_down',
                      'control', 'shift', 'alt', 'command',
                      'v', 'c', 'a', 'escape', 'enter', 'tab', 'space', 'backspace', 'delete',
                      'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
                      'f1', 'f5', 'f11', 'f12', '0', '9']) {
    assert.equal(typeof keymap.codeFor(name), 'number', name + ' has no Linux key code');
  }
  assert.equal(keymap.codeFor('no-such-key'), null);
  assert.equal(keymap.codeFor(null), null);
});

test('the four modifiers are recognised as modifiers and map to the left-hand keys', () => {
  assert.deepEqual(
    ['control', 'shift', 'alt', 'command'].map(keymap.codeFor),
    [29, 42, 56, 125], 'KEY_LEFTCTRL / LEFTSHIFT / LEFTALT / LEFTMETA');
  for (const m of ['control', 'shift', 'alt', 'command']) assert.equal(keymap.isModifier(m), true);
  assert.equal(keymap.isModifier('v'), false);
});

test('characters map to a key plus whether shift is needed', () => {
  assert.deepEqual(keymap.charToKey('a'), { code: 30, shift: false });
  assert.deepEqual(keymap.charToKey('A'), { code: 30, shift: true }, 'uppercase is shift + the same key');
  assert.deepEqual(keymap.charToKey('1'), { code: 2, shift: false });
  assert.deepEqual(keymap.charToKey('!'), { code: 2, shift: true }, 'shifted digit');
  assert.deepEqual(keymap.charToKey(' '), { code: 57, shift: false });
  assert.deepEqual(keymap.charToKey('\n'), { code: 28, shift: false }, 'newline is Enter');
  assert.deepEqual(keymap.charToKey('?'), { code: 53, shift: true });
  assert.equal(keymap.charToKey('é'), null, 'no key for it on a US layout');
  assert.equal(keymap.charToKey('ab'), null, 'one character only');
});

test('typing skips what it cannot map rather than failing the whole macro', () => {
  const { taps, skipped } = keymap.textToTaps('Hi é!');
  assert.deepEqual(skipped, ['é']);
  assert.deepEqual(taps.map(t => t.code), [35, 23, 57, 2], 'H i space !');
  assert.deepEqual(taps.map(t => t.mods.length), [1, 0, 0, 1], 'shift for H and for !');
});

test('allCodes covers every code the maps can produce, because the device declares them up front', () => {
  const codes = keymap.allCodes();
  assert.ok(codes.length > 60, 'got ' + codes.length);
  assert.deepEqual(codes, [...codes].sort((a, b) => a - b), 'sorted');
  assert.equal(new Set(codes).size, codes.length, 'no duplicates');
  for (const name of ['audio_play', 'command', 'f12', '/']) assert.ok(codes.includes(keymap.codeFor(name)), name + ' missing from the declared set');
  for (const t of keymap.textToTaps('Hello, World! 42').taps) assert.ok(codes.includes(t.code));
});

// ---- the helper wrapper -------------------------------------------------------------------

function fakeChild() {
  const writes = [];
  const handlers = {};
  return {
    writes, handlers,
    stdin: { destroyed: false, write(s) { writes.push(s.trim()); return true; }, end() { this.destroyed = true; } },
    stdout: { on(ev, fn) { handlers['stdout:' + ev] = fn; } },
    stderr: { on(ev, fn) { handlers['stderr:' + ev] = fn; } },
    on(ev, fn) { handlers[ev] = fn; },
    kill() { this.killed = true; },
  };
}
function inputWith(extra) {
  const child = fakeChild();
  const logs = [];
  const spawned = [];
  const input = createLinuxInput(Object.assign({
    spawn: (...a) => { spawned.push(a); return child; },
    log: m => logs.push(m),
  }, extra));
  return { input, child, logs, spawned };
}

test('the helper is spawned once, with python3 and the full key set', () => {
  const { input, child, spawned } = inputWith();
  input.warmUp();
  input.warmUp();
  assert.equal(spawned.length, 1, 'idempotent');
  const [bin, args] = spawned[0];
  assert.equal(bin, 'python3');
  assert.match(args[0], /uinput-helper\.py$/);
  assert.deepEqual(args[1].split(',').map(Number), keymap.allCodes(), 'declares every code it can send');
  child.handlers['stdout:data']('ready\n');
  assert.equal(input.isReady(), true);
});

test('taps and combos become the helper protocol, modifiers after the key', () => {
  const { input, child } = inputWith();
  input.tap('v', ['control']);
  input.tap('audio_play');
  input.keyUp('shift');
  input.keyDown('alt');
  assert.deepEqual(child.writes, ['tap 47 29', 'tap 164', 'key 42 0', 'key 56 1']);
});

test('an unknown key name is reported, not sent', () => {
  const { input, child, logs } = inputWith();
  assert.equal(input.tap('nonsense'), false);
  assert.deepEqual(child.writes, []);
  assert.match(logs.join(' '), /no Linux key code for "nonsense"/);
});

test('typing sends one tap per character and says what it skipped', () => {
  const { input, child, logs } = inputWith();
  input.typeString('Hé!');
  assert.deepEqual(child.writes, ['tap 35 42', 'tap 2 42'], 'H then !, both with shift');
  assert.match(logs.join(' '), /skipped 1 character/);
});

test('a helper that refuses the job is permanent, and never respawned per keystroke', () => {
  const { input, child, logs } = inputWith();
  input.warmUp();
  child.handlers.exit(3);                       // 3 = no permission on /dev/uinput
  assert.equal(input.available(), false);
  assert.match(logs.join(' '), /keystrokes unavailable/);
  const before = child.writes.length;
  assert.equal(input.tap('v', ['control']), false);
  assert.equal(child.writes.length, before, 'nothing sent after a permanent failure');
});

test('an ordinary exit is not permanent — the next keystroke starts a new helper', () => {
  const { input, child, spawned } = inputWith();
  input.warmUp();
  child.handlers.exit(0);
  assert.equal(input.available(), true);
  input.tap('v');
  assert.equal(spawned.length, 2, 'respawned on demand');
});

test('a python3 that is not installed fails once and stays failed', () => {
  const logs = [];
  const input = createLinuxInput({ spawn: () => { throw new Error('spawn python3 ENOENT'); }, log: m => logs.push(m) });
  input.warmUp();
  assert.equal(input.available(), false);
  assert.match(logs.join(' '), /cannot start python3/);
  assert.equal(input.tap('v'), false);
});

test('the helper path reaches outside the asar, since python cannot open a file inside it', () => {
  // Asserted with path.join rather than a written-out path: these tests run on whatever machine the
  // suite runs on, and a path built by path.join is backslashed off Linux. The claim is about where
  // the helper lives, not about which character separates the parts of a path.
  const script = helperScript(path.join('/opt/app/resources/app.asar', 'app'));
  assert.ok(script.includes('app.asar.unpacked'), 'still inside the archive: ' + script);
  assert.ok(script.endsWith(path.join('app.asar.unpacked', 'app', 'linux', 'uinput-helper.py')), script);
});

// ---- mediaKeys on Linux --------------------------------------------------------------------

test('createMediaKeys on Linux uses the uinput backend, not robotjs', () => {
  const calls = [];
  const stub = {
    warmUp: () => calls.push(['warmUp']), stop: () => calls.push(['stop']),
    available: () => true, isReady: () => true, failure: () => null,
    tap: (k, m) => { calls.push(['tap', k, m || []]); return true; },
    keyDown: k => calls.push(['down', k]), keyUp: k => calls.push(['up', k]),
    typeString: t => { calls.push(['type', t]); return true; },
  };
  const mk = createMediaKeys({ platform: 'linux', linuxInput: stub, log: () => {} });
  mk.transport('playpause');
  mk.volume(1); mk.volume(-1); mk.volume('mute');
  mk.pasteShortcut();
  mk.tapCombo('ctrl+shift+c');
  mk.typeString('hi');
  assert.deepEqual(calls, [
    ['tap', 'audio_play', []],
    ['tap', 'audio_vol_up', []], ['tap', 'audio_vol_down', []], ['tap', 'audio_mute', []],
    ['tap', 'v', ['control']],
    ['tap', 'c', ['control', 'shift']],
    ['type', 'hi'],
  ]);
  assert.equal(mk.available(), true);
});

test('Monitor mode drives the virtual pointer, with the desktop bounds read per move', () => {
  const calls = [];
  const stub = { warmUp() {}, stop() {}, available: () => true, isReady: () => true, failure: () => null,
                 tap: () => true, keyDown() {}, keyUp() {}, typeString: () => true,
                 warmUpPointer: () => calls.push(['warmUpPointer']),
                 movePointer: (x, y, b) => calls.push(['move', x, y, b && b.width]),
                 pointerButton: (n, d) => calls.push(['btn', n, d]),
                 scroll: dy => calls.push(['scroll', dy]) };
  // Two displays, and the second one appears between the two moves: the box must be re-read, not cached.
  let displays = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
  const mk = createMediaKeys({ platform: 'linux', linuxInput: stub, log: () => {},
                               desktopBounds: () => pointer.unionBounds(displays) });
  mk.warmUpPointer();
  mk.moveMouse(100, 200);
  displays = displays.concat([{ bounds: { x: 1920, y: 0, width: 1920, height: 480 } }]);
  mk.moveMouse(2400, 300);
  mk.mouseToggle(true, 'left');
  mk.mouseToggle(false, 'left');
  mk.click('right');
  mk.scroll(-120);
  assert.deepEqual(calls, [
    ['warmUpPointer'],
    ['move', 100, 200, 1920],
    ['move', 2400, 300, 3840],
    ['btn', 'left', true], ['btn', 'left', false],
    ['btn', 'right', true], ['btn', 'right', false],   // a click is a press and a release
    ['scroll', -120],
  ]);
});

test('the robotjs backend answers warmUpPointer too, so main.js need not know the backend', () => {
  const mk = createMediaKeys({ platform: 'win32', log: () => {} });
  assert.equal(typeof mk.warmUpPointer, 'function');
  mk.warmUpPointer();
});

// ---- the pointer mapping ------------------------------------------------------------------

test('the desktop box is every display, because the absolute scale is stretched across all of them', () => {
  assert.deepEqual(pointer.unionBounds([{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]),
                   { x: 0, y: 0, width: 1920, height: 1080 });
  // The real arrangement: the QUAKE to the right of a laptop screen.
  assert.deepEqual(pointer.unionBounds([{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
                                        { bounds: { x: 1920, y: 0, width: 1920, height: 480 } }]),
                   { x: 0, y: 0, width: 3840, height: 1080 });
  // A display left of and above the primary gives negative origins, which the mapping subtracts.
  assert.deepEqual(pointer.unionBounds([{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
                                        { bounds: { x: -1280, y: -200, width: 1280, height: 1024 } }]),
                   { x: -1280, y: -200, width: 3200, height: 1280 });
  assert.equal(pointer.unionBounds([]), null);
  assert.equal(pointer.unionBounds(null), null);
});

test('a screen pixel maps to an absolute value that lands back on the same pixel', () => {
  // The compositor rounds when it maps the value back — measured against KWin's own cursor position.
  // So the mapping is right exactly when the round trip is the identity, which is what this asserts.
  const box = { x: 0, y: 0, width: 3840, height: 1080 };
  const backX = ax => Math.round(ax / pointer.ABS_MAX * box.width);
  const backY = ay => Math.round(ay / pointer.ABS_MAX * box.height);
  for (const [x, y] of [[0, 0], [1, 1], [960, 540], [1920, 0], [2400, 300], [3000, 400], [3839, 1079]]) {
    const at = pointer.toAbsolute(x, y, box);
    assert.deepEqual([backX(at.ax), backY(at.ay)], [x, y], 'round trip for ' + x + ',' + y);
  }
});

test('the mapping is relative to the box origin, so a display left of the primary still works', () => {
  const box = { x: -1280, y: -200, width: 3200, height: 1280 };
  assert.deepEqual(pointer.toAbsolute(-1280, -200, box), { ax: 0, ay: 0 }, 'the top-left of the box');
  assert.deepEqual(pointer.toAbsolute(1920, 1080, box), { ax: pointer.ABS_MAX, ay: pointer.ABS_MAX });
});

test('a position off the desktop is clamped, and an unusable box is declined', () => {
  const box = { x: 0, y: 0, width: 3840, height: 1080 };
  assert.deepEqual(pointer.toAbsolute(-500, 9000, box), { ax: 0, ay: pointer.ABS_MAX });
  assert.equal(pointer.toAbsolute(10, 10, null), null);
  assert.equal(pointer.toAbsolute(10, 10, { x: 0, y: 0, width: 0, height: 0 }), null);
  assert.equal(pointer.toAbsolute(NaN, 10, box), null);
});

test('scrolling converts wheel deltas to whole notches, and never rounds a real scroll to nothing', () => {
  assert.equal(pointer.toNotches(120), 1);
  assert.equal(pointer.toNotches(-120), -1, 'main.js sends -120 to scroll down');
  assert.equal(pointer.toNotches(360), 3);
  assert.equal(pointer.toNotches(10), 1, 'a small scroll still moves one notch');
  assert.equal(pointer.toNotches(-10), -1);
  assert.equal(pointer.toNotches(0), 0);
  assert.equal(pointer.toNotches(NaN), 0);
});

test('button names map to the three evdev buttons the helper accepts', () => {
  assert.deepEqual(['left', 'right', 'middle'].map(pointer.buttonCode), [0x110, 0x111, 0x112]);
  assert.equal(pointer.buttonCode('RIGHT'), 0x111);
  assert.equal(pointer.buttonCode('back'), null, 'the helper would reject it, so it never gets sent');
});

test('pointer commands become the helper protocol, and the device is asked for up front', () => {
  const { input, child } = inputWith();
  const box = { x: 0, y: 0, width: 3840, height: 1080 };
  input.warmUpPointer();
  input.movePointer(2400, 300, box);
  input.pointerButton('left', true);
  input.pointerButton('left', false);
  input.scroll(-120);
  assert.deepEqual(child.writes, ['pointer', 'move 40959 18204', 'btn 272 1', 'btn 272 0', 'wheel -1']);
});

test('a pointer command with nothing sensible to send is dropped, not guessed at', () => {
  const { input, child, logs } = inputWith();
  assert.equal(input.movePointer(10, 10, null), false, 'no desktop bounds yet');
  assert.equal(input.pointerButton('back', true), false, 'not a button the helper knows');
  assert.equal(input.scroll(0), false);
  assert.deepEqual(child.writes, []);
  assert.match(logs.join(' '), /desktop bounds are not known/);
  assert.match(logs.join(' '), /no Linux button for "back"/);
});

test('the pointer is reported ready or refused separately from the keyboard', () => {
  const { input, child, logs } = inputWith();
  input.warmUp();
  child.handlers['stdout:data']('ready\n');
  assert.equal(input.isReady(), true);
  assert.equal(input.isPointerReady(), false, 'the pointer is not made until it is asked for');
  assert.equal(input.pointerAvailable(), true);
  child.handlers['stdout:data']('pointer ready\n');
  assert.equal(input.isPointerReady(), true);
  assert.match(logs.join(' '), /virtual pointer ready/);
});

test('a pointer the helper cannot create is permanent, and does not take keystrokes down with it', () => {
  const { input, child } = inputWith();
  input.warmUp();
  child.handlers['stdout:data']('ready\n');
  child.handlers['stdout:data']('err cannot create pointer: [Errno 13] Permission denied\n');
  assert.equal(input.pointerAvailable(), false);
  assert.equal(input.available(), true, 'macros and media keys still work');
  assert.equal(input.isPointerReady(), false);
});
