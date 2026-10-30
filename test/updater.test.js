'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createUpdater, FIRST_CHECK_MS, INTERVAL_MS, JITTER_MS, NOT_NOW_MS } = require('../app/updater');

// A stand-in for electron-updater's autoUpdater: checkForUpdates/downloadUpdate return promises the
// test resolves by hand, so ordering (late replies, cancels) can be driven exactly.
function fakeAutoUpdater() {
  const au = new EventEmitter();
  au.checks = []; au.downloads = []; au.installs = [];
  au.autoDownload = true; au.autoInstallOnAppQuit = true; au.allowPrerelease = false; au.allowDowngrade = true;
  au.checkForUpdates = () => new Promise((resolve, reject) => au.checks.push({ resolve, reject, allowPrerelease: au.allowPrerelease }));
  au.downloadUpdate = (token) => new Promise((resolve, reject) => au.downloads.push({ resolve, reject, token }));
  au.quitAndInstall = (silent, run) => au.installs.push({ silent, run });
  return au;
}
function fakeTimers() {
  let t = 0; const q = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms, unref() {} }; q.push(h); return h; },
    clearTimeout: (h) => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
    pending: () => q.map(h => h.at - t),
    advance(ms) { t += ms; const due = q.filter(h => h.at <= t); due.forEach(h => { q.splice(q.indexOf(h), 1); h.fn(); }); },
    set(ms) { t = ms; },
  };
}
const tick = () => new Promise(r => setImmediate(r));
const update = (version) => ({ isUpdateAvailable: true, updateInfo: { version, releaseName: 'v' + version + ' notes' } });

function setup(opts = {}) {
  const au = fakeAutoUpdater();
  const timers = fakeTimers();
  if (opts.startAt) timers.set(opts.startAt);
  const settings = Object.assign({ automatic: true, includeBetas: false }, opts.settings || {});
  let stored = opts.stored || null;
  const prompts = []; const messages = []; const opened = []; const notes = [];
  const answers = (opts.answers || []).slice();
  const tokens = [];
  const u = createUpdater({
    autoUpdater: au, isPackaged: opts.isPackaged !== false, currentVersion: '1.0.0',
    env: opts.env || {},
    getSettings: () => settings,
    readState: () => stored, writeState: (s) => { stored = JSON.parse(JSON.stringify(s)); },
    showPrompt: (p) => {
      prompts.push(p);
      if (opts.deferPrompts) return new Promise(resolve => { p.answer = resolve; });   // the test answers later
      return Promise.resolve(answers.length ? answers.shift() : p.cancelId);
    },
    showMessage: async (m) => { messages.push(m); },
    notify: (t, b) => notes.push(b),
    openExternal: (url) => opened.push(url),
    confirmQuitIfBusy: () => (opts.busyAnswer !== undefined ? opts.busyAnswer : true),
    makeCancellationToken: () => { const tk = { cancelled: false, cancel() { this.cancelled = true; } }; tokens.push(tk); return tk; },
    now: timers.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: opts.random || (() => 0),
  });
  return { u, au, timers, settings, prompts, messages, opened, notes, tokens, stored: () => stored };
}

test('first automatic check runs about a minute after start, then every 12 h plus spread', async () => {
  const s = setup({ random: () => 0.5 });
  s.u.start();
  assert.deepStrictEqual(s.timers.pending(), [FIRST_CHECK_MS]);
  s.timers.advance(FIRST_CHECK_MS);
  assert.strictEqual(s.au.checks.length, 1);
  s.au.checks[0].resolve({ isUpdateAvailable: false });
  await tick();
  assert.deepStrictEqual(s.timers.pending(), [INTERVAL_MS + JITTER_MS / 2]);
});

test('the spread never shortens the 12 h gap, and a failed check still schedules the next one 12 h out', async () => {
  const s = setup({ random: () => 0 });
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.au.checks[0].reject(new Error('offline'));
  await tick();
  assert.deepStrictEqual(s.timers.pending(), [INTERVAL_MS]);
  assert.strictEqual(s.u.getStatus().state, 'error');
  assert.strictEqual(s.u.getStatus().lastError, 'offline');
  assert.strictEqual(s.prompts.length, 0, 'a background failure stays silent');
});

