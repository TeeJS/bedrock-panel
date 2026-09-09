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

// A stand-in for the `privacy` helper: `script` maps "mode kind" to the granted value it prints, or
// to a function (called per invocation, so a test can flip the answer after the prompt).
function fakeHelper(script) {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push([file, ...args]);
    const key = args.join(' ');
    const v = typeof script[key] === 'function' ? script[key]() : script[key];
    if (v === 'fail') return cb(new Error('spawn failed'));
    if (v === 'garbage') return cb(null, 'not json\n');
    cb(null, JSON.stringify({ granted: !!v }) + '\n');
  };
  return { calls, execFile };
}

test('off macOS everything reports unsupported and never touches the OS', async () => {
  const prefs = fakePrefs();
  const helper = fakeHelper({});
  const p = createMacPermissions({ platform: 'win32', systemPreferences: prefs, shell: { openExternal: async () => { throw new Error('no'); } }, helperPath: '/x/privacy', execFile: helper.execFile });
  assert.deepStrictEqual(await p.status(), { supported: false, platform: 'win32' });
  assert.deepStrictEqual(await p.request('microphone'), { ok: false, reason: 'unsupported' });
  assert.strictEqual(await p.openSettings('microphone'), false);
  assert.strictEqual(p.ensureTrusted(), true);       // keystrokes always deliverable off macOS
  assert.strictEqual(p.canPromptInputMonitoring, false);
  assert.deepStrictEqual(prefs.calls, []);
  assert.deepStrictEqual(helper.calls, []);
});

test('status maps Electron statuses and the Accessibility boolean; Input Monitoring only with the helper', async () => {
  const p = createMacPermissions({ platform: 'darwin', systemPreferences: fakePrefs({ trusted: true, mic: 'granted', screen: 'not-determined' }) });
  assert.deepStrictEqual(await p.status(), { supported: true, platform: 'darwin', accessibility: 'granted', microphone: 'granted', screen: 'not-determined' });
  assert.strictEqual(p.canPromptInputMonitoring, false);

  const helper = fakeHelper({ 'preflight listenEvent': true });
  const q = createMacPermissions({ platform: 'darwin', systemPreferences: fakePrefs(), helperPath: '/x/privacy', execFile: helper.execFile });
  assert.strictEqual(q.canPromptInputMonitoring, true);
  assert.strictEqual((await q.status()).inputMonitoring, 'granted');
  assert.deepStrictEqual(helper.calls, [['/x/privacy', 'preflight', 'listenEvent']]);

  const denied = fakeHelper({ 'preflight listenEvent': false });
  assert.strictEqual((await createMacPermissions({ platform: 'darwin', systemPreferences: fakePrefs(), helperPath: '/x/privacy', execFile: denied.execFile }).status()).inputMonitoring, 'denied');

  // A helper that fails or prints nonsense leaves the field out (the editor then says "check in System Settings").
  for (const v of ['fail', 'garbage']) {
    const broken = fakeHelper({ 'preflight listenEvent': v });
    const logs = [];
    const st = await createMacPermissions({ platform: 'darwin', systemPreferences: fakePrefs(), helperPath: '/x/privacy', execFile: broken.execFile, log: m => logs.push(m) }).status();
    assert.strictEqual('inputMonitoring' in st, false);
    assert.strictEqual(logs.length, 1);
  }
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
  assert.deepStrictEqual(await p.request('inputMonitoring'), { ok: false, reason: 'no-helper' });
});

test('request(inputMonitoring) raises the prompt through the helper and waits for the grant', async () => {
  // Granted while the prompt is up: request returns false, the third preflight says yes.
  let polls = 0;
  const helper = fakeHelper({ 'request listenEvent': false, 'preflight listenEvent': () => ++polls >= 3 });
  const p = createMacPermissions({ platform: 'darwin', systemPreferences: fakePrefs(), helperPath: '/x/privacy', execFile: helper.execFile, pollMs: 1, pollTimeoutMs: 1000, sleep: async () => {} });
  assert.deepStrictEqual(await p.request('inputMonitoring'), { ok: true });
  assert.deepStrictEqual(helper.calls[0], ['/x/privacy', 'request', 'listenEvent']);
  assert.strictEqual(helper.calls.filter(c => c[1] === 'preflight').length, 3);

  // Already granted: the request call itself says so, no polling.
  const now = fakeHelper({ 'request listenEvent': true });
  const q = createMacPermissions({ platform: 'darwin', systemPreferences: fakePrefs(), helperPath: '/x/privacy', execFile: now.execFile });
  assert.deepStrictEqual(await q.request('inputMonitoring'), { ok: true });
  assert.strictEqual(now.calls.length, 1);

  // Never granted (and no bundle id to reset a stale entry for): gives up after the poll window.
  let t = 0;
  const never = fakeHelper({ 'request listenEvent': false, 'preflight listenEvent': false });
  const r = createMacPermissions({ platform: 'darwin', systemPreferences: fakePrefs(), helperPath: '/x/privacy', execFile: never.execFile, bundleId: null, pollMs: 10, pollTimeoutMs: 35, sleep: async ms => { t += ms; } });
  const origNow = Date.now;
  Date.now = () => 1000 + t;
  try { assert.deepStrictEqual(await r.request('inputMonitoring'), { ok: false, reason: 'not-granted' }); } finally { Date.now = origNow; }
  assert.ok(never.calls.length >= 3 && never.calls.length <= 5, 'polled a few times: ' + never.calls.length);

  // Helper failure is reported as such, not as a denial.
  const broken = fakeHelper({ 'request listenEvent': 'fail' });
  const s = createMacPermissions({ platform: 'darwin', systemPreferences: fakePrefs(), helperPath: '/x/privacy', execFile: broken.execFile });
  assert.deepStrictEqual(await s.request('inputMonitoring'), { ok: false, reason: 'helper-failed' });
});

