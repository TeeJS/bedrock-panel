'use strict';

// Which .app paths count as an INSTALLED APPLICATION.
//
// system_profiler is Spotlight-backed and reports every bundle anywhere on disk, not the
// set of installed applications. On one ordinary developer machine it returned 340 rows
// including node_modules/electron/dist/Electron.app, a dist/ build output, two cached
// copies of one app under Application Support, and Script Editor template stubs.
//
// That is not cosmetic. detect.installedVersion() reports the HIGHEST version across
// every name match, so a build artifact or a stale cache raises the reported installed
// version above what is really installed, the comparison says "up to date", and the user
// is never offered the update. An updater that silently declines to update is worse than
// one that errors.
//
// Four structural clauses, no name patterns — patterns rot, path structure does not:
//
//   1. the path ends in exactly ".app"       (a TestGUI.app.in template is not an app)
//   2. no ".app" component before the last   (a helper nested inside another bundle)
//   3. its directory is an app dir, or one vendor subfolder beneath one
//   4. it is not Apple's own, and it has a version                (applied by the caller)
//
// Measured against those 340 rows: 24 survive, 305 die on clause 3, 6 on clause 1, 5 on
// clause 2. Ground truth read off disk was 25 real bundles; the predicate keeps 24 of
// them and the only miss is Safari, which system_profiler never reports at all and which
// clause 4 would drop anyway. Zero real false negatives.
//
// Clause 2 caught nothing on that machine — every nested row was Apple's, already dead on
// clauses 3 and 4 — despite it carrying Docker, Chrome, Office, Spotify, Zoom and Teams,
// all of which ship helper bundles. So system_profiler appears not to report nested
// helpers. It is kept anyway: it is two lines, it is structurally correct, and Spotlight's
// indexing rules are an implementation detail rather than a contract.

const path = require('path');
const os = require('os');

// Where an installed application actually lives. ~/Applications is the per-user
// equivalent, and is where a non-admin install of a downloaded .app ends up.
const APP_DIRS = () => [
  path.join(path.sep, 'Applications'),
  path.join(os.homedir(), 'Applications'),
];

// One level of vendor subfolder is allowed, because that is a real convention:
// /Applications/Utilities, and installers like Setapp that group their apps.
// Unlimited depth is refused — it would re-admit everything clause 2 exists to stop.
function isInstalledAppPath(appPath, dirs) {
  const p = String(appPath || '');
  if (!p) return false;

  const parts = p.split(/[\\/]+/).filter(Boolean);
  const leaf = parts[parts.length - 1];
  if (!leaf || !/\.app$/i.test(leaf)) return false; // clause 1
  if (parts.slice(0, -1).some((seg) => /\.app$/i.test(seg))) return false; // clause 2

  // clause 3
  const dir = path.dirname(p);
  const roots = dirs || APP_DIRS();
  return roots.some((root) => {
    if (dir === root) return true;
    const rel = path.relative(root, dir);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !/[\\/]/.test(rel);
  });
}

module.exports = { isInstalledAppPath, APP_DIRS };
