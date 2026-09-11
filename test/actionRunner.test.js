'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { launchApp, macAppName } = require('../app/actionRunner');

function macDeps(calls) {
  return {
    platform: 'darwin',
    execFile: (file, args, opts, cb) => { calls.push([file, ...args]); cb(null); },
    fs: { existsSync: () => false },
    shell: { openPath: async () => '' },
    log: () => {},
  };
}

test('macOS maps Windows program names to their Mac apps and passes real names through', async () => {
  const calls = [];
  const deps = macDeps(calls);
  assert.equal(await launchApp('chrome', deps), true);
  assert.equal(await launchApp('taskmgr.exe', deps), true);
  assert.equal(await launchApp('Calc', deps), true);
  assert.equal(await launchApp('Safari', deps), true);
  assert.deepEqual(calls, [
    ['/usr/bin/open', '-a', 'Google Chrome'],
    ['/usr/bin/open', '-a', 'Activity Monitor'],
    ['/usr/bin/open', '-a', 'Calculator'],
    ['/usr/bin/open', '-a', 'Safari'],
  ]);
  assert.equal(macAppName('Notepad.EXE'), 'TextEdit');
  assert.equal(macAppName('My Custom App'), 'My Custom App');
});

test('a failed open -a is logged instead of vanishing', async () => {
  const logs = [];
  const deps = macDeps([]);
  deps.execFile = (file, args, opts, cb) => cb(new Error('Unable to find application named "Nope"'));
  deps.log = m => logs.push(m);
  await launchApp('nope', deps);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /open -a "nope" failed/);
});

test('macOS rewrites the Windows shell one-liners of older configs and passes everything else through', () => {
  const { macShellCommand, runShellCommand } = require('../app/actionRunner');
  assert.equal(macShellCommand('start ms-settings:'), 'open -a "System Settings"');
  assert.equal(macShellCommand('start sndvol'), 'open "x-apple.systempreferences:com.apple.Sound-Settings.extension"');
  assert.equal(macShellCommand('START  SNDVOL '), 'open "x-apple.systempreferences:com.apple.Sound-Settings.extension"', 'case and spacing tolerant');
  assert.equal(macShellCommand('start https://github.com'), 'open "https://github.com"');
  assert.equal(macShellCommand('start "ms-teams:"'), 'open "ms-teams:"');
  assert.equal(macShellCommand('open -a Safari'), 'open -a Safari', 'native commands untouched');
  assert.equal(macShellCommand('start notepad.exe'), 'start notepad.exe', 'a program (not a url) is not translated blindly');
  const ran = [];
  const deps = { platform: 'darwin', exec: (cmd) => ran.push(cmd) };
  runShellCommand('start sndvol', deps);
  runShellCommand("osascript -e 'set volume output muted true'", deps);
  assert.deepEqual(ran, ['open "x-apple.systempreferences:com.apple.Sound-Settings.extension"', "osascript -e 'set volume output muted true'"]);
  const winRan = [];
  runShellCommand('start sndvol', { platform: 'win32', exec: (cmd) => winRan.push(cmd) });
  assert.deepEqual(winRan, ['start sndvol'], 'Windows runs the command as written');
});

// ---- Linux ----
// The Linux launcher differs from the macOS one in kind, not just in names: distributions spell the
// same program differently, so an alias is a candidate list walked against PATH rather than one name.
function linuxDeps(installed, opened) {
  return {
    platform: 'linux',
    execFile: (file, args, opts, cb) => {
      const name = args[0];
      installed.includes(name) ? cb(null, '/usr/bin/' + name + '\n') : cb(new Error('not found'));
    },
    fs: { existsSync: p => installed.some(n => p === '/usr/bin/' + n) },
    // Electron's shell.openPath refuses to run an executable ("launching executables is not allowed
    // in this context"), so the Linux path must spawn. Fail loudly if anything reaches openPath.
    shell: { openPath: async () => { throw new Error('openPath must not be used on Linux'); } },
    spawn: (file) => { opened.push(file); return { unref() {}, on() {} }; },
    log: () => {},
  };
}

test('Linux walks the candidate list and launches the first program actually installed', async () => {
  const opened = [];
  // A GNOME-ish box: no dolphin, no kcalc.
  const deps = linuxDeps(['nautilus', 'gnome-calculator', 'firefox', 'gnome-system-monitor'], opened);
  assert.equal(await launchApp('explorer', deps), true);
  assert.equal(await launchApp('calc', deps), true);
  assert.equal(await launchApp('taskmgr.exe', deps), true, 'a trailing .exe is dropped');
  assert.equal(await launchApp('chrome', deps), true, 'falls past chrome/chromium to firefox');
  assert.deepEqual(opened, ['/usr/bin/nautilus', '/usr/bin/gnome-calculator', '/usr/bin/gnome-system-monitor', '/usr/bin/firefox']);
});

