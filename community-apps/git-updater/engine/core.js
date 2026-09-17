'use strict';

// Pure logic, no IO. Every unit test lives against this file.

// ---------------------------------------------------------------------------
// Version compare — ported from open-quake app/appRepo.js cmpVersion(), plus
// leading-"v" strip and prerelease handling.
// ---------------------------------------------------------------------------

// Strip the leading "v" AND any word prefix before the first digit ("Audacity-3.7.8",
// "release/v2.6.2" -> "3.7.8", "2.6.2") — otherwise such tags parse as version 0 and
// updates are never detected. Tags with no digits at all are left untouched.
function normTag(t) {
  const s = String(t == null ? '' : t).trim();
  return /\d/.test(s) ? s.replace(/^[^0-9]*(?=[0-9])/, '') : s;
}

// { nums:[1,2,0], pre:'rc1' } from "v1.2.0-rc1". Build metadata ("+abc") is
// dropped: per semver it does not affect precedence.
const nums = (s) => s.split('.').map((x) => parseInt(x, 10) || 0);

function splitVer(t) {
  let s = normTag(t);
  const plus = s.indexOf('+');
  if (plus >= 0) s = s.slice(0, plus);
  // A trailing "(build)" is Apple's own display convention — CFBundleShortVersionString
  // followed by CFBundleVersion, e.g. Zoom reports "7.1.5 (84650)". It is metadata, not
  // precedence, exactly like the "+build" above, and it is stripped for the same reason.
  // Doing it BEFORE the match rather than in the fallback below keeps any prerelease:
  // "1.2.3-rc1 (build 5)" still parses as 1.2.3-rc1.
  s = s.replace(/\s*\([^)]*\)\s*$/, '');
  const m = s.match(/^(\d+(?:\.\d+)*)(?:-(.*))?$/);
  if (m) return { nums: nums(m[1]), pre: m[2] || '' };
  // Anything still unparseable. Returning zero here — which is what this used to do —
  // reads as "older than every release", so the row says an update is available, the
  // user installs it, the version string does not change, and the row never clears.
  // That is the permanent update-available state 67c8c9e fixed once already, reachable
  // through any unrecognised shape. The leading numeric run is a far better guess:
  // "1.2.3 build 9" is version 1.2.3, not version 0.
  const lead = s.match(/^(\d+(?:\.\d+)*)/);
  return lead ? { nums: nums(lead[1]), pre: '' } : { nums: [0], pre: '' };
}

function cmpNums(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// Natural compare so "rc10" > "rc2" (digit runs compared numerically, not lexically).
function naturalCmp(a, b) {
  const ax = a.match(/\d+|\D+/g) || [];
  const bx = b.match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const as = ax[i];
    const bs = bx[i];
    if (as === undefined) return -1;
    if (bs === undefined) return 1;
    if (/^\d+$/.test(as) && /^\d+$/.test(bs)) {
      const d = parseInt(as, 10) - parseInt(bs, 10);
      if (d) return d < 0 ? -1 : 1;
    } else if (as !== bs) {
      return as < bs ? -1 : 1;
    }
  }
  return 0;
}

// Some apps pad the registry DisplayVersion with extra parts that the release tag lacks —
// a PREFIX (Brave: "152.1.94.117" = Chromium 152 + Brave 1.94.117, tag "1.94.117") or a
// SUFFIX (Tesseract: "5.5.3.20260724" = 5.5.3 + build date, tag "5.5.3"). When the
// installed version has MORE numeric parts than the tag scheme, return the leading or
// trailing parts in the tag's scheme — whichever matches the tag best (exact match, then
// longest shared prefix; tie -> trailing); else null.
function alignInstalledVersion(installed, latest) {
  const i = splitVer(installed);
  const l = splitVer(latest);
  if (l.nums.length < 2 || i.nums.length <= l.nums.length) return null;
  const leading = i.nums.slice(0, l.nums.length);
  const trailing = i.nums.slice(-l.nums.length);
  const shared = (nums) => {
    let n = 0;
    while (n < nums.length && nums[n] === l.nums[n]) n++;
    return n;
  };
  return (shared(leading) > shared(trailing) ? leading : trailing).join('.');
}

// >0 if a is newer than b. Handles "1.2" == "1.2.0" and prerelease < release.
function cmpVersion(a, b) {
  const va = splitVer(a);
  const vb = splitVer(b);
  const c = cmpNums(va.nums, vb.nums);
  if (c !== 0) return c;
  if (va.pre && !vb.pre) return -1; // a is a prerelease of b's version -> older
  if (!va.pre && vb.pre) return 1;
  if (va.pre === vb.pre) return 0;
  return naturalCmp(va.pre, vb.pre);
}

// ---------------------------------------------------------------------------
// Asset matching — glob ("*-win-x64.zip") or "/regex/".
// ---------------------------------------------------------------------------

function compilePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern) throw new Error('asset pattern is required');
  if (pattern.length > 1 && pattern[0] === '/' && pattern[pattern.length - 1] === '/') {
    const re = new RegExp(pattern.slice(1, -1));
    return (name) => re.test(name);
  }
  const body = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  const re = new RegExp('^' + body + '$', 'i');
  return (name) => re.test(name);
}

