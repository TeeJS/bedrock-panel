'use strict';

// IO edge: apply an update — portable swap (with rollback) or silent installer.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const { installerCmd } = require('./core');
const platform = require('./platform');
const tar = require('./tar');
const { log } = require('./log');

const isWin = process.platform === 'win32';

// --- portable swap ----------------------------------------------------------

// lstat, not stat: a macOS .app bundle contains symlinks that point back up the tree
// (Contents/Frameworks/*/Versions/Current -> A). Following them would list the same
// files repeatedly and, for a self-referential link, never terminate. A symlink is a
// leaf here — it is carried across by name, exactly as the archive shipped it.
function walk(root, base = root, out = []) {
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue; // vanished mid-walk, or a link we cannot stat
    }
    if (st.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

// Directories that ARE a unit of software rather than a wrapper around one. On macOS an
// application is a directory, so the flattening below would walk straight into it:
// stage/Foo.app -> stage/Foo.app/Contents, and what gets installed is a Contents folder
// with no bundle around it. Not a damaged app — no app at all. Every single-app disk
// image and every zip holding one .app takes that path, so this guard is unconditional
// rather than gated on the platform: a zip containing a bundle is a zip containing a
// bundle whichever OS unpacks it, and descending into one is never what was meant.
const BUNDLE_DIR = /\.(app|framework|bundle|plugin|appex|kext|xpc|prefPane|qlgenerator)$/i;

// If the archive wraps everything in N leading single-dir levels, descend past them.
function stripDirs(root, n) {
  let cur = root;
  for (let i = 0; i < n; i++) {
    const items = fs.readdirSync(cur);
    if (items.length !== 1) break;
    if (BUNDLE_DIR.test(items[0])) break; // the payload itself — never descend into it
    let st;
    try {
      st = fs.statSync(path.join(cur, items[0]));
    } catch {
      break;
    }
    if (!st.isDirectory()) break;
    cur = path.join(cur, items[0]);
  }
  return cur;
}

const OLD_SUFFIX = '.git-updater-old'; // previous version parked here during the swap

// Windows holds transient handles on files that were just written — real-time antivirus
// scanning 150MB of freshly extracted executables is the usual cause — and a directory
// rename then fails with EPERM even though nothing is legitimately using it.
//
// Reported from a real machine: a self-update failed renaming a staging directory it had
// created itself moments earlier, with EPERM on a path nothing else could have been
// holding. docs/INTERNALS already described this as a known class; it had no mitigation.
//
// Retrying is the established answer and this project already does it at BUILD time
// (waitUnlocked in sign.js). A second is plenty for a scanner to let go. A rename that
// fails because the app is genuinely RUNNING still fails after the last attempt, so the
// caller's "close it and Retry" message is delayed by a moment rather than replaced.
//
// Synchronous by necessity: swapDir is sync, and the whole point of it is that no other
// work interleaves between parking the old version and moving the new one in.
const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms; // SharedArrayBuffer unavailable: spin rather than skip
    while (Date.now() < until);
  }
};

function renameWithRetry(from, to, opts = {}) {
  const rename = opts.rename || fs.renameSync;
  const sleep = opts.sleep || sleepSync;
  const waits = opts.waits || [100, 200, 400, 800];
  for (let i = 0; ; i++) {
    try {
      return rename(from, to);
    } catch (e) {
      if (i >= waits.length || !TRANSIENT_RENAME.has(e.code)) throw e;
      sleep(waits[i]);
    }
  }
}



