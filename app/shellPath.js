'use strict';
/*
 * shellPath — give a Finder/Dock-launched app the PATH a terminal has. [MIT]
 *
 * macOS launches GUI apps with a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so `which claude`,
 * `which codex`, and every other command-line lookup fail for tools installed under Homebrew,
 * ~/.local/bin, npm's global bin, volta, nvm, … even though they work in Terminal — and the AI Voice
 * pages then report "claude CLI not found on PATH". This asks the user's login shell for its PATH
 * once at startup (interactive + login, so both .zprofile and .zshrc contribute, TERM=dumb so no
 * prompt tricks) and merges it into process.env.PATH, then appends the well-known install dirs that
 * exist on disk as a fallback for shells that print nothing. Pure and injectable for tests; a no-op
 * off macOS/Linux and on failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const MARK_START = '__BP_PATH__', MARK_END = '__END__';

// Directories worth checking even when the shell cannot be asked (or lists nothing useful).
function wellKnownDirs(home = os.homedir()) {
  const dirs = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
    path.join(home, '.local', 'bin'),          // pipx, uv, the claude CLI's native installer
    path.join(home, '.claude', 'local'),       // older claude CLI installs
    path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'), path.join(home, 'go', 'bin'), path.join(home, '.deno', 'bin'),
  ];
  // nvm: every installed node's bin, newest first (`nvm` itself only exists inside a shell).
  try {
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    const versions = fs.readdirSync(nvm).filter(v => /^v\d/.test(v)).sort((a, b) => compareVersions(b, a));
    for (const v of versions) dirs.push(path.join(nvm, v, 'bin'));
  } catch (e) {}
  return dirs;
}
function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number), pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

// The PATH the user's login shell would have, or null. `shell` defaults to $SHELL (zsh on macOS).
function loginShellPath({ shell = process.env.SHELL || '/bin/zsh', execFileSync = childProcess.execFileSync, env = process.env, timeoutMs = 4000 } = {}) {
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "%s%s%s" "' + MARK_START + '" "$PATH" "' + MARK_END + '"'], {
      encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'],
      env: Object.assign({}, env, { TERM: 'dumb', DISABLE_AUTO_UPDATE: 'true' }),
    });
    const m = new RegExp(MARK_START + '([^]*?)' + MARK_END).exec(String(out || ''));
    return m && m[1].trim() ? m[1].trim() : null;
  } catch (e) { return null; }
}

// Merge: current PATH first (unchanged order), then the shell's entries, then the well-known dirs
// that exist — no duplicates, nothing removed. Returns { path, added } and sets env.PATH.
function augmentPath({ env = process.env, shellPath = undefined, extraDirs = undefined, exists = p => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } } } = {}) {
  const current = String(env.PATH || '').split(':').filter(Boolean);
  const seen = new Set(current);
  const added = [];
  const consider = (dir, mustExist) => {
    if (!dir || seen.has(dir)) return;
    if (mustExist && !exists(dir)) return;
    seen.add(dir); added.push(dir);
  };
  for (const d of String(shellPath || '').split(':').filter(Boolean)) consider(d, false);
  for (const d of (extraDirs || wellKnownDirs())) consider(d, true);
  const merged = current.concat(added).join(':');
  env.PATH = merged;
  return { path: merged, added };
}

// One call for main.js: only where GUI launches get a bare PATH; logs what was added.
function ensureShellPath({ platform = process.platform, log = () => {}, ...opts } = {}) {
  if (platform !== 'darwin' && platform !== 'linux') return null;
  const fromShell = loginShellPath(opts);
  const r = augmentPath(Object.assign({ shellPath: fromShell }, opts));
  if (r.added.length) log('PATH: added ' + r.added.length + ' dir(s) from the login shell' + (fromShell ? '' : ' (shell gave nothing; well-known dirs only)') + ': ' + r.added.join(':'));
  else log('PATH: nothing to add (' + (fromShell ? 'login shell matched' : 'login shell unavailable') + ')');
  return r;
}

module.exports = { ensureShellPath, augmentPath, loginShellPath, wellKnownDirs };