function matchAsset(assets, pattern) {
  const list = assets || [];
  const test = compilePattern(pattern);
  const hits = list.filter((a) => test(a.name));
  if (hits.length === 0) {
    const names = list.map((a) => a.name).join(', ') || '(none)';
    throw new Error(`no asset matched "${pattern}". Available: ${names}`);
  }
  if (hits.length > 1) {
    throw new Error(
      `pattern "${pattern}" matched ${hits.length} assets (${hits.map((h) => h.name).join(', ')}); tighten it`
    );
  }
  return hits[0];
}

// ---------------------------------------------------------------------------
// Auto-pick the right asset for THIS platform from a release, given only
// "portable" or "installer". This is the app doing the work so the user never
// picks files. The per-platform extension sets, reject regexes, architecture
// tokens and scoring bonuses all live in src/platform/assets.js — that module is
// pure data, so this file keeps its "no IO" guarantee.
// ---------------------------------------------------------------------------

const { assetTable, macCompanionZips } = require('./platform/assets');

// arch: machine architecture ('x64' | 'arm64' | 'ia32'). flavor: how the app is
// ALREADY installed (Windows 'msi' | 'exe', Linux 'deb' | 'rpm', or null) — strongly
// prefer the same flavor so an update upgrades in place instead of installing a
// duplicate side-by-side. table: from assetTable(), defaults to the running platform.
function scoreAsset(name, type, arch, flavor, table) {
  const t = table || assetTable();
  if (t.reject.test(name)) return -Infinity;
  if (!(type === 'installer' ? t.ext.installer : t.ext.portable).test(name)) return -Infinity;
  // Reward naming this platform, then how well the architecture matches the running
  // machine, then the format/flavor preferences that separate portable from installer.
  return t.osBonus(name) + t.archScore(t.archTokens(name), arch) + t.typeScore(name, type, flavor);
}

// Returns the best-matching asset object, or throws if the release has none for the
// platform. arch defaults to the running machine's architecture, platform to the
// running OS ('win32' | 'darwin' | 'linux').
function pickAsset(assets, type, arch, flavor, platform) {
  const table = assetTable(platform);
  // Off macOS, drop a .zip that is the companion of a .dmg — it is the macOS bundle, and
  // nothing in its NAME says so. See macCompanionZips for why this cannot be a reject
  // pattern. Windows and Linux only: on macOS that zip is a legitimate candidate.
  const all = assets || [];
  const drop = table.id === 'darwin' ? new Set() : macCompanionZips(all.map((a) => a.name));
  const list = drop.size ? all.filter((a) => !drop.has(a.name)) : all;
  const a4 = arch || (typeof process !== 'undefined' && process.arch) || 'x64';
  let best = null;
  let bestScore = -Infinity;
  for (const a of list) {
    const sc = scoreAsset(a.name, type, a4, flavor, table);
    if (sc === -Infinity) continue;
    if (sc > bestScore || (sc === bestScore && best && a.name.length < best.name.length)) {
      best = a;
      bestScore = sc;
    }
  }
  if (!best) {
    // If the OTHER package type would match, the app just isn't shipped this way —
    // point the user at the fix instead of a dead end.
    const other = type === 'installer' ? 'portable' : 'installer';
    const otherHit = list.some((a) => scoreAsset(a.name, other, a4, null, table) !== -Infinity);
    if (otherHit) {
      throw new Error(
        type === 'installer'
          ? 'this app only ships portable builds — Edit the app and change its type to Portable'
          : 'this app only ships an installer — Edit the app and change its type to Installer'
      );
    }
    throw new Error(
      `no ${table.label} ${type} asset in release. Assets: ${list.map((a) => a.name).join(', ') || '(none)'}`
    );
  }
  return best;
}

// Always picks a WINDOWS asset regardless of the running OS. Kept so the Windows
// behaviour (and its test suite) stays pinned and platform-independent.
function pickWindowsAsset(assets, type, arch, flavor) {
  return pickAsset(assets, type, arch, flavor, 'win32');
}

// Fallback silent-install kind when the file's bytes can't identify it.
// Windows: .msi -> msi, else nsis. macOS: .pkg. Linux: by extension.
function guessKind(assetName) {
  if (/\.msi$/i.test(assetName)) return 'msi';
  if (/\.pkg$/i.test(assetName)) return 'pkg';
  if (/\.deb$/i.test(assetName)) return 'deb';
  if (/\.rpm$/i.test(assetName)) return 'rpm';
  return 'nsis';
}

// ---------------------------------------------------------------------------
// Installer silent-switch table. Only the kinds we actually use; extend freely.
// ---------------------------------------------------------------------------