// Extract an archive into destDir using 7z-wasm (pure WASM, no external binary).
// Mounts destDir into the wasm FS, copies the archive in, extracts, cleans up.
// opts.archiveName keeps the real extension so 7-Zip picks the right codec — needed
// when this is unwrapping a .tar.xz / .tar.bz2 rather than extracting a .7z.
async function extract7z(archivePath, destDir, opts = {}) {
  const SevenZip = require('7z-wasm');
  // In the packaged exe the .wasm is a SEA asset; in dev emscripten finds it itself.
  let wasmBinary;
  try {
    const sea = require('node:sea');
    if (sea.isSea()) wasmBinary = sea.getAsset('7zz.wasm');
  } catch {}
  const sevenZip = await SevenZip(wasmBinary ? { wasmBinary } : undefined);

  const mnt = '/out';
  sevenZip.FS.mkdir(mnt);
  sevenZip.FS.mount(sevenZip.NODEFS, { root: destDir }, mnt);
  const archName = opts.archiveName || 'input.7z';
  fs.copyFileSync(archivePath, path.join(destDir, archName));
  sevenZip.FS.chdir(mnt);

  let rc = 0;
  try {
    // callMain may RETURN the exit code (not throw) — capture both paths.
    const ret = sevenZip.callMain(['x', archName, '-y']); // extract flat into the mounted dir
    if (typeof ret === 'number') rc = ret;
  } catch (e) {
    rc = e && e.status !== undefined ? e.status : 1; // emscripten ExitStatus on exit()
  }
  fs.rmSync(path.join(destDir, archName), { force: true });

  // A corrupt/invalid archive makes 7-Zip print "Is not archive" and exit nonzero, but
  // the extraction "succeeds" with zero files — verify BOTH the exit code and real output.
  const produced = walk(destDir).length;
  if (rc !== 0 || produced === 0) {
    throw new Error(
      `${opts.label || '.7z'} extraction failed (exit ${rc}, ${produced} files) — the download may be corrupt or not a ${opts.label || '7-Zip'} archive`
    );
  }
}

// .tar.xz / .tar.bz2: 7-Zip unwraps the outer compressor to a plain .tar, which the
// tar reader then extracts WITH its Unix mode bits (7-Zip would drop them).
async function extractCompressedTar(archivePath, destDir, label) {
  const unwrap = fs.mkdtempSync(path.join(destDir, '.unwrap-'));
  try {
    await extract7z(archivePath, unwrap, { archiveName: path.basename(archivePath), label });
    const inner = fs.readdirSync(unwrap).map((n) => path.join(unwrap, n));
    const tarFile = inner.find((p) => /\.tar$/i.test(p)) || inner[0];
    if (!tarFile) throw new Error(`${label} archive contained no tar`);
    tar.extractTar(tarFile, destDir);
  } finally {
    fs.rmSync(unwrap, { recursive: true, force: true });
  }
}

// A zip records Unix permissions in each entry's external-attribute field, but adm-zip
// does not apply them on extract — so every binary lands non-executable and the app
// fails at FIRST LAUNCH, long after the update reported success. Re-apply them here.
// A zip built on Windows carries no such attributes; those entries are left alone.
//
// Returns the [{ path, mode }] it resolved on EVERY platform. Only the chmod call is
// skipped on Windows. Reporting the decision is what lets the resolution logic be
// asserted from any host: a test that can only run on one OS verifies nothing on the
// other, which is how both dead fixtures in this suite went unnoticed.
function restoreZipModes(zipPath, destDir) {
  let entries;
  try {
    entries = new AdmZip(zipPath).getEntries();
  } catch {
    return [];
  }
  const root = path.resolve(destDir);
  const contained = tar.containmentChecker(destDir);
  const resolved = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    const mode = (e.header.attr >>> 16) & 0o7777;
    if (!mode) continue;
    // The attribute field is attacker-controlled, so the path is re-checked here even
    // though adm-zip's own extraction is zip-slip-safe. Both checks are needed: the
    // lexical one stops "../", and realContained stops a chmod that would follow a
    // symlinked path component out of destDir onto someone else's file.
    const full = path.resolve(destDir, e.entryName);
    if (!full.startsWith(root + path.sep)) continue;
    if (!contained(full)) continue;
    resolved.push({ path: path.relative(destDir, full), mode });
    if (isWin) continue; // nothing to apply, but the entry is still reported
    try {
      fs.chmodSync(full, mode);
    } catch {}
  }
  return resolved;
}

