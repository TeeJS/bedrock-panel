'use strict';

// Orchestrate the pipeline over the repo list. Calls the IO modules directly.
// Elevation routing lives in bin/watch.js; here we assume we have the rights to apply.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./core');
const paths = require('./paths');
const github = require('./github');
const install = require('./install');
const state = require('./state');
const detect = require('./detect');
const { log } = require('./log');

// Display id ("owner/repo") vs storage/identity key (adds the type, so the same repo
// tracked as both portable AND installed keeps separate state instead of colliding).
const isWin = process.platform === 'win32';

const displayId = (repo) => `${repo.owner}/${repo.repo}`;
const appKey = (repo) => `${repo.owner}/${repo.repo}#${repo.type}`;

// "Scan this PC" adds every discovered app as an installer. On Linux that is wrong for
// most repos: of the catalog entries with Linux identifiers, 20 of 40 publish only a
// portable archive and 3 publish no binary at all, so an installer entry fails on every
// check. The first check already holds the release payload, so the correction costs
// nothing here — deciding it when the user ticks the app would cost one API call each,
// against an anonymous budget of 60 an hour that this app already exhausts in practice.
//
// The correction is REPORTED, never silent. It changes an entry the user did not type by
// hand, and for a package-managed app the portable copy installs ALONGSIDE the existing
// one rather than replacing it, which the user has to be told so they can untrack it if
// that is not what they wanted.
//
// Mutates `repo` in place and returns the disclosure, or null when nothing changed.
// `platform` defaults to the running OS; it is explicit so the whole decision table is
// testable from any host rather than only the one the suite happens to run on.
function retypeIfNoInstaller(repo, rel, portableRoot, platform) {
  if (repo.type !== 'installer' || repo.asset) return null;
  try {
    core.pickAsset(rel.assets, 'installer', null, null, platform);
    return null; // it does publish a package — leave the entry alone
  } catch (e) {
    // Only this specific case. "no <platform> installer asset" means the release has
    // nothing usable at all, which stays an error the user should see.
    if (!/only ships portable builds/.test(e.message)) return null;
  }
  const dir = (repo.install && repo.install.dir) || (portableRoot && core.resolvePortableDir(portableRoot, repo.repo));
  if (!dir) return null; // no portable folder set — the existing clear error stands
  const from = repo.type;
  repo.type = 'portable';
  repo.install = { ...(repo.install || {}), dir };
  return {
    from,
    to: 'portable',
    dir,
    note: 'switched to Portable — this app publishes no installer, so the portable copy installs alongside any existing one',
  };
}

async function run(config, opts = {}) {
  detect.clearCache(); // fresh registry scan each run — an install may have just changed versions
  const st = state.load(opts.statePath);
  const only = opts.only ? opts.only.toLowerCase() : null;
  const results = [];
  for (const repo of config.repos) {
    const id = displayId(repo);
    if (only && id.toLowerCase() !== only && appKey(repo).toLowerCase() !== only) continue;
    try {
      results.push(await handleRepo(repo, id, st, { ...opts, portableRoot: config.portableRoot }));
    } catch (e) {
      results.push({ repo: id, id: appKey(repo), status: 'failed', reason: e.message });
      log(`FAIL ${appKey(repo)}: ${e.message}`);
      if (e.rateLimited) break; // no point hammering a rate-limited API
    }
  }
  return { results, summary: core.buildSummary(results) };
}

