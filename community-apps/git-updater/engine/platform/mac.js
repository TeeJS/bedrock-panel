'use strict';

// macOS: there is no uninstall registry. The equivalent inventory is the set of .app
// bundles on disk plus each bundle's CFBundleShortVersionString.
//
// Primary source is `system_profiler SPApplicationsDataType -json` — one call that
// returns every app with its name, version and path. Like the three `reg query` calls
// on Windows it takes seconds, which is why the caller caches it for the whole run.
// Fallback is a directory scan reading each bundle's Info.plist directly, for machines
// where Spotlight indexing is off or system_profiler is unavailable.

const fs = require('fs');
const path = require('path');
const os = require('os');
const exec = require('./exec');
const { run } = exec;

const { isInstalledAppPath, APP_DIRS } = require('./appfilter');

// --- system_profiler ---------------------------------------------------------

// Provenances that are updated by a STORE rather than from a GitHub release. Apple's own
// apps come through Software Update; App Store apps come through the App Store. Offering
// either can only produce a false match, because the version schemes are unrelated to any
// tag we would compare against.
//
// mac_app_store is the more damaging of the two, and the reason is structural rather than
// cosmetic. Measured on a real machine: every App Store app carries its receipt INSIDE the
// bundle at Contents/_MASReceipt/receipt — Bitwarden, Developer and iScreen Shoter all do,
// while Developer ID apps like Chrome and Docker have none. An update replaces the bundle
// whole, so the receipt goes with it, and the app loses both its App Store update path and
// the receipt it may validate at launch. Bitwarden is the live case: it ships on the App
// Store AND on GitHub, so it WILL match a tracked repo.
//
// The harm that needs no unusual configuration at all is Scan. Receipt destruction
// requires install.dir to point at the App Store app's location, which is deliberate; but
// Scan offers the app, the user ticks it, and git-updater installs a SECOND copy into the
// portable root while the App Store keeps updating the first. Two copies, neither broken,
// neither wanted, and no error anywhere.
//
// The cost is a user who wanted to migrate from the App Store build to the GitHub build.
// That is not what an updater is for, and it is a far smaller harm than silently breaking
// a working install.
const STORE_MANAGED = new Set(['apple', 'apple_sw', 'mac_app_store']);

// Parse `system_profiler SPApplicationsDataType -json` into [{ name, version, flavor, path }].
// Apple's own bundled apps are excluded: they update through Software Update, never
// from a GitHub release, so offering them would only produce false matches.
// Pure: JSON text in, records out. `dirs` overrides the app directories, for tests.
// Exported for tests.
function parseSystemProfiler(stdout, dirs) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = (data && data.SPApplicationsDataType) || [];
  const out = [];
  for (const r of rows) {
    if (!r || !r._name) continue;
    if (STORE_MANAGED.has(r.obtained_from)) continue;
    const version = r.version || '';
    if (!version) continue;
    // Spotlight reports every bundle on disk, not the installed set. Without this the
    // inventory carries build outputs and caches, and because installedVersion() takes
    // the HIGHEST match, one of those silently pins an app as already up to date.
    if (!isInstalledAppPath(r.path, dirs)) continue;
    out.push({ name: r._name, version, flavor: 'app', path: r.path });
  }
  return out;
}

// --- Info.plist --------------------------------------------------------------

// Pull CFBundleShortVersionString out of an XML property list. Falls back to
// CFBundleVersion, which is what some apps put the user-facing version in.
// Pure: plist text in, version string or null out. Exported for tests.
function parseInfoPlistXml(text) {
  const pick = (key) => {
    const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, 'i');
    const m = re.exec(text);
    return m && m[1].trim() ? m[1].trim() : null;
  };
  return pick('CFBundleShortVersionString') || pick('CFBundleVersion');
}

// A bundle's version. XML plists are read directly; binary ones (`bplist00`, which is
// what Xcode emits for release builds) go through `defaults read`, an Apple-signed
// system tool that understands both formats.
async function bundleVersion(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  let buf;
  try {
    buf = fs.readFileSync(plist);
  } catch {
    return null;
  }
  if (buf.subarray(0, 8).toString('latin1') !== 'bplist00') {
    return parseInfoPlistXml(buf.toString('utf8'));
  }
  // `defaults read` takes the path WITHOUT the .plist extension.
  const base = plist.replace(/\.plist$/, '');
  const v = (await run('defaults', ['read', base, 'CFBundleShortVersionString'])).trim();
  if (v) return v;
  return (await run('defaults', ['read', base, 'CFBundleVersion'])).trim() || null;
}

