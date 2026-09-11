'use strict';
// The Linux keystroke backend: the pure name/char -> evdev mapping, and the helper wrapper with an
// injected spawn. Nothing here touches /dev/uinput, so it runs on any platform.
const test = require('node:test');
const assert = require('node:assert/strict');
const keymap = require('../app/linuxKeymap');
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
  assert.match(helperScript('/opt/app/resources/app.asar/app'), /app\.asar\.unpacked\/app\/linux\/uinput-helper\.py$/);
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

test('Monitor mode reports itself unavailable on Linux instead of moving a dead cursor', () => {
  const logs = [];
  const stub = { warmUp() {}, stop() {}, available: () => true, isReady: () => true, failure: () => null,
                 tap: () => true, keyDown() {}, keyUp() {}, typeString: () => true };
  const mk = createMediaKeys({ platform: 'linux', linuxInput: stub, log: m => logs.push(m) });
  mk.moveMouse(10, 10); mk.click('left'); mk.scroll(120); mk.mouseToggle(true, 'left');
  assert.equal(logs.length, 4);
  assert.match(logs[0], /Monitor mode needs pointer control/);
});