test('nothing downloads until a choice is made; betas follow the setting, not the build', async () => {
  const s = setup({ settings: { includeBetas: false } });
  s.au.allowPrerelease = true;                      // electron-updater sets this itself on a beta build
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  assert.strictEqual(s.au.checks[0].allowPrerelease, false);
  assert.strictEqual(s.au.autoDownload, false);
  assert.strictEqual(s.au.allowDowngrade, false);
  s.au.checks[0].resolve(update('1.0.1'));
  await tick();
  assert.strictEqual(s.prompts.length, 1);           // answered with cancelId = Not now
  assert.strictEqual(s.au.downloads.length, 0);
  assert.deepStrictEqual(s.prompts[0].buttons, ['Install when I close Bedrock Panel', 'Install now and restart', 'Skip this version', 'Not now']);
  assert.strictEqual(s.prompts[0].defaultId, 0);
  assert.strictEqual(s.prompts[0].cancelId, 3);
});

test('Install when I close downloads, then arms the stock install-on-quit', async () => {
  const s = setup({ answers: [0] });
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.au.checks[0].resolve(update('1.0.1'));
  await tick();
  assert.strictEqual(s.au.downloads.length, 1);
  assert.strictEqual(s.u.getStatus().state, 'downloading');
  s.au.emit('download-progress', { percent: 45.4 });
  assert.strictEqual(s.u.getStatus().progress, 45);
  s.au.downloads[0].resolve();
  await tick();
  assert.strictEqual(s.u.getStatus().state, 'ready');
  assert.strictEqual(s.au.autoInstallOnAppQuit, true);
  assert.strictEqual(s.au.installs.length, 0);
  assert.match(s.u.trayItems()[0].label, /ready — installs when you close/);
});

test('Install now asks the busy question BEFORE quitAndInstall, and Keep running schedules nothing', async () => {
  const busy = setup({ answers: [1], busyAnswer: false });
  busy.u.start(); busy.timers.advance(FIRST_CHECK_MS);
  busy.au.checks[0].resolve(update('1.0.1')); await tick();
  busy.au.downloads[0].resolve(); await tick();
  assert.strictEqual(busy.au.installs.length, 0);
  assert.strictEqual(busy.au.autoInstallOnAppQuit, false);
  assert.strictEqual(busy.u.getStatus().state, 'ready');
  assert.match(busy.u.trayItems()[0].label, /ready to install/);

  const free = setup({ answers: [1], busyAnswer: true });
  free.u.start(); free.timers.advance(FIRST_CHECK_MS);
  free.au.checks[0].resolve(update('1.0.1')); await tick();
  free.au.downloads[0].resolve(); await tick();
  assert.deepStrictEqual(free.au.installs, [{ silent: true, run: true }]);
});

test('Skip this version stays silent until a newer release; a manual check still shows it', async () => {
  const s = setup({ answers: [2] });
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.au.checks[0].resolve(update('1.0.1')); await tick();
  assert.strictEqual(s.stored().skippedVersion, '1.0.1');
  s.timers.advance(INTERVAL_MS);
  s.au.checks[1].resolve(update('1.0.1')); await tick();
  assert.strictEqual(s.prompts.length, 1, 'no prompt for the skipped version');
  assert.strictEqual(s.u.getStatus().skipped, true);
  assert.strictEqual(s.u.trayItems().length, 1, 'only Check for updates in the tray');
  s.u.checkNow();
  s.au.checks[2].resolve(update('1.0.1')); await tick();
  assert.strictEqual(s.prompts.length, 2);
  assert.match(s.prompts[1].detail, /skipped/);
  s.timers.advance(INTERVAL_MS);
  s.au.checks[3].resolve(update('1.0.2')); await tick();
  assert.strictEqual(s.prompts.length, 3, 'a newer release prompts again');
});

test('Not now waits 24 h within a run, and the next start offers it again', async () => {
  const s = setup();                                  // every prompt answers Not now
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.au.checks[0].resolve(update('1.0.1')); await tick();
  s.timers.advance(INTERVAL_MS);
  s.au.checks[1].resolve(update('1.0.1')); await tick();
  assert.strictEqual(s.prompts.length, 1, 'quiet 12 h later');
  assert.match(s.u.trayItems()[0].label, /Update available — v1.0.1/, 'the tray item stays during Not now');
  s.timers.advance(INTERVAL_MS);
  s.au.checks[2].resolve(update('1.0.1')); await tick();
  assert.strictEqual(s.prompts.length, 2, 'offered again after 24 h');

  const next = setup({ stored: s.stored(), startAt: s.timers.now() + 1000 });   // a later start
  next.u.start(); next.timers.advance(FIRST_CHECK_MS);
  next.au.checks[0].resolve(update('1.0.1')); await tick();
  assert.strictEqual(next.prompts.length, 1, 'next start offers it again');
});