// Each kind says what to spawn: `cmd(file)` -> [exe, args] for a silent install, and
// `override(file, args)` -> args when the user pins their own switches in config.json.
// Kinds that run the downloaded file itself take the override as the WHOLE switch list;
// kinds that hand the file to a system tool must keep the file argument in place.
const INSTALLER_SWITCHES = {
  // Windows
  msi: {
    cmd: (file) => ['msiexec', ['/i', file, '/qn', '/norestart']],
    override: (file, args) => ['/i', file, ...args],
  },
  nsis: { cmd: (file) => [file, ['/S']], override: (file, args) => args },
  inno: {
    cmd: (file) => [file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']],
    override: (file, args) => args,
  },
  // macOS — installer(8) writes into /Library and needs root, so this only succeeds
  // when git-updater itself is running elevated; otherwise the caller falls back to
  // opening the .pkg in Installer.app, which prompts for authorization normally.
  pkg: {
    cmd: (file) => ['installer', ['-pkg', file, '-target', '/']],
    override: (file, args) => ['-pkg', file, ...args],
  },
  // Linux — both need root for the same reason.
  deb: {
    cmd: (file) => ['dpkg', ['-i', file]],
    override: (file, args) => [...args, file],
  },
  rpm: {
    cmd: (file) => ['rpm', ['-U', '--quiet', file]],
    override: (file, args) => [...args, file],
  },
};

// Returns { exe, args } to spawn. Per-repo install.args overrides the switches.
function installerCmd(kind, file, argsOverride) {
  const spec = INSTALLER_SWITCHES[kind];
  if (!spec) {
    throw new Error(`unknown installer kind "${kind}" (known: ${Object.keys(INSTALLER_SWITCHES).join(', ')})`);
  }
  const [exe, defaultArgs] = spec.cmd(file);
  if (Array.isArray(argsOverride) && argsOverride.length) {
    return { exe, args: spec.override(file, argsOverride) };
  }
  return { exe, args: defaultArgs };
}

// ---------------------------------------------------------------------------
// Config validation.
// ---------------------------------------------------------------------------

// "C:/PortableApps"  + "ShareX" -> "C:/PortableApps/ShareX"
// "/home/tj/Apps"     + "ShareX" -> "/home/tj/Apps/ShareX"
// A forward slash rather than path.join, so the separator matches whatever the user
// typed in Settings; Windows APIs and POSIX both accept it.
function resolvePortableDir(portableRoot, repoName) {
  return `${String(portableRoot).replace(/[\\/]+$/, '')}/${repoName}`;
}

// Validates, and fills each portable entry's install.dir from a top-level
// portableRoot when omitted. Mutates json in place so callers get resolved dirs.
function validateConfig(json) {
  if (!json || !Array.isArray(json.repos)) throw new Error('config: "repos" array is required');
  json.repos.forEach((r, i) => {
    const at = `repos[${i}]`;
    if (!r.owner || !r.repo) throw new Error(`${at}: "owner" and "repo" are required`);
    if (r.type !== 'portable' && r.type !== 'installer') {
      throw new Error(`${at}: "type" must be "portable" or "installer"`);
    }
    // tagPrefix pins release lookup to one train in a multi-product repo (e.g. "desktop-v"
    // for bitwarden/clients, which also publishes web-v*/browser-v*/cli-v* under one repo).
    if (r.tagPrefix != null && (typeof r.tagPrefix !== 'string' || !r.tagPrefix)) {
      throw new Error(`${at}: "tagPrefix" must be a non-empty string`);
    }
    // asset is optional: omitted -> engine auto-picks this platform's asset from `type`.
    if (r.type === 'portable') {
      if (!r.install) r.install = {};
      if (!r.install.dir) {
        if (!json.portableRoot) throw new Error(`${at}: portable requires install.dir or a top-level portableRoot`);
        r.install.dir = resolvePortableDir(json.portableRoot, r.repo);
      }
    } else {
      // installer: kind is optional (auto-guessed from the picked file); if set, it must be valid.
      if (r.install && r.install.kind && !INSTALLER_SWITCHES[r.install.kind]) {
        throw new Error(`${at}: install.kind must be one of ${Object.keys(INSTALLER_SWITCHES).join(', ')}`);
      }
    }
  });
  return json;
}

// ---------------------------------------------------------------------------
// Run summary.
// ---------------------------------------------------------------------------

// results: [{ repo, status:'updated'|'current'|'failed', from?, to?, reason?, note? }]
function buildSummary(results) {
  const counts = { updated: 0, current: 0, failed: 0 };
  const lines = [];
  for (const r of results) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.status === 'updated') {
      lines.push(`  ✓ ${r.repo}  ${r.from || '—'} → ${r.to}${r.note ? '  (' + r.note + ')' : ''}`);
    } else if (r.status === 'current') {
      lines.push(`  · ${r.repo}  ${r.to} (already current)`);
    } else {
      lines.push(`  ✗ ${r.repo}  ${r.reason}`);
    }
  }
  const header = `updated ${counts.updated}, current ${counts.current}, failed ${counts.failed}`;
  return { text: [header, ...lines].join('\n'), counts };
}

module.exports = {
  normTag,
  cmpVersion,
  alignInstalledVersion,
  compilePattern,
  matchAsset,
  pickAsset,
  pickWindowsAsset,
  guessKind,
  installerCmd,
  validateConfig,
  resolvePortableDir,
  buildSummary,
  INSTALLER_SWITCHES,
};
