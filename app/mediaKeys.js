'use strict';
// Media key adapter — @jitsi/robotjs backend (Windows and macOS).
// Keeps the { transport(cmd), volume(v), pasteShortcut() } interface so main.js
// doesn't know the backend. Swap this file to add platform backends later.
//
// macOS: robotjs posts CGEvents, which the OS silently drops until the app has the Accessibility
// permission — robotjs itself never throws. `ensureTrusted` (injected by main.js on darwin) says
// whether keystrokes will actually land and prompts the OS once, lazily, on first use; while it
// returns false every method is a no-op that reports failure, so callers can fall back or explain.

// Macro key combos: map friendly tokens to robotjs names. Modifiers robotjs knows: control/shift/alt/command.
const MOD_ALIAS = { ctrl: 'control', control: 'control', ctl: 'control', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt', win: 'command', cmd: 'command', command: 'command', meta: 'command', super: 'command' };
const KEY_ALIAS = { esc: 'escape', escape: 'escape', del: 'delete', 'delete': 'delete', ins: 'insert', insert: 'insert', 'return': 'enter', enter: 'enter', space: 'space', spacebar: 'space', tab: 'tab', backspace: 'backspace', bksp: 'backspace', up: 'up', down: 'down', left: 'left', right: 'right', pgup: 'pageup', pageup: 'pageup', pgdn: 'pagedown', pagedown: 'pagedown', home: 'home', end: 'end', plus: '+' };

function createMediaKeys({ log = () => {}, ensureTrusted = null } = {}) {
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
      const toks = String(combo || '').split('+').map(s => s.trim().toLowerCase()).filter(Boolean);
      const mods = []; let key = null;
      for (const t of toks) {
        if (MOD_ALIAS[t]) { if (!mods.includes(MOD_ALIAS[t])) mods.push(MOD_ALIAS[t]); }
        else key = KEY_ALIAS[t] || t;
      }
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
