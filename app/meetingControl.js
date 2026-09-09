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

// Fixed Teams shortcuts per OS, from Microsoft's "Keyboard shortcuts for Microsoft Teams" page
// (support.microsoft.com/en-us/accessibility/teams/keyboard-shortcuts-for-microsoft-teams, read
// 2026-09-09). The Mac column is not a plain Ctrl->Cmd swap: accept-with-video is Cmd+Shift+V and
// accept-audio-only is Cmd+Shift+A (classic Teams had them as A and S). Unlike Zoom these aren't
// user-configurable, so there's nothing to expose in the editor. Unknown platforms get Windows'.
const TEAMS_COMBOS = {
  win32: {
    mute: 'control+shift+m',
    acceptVideo: 'control+shift+a',
    acceptAudio: 'control+shift+s',
    decline: 'control+shift+d',
    hangup: 'control+shift+h',
    video: 'control+shift+o',
    share: 'control+shift+e',     // "toggle share content tray"
    fullscreen: 'f11',
  },
  darwin: {
    mute: 'command+shift+m',
    acceptVideo: 'command+shift+v',
    acceptAudio: 'command+shift+a',
    decline: 'command+shift+d',
    hangup: 'command+shift+h',
    video: 'command+shift+o',
    share: 'command+shift+e',
    fullscreen: 'f11',
  },
};
const comboTable = (tables, platform) => tables[platform] || tables.win32;
const TEAMS_COMBO = comboTable(TEAMS_COMBOS, process.platform);

// Zoom's real shipped default keybinds per OS (Settings -> Keyboard Shortcuts, before any user
// customization), from Zoom's "Hot keys and keyboard shortcuts" article (KB0067050, read
// 2026-09-09). Used when the Meeting app's "Use Zoom's default keymappings" option is on (the
// default) -- most users never touch Zoom's own shortcut settings, so these just work without any
// setup. "leave" opens Zoom's leave/end confirmation dialog rather than leaving instantly (Alt+Q on
// Windows; on the Mac Zoom has no leave key of its own and Cmd+W on the meeting window is the same
// prompt). The Zoom Phone accept/decline keys use Control on both platforms.
const ZOOM_COMBOS = {
  win32: {
    mute: 'alt+a',
    video: 'alt+v',
    accept: 'control+shift+a',
    decline: 'control+shift+d',
    leave: 'alt+q',
    share: 'alt+s',
    fullscreen: 'alt+f',
  },
  darwin: {
    mute: 'command+shift+a',
    video: 'command+shift+v',
    accept: 'control+shift+a',
    decline: 'control+shift+d',
    leave: 'command+w',
    share: 'command+shift+s',
    fullscreen: 'command+shift+f',
  },
};
const ZOOM_DEFAULT_COMBO = comboTable(ZOOM_COMBOS, process.platform);

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

// macOS: press an app's own menu-bar item through Accessibility (foreground-watch `menu`), app in
// the background. Resolves { ok, pressed } or { ok:false, code, error } with the helper's reason word.
const MENU_REASONS = {
  NOTFOUND: 'the app is not running',
  NOACCESS: 'Accessibility permission is missing for Bedrock Panel (System Settings → Privacy & Security → Accessibility)',
  NOMENU: 'the app has no menu bar to read',
  NOITEM: 'no menu item with that title (a non-English app?)',
  DISABLED: 'that menu item is greyed out (not in a meeting?)',
  FAILED: 'the menu item did not accept the press',
};
function pressMenuItem(processNames, titles) {
  if (!FGWATCH_EXE) return Promise.resolve({ ok: false, code: 'NOHELPER', error: 'No window helper on this platform' });
  const names = normalizeProcessNames(processNames);
  const wanted = (Array.isArray(titles) ? titles : []).map(t => String(t || '').trim()).filter(Boolean);
  if (!names.length || !wanted.length) return Promise.resolve({ ok: false, code: 'NOARGS', error: 'No process names or menu titles supplied' });
  if (!fs.existsSync(FGWATCH_EXE)) return Promise.resolve({ ok: false, code: 'NOHELPER', error: 'foreground-watch helper missing (native helpers not built)' });
  return new Promise(resolve => {
    execFile(FGWATCH_EXE, ['menu', ...names, '--', ...wanted], { windowsHide: true, timeout: 5000 }, (err, stdout, stderr) => {
      const line = String(stdout || '').trim();
      if (line.startsWith('OK')) return resolve({ ok: true, pressed: line.slice(2).trim() });
      const code = line.split(/\s/)[0] || 'ERROR';
      resolve({ ok: false, code, error: MENU_REASONS[code] || String(stderr || '').trim() || (err && err.message) || 'menu press failed' });
    });
  });
}