// Extract an archive (or place a bare portable file) into stageDir, auto-flattening any
// version-named wrapper folder(s) the archive wraps everything in. Returns the file list
// (relative paths) and the directory those files actually live in (post-flatten).
async function extractArchive(archivePath, stageDir, stripOpt) {
  // macOS handles .dmg and .zip itself (ditto / hdiutil), because a .app bundle's
  // symlinks, modes and code signature do not survive a generic unzipper.
  const handled = await platform.extract(archivePath, stageDir);
  if (!handled) {
    if (/\.7z$/i.test(archivePath)) {
      await extract7z(archivePath, stageDir);
    } else if (/\.zip$/i.test(archivePath)) {
      new AdmZip(archivePath).extractAllTo(stageDir, /* overwrite */ true); // adm-zip >=0.5.10 is zip-slip-safe
      restoreZipModes(archivePath, stageDir);
    } else if (/\.(tar\.gz|tgz|tar)$/i.test(archivePath)) {
      tar.extractTar(archivePath, stageDir);
    } else if (/\.tar\.xz$/i.test(archivePath)) {
      await extractCompressedTar(archivePath, stageDir, '.tar.xz');
    } else if (/\.tar\.bz2$/i.test(archivePath)) {
      await extractCompressedTar(archivePath, stageDir, '.tar.bz2');
    } else {
      // Bare portable file: a single .exe on Windows, an .AppImage on Linux. The
      // AppImage arrives as plain bytes with no permission bits anywhere, so it has to
      // be made executable here or it simply will not run.
      const placed = path.join(stageDir, path.basename(archivePath));
      fs.copyFileSync(archivePath, placed);
      if (!isWin) {
        try {
          fs.chmodSync(placed, 0o755);
        } catch {}
      }
    }
  }
  // Auto-flatten version-named wrapper folders (deskflow-1.26.0-.../). Explicit strip wins.
  const srcDir = stripOpt != null ? stripDirs(stageDir, stripOpt) : stripDirs(stageDir, Infinity);
  const files = walk(srcDir);
  if (files.length === 0) throw new Error('archive contained no files');
  return { files, srcDir };
}

