'use strict';
// appListTokens: what the Meeting tab's app pickers save, per platform. The invariant that matters:
// every saved Call-apps name survives the detector's own parser as ONE entry — a macOS app whose
// name has a space ("Microsoft Teams") is saved as its bundle id instead of splitting in two.

const test = require('node:test');
const assert = require('node:assert/strict');
const { forPlatform } = require('../app/appListTokens');
const { parseAppList } = require('../app/micMonitorRouting');
const { parseAppFilter } = require('../app/slideCapture');

const MAC_APPS = [
  { processName: 'zoom.us', bundleId: 'us.zoom.xos' },
  { processName: 'Microsoft Teams', bundleId: 'com.microsoft.teams2' },
  { processName: 'Google Chrome', bundleId: 'com.google.Chrome' },
  { processName: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' },
];
const WIN_APPS = [{ processName: 'ms-teams' }, { processName: 'Zoom' }, { processName: 'chrome' }];

test('win32 call apps: running app saved with .exe, the name the detector matches', () => {
  const { callApps } = forPlatform('win32');
  assert.deepEqual(WIN_APPS.map(callApps.fromApp), ['ms-teams.exe', 'Zoom.exe', 'chrome.exe']);
  assert.equal(callApps.fromApp({ processName: 'Code - Insiders' }), '', 'a spaced name cannot be saved');
});

test('win32 call apps: typed names get .exe, a pasted comma list splits, spaces are refused', () => {
  const { callApps } = forPlatform('win32');
  assert.deepEqual(callApps.fromTyped('zoom').tokens, ['zoom.exe']);
  assert.deepEqual(callApps.fromTyped('Zoom.exe, webex').tokens, ['Zoom.exe', 'webex.exe']);
  const bad = callApps.fromTyped('Code - Insiders');
  assert.ok(bad.error);
  assert.deepEqual(bad.tokens, []);
});

test('darwin call apps: spaced names are saved as the bundle id, others by name', () => {
  const { callApps } = forPlatform('darwin');
  assert.deepEqual(MAC_APPS.map(callApps.fromApp), ['zoom.us', 'com.microsoft.teams2', 'com.google.Chrome', 'Slack']);
  assert.equal(callApps.label(MAC_APPS[1], 'com.microsoft.teams2'), 'Microsoft Teams (com.microsoft.teams2)');
  assert.equal(callApps.label(MAC_APPS[0], 'zoom.us'), 'zoom.us');
  assert.equal(callApps.fromApp({ processName: 'Some App', bundleId: '' }), '', 'no bundle id -> left out, never saved broken');
});

test('darwin call apps: a typed name with a space is refused and points at the pulldown', () => {
  const { callApps } = forPlatform('darwin');
  const r = callApps.fromTyped('Microsoft Teams');
  assert.match(r.error, /running app/);
  assert.deepEqual(callApps.fromTyped('zoom').tokens, ['zoom'], 'no .exe added on macOS');
});

test('every saved call-app name is one entry to the detector (all platforms)', () => {
  for (const [platform, apps] of [['win32', WIN_APPS], ['darwin', MAC_APPS]]) {
    const { callApps } = forPlatform(platform);
    for (const a of apps) {
      const t = callApps.fromApp(a);
      if (!t) continue;
      assert.deepEqual([...parseAppList(t)], [t.toLowerCase()], platform + ' ' + a.processName);
    }
  }
});

test('the editor reads saved lists exactly as their consumers do', () => {
  const { callApps, slideFilter } = forPlatform('darwin');
  for (const s of ['Zoom.exe,Teams.exe', ' zoom.us ; Slack ', 'Zoom.exe Teams.exe', 'Microsoft Teams, chrome', '']) {
    assert.deepEqual(callApps.parse(s).map(x => x.toLowerCase()), [...parseAppList(s)], 'call apps: ' + s);
    assert.deepEqual(slideFilter.parse(s).map(x => x.toLowerCase()), [...parseAppFilter(s)], 'slide filter: ' + s);
  }
});

test('names compare case- and .exe-insensitively, so a pick never duplicates a typed name', () => {
  const { callApps } = forPlatform('win32');
  assert.equal(callApps.key('ms-teams.exe'), callApps.key('MS-Teams.EXE'.toLowerCase()));
  assert.equal(callApps.key(callApps.fromApp({ processName: 'Zoom' })), callApps.key('zoom.exe'));
});

test('slide filter: Windows strips .exe to match the window list; macOS keeps spaced names whole', () => {
  assert.deepEqual(forPlatform('win32').slideFilter.fromTyped('ms-teams.exe, chrome').tokens, ['ms-teams', 'chrome']);
  assert.deepEqual(forPlatform('darwin').slideFilter.fromTyped('Microsoft Teams').tokens, ['Microsoft Teams']);
  assert.equal(forPlatform('darwin').slideFilter.fromApp(MAC_APPS[1]), 'Microsoft Teams');
});
