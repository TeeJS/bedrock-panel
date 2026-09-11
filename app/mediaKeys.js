'use strict';
// Media key adapter — @jitsi/robotjs on Windows and macOS, a uinput virtual keyboard on Linux.
// Keeps the { transport(cmd), volume(v), pasteShortcut() } interface so main.js
// doesn't know the backend.
//
// Linux: robotjs is NOT used. It drives XTEST, which does not deliver under XWayland — it loads,
// reports success, and the keystroke arrives nowhere (measured: typing into this app's own focused
// window produced an empty field). app/linuxInput.js creates uinput devices instead, which the
// kernel presents as a real keyboard and a real pointer, so the compositor routes them like any
// other. The pointer reports an absolute position across the whole desktop, so this backend needs
// to be told the desktop's bounding box — `desktopBounds`, injected by main.js from Electron's
// display list, since only the main process knows the current arrangement.
//
// macOS: robotjs posts CGEvents, which the OS silently drops until the app has the Accessibility
// permission — robotjs itself never throws. `ensureTrusted` (injected by main.js on darwin) says
// whether keystrokes will actually land and prompts the OS once, lazily, on first use; while it
// returns false every method is a no-op that reports failure, so callers can fall back or explain.

// Macro key combos: map friendly tokens to robotjs names. Modifiers robotjs knows: control/shift/alt/command.
const MOD_ALIAS = { ctrl: 'control', control: 'control', ctl: 'control', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt', win: 'command', cmd: 'command', command: 'command', meta: 'command', super: 'command' };
const KEY_ALIAS = { esc: 'escape', escape: 'escape', del: 'delete', 'delete': 'delete', ins: 'insert', insert: 'insert', 'return': 'enter', enter: 'enter', space: 'space', spacebar: 'space', tab: 'tab', backspace: 'backspace', bksp: 'backspace', up: 'up', down: 'down', left: 'left', right: 'right', pgup: 'pageup', pageup: 'pageup', pgdn: 'pagedown', pagedown: 'pagedown', home: 'home', end: 'end', plus: '+' };

// Split "control+shift+c" into its modifiers and its one key, using the aliases above. Shared by
// both backends so a macro means the same thing on every platform.
function parseCombo(combo) {
  const toks = String(combo || '').split('+').map(s => s.trim().toLowerCase()).filter(Boolean);
  const mods = []; let key = null;
  for (const t of toks) {
    if (MOD_ALIAS[t]) { if (!mods.includes(MOD_ALIAS[t])) mods.push(MOD_ALIAS[t]); }
    else key = KEY_ALIAS[t] || t;
  }
  return { mods, key };
}

// Linux backend. Same surface as the robotjs one.
function createLinuxMediaKeys({ log, linuxInput, desktopBounds }) {
  const input = linuxInput || require('./linuxInput').createLinuxInput({ log: m => log('[input] ' + m) });
  const TRANSPORT = { playpause: 'audio_play', next: 'audio_next', prev: 'audio_prev', stop: 'audio_stop' };
  // Asked for on every move rather than cached: displays come and go, and the QUAKE arriving is
  // exactly the moment Monitor mode is used, so a stale box would aim at the wrong screen.
  const bounds = typeof desktopBounds === 'function' ? desktopBounds : () => null;
  return {
    warmUp() { input.warmUp(); },
    transport(cmd) { const k = TRANSPORT[cmd]; return k ? input.tap(k) : false; },
    volume(v) { input.tap(v === 'mute' ? 'audio_mute' : (v > 0 ? 'audio_vol_up' : 'audio_vol_down')); },
    pasteShortcut() { return input.tap('v', ['control']); },
    available() { return input.available(); },
    // ---- monitor mode. The pointer device is made on demand, so entering the mode warms it up and
    // the first touch is not swallowed by device settle time.
    warmUpPointer() { input.warmUpPointer(); },
    moveMouse(x, y) { input.movePointer(x, y, bounds()); },
    mouseToggle(down, button) { input.pointerButton(button || 'left', !!down); },
    click(button) { input.pointerButton(button || 'left', true); input.pointerButton(button || 'left', false); },
    scroll(dy) { input.scroll(dy); },
    tapKey(name) { input.tap(name); },
    keyUp(name) { input.keyUp(name); },
    tapCombo(combo) {
      const { mods, key } = parseCombo(combo);
      if (!key) return false;
      return input.tap(key, mods);
    },
    typeString(text) { return (text == null || text === '') ? false : input.typeString(String(text)); },
    stop() { input.stop(); },
  };
}

function createMediaKeys({ log = () => {}, ensureTrusted = null, platform = process.platform, linuxInput = null, desktopBounds = null } = {}) {
  if (platform === 'linux') return createLinuxMediaKeys({ log, linuxInput, desktopBounds });
  let robot = null;
  try { robot = require('@jitsi/robotjs'); }
  catch (e) {
    try { robot = require('robotjs'); }
    catch (e2) { log('robotjs unavailable (media keys off): ' + e2.message); }
  }
  // The backend for this call, or null when input can't be delivered (module missing, or macOS
  // Accessibility not granted yet).
  const bot = () => (robot && (!ensureTrusted || ensureTrusted())) ? robot : null;

  return {
    // No-ops on the robotjs backend: it has no device to create and nothing to tear down. They exist
    // so main.js can call them without knowing which backend it got.
    warmUp() {},
    warmUpPointer() {},
    stop() {},
    transport(cmd) {
      const r = bot(); if (!r) return false;
      const map = { playpause: 'audio_play', next: 'audio_next', prev: 'audio_prev', stop: 'audio_stop' };
      const k = map[cmd];
      if (!k) return false;
      try { r.keyTap(k); return true; } catch (e) { return false; }
    },
    volume(v) {
      const r = bot(); if (!r) return;
      try {
        if (v === 'mute') r.keyTap('audio_mute');
        else r.keyTap(v > 0 ? 'audio_vol_up' : 'audio_vol_down');
      } catch (e) {}
    },
    // Used by the paste-text tile: sends Ctrl+V (Cmd+V on macOS) to the active foreground window.
    pasteShortcut() {
      const r = bot(); if (!r) return false;
      try { r.keyTap('v', process.platform === 'darwin' ? 'command' : 'control'); return true; } catch (e) { return false; }
    },
    // ---- monitor mode: the device (knob/touch) drives the OS cursor while the panel shows the desktop.
    // Driven only by trusted device input in the main process — never by web/renderer content.
    available() { return !!robot; },
    moveMouse(x, y) { const r = bot(); if (r) { try { r.moveMouse(x, y); } catch (e) {} } },
    mouseToggle(down, button) { const r = bot(); if (r) { try { r.mouseToggle(down ? 'down' : 'up', button || 'left'); } catch (e) {} } },
    click(button) { const r = bot(); if (r) { try { r.mouseClick(button || 'left'); } catch (e) {} } },
    scroll(dy) { const r = bot(); if (r) { try { r.scrollMouse(0, dy); } catch (e) {} } },
    tapKey(name) { const r = bot(); if (r) { try { r.keyTap(name); } catch (e) {} } },
    // Release a modifier (or any key) system-wide. Used by the global-shortcut handler to clear
    // the stuck-modifier state Win32 RegisterHotKey leaves behind when a hotkey with modifiers
    // fires while the user is still holding them. `name` is a robotjs key name (e.g. 'control').
    keyUp(name) { const r = bot(); if (r) { try { r.keyToggle(name, 'up'); } catch (e) {} } },
    // Macro: send a key combo like "control+shift+c". Last non-modifier token is the key.
    tapCombo(combo) {
      const r = bot(); if (!r) return false;
      const { mods, key } = parseCombo(combo);
      if (!key) return false;
      try { mods.length ? r.keyTap(key, mods) : r.keyTap(key); return true; }
      catch (e) { log('keyTap failed for "' + combo + '": ' + e.message); return false; }
    },
    // Macro: type literal text into the active window (does NOT touch the clipboard, unlike pasteShortcut).
    typeString(text) {
      const r = bot(); if (!r || text == null || text === '') return false;
      try { r.typeString(String(text)); return true; } catch (e) { log('typeString failed: ' + e.message); return false; }
    },
  };
}

module.exports = { createMediaKeys };
