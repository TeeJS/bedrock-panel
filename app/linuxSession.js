'use strict';
/*
 * linuxSession.js — what kind of Linux session this is, and the one launch decision that depends on
 * it. Pure (no electron require) so it unit-tests in isolation, like runMode.js.
 *
 * Why this exists: Bedrock Panel must run on Chromium's X11 backend on Linux, through XWayland when
 * the session is Wayland. A Wayland client is not allowed to place itself in global screen
 * coordinates, and Panel mode is nothing but placement — measured on KDE Plasma 6.6 with the panel
 * display in landscape at 1920,0 1920x480, the page ends up 1952x522 at 1904,-10 under wayland and
 * exactly 1920x480 at 1920,0 under x11. The X11 backend also keeps globalShortcut and robotjs
 * working; neither has a native Wayland path.
 *
 * The trap: `app.commandLine.appendSwitch('ozone-platform', 'x11')` DOES NOT WORK. Chromium picks
 * the ozone platform before the main script runs, so the switch only reaches child processes — their
 * argv reads --ozone-platform=x11 while the browser process is still Wayland, which looks fixed and
 * is not. ELECTRON_OZONE_PLATFORM_HINT does not work either. The flag has to be on our own argv, so
 * main.js relaunches once with it when it is missing.
 */

/** 'wayland' | 'x11' | null (unknown / not Linux). Session type as the desktop reports it. */
function sessionType({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'linux') return null;
  const declared = String(env.XDG_SESSION_TYPE || '').toLowerCase();
  if (declared === 'wayland' || declared === 'x11') return declared;
  if (env.WAYLAND_DISPLAY) return 'wayland';
  if (env.DISPLAY) return 'x11';
  return null;
}

/**
 * The --ozone-platform flag this process should have been started with, or null when it already has
 * one / does not need one. Returning a string means main.js should relaunch itself with it.
 *
 * BEDROCK_LINUX_OZONE overrides the choice; 'wayland' or 'auto' opts out entirely (fractional
 * scaling, say), at the cost of Panel mode.
 */
function ozoneRelaunchFlag({ platform = process.platform, argv = process.argv, env = process.env } = {}) {
  if (platform !== 'linux') return null;
  const choice = env.BEDROCK_LINUX_OZONE || 'x11';
  if (choice === 'wayland' || choice === 'auto') return null;
  if (argv.some(a => String(a).startsWith('--ozone-platform'))) return null;   // already relaunched, or set by hand
  if (sessionType({ platform, env }) !== 'wayland') return null;               // an X11 session is already what we want
  return '--ozone-platform=' + choice;
}

/**
 * What a Wayland session cannot do, for Device Diagnostics and the editor. Reported even after the
 * XWayland relaunch, because XWayland only ever sees other X11 clients: a window list taken there
 * misses every native Wayland window, which is worse than saying the feature is unavailable.
 */
function unavailableFeatures({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'linux' || sessionType({ platform, env }) !== 'wayland') return [];
  return [
    { key: 'reservedDisplay', label: 'Reserved Display', why: 'Wayland does not let an application move another application\'s windows.' },
    { key: 'foregroundFollow', label: 'Follow the focused app', why: 'Wayland does not tell an application which other window has focus.' },
  ];
}

module.exports = { sessionType, ozoneRelaunchFlag, unavailableFeatures };