test('Linux passes a real binary name through, and reports when nothing in the list is installed', async () => {
  const opened = [];
  const logs = [];
  const deps = linuxDeps(['obs'], opened);
  deps.log = m => logs.push(m);
  assert.equal(await launchApp('obs', deps), true, 'an unaliased name is tried as written');
  assert.deepEqual(opened, ['/usr/bin/obs']);
  assert.equal(await launchApp('notepad', deps), false, 'no editor installed');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /none of the candidates for "notepad"/);
});

test('Linux rewrites the Windows shell one-liners of copied configs', () => {
  const { linuxShellCommand, runShellCommand } = require('../app/actionRunner');
  assert.equal(linuxShellCommand('start ms-settings:'), 'systemsettings || gnome-control-center || xfce4-settings-manager');
  assert.equal(linuxShellCommand('START  SNDVOL '), 'pavucontrol || systemsettings kcm_pulseaudio || gnome-control-center sound', 'case and spacing tolerant');
  assert.equal(linuxShellCommand('start https://github.com'), 'xdg-open "https://github.com"');
  assert.equal(linuxShellCommand('start "ms-teams:"'), 'xdg-open "ms-teams:"');
  assert.equal(linuxShellCommand('pactl set-sink-volume @DEFAULT_SINK@ +5%'), 'pactl set-sink-volume @DEFAULT_SINK@ +5%', 'native commands untouched');
  assert.equal(linuxShellCommand('start notepad.exe'), 'start notepad.exe', 'a program (not a url) is not translated blindly');
  const ran = [];
  runShellCommand('start sndvol', { platform: 'linux', exec: cmd => ran.push(cmd) });
  assert.deepEqual(ran, ['pavucontrol || systemsettings kcm_pulseaudio || gnome-control-center sound']);
});

test('Linux locks through logind, falling back to the screensaver call', () => {
  const { lockWorkstation } = require('../app/actionRunner');
  const ok = [];
  lockWorkstation({ platform: 'linux', execFile: (file, args, opts, cb) => { ok.push([file, ...args]); cb(null); } });
  assert.deepEqual(ok, [['loginctl', 'lock-session']], 'no fallback when logind answers');
  const failed = [];
  lockWorkstation({
    platform: 'linux',
    execFile: (file, args, opts, cb) => { failed.push([file, ...args]); cb(file === 'loginctl' ? new Error('no session') : null); },
  });
  assert.deepEqual(failed, [['loginctl', 'lock-session'], ['xdg-screensaver', 'lock']]);
  const win = [];
  lockWorkstation({ platform: 'win32', execFile: (file, args, opts, cb) => { win.push(file); cb(null); } });
  assert.deepEqual(win, ['rundll32.exe'], 'Windows is unchanged');
});

test('Linux spawns the binary instead of shell.openPath, which refuses executables', () => {
  // Regression: every tile answered "For security reasons, launching executables is not allowed in
  // this context" because the Linux branch went through Electron's shell.openPath.
  const opened = [];
  const deps = linuxDeps(['kate'], opened);
  const spawned = [];
  deps.spawn = (file, args, opts) => { spawned.push([file, args, opts]); return { unref() {}, on() {} }; };
  return launchApp('editor', deps).then(ok => {
    assert.equal(ok, true);
    assert.deepEqual(spawned, [['/usr/bin/kate', [], { detached: true, stdio: 'ignore' }]],
      'detached and stdio-ignored so the program outlives the panel');
  });
});

test('Linux takes an explicit path too, and reports a spawn that throws', async () => {
  const spawned = [];
  const deps = linuxDeps(['obs'], []);
  deps.fs = { existsSync: () => true };
  deps.spawn = file => { spawned.push(file); return { unref() {}, on() {} }; };
  assert.equal(await launchApp('/opt/thing/run.sh', deps), true);
  assert.deepEqual(spawned, ['/opt/thing/run.sh']);
  const logs = [];
  const bad = linuxDeps(['kate'], []);
  bad.spawn = () => { throw new Error('ENOENT'); };
  bad.log = m => logs.push(m);
  assert.equal(await launchApp('editor', bad), false);
  assert.match(logs.join(' '), /could not start|none of the candidates/);
});