// Transactional directory swap by rename — dest is always either the complete old version
// or the complete new one, never a mix. srcDir (already-extracted, same volume as dest) is
// moved into dest's place; the previous dest, if any, is parked at oldSuffix first and rolled
// back whole on any failure. carryOver (default true) copies runtime-created user files from
// the parked old dir forward — comparing against prevManifest (what WE shipped last time) so
// stale shipped files stay dropped; skip it for a target with no such manifest (e.g. self-update).
// deleteOldDir (default true) removes the parked old dir once the swap commits — skip it when
// the caller can't safely delete it yet (e.g. self-update, which is executing FROM that dir).
function swapDir(dest, srcDir, opts = {}) {
  const { files = walk(srcDir), carryOver = true, prevManifest, oldSuffix = OLD_SUFFIX, deleteOldDir = true } = opts;
  const oldDir = dest + oldSuffix;

  // Swap: park the old dir, move the new one in; restore the old on any failure.
  const hadOld = fs.existsSync(dest);
  if (hadOld) {
    try {
      // EBUSY/EPERM here if the app is running — on WINDOWS. A POSIX rename of a
      // running application's directory succeeds, so this is not a cross-platform
      // guard: macOS and Linux rely on the running-app check in runner.js instead.
      renameWithRetry(dest, oldDir);
    } catch (e) {
      if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') {
        const err = new Error('app files are in use — close the app and Retry');
        err.locked = true;
        throw err;
      }
      throw e;
    }
  }
  try {
    renameWithRetry(srcDir, dest);
  } catch (e) {
    if (hadOld) renameWithRetry(oldDir, dest); // complete rollback: old version restored whole
    throw e;
  }

  if (hadOld && carryOver) {
    // Carry over runtime files (user settings etc.): in the old dir, not shipped by the
    // new version, and not shipped by the PREVIOUS version either (those are stale and
    // stay dropped). Compared as strings only — a poisoned manifest can't reach outside.
    const norm = (f) => f.replace(/\\/g, '/');
    const shipped = new Set(files.map(norm));
    const prevShipped = new Set((prevManifest || []).map(norm));
    for (const rel of walk(oldDir)) {
      const n = norm(rel);
      if (shipped.has(n) || prevShipped.has(n)) continue;
      // Never write INSIDE a bundle. On macOS the app folder IS the .app, and a single
      // foreign file breaks its code-signature seal — Gatekeeper then refuses to launch
      // it, after an update that reported success, with nothing saying why. There is
      // nothing legitimate to carry over in there either: a mac app keeps its user data
      // in ~/Library, not inside its own bundle.
      //
      // A normal second update never reaches this, because everything the old bundle
      // shipped is in prevManifest. It fires when that manifest is empty or short — a
      // corrupt state.json is documented to start fresh — and then every file of the old
      // bundle would be injected into the new one.
      if (n.split('/').some((seg) => BUNDLE_DIR.test(seg))) continue;
      const to = path.join(dest, rel);
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(oldDir, rel), to);
      } catch {}
    }
  }
  if (hadOld && deleteOldDir) fs.rmSync(oldDir, { recursive: true, force: true }); // commit: old version gone
  return files;
}