test('manual check says up to date, and works with automatic updates off', async () => {
  const s = setup({ settings: { automatic: false } });
  s.u.start();
  assert.deepStrictEqual(s.timers.pending(), [], 'no automatic check scheduled while off');
  s.u.checkNow();
  s.au.checks[0].resolve({ isUpdateAvailable: false }); await tick();
  assert.match(s.messages[0].message, /up to date/);
  assert.ok(s.stored().lastCheckedAt);
});

test('switching off cancels an automatic download and clears an automatic install-on-quit', async () => {
  const s = setup({ answers: [0] });
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.au.checks[0].resolve(update('1.0.1')); await tick();
  assert.strictEqual(s.u.getStatus().state, 'downloading');
  s.settings.automatic = false; s.u.applySettings();
  assert.strictEqual(s.tokens[0].cancelled, true);
  assert.strictEqual(s.au.autoInstallOnAppQuit, false);
  assert.strictEqual(s.u.getStatus().pending, null);
  s.au.downloads[0].resolve(); await tick();          // the cancelled download finishing late changes nothing
  assert.strictEqual(s.au.autoInstallOnAppQuit, false);
  assert.strictEqual(s.au.installs.length, 0);
  assert.deepStrictEqual(s.timers.pending(), []);

  const armed = setup({ answers: [0] });
  armed.u.start(); armed.timers.advance(FIRST_CHECK_MS);
  armed.au.checks[0].resolve(update('1.0.1')); await tick();
  armed.au.downloads[0].resolve(); await tick();
  assert.strictEqual(armed.au.autoInstallOnAppQuit, true);
  armed.settings.automatic = false; armed.u.applySettings();
  assert.strictEqual(armed.au.autoInstallOnAppQuit, false, 'nothing installs at quit');
});

test('a late automatic reply after switching off is ignored, while a manual check in between is shown', async () => {
  const s = setup();
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);       // automatic check in flight
  s.settings.automatic = false; s.u.applySettings();
  s.u.checkNow();                                      // manual check
  s.au.checks[0].resolve(update('1.0.9')); await tick();     // late automatic reply
  assert.strictEqual(s.prompts.length, 0);
  assert.strictEqual(s.notes.length, 0);
  s.au.checks[1].resolve(update('1.0.1')); await tick();
  assert.strictEqual(s.prompts.length, 1);
  assert.match(s.prompts[0].message, /1\.0\.1/);
});

test('a reply from before a quick off-then-on is still ignored', async () => {
  const s = setup();
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);       // automatic check in flight
  s.settings.automatic = false; s.u.applySettings();
  s.settings.automatic = true; s.u.applySettings();
  s.au.checks[0].resolve(update('1.0.1')); await tick();
  assert.strictEqual(s.prompts.length, 0);
  assert.strictEqual(s.notes.length, 0);
});

test('with automatic updates off, the user’s own Install when I close from a manual check still installs', async () => {
  const s = setup({ settings: { automatic: false }, answers: [0] });
  s.u.start();
  s.u.checkNow();
  s.au.checks[0].resolve(update('1.0.1')); await tick();
  s.au.downloads[0].resolve(); await tick();
  assert.strictEqual(s.au.autoInstallOnAppQuit, true);
  assert.match(s.u.trayItems()[0].label, /installs when you close/, 'a user-made pending install keeps its tray item');
});

// Regressions from C3Po's security review (room #284).
test('an automatic prompt answered after switching off starts nothing', async () => {
  const s = setup({ deferPrompts: true });
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.au.checks[0].resolve(update('1.0.1')); await tick();
  assert.strictEqual(s.prompts.length, 1);
  s.settings.automatic = false; s.u.applySettings();
  s.prompts[0].answer(1); await tick();               // Install now, after the switch went off
  assert.strictEqual(s.au.downloads.length, 0);
  assert.strictEqual(s.au.installs.length, 0);

  const p = setup({ deferPrompts: true, env: { PORTABLE_EXECUTABLE_FILE: 'x.exe' } });
  p.u.start(); p.timers.advance(FIRST_CHECK_MS);
  p.au.checks[0].resolve(update('1.0.1')); await tick();
  p.settings.automatic = false; p.u.applySettings();
  p.prompts[0].answer(0); await tick();               // portable Download, after the switch went off
  assert.deepStrictEqual(p.opened, []);
});