test('openSettings deep-links known panes only', async () => {
  const opened = [];
  const p = createMacPermissions({ platform: 'darwin', systemPreferences: fakePrefs(), shell: { async openExternal(u) { opened.push(u); } } });
  assert.strictEqual(await p.openSettings('screen'), true);
  assert.strictEqual(await p.openSettings('inputMonitoring'), true);
  assert.strictEqual(await p.openSettings('bogus'), false);
  assert.deepStrictEqual(opened, [SETTINGS_URL + PANES.screen, SETTINGS_URL + PANES.inputMonitoring]);
});

test('a stale grant (no prompt, no grant within the grace period) is reset with tccutil and requested again', async () => {
  // Input Monitoring: request says no, preflight stays no until the entry is reset; the second request prompts and is granted.
  let reset = false, polls = 0;
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push([file, ...args]);
    if (file === '/usr/bin/tccutil') { reset = true; return cb(null, 'Successfully reset ListenEvent approval status for com.teejs.bedrockpanel\n'); }
    const key = args.join(' ');
    let granted = false;
    if (key === 'request listenEvent') granted = reset;
    if (key === 'preflight listenEvent') { polls++; granted = false; }
    cb(null, JSON.stringify({ granted }) + '\n');
  };
  let t = 0;
  const origNow = Date.now;
  Date.now = () => 1000 + t;
  try {
    const logs = [];
    const p = createMacPermissions({ platform: 'darwin', systemPreferences: fakePrefs(), helperPath: '/x/privacy', execFile, bundleId: 'com.teejs.bedrockpanel', pollMs: 100, pollTimeoutMs: 5000, staleGraceMs: 300, sleep: async ms => { t += ms; }, log: m => logs.push(m) });
    assert.deepStrictEqual(await p.request('inputMonitoring'), { ok: true, reset: true });
    assert.deepStrictEqual(calls.filter(c => c[0] === '/usr/bin/tccutil'), [['/usr/bin/tccutil', 'reset', 'ListenEvent', 'com.teejs.bedrockpanel']]);
    assert.strictEqual(calls.filter(c => c[1] === 'request').length, 2, 'request, reset, request');
    assert.ok(polls >= 2 && polls <= 4, 'polled through the grace period only: ' + polls);
    assert.match(logs[0], /cleared a stale ListenEvent entry for com.teejs.bedrockpanel/);
    // The reset runs once per session: a later refusal does not reset again.
    reset = false; calls.length = 0;
    assert.deepStrictEqual(await p.request('inputMonitoring'), { ok: false, reason: 'not-granted' });
    assert.strictEqual(calls.filter(c => c[0] === '/usr/bin/tccutil').length, 0);
  } finally { Date.now = origNow; }
});

test('Accessibility: one prompt call, then wait for the grant — never a reset (it would wipe an entry being added by hand)', async () => {
  let toggledOn = false;
  const prefs = { calls: [], isTrustedAccessibilityClient(prompt) { prefs.calls.push(['axs', prompt]); return toggledOn; }, getMediaAccessStatus() { return 'granted'; }, async askForMediaAccess() { return true; } };
  const tccutil = [];
  const execFile = (file, args, opts, cb) => { if (file === '/usr/bin/tccutil') { tccutil.push(args); return cb(null, ''); } cb(new Error('unexpected ' + args.join(' '))); };
  let t = 0;
  const origNow = Date.now;
  Date.now = () => 1000 + t;
  try {
    // The person adds the entry with + and toggles it on while we poll.
    const p = createMacPermissions({ platform: 'darwin', systemPreferences: prefs, helperPath: '/x/privacy', execFile, bundleId: 'com.apple.Terminal', pollMs: 100, pollTimeoutMs: 5000, staleGraceMs: 300, sleep: async ms => { t += ms; if (t >= 1500) toggledOn = true; } });
    assert.deepStrictEqual(await p.request('accessibility'), { ok: true });
    assert.strictEqual(prefs.calls.filter(c => c[1] === true).length, 1, 'exactly one prompt call');
    assert.deepStrictEqual(tccutil, [], 'no tccutil reset for Accessibility');
    // Never granted: reports not-granted after the poll window, still without a reset.
    const q = createMacPermissions({ platform: 'darwin', systemPreferences: { isTrustedAccessibilityClient: () => false, getMediaAccessStatus: () => 'granted' }, helperPath: '/x/privacy', execFile, pollMs: 100, pollTimeoutMs: 500, staleGraceMs: 200, sleep: async ms => { t += ms; } });
    assert.deepStrictEqual(await q.request('accessibility'), { ok: false, reason: 'not-granted' });
    assert.deepStrictEqual(tccutil, []);
  } finally { Date.now = origNow; }
});

test('responsibleBundleId comes from LaunchServices\' environment, else the app id', () => {
  const { responsibleBundleId } = require('../app/macPermissions');
  assert.strictEqual(responsibleBundleId({ __CFBundleIdentifier: 'com.apple.Terminal' }), 'com.apple.Terminal');
  assert.strictEqual(responsibleBundleId({}), 'com.teejs.bedrockpanel');
  assert.strictEqual(responsibleBundleId(null, 'x'), 'x');
});