// Directory-scan fallback: every .app bundle in the standard locations, with the
// version read from its own Info.plist.
async function scanAppBundles() {
  const found = [];
  const list = (d) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  };
  for (const dir of APP_DIRS()) {
    for (const name of list(dir)) {
      const appPath = path.join(dir, name);
      if (isInstalledAppPath(appPath)) {
        found.push({ name: name.replace(/\.app$/i, ''), appPath });
        continue;
      }
      // One level of vendor subfolder, matching what the predicate accepts — otherwise
      // this scan would miss /Applications/Utilities and every grouped installer like
      // Setapp, while the primary path happily reports them. The two inventories have to
      // agree, or the fallback is a different answer rather than the same one.
      for (const inner of list(appPath)) {
        const nested = path.join(appPath, inner);
        // Same predicate as the primary path, so both see exactly one set of things.
        if (!isInstalledAppPath(nested)) continue;
        found.push({ name: inner.replace(/\.app$/i, ''), appPath: nested });
      }
    }
  }
  const versions = await Promise.all(found.map((f) => bundleVersion(f.appPath)));
  return found
    .map((f, i) => ({ name: f.name, version: versions[i] || '', flavor: 'app', path: f.appPath }))
    .filter((r) => r.version);
}

async function installedApps() {
  // system_profiler walks the whole disk, so give it more room than the default.
  const out = await run('system_profiler', ['SPApplicationsDataType', '-json'], { timeout: 120_000 });
  const rows = parseSystemProfiler(out);
  return rows.length ? rows : scanAppBundles();
}

// --- processes ---------------------------------------------------------------

// Parse `ps -Ao pid=,comm=` into [{ name, pid }]. comm is the full executable path
// (e.g. /Applications/Foo.app/Contents/MacOS/Foo), so the name is its basename —
// which is what matches the repo name the user tracks. Pure; exported for tests.
function parsePs(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    out.push({ name: path.posix.basename(m[2]), pid: m[1] });
  }
  return out;
}

async function runningProcesses() {
  return parsePs(await run('ps', ['-Ao', 'pid=,comm=']));
}

// POSIX signals, so no subprocess at all: SIGTERM lets the app save and quit,
// SIGKILL is the "force" path the UI double-confirms.
function killProcess(pid, force) {
  try {
    process.kill(Number(pid), force ? 'SIGKILL' : 'SIGTERM');
  } catch {}
}

// --- extraction --------------------------------------------------------------
// A .app bundle carries symlinks (Contents/Frameworks), Unix mode bits and a code
// signature. A generic JavaScript unzipper destroys all three and the result fails
// Gatekeeper, so macOS archives go through Apple's own tools instead: ditto for zips,
// hdiutil + ditto for disk images. Both are signed system utilities and take an argv
// array — no shell, consistent with the rest of the engine.

// Copying a 300MB bundle off a compressed disk image is not an inventory query — the
// 60s default would kill ditto mid-copy and, before the exit code was checked, that
// partial copy reported success. Matches the installer timeout in src/install.js.
const COPY_TIMEOUT = 10 * 60 * 1000;

// The last meaningful line a tool wrote to stderr, with its own name prefix stripped.
// Apple's tools put the actual reason there — "Resource temporarily unavailable",
// "image not recognized" — and reporting an exit code instead throws it away. Shared so
// a new call site cannot quietly forget, which is how both ditto sites came to.
function stderrReason(r, tool) {
  const strip = new RegExp(`^${tool}:\\s*`, 'i');
  return String((r && r.err) || '')
    .split(/\r?\n/)
    .map((l) => l.replace(strip, '').trim())
    .filter(Boolean)
    .pop();
}

// ditto succeeds SILENTLY, so its stdout says nothing about whether it worked; only the
// exit code does. A failure here must throw rather than leave a half-copied bundle that
// extracts clean and dies at first launch.
async function ditto(src, dest) {
  const r = await exec.runStatus('ditto', [src, dest], { timeout: COPY_TIMEOUT });
  if (r.code === 0) return;
  if (r.timedOut) {
    throw new Error(`copying ${path.basename(src)} timed out — the disk image may be on slow or failing media`);
  }
  const why = stderrReason(r, 'ditto');
  throw new Error(
    why
      ? `copying ${path.basename(src)} failed: ${why}`
      : `copying ${path.basename(src)} failed (ditto exit ${r.code === null ? 'n/a' : r.code})`
  );
}

