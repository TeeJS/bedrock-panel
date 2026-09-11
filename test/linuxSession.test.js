'use strict';
// linuxSession: the session probe and the one launch decision that depends on it. The relaunch guard
// is the load-bearing part — get it wrong in the "already has the flag" direction and the app
// relaunches itself forever.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionType, ozoneRelaunchFlag, unavailableFeatures } = require('../app/linuxSession');

const linux = extra => Object.assign({ platform: 'linux', argv: ['/opt/app/bedrock-panel'], env: {} }, extra);

test('sessionType prefers what the desktop declares, then falls back to the sockets', () => {
  assert.equal(sessionType({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland' } }), 'wayland');
  assert.equal(sessionType({ platform: 'linux', env: { XDG_SESSION_TYPE: 'X11' } }), 'x11', 'case tolerant');
  assert.equal(sessionType({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }), 'wayland');
  assert.equal(sessionType({ platform: 'linux', env: { DISPLAY: ':0' } }), 'x11');
  // A Wayland session also exports DISPLAY for XWayland, so the Wayland socket has to win.
  assert.equal(sessionType({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } }), 'wayland');
  assert.equal(sessionType({ platform: 'linux', env: {} }), null);
  assert.equal(sessionType({ platform: 'win32', env: { WAYLAND_DISPLAY: 'wayland-0' } }), null);
  assert.equal(sessionType({ platform: 'darwin', env: {} }), null);
});

test('a Wayland session is relaunched onto X11, and nothing else is', () => {
  assert.equal(ozoneRelaunchFlag(linux({ env: { WAYLAND_DISPLAY: 'wayland-0' } })), '--ozone-platform=x11');
  assert.equal(ozoneRelaunchFlag(linux({ env: { XDG_SESSION_TYPE: 'wayland' } })), '--ozone-platform=x11');
  assert.equal(ozoneRelaunchFlag(linux({ env: { DISPLAY: ':0' } })), null, 'an X11 session is already right');
  assert.equal(ozoneRelaunchFlag(linux({ env: {} })), null, 'no session info: leave it alone');
  assert.equal(ozoneRelaunchFlag({ platform: 'win32', argv: [], env: { WAYLAND_DISPLAY: 'wayland-0' } }), null);
  assert.equal(ozoneRelaunchFlag({ platform: 'darwin', argv: [], env: { WAYLAND_DISPLAY: 'wayland-0' } }), null);
});

test('the relaunch never recurses: an existing --ozone-platform flag ends it', () => {
  const env = { WAYLAND_DISPLAY: 'wayland-0' };
  // This is exactly the argv the relaunched process sees, and it must come back null.
  assert.equal(ozoneRelaunchFlag({ platform: 'linux', argv: ['.', '--ozone-platform=x11'], env }), null);
  assert.equal(ozoneRelaunchFlag({ platform: 'linux', argv: ['.', '--ozone-platform=wayland'], env }), null,
    'someone asking for wayland by hand is obeyed, not overridden');
  assert.equal(ozoneRelaunchFlag({ platform: 'linux', argv: ['.', '--ozone-platform-hint=auto'], env }), null);
});

test('BEDROCK_LINUX_OZONE overrides the choice and can opt out entirely', () => {
  const w = 'wayland-0';
  assert.equal(ozoneRelaunchFlag(linux({ env: { WAYLAND_DISPLAY: w, BEDROCK_LINUX_OZONE: 'wayland' } })), null, 'opted out');
  assert.equal(ozoneRelaunchFlag(linux({ env: { WAYLAND_DISPLAY: w, BEDROCK_LINUX_OZONE: 'auto' } })), null, 'opted out');
  assert.equal(ozoneRelaunchFlag(linux({ env: { WAYLAND_DISPLAY: w, BEDROCK_LINUX_OZONE: 'x11' } })), '--ozone-platform=x11');
});

test('the Wayland-only casualties are named, and only on Wayland', () => {
  const on = unavailableFeatures({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } });
  assert.deepEqual(on.map(f => f.key), ['reservedDisplay', 'foregroundFollow']);
  for (const f of on) assert.ok(f.label && /Wayland/.test(f.why), f.key + ' needs a reason naming Wayland');
  assert.deepEqual(unavailableFeatures({ platform: 'linux', env: { DISPLAY: ':0' } }), []);
  assert.deepEqual(unavailableFeatures({ platform: 'win32', env: {} }), []);
  assert.deepEqual(unavailableFeatures({ platform: 'darwin', env: {} }), []);
});

test('main.js relaunches instead of using appendSwitch, which silently does not work', () => {
  // Chromium picks the ozone platform before the main script runs: appendSwitch reaches only child
  // processes, so their argv reads --ozone-platform=x11 while the browser process is still Wayland.
  // That looked fixed for a whole release cycle. Keep it out of main.js.
  const fs = require('fs');
  const path = require('path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /appendSwitch\(\s*['"]ozone-platform/, 'appendSwitch cannot set the ozone platform');
  assert.match(main, /linuxSession\.ozoneRelaunchFlag\(\)/);
  assert.match(main, /app\.relaunch\(/);
});