function dirHasFiles(dir) {
  try {
    return !!dir && fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

async function handleRepo(repo, id, st, opts) {
  const key = appKey(repo);
  const emit = (phase, pct) => opts.onProgress && opts.onProgress(key, phase, pct);
  emit('checking');
  const rel = await github.getLatestRelease(repo.owner, repo.repo, { prerelease: repo.prerelease, tagPrefix: repo.tagPrefix });
  // Correct the type before anything reads it. Check-time only: an update run installs,
  // and changing what gets installed mid-run is worse than the clear error it replaces.
  // It has to happen ahead of the comparison below, or an entry whose installed version
  // already matches the latest tag returns "current" and is never corrected at all.
  const retyped = opts.mode === 'check' ? retypeIfNoInstaller(repo, rel, opts.portableRoot) : null;

  const latest = rel.tag_name;
  const prev = st[key] || {};

  // Compare against the ACTUAL installed version, not just our update history:
  // installer -> uninstall-registry DisplayVersion; portable -> our install manifest.
  let installed = null;
  if (repo.type === 'installer') {
    try {
      installed = await detect.installedVersion(repo.detect || repo.repo);
    } catch {}
    // Scheme mismatch (e.g. Brave: registry 152.1.94.117 vs tag 1.94.117): the install
    // looks "newer" than any release, so updates would never be detected. Align the
    // installed version to the tag's scheme; Current then displays comparably too.
    if (installed && core.cmpVersion(latest, installed) < 0) {
      const aligned = core.alignInstalledVersion(installed, latest);
      if (aligned) installed = aligned;
    }
  } else {
    installed = prev.version || null;
  }
  const baseline = installed || prev.tag || '';
  const tracked = installed || prev.tag; // do we believe it's installed at all?

  const cmp = core.cmpVersion(latest, baseline);
  let isNew = cmp > 0 || !tracked; // newer than installed, or not installed yet
  // Only NON-numeric tags (e.g. "release-2026-08", which collapse to version 0) fall back
  // to tag identity — otherwise 1.26.0 vs 1.26.0.0 would look like an update.
  if (!isNew && !/^\d/.test(core.normTag(latest)) && prev.tag && core.normTag(latest) !== core.normTag(prev.tag)) {
    isNew = true;
  }
  // Portable recorded as installed but its folder is gone/empty -> reinstall.
  if (!isNew && !opts.force && tracked && repo.type === 'portable' && repo.install && !dirHasFiles(repo.install.dir)) {
    isNew = true;
  }

  const fromV = installed ? core.normTag(installed) : prev.tag && core.normTag(prev.tag);
  if (!isNew && !opts.force) {
    return { repo: id, id: key, status: 'current', from: fromV, to: core.normTag(latest), ...(retyped ? { retyped, note: retyped.note } : {}) };
  }

  const base = { repo: id, id: key, from: fromV, to: core.normTag(latest) };

  if (opts.mode === 'check') return { ...base, status: 'updated', ...(retyped ? { retyped, note: retyped.note } : {}) };

  // Manual `asset` pattern overrides; otherwise auto-pick this platform's asset from
  // the type. For installers, match the flavor of the EXISTING install (msi vs exe on
  // Windows, deb vs rpm on Linux) so the update upgrades in place instead of installing
  // a duplicate side-by-side.
  const flavor = repo.type === 'installer' ? await detect.installedFlavor(repo.detect || repo.repo) : null;
  const asset = repo.asset
    ? core.matchAsset(rel.assets, repo.asset)
    : core.pickAsset(rel.assets, repo.type, null, flavor);

  if (opts.dryRun) {
    const verb = /\.(zip|7z|tar\.gz|tgz|tar\.xz|tar\.bz2|tar|dmg)$/i.test(asset.name) ? 'extract' : 'place';
    const plan =
      repo.type === 'installer'
        ? `install ${asset.name} silently`
        : `${verb} ${asset.name} -> ${repo.install.dir}`;
    return { ...base, status: 'updated', note: plan };
  }

  // Proactive check: a running app blocks both installers (in-use files) and portable
  // swaps (locked files). Tell the user up front instead of failing mid-download.
  if (await detect.isRunning(repo.process || repo.repo)) {
    log(`SKIP ${key}: ${repo.repo} is running`);
    return { ...base, status: 'failed', reason: `${repo.repo} is running — close it, then Retry` };
  }

  log(`update ${key}: installed=${installed || '(none)'} -> latest=${core.normTag(latest)}, asset=${asset.name}`);

  // Stage under git-updater's own data dir, NOT the system temp dir — EDR/ASR rules on
  // Windows flag executables run from %TEMP%, and macOS Gatekeeper treats a quarantined
  // bundle there differently. src/paths.js picks the right location per platform.
  const stageBase = path.join(paths.dataDir(), 'staging');
  fs.mkdirSync(stageBase, { recursive: true });
  // Best-effort cleanup of leftovers older than a day (kept interactive installers, crashed runs).
  try {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(stageBase)) {
      const p = path.join(stageBase, name);
      try {
        if (fs.statSync(p).mtimeMs < dayAgo) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
  const tmp = fs.mkdtempSync(path.join(stageBase, 'dl-'));
  try {
    const file = path.join(tmp, asset.name);
    emit('downloading', 0);
    await github.downloadAsset(asset.browser_download_url, file, (pct) => emit('downloading', pct));
    emit('verifying');
    // Prefer GitHub's own digest; fall back to a checksums file shipped in the release
    // (SHA256SUMS, <asset>.sha256, ...). Only truly digest-less releases skip.
    let digest = asset.digest;
    let digestNote = null;
    if (!digest) {
      const found = await github.fetchChecksumFromRelease(rel, asset.name);
      if (found) {
        digest = `${found.algo}:${found.expected}`;
        digestNote = 'verified via release checksums file';
      }
    }
    const v = github.verifyDigest(file, digest);
    if (v && v.verified && digestNote) v.note = digestNote;
    if (v && v.skipped) log(`  WARN ${key}: ${v.note}`);

    emit('installing');
    let files; // portable manifest, for stale-file pruning
    if (repo.type === 'installer') {
      // Detect the installer's silent-install technology from its bytes. If it can't be
      // identified, FAIL rather than blindly running an unknown .exe with NSIS's /S switch.
      // Open the downloaded package in its OWN installer window, where the user gets the
      // platform's normal authorization prompt. git-updater never self-elevates.
      //   Windows MSI: msiexec with UI (msiexec.exe itself needs no manifest elevation).
      //   Windows EXE: opts.openFile (ShellExecute via Electron) so the setup's UAC manifest works.
      //   macOS .pkg:  opts.openFile hands it to Installer.app, which prompts for admin.
      //   Linux .deb/.rpm: opts.openFile hands it to the desktop's package installer.
      const interactive = (keepName) => {
        const keep = path.join(stageBase, keepName); // outlives the tmp cleanup below
        fs.copyFileSync(file, keep);
        log(`  -> opening interactive installer: ${keep}`);
        if (isWin && /\.msi$/i.test(keep)) spawn('msiexec', ['/i', keep], { detached: true, stdio: 'ignore' }).unref();
        else if (opts.openFile) opts.openFile(keep);
        else return false;
        return true;
      };
      const interactiveResult = {
        ...base,
        status: 'failed',
        reason: isWin
          ? 'installer window opened — approve the UAC prompt and finish it, then Check'
          : 'installer window opened — authorize and finish it, then Check',
      };

      const kind = (repo.install && repo.install.kind) || install.detectInstallerKind(file);
      if (!kind) {
        // Unidentifiable installer: never guess silent switches — run its window instead.
        if (interactive(asset.name)) return interactiveResult;
        throw new Error(
          `could not identify the installer type for ${asset.name} — add "install":{"kind":"nsis|inno|msi"} for ${id} in config.json`
        );
      }
      try {
        install.installInstaller(file, { ...repo.install, kind });
      } catch (e) {
        // Silent installs can't show a UAC prompt, so unelevated they fail — MSI with
        // exit 1603, EXE installers with an elevation spawn error. Fall back to the
        // installer's own window in both cases. (No PowerShell, no self-elevation.)
        if ((e.status === 1603 || e.elevation) && interactive(asset.name)) return interactiveResult;
        throw e;
      }
    } else {
      // Re-check immediately before the swap, not just before the download. The download
      // takes seconds to minutes, and the user may well have launched the app during it.
      //
      // This is the ONLY protection on macOS and Linux. On Windows the swap itself fails
      // with EBUSY or EPERM when files are open, and install.js turns that into "close
      // the app and Retry" — but a POSIX rename of a running application's directory
      // SUCCEEDS. Measured on macOS with a real signed Electron app: it survived the
      // swap for at least 30 seconds — including having its old directory DELETED
      // underneath it — across four processes, with no crash and no crash report. A
      // fresh read at the live path returns the new version while the process keeps
      // executing code loaded before the swap.
      //
      // So this is not "it crashes". It is old code, new files, one path, and nobody
      // has managed to provoke a failure from that mismatch. Unprovoked is not safe:
      // whatever the app loads next comes from a version it did not start with.
      if (await detect.isRunning(repo.process || repo.repo)) {
        log(`SKIP ${key}: ${repo.repo} started during the download`);
        return { ...base, status: 'failed', reason: `${repo.repo} is running — close it, then Retry` };
      }
      // Transactional dir swap: stale files vanish with the old dir, user files carry over.
      files = await install.installPortable(file, repo.install, prev.files);
    }

    st[key] = {
      repo: id,
      type: repo.type,
      tag: latest,
      version: core.normTag(latest),
      assetName: asset.name,
      installedAt: new Date().toISOString(),
      ...(files ? { files } : {}),
    };
    state.save(st, opts.statePath);
    log(`OK ${key}: installed ${core.normTag(latest)}`);
    return { ...base, status: 'updated', note: v && v.note };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { run, retypeIfNoInstaller };