// macOS Zoom: the Meeting menu's own items, both states of each toggle. Zoom's English titles
// (zoom.us.app/Contents/Resources/en.lproj); a localized Zoom answers NOITEM and gets the keystroke.
const ZOOM_MENU_ITEMS = {
  mute: ['Mute Audio', 'Unmute Audio'],
  video: ['Stop Video', 'Start Video'],
  leave: ['Leave Meeting', 'End Meeting'],
  share: ['Share Screen'],
  fullscreen: ['Enter Full Screen', 'Exit Full Screen'],
};

function hasProcessWindow(processNames) { return runWindowHelper('find', processNames, 'process check'); }

function focusTeamsWindow() {
  return focusProcessWindow(['ms-teams', 'Teams']);
}

// Force-focus Teams, then send the fixed shortcut. Focus failure doesn't block the keystroke --
// if Teams happens to already be focused, or the user doesn't mind, the keystroke can still land.
async function sendTeamsAction(action, deps) {
  const combo = TEAMS_COMBO[action];
  if (!combo) return { ok: false, error: 'unknown Teams action: ' + action };
  const focus = await ((deps && deps.focus) || focusTeamsWindow)();
  await new Promise(r => setTimeout(r, settleMs(deps)));   // let the foreground switch settle before the keystroke
  const sent = deps.mediaKeys.tapCombo(combo);
  return { ok: sent, focused: focus.ok, focusError: focus.ok ? undefined : focus.error };
}

// Windows: no focus-forcing -- `combo` is whatever the user configured (and enabled "Global
// Shortcut" for) inside Zoom's own Settings -> Keyboard Shortcuts, and stealing focus from the
// user's notes is deliberately avoided. macOS: `deps.action` names a Meeting-menu item, which is
// pressed through Accessibility with Zoom in the background -- bringing Zoom to the front reopens
// it, Zoom raises its home window, the meeting shrinks into the mini window, and the keystroke
// lands on the wrong window (what T.J. saw: video half the time, "leave" only minimizing). Zoom
// not running or not in a meeting is reported as such. Only when the menu cannot be read (no
// Accessibility grant, a localized Zoom, no helper) does the keystroke path run: Zoom is brought to
// the front first and the keystroke is withheld when that fails -- Cmd+W (leave) would close a
// window in whatever app is in front, and Cmd+Shift+A / Cmd+Shift+V mean other things elsewhere.
const settleMs = deps => (deps && deps.settleMs != null) ? deps.settleMs : 150;
async function sendZoomAction(combo, deps) {
  const platform = (deps && deps.platform) || process.platform;
  const action = deps && deps.action;
  if (platform === 'darwin' && action && ZOOM_MENU_ITEMS[action]) {
    const menu = await ((deps && deps.pressMenu) || pressMenuItem)(['Zoom'], ZOOM_MENU_ITEMS[action]);
    if (menu.ok) return { ok: true, method: 'menu', pressed: menu.pressed };
    if (menu.code === 'NOTFOUND' || menu.code === 'DISABLED') return { ok: false, method: 'menu', code: menu.code, error: 'Zoom: ' + menu.error };
  }
  if (!combo) return { ok: false, error: 'no combo configured for this action' };
  if (platform !== 'darwin') return { ok: deps.mediaKeys.tapCombo(combo) };
  const focus = await ((deps && deps.focus) || focusProcessWindow)(['Zoom']);
  if (!focus.ok) return { ok: false, focused: false, focusError: focus.error, error: 'Zoom is not in front, so nothing was sent (' + (focus.error || 'window not found') + ')' };
  await new Promise(r => setTimeout(r, settleMs(deps)));
  return { ok: deps.mediaKeys.tapCombo(combo), focused: true };
}

module.exports = { TEAMS_COMBOS, ZOOM_COMBOS, ZOOM_MENU_ITEMS, comboTable, TEAMS_COMBO, ZOOM_DEFAULT_COMBO, focusProcessWindow, focusTeamsWindow, hasProcessWindow, pressMenuItem, sendTeamsAction, sendZoomAction };
