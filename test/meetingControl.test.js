'use strict';
// Zoom/Teams call-control keystrokes: the per-OS shortcut tables (Microsoft's and Zoom's own
// published defaults) and the macOS rule that Zoom is brought to the front before a keystroke —
// Cmd+W (leave) would close a window in whatever app is in front otherwise. Focus is injected, so
// no window helper runs here.
const test = require('node:test');
const assert = require('node:assert/strict');
const mc = require('../app/meetingControl');

test('Teams tables: Windows unchanged; macOS is Microsoft\'s Mac column (accept video/audio are V and A, not a Ctrl->Cmd swap)', () => {
  assert.deepEqual(mc.TEAMS_COMBOS.win32, { mute: 'control+shift+m', acceptVideo: 'control+shift+a', acceptAudio: 'control+shift+s', decline: 'control+shift+d', hangup: 'control+shift+h', video: 'control+shift+o', share: 'control+shift+e', fullscreen: 'f11' });
  assert.deepEqual(mc.TEAMS_COMBOS.darwin, { mute: 'command+shift+m', acceptVideo: 'command+shift+v', acceptAudio: 'command+shift+a', decline: 'command+shift+d', hangup: 'command+shift+h', video: 'command+shift+o', share: 'command+shift+e', fullscreen: 'f11' });
  assert.equal(mc.comboTable(mc.TEAMS_COMBOS, 'linux'), mc.TEAMS_COMBOS.win32, 'unknown platforms get the Windows table');
  assert.equal(mc.TEAMS_COMBO, mc.comboTable(mc.TEAMS_COMBOS, process.platform));
});

test('Zoom tables: Windows defaults unchanged; macOS defaults from Zoom\'s hot-key list (Cmd+W is the leave prompt)', () => {
  assert.deepEqual(mc.ZOOM_COMBOS.win32, { mute: 'alt+a', video: 'alt+v', accept: 'control+shift+a', decline: 'control+shift+d', leave: 'alt+q', share: 'alt+s', fullscreen: 'alt+f' });
  assert.deepEqual(mc.ZOOM_COMBOS.darwin, { mute: 'command+shift+a', video: 'command+shift+v', accept: 'control+shift+a', decline: 'control+shift+d', leave: 'command+w', share: 'command+shift+s', fullscreen: 'command+shift+f' });
  assert.equal(mc.ZOOM_DEFAULT_COMBO, mc.comboTable(mc.ZOOM_COMBOS, process.platform));
});

test('sendZoomAction on Windows taps without touching focus (Zoom\'s Global Shortcut does the rest)', async () => {
  const taps = []; let focusCalls = 0;
  const r = await mc.sendZoomAction('alt+a', { platform: 'win32', mediaKeys: { tapCombo: c => { taps.push(c); return true; } }, focus: async () => { focusCalls++; return { ok: true }; } });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(taps, ['alt+a']);
  assert.equal(focusCalls, 0);
});

test('sendZoomAction on macOS brings Zoom to the front first and withholds the keystroke when it cannot', async () => {
  const taps = []; const focused = [];
  const deps = { platform: 'darwin', settleMs: 0, mediaKeys: { tapCombo: c => { taps.push(c); return true; } }, focus: async names => { focused.push(names); return { ok: true }; } };
  assert.deepEqual(await mc.sendZoomAction('command+w', deps), { ok: true, focused: true });
  assert.deepEqual(focused, [['Zoom']]);
  assert.deepEqual(taps, ['command+w']);
  const r = await mc.sendZoomAction('command+w', { ...deps, focus: async () => ({ ok: false, error: 'Application window not found.' }) });
  assert.equal(r.ok, false);
  assert.equal(r.focused, false);
  assert.match(r.error, /nothing was sent/);
  assert.deepEqual(taps, ['command+w'], 'nothing reached whatever app was in front');
  assert.deepEqual(await mc.sendZoomAction('', deps), { ok: false, error: 'no combo configured for this action' });
});

test('sendTeamsAction focuses Teams (injected here) and sends this platform\'s combo', async () => {
  const taps = []; let focusCalls = 0;
  const r = await mc.sendTeamsAction('hangup', { settleMs: 0, mediaKeys: { tapCombo: c => { taps.push(c); return true; } }, focus: async () => { focusCalls++; return { ok: true }; } });
  assert.deepEqual(r, { ok: true, focused: true, focusError: undefined });
  assert.equal(focusCalls, 1);
  assert.deepEqual(taps, [mc.TEAMS_COMBO.hangup]);
  const bad = await mc.sendTeamsAction('nope', { mediaKeys: { tapCombo: () => true } });
  assert.equal(bad.ok, false);
});

test('macOS Zoom actions press the Meeting menu item through the helper; no focus, no keystroke', async () => {
  const taps = []; const presses = []; let focusCalls = 0;
  const deps = { platform: 'darwin', action: 'mute', settleMs: 0, mediaKeys: { tapCombo: c => { taps.push(c); return true; } },
    focus: async () => { focusCalls++; return { ok: true }; }, pressMenu: async (names, titles) => { presses.push([names, titles]); return { ok: true, pressed: 'Unmute Audio' }; } };
  assert.deepEqual(await mc.sendZoomAction('command+shift+a', deps), { ok: true, method: 'menu', pressed: 'Unmute Audio' });
  assert.deepEqual(presses, [[['Zoom'], ['Mute Audio', 'Unmute Audio']]]);
  assert.deepEqual(taps, []);
  assert.equal(focusCalls, 0);
  assert.deepEqual(mc.ZOOM_MENU_ITEMS.leave, ['Leave Meeting', 'End Meeting']);
  assert.deepEqual(mc.ZOOM_MENU_ITEMS.video, ['Stop Video', 'Start Video']);
});

test('macOS Zoom: not running / not in a meeting is reported, nothing is sent; unreadable menu falls back to the focused keystroke', async () => {
  const taps = []; const focused = [];
  const base = { platform: 'darwin', action: 'leave', settleMs: 0, mediaKeys: { tapCombo: c => { taps.push(c); return true; } }, focus: async n => { focused.push(n); return { ok: true }; } };
  const off = await mc.sendZoomAction('command+w', { ...base, pressMenu: async () => ({ ok: false, code: 'NOTFOUND', error: 'the app is not running' }) });
  assert.equal(off.ok, false); assert.equal(off.code, 'NOTFOUND'); assert.match(off.error, /^Zoom: /);
  const idle = await mc.sendZoomAction('command+w', { ...base, pressMenu: async () => ({ ok: false, code: 'DISABLED', error: 'greyed out' }) });
  assert.equal(idle.ok, false); assert.equal(idle.code, 'DISABLED');
  assert.deepEqual(taps, [], 'no keystroke when Zoom is absent or idle');
  const localized = await mc.sendZoomAction('command+w', { ...base, pressMenu: async () => ({ ok: false, code: 'NOITEM', error: 'no such item' }) });
  assert.deepEqual(localized, { ok: true, focused: true });
  assert.deepEqual(focused, [['Zoom']]);
  assert.deepEqual(taps, ['command+w'], 'keystroke path after focusing Zoom');
  const win = await mc.sendZoomAction('alt+q', { platform: 'win32', action: 'leave', mediaKeys: { tapCombo: c => { taps.push(c); return true; } }, pressMenu: async () => { throw new Error('never on Windows'); } });
  assert.deepEqual(win, { ok: true });
});
