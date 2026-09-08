'use strict';

// Pure logic, no IO. Every unit test lives against this file.

// ---------------------------------------------------------------------------
// Version compare — ported from Bedrock Panel app/appRepo.js cmpVersion(), plus
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
function splitVer(t) {
  let s = normTag(t);
  const plus = s.indexOf('+');
  if (plus >= 0) s = s.slice(0, plus);
  const m = s.match(/^(\d+(?:\.\d+)*)(?:-(.*))?$/);
  if (!m) return { nums: [0], pre: '' };
  return { nums: m[1].split('.').map((x) => parseInt(x, 10) || 0), pre: m[2] || '' };
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

// Some apps prefix the registry DisplayVersion with another product's version —
// Brave: "152.1.94.117" = Chromium 152 + Brave 1.94.117, while release tags are plain
// "1.94.117". When the installed version has MORE numeric parts than the tag scheme,
// return its trailing parts in the tag's scheme; else null.
function alignInstalledVersion(installed, latest) {
  const i = splitVer(installed);
  const l = splitVer(latest);
  if (l.nums.length >= 2 && i.nums.length > l.nums.length) {
    return i.nums.slice(-l.nums.length).join('.');
  }
  return null;
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
// Auto-pick the right Windows asset from a release, given only "portable" or
// "installer". This is the app doing the work so the user never picks files.
// ---------------------------------------------------------------------------

const NON_WINDOWS =
  /\.(deb|rpm|dmg|pkg|appimage|apk|snap|flatpak|tar\.gz|tgz|tar\.xz|tar\.bz2)$|(?:^|[-_.])(linux|darwin|mac(?:os)?|osx|x11|android|freebsd|source)(?:[-_.0-9]|$)/i;
// Portable can be an archive OR a single portable .exe (e.g. app-portable.exe).
const PORTABLE_EXT = /\.(zip|7z|exe)$/i;
const INSTALLER_EXT = /\.(exe|msi)$/i;
const SETUP_TOKEN = /(setup|install(er)?|_inst|-inst)/i;

// arch: machine architecture ('x64' | 'arm64' | 'ia32'). flavor: how the app is
// ALREADY installed ('msi' | 'exe' | null) — strongly prefer the same flavor so an
// update upgrades in place instead of installing a duplicate side-by-side.
function scoreAsset(name, type, arch, flavor) {
  if (NON_WINDOWS.test(name)) return -Infinity;
  if (!(type === 'installer' ? INSTALLER_EXT : PORTABLE_EXT).test(name)) return -Infinity;
  let s = 0;
  if (/win(dows|64|32)?/i.test(name)) s += 4;
  const isX64 = /(x64|amd64|x86[_-]?64|win64)/i.test(name);
  const isArm = /(arm64|aarch64|arm)/i.test(name);
  const isX86 = /(x86|ia32|win32|32-?bit)/i.test(name) && !isX64;
  // Prefer the file matching the running machine's architecture; penalize mismatches.
  if (arch === 'arm64') {
    if (isArm) s += 3;
    else if (isX64) s -= 1; // x64 runs on arm64 Windows via emulation, so mild penalty only
    else if (isX86) s -= 1;
  } else if (arch === 'ia32') {
    if (isX86) s += 3;
    else if (isX64) s -= 6;
    else if (isArm) s -= 6;
  } else {
    // x64 (default)
    if (isX64) s += 3;
    else if (isArm) s -= 6;
    else if (isX86) s += 1;
  }
  // Portable vs installer both can be .exe, so disambiguate by name tokens:
  // portable wants a "portable" build and must AVOID a setup/installer; vice versa.
  if (type === 'portable') {
    if (/portable/i.test(name)) s += 3;
    if (SETUP_TOKEN.test(name)) s -= 5; // a setup.exe is NOT the portable build
    if (/\.zip$/i.test(name)) s += 2; // archives extract cleanly; a bare .exe is placed as-is
    else if (/\.7z$/i.test(name)) s += 1;
  } else {
    if (SETUP_TOKEN.test(name)) s += 2;
    if (/portable/i.test(name)) s -= 5; // a portable.exe is NOT the installer
    if (flavor === 'exe') {
      // Already EXE-installed: an MSI would install side-by-side, not upgrade. Avoid it.
      if (/\.msi$/i.test(name)) s -= 6;
      else if (/\.exe$/i.test(name)) s += 2;
    } else {
      // MSI-installed or fresh install: prefer .msi (silent via msiexec, upgrades in place).
      if (/\.msi$/i.test(name)) s += 2;
      else if (/\.exe$/i.test(name)) s += 1;
    }
  }
  return s;
}

// Returns the best-matching asset object, or throws if the release has none for Windows.
// arch defaults to the running machine's architecture.
function pickWindowsAsset(assets, type, arch, flavor) {
  const list = assets || [];
  const a4 = arch || (typeof process !== 'undefined' && process.arch) || 'x64';
  let best = null;
  let bestScore = -Infinity;
  for (const a of list) {
    const sc = scoreAsset(a.name, type, a4, flavor);
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
    const otherHit = list.some((a) => scoreAsset(a.name, other, a4, null) !== -Infinity);
    if (otherHit) {
      throw new Error(
        type === 'installer'
          ? 'this app only ships portable builds — Edit the app and change its type to Portable'
          : 'this app only ships an installer — Edit the app and change its type to Installer'
      );
    }
    throw new Error(`no Windows ${type} asset in release. Assets: ${list.map((a) => a.name).join(', ') || '(none)'}`);
  }
  return best;
}

// exe -> nsis (/S), msi -> msi. Overridable via install.kind in config.json.
function guessKind(assetName) {
  return /\.msi$/i.test(assetName) ? 'msi' : 'nsis';
}

// ---------------------------------------------------------------------------
// Installer silent-switch table. Only the kinds we actually use; extend freely.
// ---------------------------------------------------------------------------

const INSTALLER_SWITCHES = {
  msi: (file) => ['msiexec', ['/i', file, '/qn', '/norestart']],
  nsis: (file) => [file, ['/S']],
  inno: (file) => [file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']],
};

// Returns { exe, args } to spawn. Per-repo install.args overrides the switches.
function installerCmd(kind, file, argsOverride) {
  const fn = INSTALLER_SWITCHES[kind];
  if (!fn) {
    throw new Error(`unknown installer kind "${kind}" (known: ${Object.keys(INSTALLER_SWITCHES).join(', ')})`);
  }
  const [exe, defaultArgs] = fn(file);
  if (Array.isArray(argsOverride) && argsOverride.length) {
    // msi keeps "/i <file>"; other kinds run the file directly, override is the full switch list.
    const args = kind === 'msi' ? ['/i', file, ...argsOverride] : argsOverride;
    return { exe, args };
  }
  return { exe, args: defaultArgs };
}

// ---------------------------------------------------------------------------
// Config validation.
// ---------------------------------------------------------------------------

// "C:/PortableApps" + "ShareX" -> "C:/PortableApps/ShareX"
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
    // asset is optional: omitted -> engine auto-picks the Windows asset from `type`.
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
  pickWindowsAsset,
  guessKind,
  installerCmd,
  validateConfig,
  resolvePortableDir,
  buildSummary,
  INSTALLER_SWITCHES,
};
