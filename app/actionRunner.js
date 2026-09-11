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

// The same idea for Linux, with one difference that matters: distributions disagree about which of
// these programs exist, so an entry is a CANDIDATE LIST tried in order against PATH rather than a
// single name. The first one installed wins; a name that matches nothing falls through unchanged, so
// a real Linux binary ('firefox', 'dolphin', 'obs') keeps working exactly as typed.
const L_TERMINAL = ['x-terminal-emulator', 'konsole', 'gnome-terminal', 'xfce4-terminal', 'alacritty', 'xterm'];
const L_FILES    = ['dolphin', 'nautilus', 'nemo', 'thunar', 'pcmanfm'];
const L_EDITOR   = ['kate', 'gnome-text-editor', 'gedit', 'kwrite', 'mousepad'];
const L_CALC     = ['kcalc', 'gnome-calculator', 'qalculate-gtk', 'galculator'];
const L_MONITOR  = ['plasma-systemmonitor', 'gnome-system-monitor', 'ksysguard', 'xfce4-taskmanager'];
const L_SETTINGS = ['systemsettings', 'gnome-control-center', 'xfce4-settings-manager'];
const L_SHOT     = ['spectacle', 'gnome-screenshot', 'flameshot', 'xfce4-screenshooter'];
const L_BROWSER  = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'firefox'];
const LINUX_APP_ALIASES = {
  chrome: L_BROWSER, msedge: ['microsoft-edge', 'microsoft-edge-stable', ...L_BROWSER], iexplore: ['firefox', ...L_BROWSER],
  safari: ['firefox', ...L_BROWSER],
  calc: L_CALC, calculator: L_CALC,
  taskmgr: L_MONITOR, 'activity monitor': L_MONITOR,
  explorer: L_FILES, finder: L_FILES,
  notepad: L_EDITOR, wordpad: L_EDITOR, textedit: L_EDITOR, notes: L_EDITOR,
  mspaint: ['krita', 'gimp', 'kolourpaint'], preview: ['okular', 'evince', 'xdg-open'],
  snippingtool: L_SHOT, screenshot: L_SHOT,
  'ms-settings': L_SETTINGS, control: L_SETTINGS, 'system settings': L_SETTINGS,
  cmd: L_TERMINAL, powershell: L_TERMINAL, pwsh: L_TERMINAL, wt: L_TERMINAL, terminal: L_TERMINAL,
  code: ['code', 'codium', 'code-oss'],
  obs64: ['obs'], winword: ['libreoffice'], excel: ['libreoffice'], powerpnt: ['libreoffice'],
  // Generic names for the Linux starter grid. There is no single "the calculator" on Linux the way
  // there is on Windows or a Mac, so the shipped tiles name the JOB and the resolver picks whichever
  // program this machine actually has. These are also what someone would reasonably type by hand.
  browser: L_BROWSER, files: L_FILES, editor: L_EDITOR,
  monitor: L_MONITOR, 'system monitor': L_MONITOR, settings: L_SETTINGS,
  paint: ['krita', 'gimp', 'kolourpaint', 'pinta'],
  archive: ['ark', 'file-roller', 'xarchiver', 'engrampa'],
  images: ['gwenview', 'loupe', 'eog', 'gthumb', 'nomacs', 'shotwell'],
  documents: ['okular', 'evince', 'papers', 'atril', 'qpdfview'],
  video: ['haruna', 'vlc', 'mpv', 'celluloid', 'totem', 'dragonplayer'],
  music: ['elisa', 'rhythmbox', 'amberol', 'strawberry', 'audacious', 'clementine'],
  software: ['plasma-discover', 'gnome-software'],
  disks: ['partitionmanager', 'gnome-disks', 'gparted'],
  sysinfo: ['kinfocenter', 'hardinfo', 'cpu-x'],
};
function linuxAppCandidates(value) {
  const bare = String(value).trim().replace(/\.exe$/i, '');
  return LINUX_APP_ALIASES[bare.toLowerCase()] || [bare];
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

// Launch a resolved Linux binary. Electron's shell.openPath REFUSES an executable — it answers
// "For security reasons, launching executables is not allowed in this context", which is the right
// call for a file a web page handed you and the wrong one for a tile the user configured. On Windows
// openPath is still the only sane launcher (Store app-execution aliases), so this is Linux-only.
// Detached and stdio-ignored so the launched program outlives the panel and cannot block on a pipe.
function spawnDetached(file, deps) {
  try {
    const child = deps.spawn(file, [], { detached: true, stdio: 'ignore' });
    if (child && typeof child.unref === 'function') child.unref();
    if (child && typeof child.on === 'function') child.on('error', e => { if (deps.log) deps.log('launchApp: "' + file + '" failed: ' + (e && e.message)); });
    return true;
  } catch (e) {
    if (deps.log) deps.log('launchApp: could not start "' + file + '": ' + (e && e.message));
    return false;
  }
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
  // Linux bare name: walk the candidate list and launch the first one actually installed. A single
  // guess would strand every config copied from Windows or a Mac on any distribution that spells the
  // program differently, which is most of them.
  if (platform === 'linux' && !hasPathSeparator(value)) {
    for (const candidate of linuxAppCandidates(value)) {
      const hit = await resolveAppPath(candidate, deps);
      if (!hit) continue;
      if (spawnDetached(hit, deps)) return true;
    }
    if (deps.log) deps.log('launchApp: none of the candidates for "' + value + '" are installed');
    return false;
  }
  const resolved = await resolveAppPath(value, deps);
  if (!resolved) { if (deps.log) deps.log('launchApp: could not resolve "' + value + '"'); return false; }
  // Linux with an explicit path: same story as above — spawn it, never openPath.
  if (platform === 'linux') return spawnDetached(resolved, deps);
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

// The Linux half of the same table. These run through /bin/sh, so a `||` chain is the honest way to
// cover desktops that ship different programs for the same job — the first one present answers, and
// nothing has to know which desktop is running. `xdg-open` handles the generic `start <url-or-scheme>`
// case properly, which is the one that matters most for copied configs.
const LINUX_SHELL_ALIASES = {
  'start ms-settings:': 'systemsettings || gnome-control-center || xfce4-settings-manager',
  'start ms-settings:sound': 'pavucontrol || systemsettings kcm_pulseaudio || gnome-control-center sound',
  'start sndvol': 'pavucontrol || systemsettings kcm_pulseaudio || gnome-control-center sound',
  'explorer': 'xdg-open ~',
  'calc': 'kcalc || gnome-calculator || qalculate-gtk',
  'notepad': 'kate || gnome-text-editor || gedit',
  'taskmgr': 'plasma-systemmonitor || gnome-system-monitor || ksysguard',
};
function linuxShellCommand(value) {
  const key = String(value).trim().replace(/\s+/g, ' ');
  if (LINUX_SHELL_ALIASES[key.toLowerCase()]) return LINUX_SHELL_ALIASES[key.toLowerCase()];
  const m = /^start\s+("?)([a-z][a-z0-9+.-]*:[^\s"]*)\1$/i.exec(key);   // start https://… / start ms-teams:… → xdg-open
  if (m) return 'xdg-open "' + m[2] + '"';
  return value;
}

const SHELL_TRANSLATE = { darwin: macShellCommand, linux: linuxShellCommand };

function runShellCommand(value, deps) {
  if (!value || typeof value !== 'string') return false;
  const translate = SHELL_TRANSLATE[platformOf(deps)];
  deps.exec(translate ? translate(value) : value, { windowsHide: true });
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
  if (platform === 'linux') {
    // logind is the one lock path that works the same on every desktop and needs no privileges. It is
    // absent on a session started outside logind, so fall back to the freedesktop screensaver call,
    // which KDE, GNOME and Xfce all answer. Both are fire-and-forget; a failure locks nothing rather
    // than throwing at the tile.
    deps.execFile('loginctl', ['lock-session'], hiddenOptions(platform), err => {
      if (err) deps.execFile('xdg-screensaver', ['lock'], hiddenOptions(platform), () => {});
    });
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
  linuxAppCandidates,
  LINUX_APP_ALIASES,
  linuxShellCommand,
  LINUX_SHELL_ALIASES,
  hasPathSeparator,
  resolveAppPath,
  launchApp,
  runShellCommand,
  lockWorkstation,
};
