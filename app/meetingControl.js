'use strict';
/*
 * meetingControl.js — call-control actions for Zoom and Microsoft Teams. [MIT]
 *
 * Zoom: sends the keystroke combo the user has configured in the editor's Meeting app
 * options, which must match whatever they've assigned (and enabled "Global Shortcut" for)
 * inside Zoom's own Settings -> Keyboard Shortcuts. No focus-forcing needed -- Zoom's own
 * global-shortcut mechanism handles background operation once set up on Zoom's side.
 *
 * Teams: the local third-party API was retired by Microsoft on 2026-06-30 (see PROJECT.md).
 * The only remaining mechanism is Teams' own keyboard shortcuts, which require Teams to be
 * the focused window -- so we force-focus it first. The naive SetForegroundWindow call is
 * routinely blocked by Windows' foreground-lock protection when called from a background
 * process; AttachThreadInput to the current foreground thread first is the standard workaround.
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// Window find/focus via the bundled foreground-watch.exe helper (native/foreground-watch.cs) —
// one signed exe instead of a powershell.exe spawn per panel tap, which endpoint-security tools
// flag as malware-like churn. Same AttachThreadInput focus technique, now compiled.
const { helperPath } = require('./nativeHelpers');
const FGWATCH_EXE = helperPath('foregroundWatch');   // null on platforms without a window helper

// Fixed Teams shortcuts (Ctrl+Shift+...), confirmed against Microsoft's own support docs.
// Unlike Zoom these aren't user-configurable, so there's nothing to expose in the editor.
const TEAMS_COMBO = {
  mute: 'control+shift+m',
  acceptVideo: 'control+shift+a',
  acceptAudio: 'control+shift+s',
  decline: 'control+shift+d',
  hangup: 'control+shift+h',
  video: 'control+shift+o',
};

// Zoom's real shipped default keybinds (Settings -> Keyboard Shortcuts, before any user
// customization), confirmed against Zoom's own support docs. Used when the Meeting app's "Use
// Zoom's default keymappings" option is on (the default) -- most users never touch Zoom's own
// shortcut settings, so these just work without any setup. "leave" opens Zoom's leave/end
// confirmation dialog rather than leaving instantly; the user still confirms it once in Zoom.
const ZOOM_DEFAULT_COMBO = {
  mute: 'alt+a',
  video: 'alt+v',
  accept: 'control+shift+a',
  decline: 'control+shift+d',
  leave: 'alt+q',
};

function normalizeProcessNames(processNames) {
  return (Array.isArray(processNames) ? processNames : [])
    .map(name => String(name || '').replace(/\.exe$/i, ''))
    .filter(name => /^[A-Za-z0-9._-]+$/.test(name));
}

// mode 'focus' | 'find'; both print OK / NOTFOUND, mirroring the retired PowerShell scripts.
function runWindowHelper(mode, processNames, missingWord) {
  if (!FGWATCH_EXE) return Promise.resolve({ ok: false, error: 'No window helper on this platform' });
  const names = normalizeProcessNames(processNames);
  if (!names.length) return Promise.resolve({ ok: false, error: 'No process names supplied' });
  if (!fs.existsSync(FGWATCH_EXE)) return Promise.resolve({ ok: false, error: 'foreground-watch helper missing (native helpers not built)' });
  return new Promise(resolve => {
    execFile(FGWATCH_EXE, [mode, ...names], { windowsHide: true, timeout: 5000 }, (err, stdout, stderr) => {
      const trimmed = String(stdout || '').trim();
      if (trimmed === 'OK') return resolve({ ok: true });
      if (trimmed === 'NOTFOUND') return resolve({ ok: false, error: 'Application window not found.' });
      resolve({ ok: false, error: String(stderr || '').trim() || (err && err.message) || ('unknown ' + missingWord + ' failure') });
    });
  });
}

function focusProcessWindow(processNames) { return runWindowHelper('focus', processNames, 'focus'); }

function hasProcessWindow(processNames) { return runWindowHelper('find', processNames, 'process check'); }

function focusTeamsWindow() {
  return focusProcessWindow(['ms-teams', 'Teams']);
}

// Force-focus Teams, then send the fixed shortcut. Focus failure doesn't block the keystroke --
// if Teams happens to already be focused, or the user doesn't mind, the keystroke can still land.
async function sendTeamsAction(action, deps) {
  const combo = TEAMS_COMBO[action];
  if (!combo) return { ok: false, error: 'unknown Teams action: ' + action };
  const focus = await focusTeamsWindow();
  await new Promise(r => setTimeout(r, 150));   // let the foreground switch settle before the keystroke
  const sent = deps.mediaKeys.tapCombo(combo);
  return { ok: sent, focused: focus.ok, focusError: focus.ok ? undefined : focus.error };
}

// No focus-forcing -- `combo` is whatever the user configured (and enabled "Global Shortcut"
// for) inside Zoom's own Settings -> Keyboard Shortcuts.
function sendZoomAction(combo, deps) {
  if (!combo) return { ok: false, error: 'no combo configured for this action' };
  const sent = deps.mediaKeys.tapCombo(combo);
  return { ok: sent };
}

module.exports = { TEAMS_COMBO, ZOOM_DEFAULT_COMBO, focusProcessWindow, focusTeamsWindow, hasProcessWindow, sendTeamsAction, sendZoomAction };
