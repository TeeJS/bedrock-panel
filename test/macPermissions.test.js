'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createMacPermissions, PANES, SETTINGS_URL } = require('../app/macPermissions');

function fakePrefs({ trusted = false, mic = 'not-determined', screen = 'denied' } = {}) {
  const calls = [];
  return {
    calls,
    isTrustedAccessibilityClient(prompt) { calls.push(['axs', prompt]); return trusted; },
    getMediaAccessStatus(kind) { calls.push(['status', kind]); return kind === 'microphone' ? mic : screen; },
    async askForMediaAccess(kind) { calls.push(['ask', kind]); return kind === 'microphone'; },
  };
}

test('off macOS everything reports unsupported and never touches the OS', async () => {
  const prefs = fakePrefs();
  const p = createMacPermissions({ platform: 'win32', systemPreferences: prefs, shell: { openExternal: async () => { throw new Error('no'); } } });
  assert.deepStrictEqual(p.status(), { supported: false, platform: 'win32' });
  assert.deepStrictEqual(await p.request('microphone'), { ok: false, reason: 'unsupported' });
  assert.strictEqual(await p.openSettings('microphone'), false);
  assert.strictEqual(p.ensureTrusted(), true);       // keystrokes always deliverable off macOS
  assert.deepStrictEqual(prefs.calls, []);
});

test('status maps Electron statuses and the Accessibility boolean', () => {
  const p = createMacPermissions({ platform: 'darwin', systemPreferences: fakePrefs({ trusted: true, mic: 'granted', screen: 'not-determined' }) });
  assert.deepStrictEqual(p.status(), { supported: true, platform: 'darwin', accessibility: 'granted', microphone: 'granted', screen: 'not-determined' });
});

test('ensureTrusted prompts the OS once, then keeps answering without prompting', () => {
  const prefs = fakePrefs({ trusted: false });
  const logs = [];
  const p = createMacPermissions({ platform: 'darwin', systemPreferences: prefs, log: m => logs.push(m) });
  assert.strictEqual(p.ensureTrusted(), false);
  assert.strictEqual(p.ensureTrusted(), false);
  const prompts = prefs.calls.filter(c => c[0] === 'axs' && c[1] === true);
  assert.strictEqual(prompts.length, 1);
  assert.strictEqual(logs.length, 1);
});

test('request drives the prompts we can, and says so for the ones we cannot', async () => {
  const prefs = fakePrefs({ trusted: true, screen: 'granted' });
  let sources = 0;
  const p = createMacPermissions({ platform: 'darwin', systemPreferences: prefs, desktopCapturer: { async getSources() { sources++; return []; } } });
  assert.deepStrictEqual(await p.request('microphone'), { ok: true });
  assert.deepStrictEqual(await p.request('accessibility'), { ok: true });
  assert.deepStrictEqual(await p.request('screen'), { ok: true });
  assert.strictEqual(sources, 1);
  assert.deepStrictEqual(await p.request('localNetwork'), { ok: false, reason: 'system-prompted-on-first-use' });
});

test('openSettings deep-links known panes only', async () => {
  const opened = [];
  const p = createMacPermissions({ platform: 'darwin', systemPreferences: fakePrefs(), shell: { async openExternal(u) { opened.push(u); } } });
  assert.strictEqual(await p.openSettings('screen'), true);
  assert.strictEqual(await p.openSettings('bogus'), false);
  assert.deepStrictEqual(opened, [SETTINGS_URL + PANES.screen]);
});