// Why a mount failed, in hdiutil's OWN words. The previous message asserted a licence
// agreement for EVERY non-zero exit, and measured on real hardware that is usually wrong:
// a file that is not a disk image at all, and a transient "Resource temporarily
// unavailable", both produced the licence-agreement text. stderr is where hdiutil puts the
// actual reason, so quote it and offer the licence agreement as a possibility rather than
// a diagnosis. A timeout is a different failure and says so.
// When a licence agreement is the KNOWN cause, say so definitively and do not hedge. The
// hedged version of this message shipped first and was measured to be wrong more often
// than right, so guessing a cause is not better than naming it.
//
// git-updater will not agree to a licence on the user's behalf. Technically it could:
// `yes | hdiutil attach` mounts the image, measured on deskflow 1.26.0. It is deliberately
// not done. The agreement is a legal act, the text is 15,000 characters we never show, and
// we cannot know whether a given image carries the GPL or a restrictive EULA. That is the
// same posture as not stripping com.apple.quarantine: the honest limitation beats the
// convenient workaround.
const LICENCE_AGREEMENT =
  'this disk image requires agreeing to a licence agreement before it can be opened, and ' +
  'git-updater will not agree to one for you — open the image yourself, accept the licence, ' +
  'and install the app by hand';

function mountFailure(attach, hasLicence) {
  if (attach.timedOut) return 'mounting the disk image timed out — the file may be on slow or failing media';
  if (hasLicence) return LICENCE_AGREEMENT;
  const reason = stderrReason(attach, 'hdiutil');
  return reason
    ? `could not mount the disk image: ${reason}`
    : `could not mount the disk image (hdiutil exit ${attach.code === null ? 'n/a' : attach.code})`;
}

// Does this image carry a software licence agreement? Read from the image's own resources,
// which is where hdiutil looks: LPic names the languages, STR# the button labels, TEXT the
// agreement itself. Only called on the FAILURE path, so its cost never touches a good build.
//
// udifderez still works on macOS 26 even though its write counterpart udifrez does not —
// resource forks cannot be CREATED any more, which is why an SLA image could not be
// authored here for testing, and why this was the last untested claim on the branch until
// a real one turned up in the wild.
async function hasLicenceAgreement(dmgPath) {
  const r = await exec.runStatus('hdiutil', ['udifderez', '-xml', dmgPath], { timeout: 30_000 });
  if (r.code !== 0) return false; // cannot tell; fall back to quoting hdiutil
  return /<key>(LPic|STR#|TEXT)<\/key>/.test(r.out || '');
}

// Said here rather than inline so it can be asserted without a real disk image: a test that
// needs hdiutil only runs on macOS, and a macOS-only test is not a test anywhere else.
const PKG_IN_DMG =
  'this disk image contains an installer package (.pkg) rather than an application, ' +
  'which git-updater cannot install on macOS — install it by hand from the disk image';

// Mount a .dmg, copy its payload out, unmount. The /Applications symlink that disk
// images conventionally carry is skipped: it is a drag-and-drop affordance, not payload.
async function extractDmg(dmgPath, destDir) {
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'git-updater-dmg-'));
  // The mount must be judged by hdiutil's OWN exit code. mkdtempSync has already created
  // the mountpoint, so a failed attach still leaves a readable empty directory — testing
  // for a readdir throw could never fire, which made the licence-agreement message below
  // unreachable in precisely the case it was written for.
  const attach = await exec.runStatus(
    'hdiutil',
    ['attach', dmgPath, '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mnt],
    { timeout: COPY_TIMEOUT }
  );
  try {
    if (attach.code !== 0) {
      fs.rmSync(mnt, { recursive: true, force: true });
      // hdiutil prints "attach canceled" for a licence agreement it could not get an answer
      // to — our stdin is the null device, so the prompt reads EOF and it declines. That
      // reason is true and useless to a user. Ask the image whether it has an agreement and
      // say so instead. Measured in the wild on deskflow 1.26.0, whose image carries GPL v2.
      throw new Error(mountFailure(attach, await hasLicenceAgreement(dmgPath)));
    }
    let names;
    try {
      names = fs.readdirSync(mnt);
    } catch {
      throw new Error('the disk image mounted but could not be read');
    }
    const payload = names.filter((n) => !n.startsWith('.') && n !== 'Applications');
    // A disk image whose payload is an installer package, not an application. Copying it
    // "succeeds" and leaves a .pkg sitting in the portable folder doing nothing, while
    // the row reports the update applied. The asset picker cannot see this — it only saw
    // a .dmg — so it has to be caught here.
    //
    // It must NOT advise switching the entry to Installer, which is what it used to say.
    // Measured: that advice is a closed loop. The mac asset table counts a .dmg as
    // portable only and an installer as .pkg only, so for a release publishing just a
    // .dmg, pickAsset(assets, 'installer') throws "this app only ships portable builds —
    // change its type to Portable". Switch to Installer and it sends you back to
    // Portable; switch back and you land here again. Each message is right on its own
    // and together they are an infinite loop the user cannot escape.
    //
    // Handling this properly would mean teaching the installer lane to select a .dmg,
    // mount it and hand the .pkg to the desktop installer for authorization — the
    // elevation path in install.js already exists for that. Until then, say what is
    // true and do not send the user somewhere that cannot work.
    if (payload.length && payload.every((n) => /\.(pkg|mpkg)$/i.test(n))) {
      throw new Error(
        PKG_IN_DMG
      );
    }
    let copied = 0;
    for (const name of payload) {
      await ditto(path.join(mnt, name), path.join(destDir, name)); // throws on failure
      copied++; // only reached when the copy actually succeeded
    }
    if (!copied) throw new Error('the disk image contained nothing to install');
  } finally {
    if (attach.code === 0) {
      await run('hdiutil', ['detach', mnt, '-force'], { acceptAnyExit: true });
      fs.rmSync(mnt, { recursive: true, force: true });
    }
  }
}

