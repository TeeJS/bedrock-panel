'use strict';

// Pure run-mode helpers, shared by main.js and unit tests (main.js itself pulls in electron/node-hid
// and can't be required in isolation). Run mode decides how the app presents itself:
//   'panel'    - frameless full-screen on the DK-QUAKE / open-bedrock display (the original behavior)
//   'software' - a normal resizable desktop window; no special hardware needed
//   'monitor'  - the QUAKE shows the Windows desktop (panel hidden)
// Unset/unknown resolves to 'panel' so existing installs (no runMode saved) are unchanged — only a
// fresh install triggers the first-run picker.
function resolveRunMode(settings) {
  const m = settings && settings.runMode;
  return (m === 'software' || m === 'monitor') ? m : 'panel';
}

// The reserved-display helper keeps foreign windows off the QUAKE panel display. It only makes sense
// when the UI is actually on the device, so it's forced off in software mode regardless of the saved
// toggle; in panel/monitor mode it follows the user's reservedDisplay setting.
function reservedDisplayEnabled(settings) {
  if (resolveRunMode(settings) === 'software') return false;
  return !!(settings && settings.reservedDisplay);
}

// macOS: the display-arrange helper keeps the QUAKE display at the far right of the arrangement
// (never mirrored, never the main display) so the cursor cannot wander onto it. Same gating as the
// reserved display: pointless in software mode, otherwise the user's panelFarRight setting.
function panelFarRightEnabled(settings) {
  if (resolveRunMode(settings) === 'software') return false;
  return !!(settings && settings.panelFarRight);
}

module.exports = { resolveRunMode, reservedDisplayEnabled, panelFarRightEnabled };
