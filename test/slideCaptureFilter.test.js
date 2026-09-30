'use strict';
// Slide-capture "Limit window picker to apps": the filter is a comma-separated list of process
// names; the panel picker lists windows from ANY of them. A pre-list single value still works.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlideCapture, parseAppFilter } = require('../app/slideCapture');

const WINDOWS = [
  { hwnd: 1, title: 'Meeting | Microsoft Teams', processName: 'ms-teams' },
  { hwnd: 2, title: 'Beyond the Pilot - Google Chrome', processName: 'chrome' },
  { hwnd: 3, title: 'Zoom Meeting', processName: 'Zoom' },
  { hwnd: 4, title: 'Teams (Mac)', processName: 'Microsoft Teams' },
];

async function titlesFor(filter) {
  const sc = createSlideCapture({
    resolveSettings: () => ({ slideCaptureEnabled: true, slideAppFilter: filter }),
    resolveActiveRecording: () => null,
    listApps: async () => WINDOWS,
    log: () => {},
  });
  return (await sc.listWindows()).map(w => w.name);
}

test('two apps: windows from either, nothing else', async () => {
  assert.deepEqual(await titlesFor('ms-teams,chrome'),
    ['Meeting | Microsoft Teams', 'Beyond the Pilot - Google Chrome']);
});

test('pre-list single value still filters to that one app', async () => {
  assert.deepEqual(await titlesFor('ms-teams'), ['Meeting | Microsoft Teams']);
});

test('blank filter lists every window', async () => {
  assert.equal((await titlesFor('')).length, WINDOWS.length);
  assert.equal((await titlesFor(undefined)).length, WINDOWS.length);
});

test('case and spacing around separators are ignored', async () => {
  assert.deepEqual(await titlesFor(' MS-Teams ;  zoom '), ['Meeting | Microsoft Teams', 'Zoom Meeting']);
});

test('names with spaces (macOS) stay whole', () => {
  assert.deepEqual([...parseAppFilter('Microsoft Teams, chrome')], ['microsoft teams', 'chrome']);
});
