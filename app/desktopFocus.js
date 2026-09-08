'use strict';
/*
 * desktopFocus.js — track the PC's foreground (focused) application and let the panel
 * auto-switch to a page mapped to it. [MIT]
 *
 * Via the bundled foreground-watch helper (native/foreground-watch.cs on Windows,
 * native/mac/foreground-watch.swift on macOS; none elsewhere, so the tracker stays off):
 *   - watch mode: ONE persistent helper process holding a SetWinEventHook, streaming the
 *     foreground process name (bare, no ".exe") over stdout on every change — event-driven,
 *     zero polling. This replaced a powershell.exe spawn every 1.5s (~40 processes/min),
 *     which endpoint-security tools flag as malware-like process churn.
 *   - list mode (one-shot): every process owning a real window, for the editor's
 *     "browse running apps" picker.
 *
 * Debounce is unchanged in spirit: a new foreground app is only committed (reported via
 * onChange) once it has HELD focus for COMMIT_MS, so rapid alt-tabbing can't flick pages,
 * and the tracker never fights a manual page navigation while the same app stays focused.
 */
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const { helperPath } = require('./nativeHelpers');
const WATCH_EXE = helperPath('foregroundWatch');   // null on platforms without a helper

const COMMIT_MS = 3000;     // a new app must hold focus this long before it's reported (matches the old 2×1.5s polls)
const RESPAWN_MS = 5000;    // helper crash -> retry delay (only while running)

let running = false, proc = null, respawnTimer = null, commitTimer = null;
let committed = null;             // the last process name actually reported to onChange
let onChange = null;
let warned = false;

function clearTimers() {
  if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
}

function onLine(name) {
  if (!running || !name) return;
  if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
  if (name === committed) return;                     // back to the committed app -> nothing pending
  commitTimer = setTimeout(() => {
    commitTimer = null;
    if (!running) return;
    committed = name;
    if (onChange) onChange(name);
  }, COMMIT_MS);
}

function spawnWatcher() {
  if (!running || proc) return;
  if (!WATCH_EXE || !fs.existsSync(WATCH_EXE)) {
    if (!warned) { warned = true; console.log('[desktopFocus] foreground-watch helper missing (native helpers not built) — auto-follow inactive'); }
    return;
  }
  // stdin stays open (piped): the helper exits on stdin EOF, so it can never outlive us.
  try { proc = spawn(WATCH_EXE, ['watch'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch (e) { proc = null; return; }
  let buf = '';
  proc.stdout.on('data', d => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  });
  proc.on('error', () => {});
  proc.on('close', () => {
    proc = null;
    if (running && !respawnTimer) respawnTimer = setTimeout(() => { respawnTimer = null; spawnWatcher(); }, RESPAWN_MS);
  });
}

// Every top-level titled window (EnumWindows in the helper — minimized included), one entry PER
// WINDOW: [{ processName, title, hwnd, minimized }]. A process can own several windows — e.g. four
// Chrome windows — and each appears here; the hwnd is what slide capture builds its source id from.
function listAllWindows() {
  return new Promise(resolve => {
    if (!WATCH_EXE || !fs.existsSync(WATCH_EXE)) return resolve([]);
    execFile(WATCH_EXE, ['list'], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      let rows;
      try { rows = JSON.parse(String(stdout).trim()); } catch (e) { return resolve([]); }
      if (!Array.isArray(rows)) rows = [rows];
      const out = [];
      for (const r of rows) {
        if (!r || !r.ProcessName) continue;
        out.push({ processName: r.ProcessName, title: r.MainWindowTitle || '', hwnd: r.Hwnd || 0, minimized: !!r.Minimized });
      }
      resolve(out);
    });
  });
}

// [{ processName, title }], DEDUPED by processName for the editor's "browse running apps" picker
// (you pick an app, not a window; keep one representative title per process).
function listRunningApps() {
  return listAllWindows().then(rows => {
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      if (!r.processName || seen.has(r.processName)) continue;
      seen.add(r.processName);
      out.push({ processName: r.processName, title: r.title || '' });
    }
    out.sort((a, b) => a.processName.localeCompare(b.processName));
    return out;
  });
}

/** cb(processName) fires on each committed (debounced) foreground-process change. */
function start(cb) {
  onChange = cb;
  if (running) return;
  if (!WATCH_EXE) return;
  running = true;
  spawnWatcher();
}
function stop() {
  running = false;
  clearTimers();
  if (proc) { try { proc.kill(); } catch (e) {} proc = null; }
  committed = null;
}

/** The last debounced/committed foreground process name (what onChange most recently fired with), or null. */
function getCommittedProcess() { return committed; }

module.exports = { start, stop, listRunningApps, listAllWindows, getCommittedProcess };
