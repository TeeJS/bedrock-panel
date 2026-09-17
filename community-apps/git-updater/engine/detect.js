'use strict';

// Installed-version and running-process detection, over whatever inventory the
// running platform actually has: the uninstall registry on Windows, .app bundles on
// macOS, the package managers on Linux. All of that lives in src/platform/; this file
// is the matching logic on top, and is identical everywhere.
//
// Everything here is ASYNC: the inventory calls take seconds, and a sync version would
// freeze the Electron main process (window paint, IPC) for that whole time.

const platform = require('./platform');
const { cmpVersion } = require('./core');

const norm = (s) => String(s || '').toLowerCase().replace(/\.(exe|app)$/, '').replace(/[^a-z0-9]/g, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let cache = null; // cleared after installs so fresh versions show
function clearCache() {
  cache = null;
}

// Every installed app: [{ name, version, flavor }]. One inventory pass per run.
// DisplayName/DisplayVersion are kept as aliases because src/catalog.js and the
// open-quake drop-in read the records under those names.
async function allInstalled() {
  if (cache) return cache;
  const rows = await platform.installedApps();
  cache = rows
    .filter((e) => e && e.name && e.version)
    .map((e) => ({ ...e, DisplayName: e.name, DisplayVersion: e.version }));
  return cache;
}

async function matchEntries(needle) {
  const t = norm(needle);
  if (t.length < 2) return [];
  return (await allInstalled()).filter((e) => {
    const n = norm(e.name);
    return n.length >= 2 && (n.includes(t) || t.includes(n));
  });
}

// Best version for an app whose inventory name matches `needle`. An app can have
// several entries (e.g. an old EXE install alongside a newer MSI install, or a deb
// and a flatpak) — report the highest version. null = not installed.
async function installedVersion(needle) {
  const hits = await matchEntries(needle);
  if (!hits.length) return null;
  return hits.map((h) => h.version).sort(cmpVersion).pop();
}

// How is the app currently installed — 'msi'/'exe' on Windows, 'deb'/'rpm'/'flatpak'/
// 'snap' on Linux, 'app' on macOS? null when not installed. Used to pick the SAME
// package format on update, so a second copy never lands beside the first.
async function installedFlavor(needle) {
  const hits = await matchEntries(needle);
  if (!hits.length) return null;
  hits.sort((a, b) => cmpVersion(a.version, b.version));
  return hits[hits.length - 1].flavor || null;
}

// --- running-process detection (for a proactive "close the app" warning) ------

async function matchProcs(needle) {
  const t = norm(needle);
  if (t.length < 3) return [];
  return (await platform.runningProcesses()).filter((p) => {
    const pn = norm(p.name);
    return pn.length >= 3 && (pn.includes(t) || t.includes(pn));
  });
}

// Is a process whose name looks like `needle` running? Loose alphanumeric match
// (so "notepad-plus-plus" matches "notepad++.exe"); override per app with `process`.
async function isRunning(needle) {
  return (await matchProcs(needle)).length > 0;
}

// Close the running processes for `needle` — graceful by default (WM_CLOSE on Windows,
// SIGTERM elsewhere), or forced. Waits briefly for exit.
// ponytail: kill by PID; force can lose unsaved work, so the UI double-confirms it.
async function closeApp(needle, opts = {}) {
  const procs = await matchProcs(needle);
  for (const p of procs) platform.killProcess(p.pid, !!opts.force);
  for (let i = 0; i < 15 && (await isRunning(needle)); i++) await wait(200); // up to ~3s to exit
  return { closed: procs.length, stillRunning: await isRunning(needle) };
}

module.exports = {
  installedVersion,
  installedFlavor,
  isRunning,
  closeApp,
  clearCache,
  allInstalled,
  // Former name, kept so the vendored open-quake drop-in keeps working.
  registryVersion: installedVersion,
};
