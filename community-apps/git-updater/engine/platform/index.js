'use strict';

// Platform strategy layer. Everything OS-specific lives behind this one interface:
//
//   installedApps()      -> [{ name, version, flavor }]   (async, slow, cached by caller)
//   runningProcesses()   -> [{ name, pid }]               (async)
//   killProcess(pid, force)                               (sync, best effort)
//
// `flavor` is how the app is currently installed — Windows 'msi' | 'exe', Linux
// 'deb' | 'rpm' | 'flatpak' | 'snap', macOS 'app'. The asset picker uses it to pick
// the SAME format on update, so a second copy never lands beside the first.
//
// Asset tables live in ./assets — that module is pure and IO-free so core.js can
// require it without dragging child_process into the "no IO" half of the engine.

const { assetTable } = require('./assets');

const IMPLS = {
  win32: () => require('./win'),
  darwin: () => require('./mac'),
  linux: () => require('./linux'),
};

// An unsupported platform gets a no-op implementation rather than a crash: portable
// installs still work, and only the "what's already installed" and "is it running"
// features go quiet — the same graceful degradation the Windows-only build had.
const NOOP = {
  installedApps: async () => [],
  runningProcesses: async () => [],
  killProcess: () => {},
};

// Optional per-platform archive handling. Only macOS defines it (ditto / hdiutil, so
// .app bundles keep their symlinks, modes and code signature); everywhere else the
// generic zip/7z/tar path in install.js does the work.
async function extract(archivePath, destDir) {
  const p = impl();
  return p.extract ? p.extract(archivePath, destDir) : false;
}

// Optional integrity check on an extracted or installed payload. Only macOS defines it,
// where an application bundle is cryptographically sealed and a single stray file inside
// it makes the app refuse to launch. null means "nothing here to check".
async function verifyPayload(dir) {
  const p = impl();
  return p.verifyPayload ? p.verifyPayload(dir) : null;
}

function impl(platform) {
  const key = platform || process.platform;
  const make = IMPLS[key];
  return make ? make() : NOOP;
}

const current = impl();

module.exports = {
  impl,
  assetTable,
  extract,
  verifyPayload,
  installedApps: (...a) => current.installedApps(...a),
  runningProcesses: (...a) => current.runningProcesses(...a),
  killProcess: (...a) => current.killProcess(...a),
};
