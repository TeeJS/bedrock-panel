'use strict';

// Windows program names the default grid and many tiles carry ('chrome', 'calc', 'taskmgr', 'notepad'),
// mapped to the app `open -a` should launch on a Mac. Anything not listed passes through unchanged, so a
// real macOS app name ('Safari', 'Google Chrome') keeps working; a trailing .exe is dropped either way.
const MAC_APP_ALIASES = {
  chrome: 'Google Chrome', msedge: 'Microsoft Edge', firefox: 'Firefox', iexplore: 'Safari',
  calc: 'Calculator', taskmgr: 'Activity Monitor', notepad: 'TextEdit', wordpad: 'TextEdit', explorer: 'Finder',
  mspaint: 'Preview', snippingtool: 'Screenshot', 'ms-settings': 'System Settings', control: 'System Settings',
  cmd: 'Terminal', powershell: 'Terminal', pwsh: 'Terminal', wt: 'Terminal', code: 'Visual Studio Code',
  outlook: 'Microsoft Outlook', olk: 'Microsoft Outlook', winword: 'Microsoft Word', excel: 'Microsoft Excel',
  powerpnt: 'Microsoft PowerPoint', onenote: 'Microsoft OneNote', teams: 'Microsoft Teams', 'ms-teams': 'Microsoft Teams',
  zoom: 'zoom.us', discord: 'Discord', slack: 'Slack', spotify: 'Spotify', obs64: 'OBS', obs: 'OBS', steam: 'Steam', vlc: 'VLC',
};
function macAppName(value) {
  const bare = String(value).trim().replace(/\.exe$/i, '');
  return MAC_APP_ALIASES[bare.toLowerCase()] || bare;
}

function hasPathSeparator(value) {
  return /[\\/]/.test(value);
}

function platformOf(deps) {
  return (deps && deps.platform) || process.platform;
}

function hiddenOptions(platform) {
  return platform === 'win32' ? { windowsHide: true } : {};
}

function commandResolver(platform) {
  return platform === 'win32'
    ? { file: 'where', args: value => [value] }
    : { file: '/usr/bin/which', args: value => [value] };
}

function resolveAppPath(value, deps) {
  return new Promise(resolve => {
    if (!value || typeof value !== 'string') return resolve(null);
    if (hasPathSeparator(value)) return resolve(deps.fs.existsSync(value) ? value : null);
    const platform = platformOf(deps);
    const resolver = commandResolver(platform);
    deps.execFile(resolver.file, resolver.args(value), hiddenOptions(platform), (err, stdout) => {
      if (err) return resolve(null);
      // Trust `where`'s output — it only returns paths Windows considers valid. Don't double-check
      // with fs.existsSync: Microsoft Store app-execution-alias reparse points (e.g. mspaint.exe in
      // %LOCALAPPDATA%\Microsoft\WindowsApps\) make existsSync return false, even though the alias
      // is launchable via shell.openPath / ShellExecuteEx.
      const first = (stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
      resolve(first || null);
    });
  });
}

async function launchApp(value, deps) {
  if (!value || typeof value !== 'string') return false;
  const platform = platformOf(deps);
  // macOS bare name: `open -a name` handles app lookup natively (Windows program names are mapped first).
  if (platform === 'darwin' && !hasPathSeparator(value)) {
    const name = macAppName(value);
    deps.execFile('/usr/bin/open', ['-a', name], hiddenOptions(platform), err => {
      if (err && deps.log) deps.log('launchApp: open -a "' + name + '" failed: ' + (err.message || err));
    });
    return true;
  }
  const resolved = await resolveAppPath(value, deps);
  if (!resolved) { if (deps.log) deps.log('launchApp: could not resolve "' + value + '"'); return false; }
  // shell.openPath (ShellExecuteEx under the hood) is the only sane Windows launcher: it handles
  // Microsoft Store app aliases (mspaint, calc, etc. — zero-byte reparse points that direct
  // CreateProcess can't launch) AND it doesn't pass SW_HIDE to GUI apps the way detached+
  // windowsHide spawn does, which previously kept GUI apps like Notepad invisible after launch.
  const err = await deps.shell.openPath(resolved);
  if (err && deps.log) deps.log('launchApp: openPath error for "' + resolved + '": ' + err);
  return !err;
}

// Windows shell one-liners the original default grid and older configs carry, and what they mean on a
// Mac. Exact matches only, plus the generic `start <url-or-scheme>` → `open`, so a config authored on
// Windows keeps its Settings / Sound tiles working after a copy to a Mac.
const MAC_SHELL_ALIASES = {
  'start ms-settings:': 'open -a "System Settings"',
  'start ms-settings:sound': 'open "x-apple.systempreferences:com.apple.Sound-Settings.extension"',
  'start sndvol': 'open "x-apple.systempreferences:com.apple.Sound-Settings.extension"',
  'explorer': 'open -a Finder',
  'calc': 'open -a Calculator',
  'notepad': 'open -a TextEdit',
  'taskmgr': 'open -a "Activity Monitor"',
};
function macShellCommand(value) {
  const key = String(value).trim().replace(/\s+/g, ' ');
  if (MAC_SHELL_ALIASES[key.toLowerCase()]) return MAC_SHELL_ALIASES[key.toLowerCase()];
  const m = /^start\s+("?)([a-z][a-z0-9+.-]*:[^\s"]*)\1$/i.exec(key);   // start https://… / start ms-teams:… → open
  if (m) return 'open "' + m[2] + '"';
  return value;
}

function runShellCommand(value, deps) {
  if (!value || typeof value !== 'string') return false;
  deps.exec(platformOf(deps) === 'darwin' ? macShellCommand(value) : value, { windowsHide: true });
  return true;
}

function lockWorkstation(deps) {
  const platform = platformOf(deps);
  if (platform === 'darwin') {
    // The old CGSession binary was removed on modern macOS. `pmset displaysleepnow` needs no special
    // permission and locks the screen when the user has "require password after sleep/screensaver" on.
    deps.execFile('/usr/bin/pmset', ['displaysleepnow'], hiddenOptions(platform), () => {});
    return true;
  }
  deps.execFile('rundll32.exe', ['user32.dll,LockWorkStation'], hiddenOptions(platform), () => {});
  return true;
}

module.exports = {
  macAppName,
  MAC_APP_ALIASES,
  macShellCommand,
  MAC_SHELL_ALIASES,
  hasPathSeparator,
  resolveAppPath,
  launchApp,
  runShellCommand,
  lockWorkstation,
};
