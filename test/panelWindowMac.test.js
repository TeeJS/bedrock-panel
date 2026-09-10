'use strict';
// Source-level guards for the macOS kiosk panel window in app/main.js (main.js pulls in Electron and
// cannot be required here). Each of these was a real regression: a window option or a missing quit
// step that hung Cmd+Q or let the desktop show through on the DK-QUAKE.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
const panelOptions = src.slice(src.indexOf('function placePanel()'), src.indexOf("panelWin.loadFile(path.join(__dirname, 'index.html'))"));

test('the panel window stays closable: Electron cancels the whole quit when a window refuses to close', () => {
  assert.doesNotMatch(panelOptions, /closable:\s*false/, 'closable:false on the panel window hangs Cmd+Q (DK-Suite sets it and destroys its window by hand)');
  const beforeQuit = src.slice(src.indexOf("app.on('before-quit'"));
  assert.match(beforeQuit, /panelWin\.destroy\(\)/, 'before-quit must tear the panel down itself so the close pass cannot cancel the quit');
});

test('macOS panel window: plain cover of the display, never a (simple) full-screen window', () => {
  assert.match(panelOptions, /fullscreenable: false, hasShadow: false, roundedCorners: false, enableLargerThanScreen: true, alwaysOnTop: true/);
  assert.match(panelOptions, /focusable: process\.platform !== 'darwin' \|\| panelInputEnabled\(\)/, 'macOS: focusable only while mouse/keyboard use of the panel is on');
  assert.match(panelOptions, /acceptFirstMouse: process\.platform === 'darwin' && panelInputEnabled\(\)/, 'the first click presses the tile instead of just activating the window');
  const pin = src.slice(src.indexOf('function pinPanelMac('), src.indexOf('function placePanel()'));
  assert.match(pin, /setSimpleFullScreen\(false\)/, 'simple full screen is switched off if ever on (app-wide auto-hide presentation options)');
  assert.match(pin, /setAlwaysOnTop\(true, 'screen-saver', 1\)/, "DK-Suite's level: above the menu bar (24), Control Center items (25), the Dock (20)");
  assert.match(pin, /setIgnoreMouseEvents\(!panelInputEnabled\(\)\)/, 'touch-only mode is click-through; the default accepts the mouse like Windows');
  assert.match(pin, /setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: false \}\)/);
  assert.doesNotMatch(src.slice(src.indexOf('function applyPanelDisplayMode(')).split('\n').slice(0, 6).join('\n'), /setSimpleFullScreen\(true\)/);
});

test('macOS: the first touch of a gesture focuses the panel window when mouse/keyboard use is on, so pages driven by focus events work', () => {
  const touch = src.slice(src.indexOf("dev.on('touch'"), src.indexOf("dev.on('knob'"));
  assert.match(touch, /process\.platform === 'darwin' && panelInputEnabled\(\) && !panelWin\.isFocused\(\) && pts\.some\(p => p\.action === 1\)/, 'guarded by platform, the setting, and a real touch-down');
  assert.match(touch, /panelWin\.focus\(\)/);
  assert.match(touch, /panelWin\.webContents\.send\('touch', pts\)/, 'the touch still reaches the page');
});