// Returns true when it handled the archive, false to let the generic path take it.
async function extract(archivePath, destDir) {
  if (/\.dmg$/i.test(archivePath)) {
    await extractDmg(archivePath, destDir);
    return true;
  }
  if (/\.zip$/i.test(archivePath)) {
    // -x extract, -k treat the source as a PKZip archive.
    //
    // NOTE: this bypasses the symlink-containment guard in src/tar.js entirely — ditto
    // is doing the extraction, so the archive's own paths and links are its problem, not
    // ours. That is deliberate (nothing else preserves a bundle's signature), but it does
    // mean a malicious .zip is contained by ditto's behaviour alone.
    const r = await exec.runStatus('ditto', ['-x', '-k', archivePath, destDir], { timeout: COPY_TIMEOUT });
    if (r.code !== 0) {
      if (r.timedOut) throw new Error('extracting the archive timed out');
      const why = stderrReason(r, 'ditto');
      throw new Error(
        why
          ? `extracting the archive failed: ${why}`
          : `extracting the archive failed (ditto exit ${r.code === null ? 'n/a' : r.code})`
      );
    }
    return true;
  }
  return false;
}

// --- signature verification ---------------------------------------------------
// A .app is sealed: its signature covers every file inside it, so ONE foreign file makes
// the bundle objectively invalid. Not a Gatekeeper policy nicety — codesign itself
// reports it. Measured on real hardware: a notarized app with one junk file injected
// gives "a sealed resource is missing or invalid" from both codesign and spctl.
//
// This is used as a DIFFERENTIAL check, never an absolute one. Plenty of GitHub projects
// ship an unsigned or ad-hoc .app, and codesign fails those too; refusing them outright
// would turn a bug fix into a silent policy that drops support for software the user can
// install by hand today. The caller verifies before and after, and only treats a
// valid-then-invalid transition as damage. See installPortable.
//
// Returns null when there is no bundle to check, so the caller can skip the whole dance.
async function verifyPayload(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const apps = names.filter((n) => /\.app$/i.test(n));
  if (!apps.length) return null;
  for (const app of apps) {
    // Measured on an 854MB / 3422-file bundle: plain --verify is ~155ms and already
    // reports "a sealed resource is missing or invalid" for an injected file, because
    // the seal covers the bundle's resource manifest. --deep costs 4x for no extra catch
    // here and is deprecated by Apple; --strict is cheap and rejects more classes.
    const r = await exec.runStatus('codesign', ['--verify', '--strict', path.join(dir, app)], {
      timeout: COPY_TIMEOUT,
    });
    if (r.code !== 0) {
      const reason = String(r.err || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      return { valid: false, app, reason: reason || `codesign exit ${r.code === null ? 'n/a' : r.code}` };
    }
  }
  return { valid: true };
}

module.exports = {
  installedApps,
  verifyPayload,
  runningProcesses,
  killProcess,
  extract,
  // exported for tests
  parseSystemProfiler,
  parseInfoPlistXml,
  parsePs,
  stderrReason,
  scanAppBundles,
  bundleVersion,
  extractDmg,
  mountFailure,
  PKG_IN_DMG,
  LICENCE_AGREEMENT,
  hasLicenceAgreement,
};