test('switching off and back on does not revive an automatic prompt left open', async () => {
  const s = setup({ deferPrompts: true });
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.au.checks[0].resolve(update('1.0.1')); await tick();
  s.settings.automatic = false; s.u.applySettings();
  s.settings.automatic = true; s.u.applySettings();
  s.prompts[0].answer(0); await tick();               // Install when I close, on the stale prompt
  assert.strictEqual(s.au.downloads.length, 0);

  const p = setup({ deferPrompts: true, env: { PORTABLE_EXECUTABLE_FILE: 'x.exe' } });
  p.u.start(); p.timers.advance(FIRST_CHECK_MS);
  p.au.checks[0].resolve(update('1.0.1')); await tick();
  p.settings.automatic = false; p.u.applySettings();
  p.settings.automatic = true; p.u.applySettings();
  p.prompts[0].answer(0); await tick();
  assert.deepStrictEqual(p.opened, []);
});

test('no new check runs while a prompt waits, so the chosen version is the one downloaded', async () => {
  const s = setup({ deferPrompts: true });
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.au.checks[0].resolve(update('1.0.1')); await tick();
  s.timers.advance(INTERVAL_MS + JITTER_MS);          // the scheduled check comes due while the prompt is open
  s.u.checkNow();                                     // and a manual one
  assert.strictEqual(s.au.checks.length, 1, 'no check replaced the metadata behind the open prompt');
  s.prompts[0].answer(0); await tick();
  assert.strictEqual(s.au.downloads.length, 1);
  assert.strictEqual(s.u.getStatus().pending.version, '1.0.1');
});

test('a stale download finishing late cannot mark a newer same-version download done', async () => {
  const s = setup({ answers: [0, 0] });
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.au.checks[0].resolve(update('1.0.1')); await tick();
  assert.strictEqual(s.au.downloads.length, 1);       // automatic download #1
  s.settings.automatic = false; s.u.applySettings();  // cancelled
  s.settings.automatic = true; s.u.applySettings();
  s.u.checkNow();
  s.au.checks[1].resolve(update('1.0.1')); await tick();
  assert.strictEqual(s.au.downloads.length, 2);       // download #2, same version
  s.au.downloads[0].resolve(); await tick();          // #1 completes late
  assert.strictEqual(s.u.getStatus().state, 'downloading');
  assert.strictEqual(s.au.autoInstallOnAppQuit, false);
  s.au.downloads[1].resolve(); await tick();
  assert.strictEqual(s.u.getStatus().state, 'ready');
  assert.strictEqual(s.au.autoInstallOnAppQuit, true);
});

test('a manual check that supersedes an automatic one never ends the automatic schedule', async () => {
  const s = setup();
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);       // automatic check in flight; its timer is gone
  s.u.checkNow();                                      // manual check makes the automatic reply stale
  s.au.checks[0].resolve({ isUpdateAvailable: false }); await tick();
  s.au.checks[1].resolve({ isUpdateAvailable: false }); await tick();
  assert.strictEqual(s.timers.pending().length, 1, 'the next automatic check is still scheduled');
  s.timers.advance(INTERVAL_MS + JITTER_MS);
  assert.strictEqual(s.au.checks.length, 3, 'and it runs');

  const f = setup();                                   // same, with the stale automatic check failing
  f.u.start(); f.timers.advance(FIRST_CHECK_MS);
  f.u.checkNow();
  f.au.checks[0].reject(new Error('net')); await tick();
  f.au.checks[1].resolve({ isUpdateAvailable: false }); await tick();
  assert.strictEqual(f.timers.pending().length, 1);
});

test('turning betas off stops a beta that is downloading or waiting to install, whoever chose it', async () => {
  const s = setup({ settings: { includeBetas: true }, answers: [0] });
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.au.checks[0].resolve(update('1.0.1-beta.2')); await tick();
  s.au.downloads[0].resolve(); await tick();
  assert.strictEqual(s.au.autoInstallOnAppQuit, true);
  s.settings.includeBetas = false; s.u.applySettings();
  assert.strictEqual(s.au.autoInstallOnAppQuit, false, 'no beta installs at quit after opting out');
  assert.strictEqual(s.u.getStatus().pending, null);
  assert.strictEqual(s.u.getStatus().available, null);

  const d = setup({ settings: { includeBetas: true }, answers: [1] });
  d.u.start(); d.timers.advance(FIRST_CHECK_MS);
  d.au.checks[0].resolve(update('1.0.1-beta.2')); await tick();   // Install now, still downloading
  d.settings.includeBetas = false; d.u.applySettings();
  assert.strictEqual(d.tokens[0].cancelled, true);
  d.au.downloads[0].resolve(); await tick();
  assert.strictEqual(d.au.installs.length, 0, 'no beta installs after opting out');

  const m = setup({ settings: { automatic: false, includeBetas: true }, answers: [0] });   // the user's own manual choice
  m.u.start(); m.u.checkNow();
  m.au.checks[0].resolve(update('1.0.1-beta.2')); await tick();
  m.au.downloads[0].resolve(); await tick();
  m.settings.includeBetas = false; m.u.applySettings();
  assert.strictEqual(m.au.autoInstallOnAppQuit, false);
});

