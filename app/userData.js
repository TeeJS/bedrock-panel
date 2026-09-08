'use strict';
// Bedrock Panel was called open-quake through v0.9.x. Electron derives the userData folder from the
// package name, so the rename alone would start every existing install with an empty config (and lose
// the dashboards' persisted logins, which live in Chromium's session data under the same folder).
// This moves the old folder to the new name ONCE, at startup, before anything opens it — the config,
// the single-instance lock, and Chromium's session data all key off userData, so it must run before
// `app.getPath('userData')` is first read and before the `ready` event.
//
// Failure policy: if the rename throws (a locked file, an AV scanner holding the folder), keep using
// the OLD folder for this run and retry on the next launch. Nothing is ever copied or deleted, so a
// failed attempt can't leave two half-copies.
const fs = require('fs');
const path = require('path');

const OLD_NAME = 'open-quake';
const NEW_NAME = 'bedrock-panel';

function exists(p) { try { fs.statSync(p); return true; } catch (e) { return false; } }
function hasContent(dir) { try { return fs.readdirSync(dir).length > 0; } catch (e) { return false; } }

// Move oldDir → newDir. `marker` (e.g. 'config.json') names the file that proves a folder is "live".
// Returns { status, dir } — `dir` is the folder to USE for this run:
//   'none'   nothing to migrate (fresh install, or already migrated)            → newDir
//   'moved'  old folder renamed to the new name                                  → newDir
//   'merged' newDir already existed with unrelated content; old entries moved in → newDir
//   'failed' rename threw; the old folder stays authoritative this run           → whichever holds the marker
function migrateDir(oldDir, newDir, opts) {
  const marker = (opts && opts.marker) || '';
  const log = (opts && opts.log) || (() => {});
  const live = dir => marker ? exists(path.join(dir, marker)) : hasContent(dir);
  if (!hasContent(oldDir)) return { status: 'none', dir: newDir };
  if (live(newDir)) return { status: 'none', dir: newDir };           // new folder already in use; leave the old one alone
  try {
    if (!exists(newDir)) { fs.renameSync(oldDir, newDir); return { status: 'moved', dir: newDir }; }
    if (!hasContent(newDir)) { fs.rmdirSync(newDir); fs.renameSync(oldDir, newDir); return { status: 'moved', dir: newDir }; }
    // newDir exists with content (e.g. Chromium pre-created cache dirs) but isn't live: move the old
    // entries in, skipping anything that would collide.
    for (const entry of fs.readdirSync(oldDir)) {
      const dst = path.join(newDir, entry);
      if (exists(dst)) continue;
      fs.renameSync(path.join(oldDir, entry), dst);
    }
    return { status: 'merged', dir: newDir };
  } catch (e) {
    log('user data migration failed (' + oldDir + ' → ' + newDir + '): ' + (e && e.message));
    return { status: 'failed', dir: live(newDir) && !live(oldDir) ? newDir : oldDir };
  }
}

// Remove the old parent folder if the migration left it empty (best-effort, never throws).
function pruneEmpty(dir) { try { if (exists(dir) && !hasContent(dir)) fs.rmdirSync(dir); } catch (e) {} }

// Wire the migration into an Electron `app`. Call immediately after requiring electron, before any
// module reads app.getPath('userData'). A harness that wants isolation should set app.setPath('appData')
// BEFORE calling this — userData/sessionData are derived from appData here.
function applyToApp(app, log) {
  const say = log || (() => {});
  const appData = app.getPath('appData');
  const r = migrateDir(path.join(appData, OLD_NAME), path.join(appData, NEW_NAME), { marker: 'config.json', log: say });
  app.setPath('userData', r.dir);
  app.setPath('sessionData', r.dir);   // cookies/cache for dashboard logins — must follow userData
  if (r.status !== 'none') say('user data: ' + r.status + ' → ' + r.dir);
  // Drop-in apps can live outside userData (%LOCALAPPDATA%\<name>\apps, or %APPDATA% when it differs
  // from Electron's appData). Move those too; the drop-in dir is computed from NEW_NAME from now on.
  // (When %APPDATA% is Electron's appData, the userData rename above already carried apps/ along, so
  // that base is a no-op unless the rename failed — then apps/ still moves, matching dropInDir().)
  const bases = [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean)
    .filter((b, i, arr) => arr.findIndex(x => path.resolve(x) === path.resolve(b)) === i);
  for (const base of bases) {
    const oldApps = path.join(base, OLD_NAME, 'apps'), newApps = path.join(base, NEW_NAME, 'apps');
    if (!hasContent(oldApps)) continue;
    try { fs.mkdirSync(path.join(base, NEW_NAME), { recursive: true }); } catch (e) {}
    const a = migrateDir(oldApps, newApps, { log: say });
    if (a.status !== 'none') say('drop-in apps: ' + a.status + ' → ' + a.dir);
    pruneEmpty(path.join(base, OLD_NAME));
  }
  return r;
}

module.exports = { OLD_NAME, NEW_NAME, migrateDir, applyToApp };