// Transactional portable install: extract into a staging dir ON THE SAME VOLUME as
// the target, then swap whole directories by rename via swapDir(). prevManifest (what
// WE shipped last time, from state) separates stale shipped files (dropped) from
// runtime-created user files (carried over). Returns the new manifest.
async function installPortable(archivePath, install, prevManifest) {
  const dest = path.resolve(install.dir);
  const parent = path.dirname(dest);
  const base = path.basename(dest);
  fs.mkdirSync(parent, { recursive: true });
  const oldDir = dest + OLD_SUFFIX;

  // Crash recovery: a previous run parked the old version and died before finishing.
  if (fs.existsSync(oldDir) && !fs.existsSync(dest)) fs.renameSync(oldDir, dest);
  fs.rmSync(oldDir, { recursive: true, force: true }); // any other leftover is disposable

  // Stage next to the destination so the renames below are same-volume (atomic-ish).
  const stage = fs.mkdtempSync(path.join(parent, `.${base}.git-updater-stage-`));
  try {
    const hadOld = fs.existsSync(dest);
    const { files, srcDir } = await extractArchive(archivePath, stage, install.strip);

    // A macOS application bundle is cryptographically sealed, so anything this install
    // adds inside it makes the app refuse to launch — after an update that reported
    // success, with nothing saying why. The carry-over guard in swapDir fixes the cause
    // we found; this catches the same class of damage from a cause we have not.
    //
    // DIFFERENTIAL, never absolute. Plenty of projects ship an unsigned or ad-hoc .app
    // and those fail verification too; refusing them would quietly drop support for
    // software the user can install by hand today. Only a valid-BEFORE, invalid-AFTER
    // transition means we broke it. Anything else installs exactly as it always did.
    const before = hadOld ? await platform.verifyPayload(srcDir) : null;
    const check = !!(before && before.valid);

    // When checking, the old version stays parked rather than being deleted, so a
    // failure can restore a working app instead of leaving a corpse and an error.
    const out = swapDir(dest, srcDir, { files, carryOver: true, prevManifest, deleteOldDir: !check });
    if (!check) return out;

    const after = await platform.verifyPayload(dest);
    if (after && !after.valid) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(oldDir, dest); // the previous version, whole
      const err = new Error(
        `the updated app failed signature verification (${after.reason}) — the previous version has been restored`
      );
      err.signature = true;
      throw err;
    }
    fs.rmSync(oldDir, { recursive: true, force: true }); // commit
    return out;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// Detect an installer's technology from its bytes (far safer than assuming every
// .exe is NSIS). Falls back to null when unrecognized, which the caller turns into
// "open the installer's own window" rather than guessing silent switches.
function detectInstallerKind(filePath) {
  if (/\.msi$/i.test(filePath)) return 'msi';
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  const magic = (s) => buf.subarray(0, s.length).toString('latin1') === s;
  if (buf.length > 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'msi'; // OLE compound = MSI
  if (magic('xar!')) return 'pkg'; // macOS flat package is a xar archive
  if (magic('!<arch>')) return 'deb'; // .deb is an ar archive
  if (buf.length > 4 && buf[0] === 0xed && buf[1] === 0xab && buf[2] === 0xee && buf[3] === 0xdb) return 'rpm';
  // These two scan the whole file, so they come last.
  if (buf.indexOf(Buffer.from('Inno Setup')) !== -1) return 'inno';
  if (buf.indexOf(Buffer.from('Nullsoft')) !== -1) return 'nsis';
  return null;
}

// --- installer --------------------------------------------------------------

// Windows installer exit codes. 3010 (reboot required) counts as success.
const WIN_INSTALLER_CODES = {
  1602: 'installer was cancelled',
  1603: 'silent install needs administrator rights',
  1618: 'another installer is already running — wait for it to finish, then Retry',
  1619: 'installer package could not be opened',
  1620: 'installer package is invalid',
};

function installInstaller(filePath, install, opts = {}) {
  const { exe, args } = installerCmd(install.kind, filePath, install.args);
  const command = [exe, ...args].join(' ');
  if (opts.dryRun) return { command, dryRun: true };
  log(`  installer (${install.kind}): ${command}`);
  // Launch the installer directly (no PowerShell). A requireAdministrator installer that
  // can't elevate from a non-elevated parent fails here; surface a clear message instead.
  const r = spawnSync(exe, args, {
    windowsHide: true,
    timeout: opts.timeout || 10 * 60 * 1000,
    stdio: 'ignore',
  });
  if (r.error) {
    if (r.error.code === 'EACCES' || r.error.code === 'EPERM' || r.error.errno === -4092) {
      const err = new Error('needs administrator rights');
      err.elevation = true; // callers fall back to the installer's own window (UAC)
      throw err;
    }
    throw r.error;
  }
  if (r.status !== 0 && !(isWin && r.status === 3010)) {
    // 3010 = reboot required (success). 1603 from a silent machine-install is almost
    // always missing admin rights (silent installs can't show a UAC prompt).
    if (isWin) {
      const err = new Error(
        WIN_INSTALLER_CODES[r.status] || `installer failed (exit ${r.status}) — if the app is open, close it and Retry`
      );
      err.status = r.status;
      throw err;
    }
    // macOS installer(8) and Linux dpkg/rpm all write to system locations, so an
    // unelevated run fails with a plain nonzero exit and no distinguishing code. That
    // is the normal case here — git-updater never self-elevates — so flag it for the
    // caller, which reopens the package in the desktop's own installer where the user
    // gets a standard authorization prompt.
    const err = new Error(
      install.kind === 'pkg'
        ? 'installing a .pkg needs administrator rights'
        : 'installing a system package needs root'
    );
    err.status = r.status;
    err.elevation = true;
    throw err;
  }
  return { command, status: r.status };
}

module.exports = {
  installPortable,
  installInstaller,
  detectInstallerKind,
  extractArchive,
  swapDir,
  renameWithRetry,
  // exported for tests
  restoreZipModes,
  BUNDLE_DIR,
  stripDirs,
  walk,
};