test('a beta reply landing after betas went off is not offered', async () => {
  const s = setup({ settings: { includeBetas: true } });
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);       // beta-allowed check in flight
  s.settings.includeBetas = false; s.u.applySettings();
  s.au.checks[0].resolve(update('1.0.1-beta.3')); await tick();
  assert.strictEqual(s.prompts.length, 0);
  assert.strictEqual(s.notes.length, 0);
  assert.strictEqual(s.u.getStatus().available, null);
});

test('a beta reply from before a betas off-then-on is not offered, but a stable reply still is', async () => {
  const s = setup({ settings: { includeBetas: true } });
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.settings.includeBetas = false; s.u.applySettings();
  s.settings.includeBetas = true; s.u.applySettings();
  s.au.checks[0].resolve(update('1.0.1-beta.3')); await tick();
  assert.strictEqual(s.prompts.length, 0);
  assert.strictEqual(s.notes.length, 0);

  const st = setup({ settings: { includeBetas: true } });
  st.u.start(); st.timers.advance(FIRST_CHECK_MS);
  st.settings.includeBetas = false; st.u.applySettings();
  st.settings.includeBetas = true; st.u.applySettings();
  st.au.checks[0].resolve(update('1.0.1')); await tick();
  assert.strictEqual(st.prompts.length, 1, 'a stable release is unaffected');
});

test('a beta prompt left open does not come back to life when betas go off then on', async () => {
  const s = setup({ settings: { includeBetas: true }, deferPrompts: true });
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.au.checks[0].resolve(update('1.0.1-beta.3')); await tick();
  s.settings.includeBetas = false; s.u.applySettings();
  s.settings.includeBetas = true; s.u.applySettings();
  s.prompts[0].answer(0); await tick();
  assert.strictEqual(s.au.downloads.length, 0);

  const m = setup({ settings: { includeBetas: true }, deferPrompts: true });   // a manual beta prompt too
  m.u.start(); m.u.checkNow();
  m.au.checks[0].resolve(update('1.0.1-beta.3')); await tick();
  m.settings.includeBetas = false; m.u.applySettings();
  m.prompts[0].answer(1); await tick();
  assert.strictEqual(m.au.downloads.length, 0);
});

test('a malformed feed version is never offered or turned into a link', async () => {
  const { releasePageUrl } = require('../app/updater');
  assert.strictEqual(releasePageUrl('1.0.1'), 'https://github.com/TeeJS/bedrock-panel/releases/tag/v1.0.1');
  assert.strictEqual(releasePageUrl('1.0.0-beta.10'), 'https://github.com/TeeJS/bedrock-panel/releases/tag/v1.0.0-beta.10');
  assert.strictEqual(releasePageUrl('1.0.1/../../evil'), null);
  assert.strictEqual(releasePageUrl('javascript:alert(1)'), null);
  const s = setup();
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.au.checks[0].resolve(update('1.0.1/../x')); await tick();
  assert.strictEqual(s.prompts.length, 0);
  assert.strictEqual(s.u.getStatus().available, null);
});

test('portable builds never download: the prompt links to the release page', async () => {
  const s = setup({ env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x\\bedrock-panel-portable.exe' }, answers: [0] });
  s.u.start(); s.timers.advance(FIRST_CHECK_MS);
  s.au.checks[0].resolve(update('1.0.1')); await tick();
  assert.deepStrictEqual(s.prompts[0].buttons, ['Download 1.0.1', 'Skip this version', 'Not now']);
  assert.deepStrictEqual(s.opened, ['https://github.com/TeeJS/bedrock-panel/releases/tag/v1.0.1']);
  assert.strictEqual(s.au.downloads.length, 0);
  assert.strictEqual(s.u.getStatus().portable, true);
});

test('development runs are not supported and never check', async () => {
  const s = setup({ isPackaged: false });
  s.u.start();
  assert.deepStrictEqual(s.timers.pending(), []);
  assert.strictEqual(s.u.getStatus().supported, false);
  s.u.checkNow(); await tick();
  assert.strictEqual(s.au.checks.length, 0);
  assert.strictEqual(s.messages.length, 1);
});
