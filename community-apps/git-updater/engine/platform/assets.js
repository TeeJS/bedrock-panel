'use strict';

// Per-platform release-asset tables. PURE DATA + PURE FUNCTIONS — no IO, no child
// processes — so core.js can keep its "no IO" guarantee and stay unit-testable.
//
// Each table drives core.scoreAsset():
//   label         human name used in error messages
//   reject        assets for OTHER platforms -> instant -Infinity
//   ext.portable  extensions that count as a portable/standalone build
//   ext.installer extensions that count as a system installer
//   osBonus()     reward for naming this platform explicitly
//   archTokens()  which architecture words the filename carries
//   archScore()   how well those match the running machine
//   typeScore()   portable-vs-installer disambiguation and format preference

// A "setup" word means a system installer, not a standalone build. Shared by all
// platforms — vendors use the same vocabulary regardless of target.
const SETUP_TOKEN = /(setup|install(er)?|_inst|-inst)/i;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const win = {
  id: 'win32',
  label: 'Windows',
  reject:
    /\.(deb|rpm|dmg|pkg|appimage|apk|snap|flatpak|tar\.gz|tgz|tar\.xz|tar\.bz2)$|(?:^|[-_.])(linux|darwin|mac(?:os)?|osx|x11|android|freebsd|source)(?:[-_.0-9]|$)/i,
  ext: {
    // Portable can be an archive OR a single portable .exe (e.g. app-portable.exe).
    portable: /\.(zip|7z|exe)$/i,
    installer: /\.(exe|msi)$/i,
  },
  osBonus: (name) => (/win(dows|64|32)?/i.test(name) ? 4 : 0),
  archTokens(name) {
    const isX64 = /(x64|amd64|x86[_-]?64|win64)/i.test(name);
    return {
      isX64,
      isArm: /(arm64|aarch64|arm)/i.test(name),
      isX86: /(x86|ia32|win32|32-?bit)/i.test(name) && !isX64,
      isUniversal: false,
    };
  },
  archScore({ isX64, isArm, isX86 }, arch) {
    if (arch === 'arm64') {
      if (isArm) return 3;
      if (isX64) return -1; // x64 runs on arm64 Windows via emulation, so mild penalty only
      if (isX86) return -1;
      return 0;
    }
    if (arch === 'ia32') {
      if (isX86) return 3;
      if (isX64 || isArm) return -6;
      return 0;
    }
    // x64 (default)
    if (isX64) return 3;
    if (isArm) return -6;
    if (isX86) return 1;
    return 0;
  },
  typeScore(name, type, flavor) {
    let s = 0;
    // Portable vs installer both can be .exe, so disambiguate by name tokens:
    // portable wants a "portable" build and must AVOID a setup/installer; vice versa.
    if (type === 'portable') {
      if (/portable/i.test(name)) s += 3;
      if (SETUP_TOKEN.test(name)) s -= 5; // a setup.exe is NOT the portable build
      // electron-builder's "*.nsis.7z" is the installer's own update payload (raw app files,
      // no proper packaging) — an arch match + archive bonus can otherwise outscore the
      // vendor's actual dedicated portable build when that build has no arch token in its name.
      if (/nsis/i.test(name)) s -= 5;
      if (/\.zip$/i.test(name)) s += 2; // archives extract cleanly; a bare .exe is placed as-is
      else if (/\.7z$/i.test(name)) s += 1;
      return s;
    }
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
    return s;
  },
};

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------
// "Portable" on macOS means a .app bundle, shipped either inside a .dmg or a .zip.
// "Installer" means a .pkg, which writes into /Library and needs authorization.

const mac = {
  id: 'darwin',
  label: 'macOS',
  reject:
    /\.(exe|msi|deb|rpm|appimage|apk|snap|flatpak)$|(?:^|[-_.])(win(?:dows|32|64)?|linux|x11|android|freebsd|source)(?:[-_.0-9]|$)/i,
  ext: {
    portable: /\.(dmg|zip)$/i,
    installer: /\.pkg$/i,
  },
  // A .dmg or .pkg is itself a macOS marker, exactly like the word "macos" in the
  // filename — without this, electron-builder's "<app>-mac.zip" auto-update payload
  // outscores the "<app>.dmg" a human is actually meant to download.
  osBonus: (name) => (/(mac(os)?|darwin|osx|apple|universal)|\.(dmg|pkg)$/i.test(name) ? 4 : 0),
  archTokens(name) {
    return {
      isX64: /(x64|amd64|x86[_-]?64|intel)/i.test(name),
      isArm: /(arm64|aarch64|apple[-_]?silicon|m1|m2|m3)/i.test(name),
      isX86: false, // 32-bit macOS has not existed since 10.15
      // A universal binary runs natively on both, so it is never a mismatch.
      isUniversal: /universal/i.test(name),
    };
  },
  archScore({ isX64, isArm, isUniversal }, arch) {
    // Universal runs natively everywhere, so it is never wrong — but it also carries
    // both slices, so a build for THIS architecture still wins when one exists.
    if (isUniversal) return 2;
    if (arch === 'arm64') {
      if (isArm) return 3;
      if (isX64) return -1; // Rosetta 2 runs it, so only a mild penalty
      return 0;
    }
    // x64 Macs cannot run arm64 code at all — hard reject by score.
    if (isX64) return 3;
    if (isArm) return -6;
    return 0;
  },
  typeScore(name, type) {
    let s = 0;
    if (type === 'portable') {
      // A .dmg is the canonical macOS delivery; a .zip is usually the auto-update payload.
      if (/\.dmg$/i.test(name)) s += 2;
      else if (/\.zip$/i.test(name)) s += 1;
      if (SETUP_TOKEN.test(name)) s -= 5;
      return s;
    }
    if (SETUP_TOKEN.test(name)) s += 2;
    return s;
  },
};

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------
// "Portable" means an AppImage or a tarball that unpacks into a folder — the lane
// that needs no root. "Installer" means a distro package, which does.

const linux = {
  id: 'linux',
  label: 'Linux',
  reject:
    /\.(exe|msi|dmg|pkg|apk)$|(?:^|[-_.])(win(?:dows|32|64)?|darwin|mac(?:os)?|osx|android|freebsd|source)(?:[-_.0-9]|$)/i,
  ext: {
    portable: /(\.appimage|\.tar\.gz|\.tgz|\.tar\.xz|\.tar\.bz2|\.zip)$/i,
    installer: /\.(deb|rpm)$/i,
  },
  // x11 is a Linux marker in the wild (Godot ships "..._x11.64.zip"), and the
  // .AppImage/.deb/.rpm extensions are markers in their own right.
  osBonus: (name) => (/(linux|gnu|x11)|\.(appimage|deb|rpm)$/i.test(name) ? 4 : 0),
  archTokens(name) {
    const isX64 = /(x86[_-]?64|amd64|x64)/i.test(name);
    return {
      isX64,
      isArm: /(arm64|aarch64|armv7|armhf)/i.test(name),
      isX86: /(i[3-6]86|ia32|32-?bit)/i.test(name) && !isX64,
      isUniversal: false,
    };
  },
  archScore({ isX64, isArm, isX86 }, arch) {
    if (arch === 'arm64') {
      if (isArm) return 3;
      // No transparent emulation on Linux — an x64 build simply will not run.
      if (isX64 || isX86) return -6;
      return 0;
    }
    if (arch === 'ia32') {
      if (isX86) return 3;
      if (isX64 || isArm) return -6;
      return 0;
    }
    if (isX64) return 3;
    if (isArm) return -6;
    if (isX86) return -6;
    return 0;
  },
  typeScore(name, type, flavor) {
    let s = 0;
    if (type === 'portable') {
      // A tarball is preferred over an AppImage, which is the reverse of what the format
      // promises. An AppImage is self-contained, but its runtime dlopen()s libfuse.so.2 and
      // Ubuntu has not shipped libfuse2 by default since 22.04 — so on a current Ubuntu or
      // Kubuntu it dies before the app is reached, with an error naming FUSE rather than
      // anything the user can act on. The runtime CAN extract-and-run instead, but only when
      // asked (APPIMAGE_EXTRACT_AND_RUN / --appimage-extract-and-run); it never falls back on
      // its own, and electron-builder exposes no option to ship a newer runtime that would.
      // Measured on Ubuntu 26.04: the AppImage fails at dlopen, the tarball extracts and runs.
      // An AppImage is still chosen when it is the ONLY portable asset — something that may
      // need libfuse2 beats nothing at all.
      if (/\.tar\.(gz|xz|bz2)$|\.tgz$/i.test(name)) s += 3;
      else if (/\.appimage$/i.test(name)) s += 2;
      else if (/\.zip$/i.test(name)) s += 1;
      if (SETUP_TOKEN.test(name)) s -= 5;
      return s;
    }
    // Never cross package formats: a .deb beside an .rpm install is a duplicate.
    if (flavor === 'deb') s += /\.deb$/i.test(name) ? 2 : -6;
    else if (flavor === 'rpm') s += /\.rpm$/i.test(name) ? 2 : -6;
    else if (/\.deb$/i.test(name)) s += 1; // fresh install: .deb is the more common ship
    return s;
  },
};

// A .zip sitting beside a .dmg of the SAME name is the macOS build.
//
// electron-builder emits exactly that pair — Foo-arm64.dmg and Foo-arm64.zip — and the
// zip carries no platform word at all. Neither the Windows nor the Linux reject regex
// catches it, because both look for a platform WORD and there is none. On x64 the correct
// build wins on architecture and hides it; on arm64 the bare arm64 token beats a portable
// .exe with no arch token and beats an x86_64 AppImage outright, so an arm64 Windows or
// Linux machine downloads a macOS .app bundle and installs it.
//
// The filename alone cannot settle this, and that is the whole difficulty: git-updater's
// own Windows asset is git-updater-0.2.0-arm64.zip, the identical shape. What separates
// them is the RELEASE, not the name — ours has no .dmg of that stem and bedrock-panel's
// does. So the rule is about the pair, which is why it lives here rather than in a reject
// regex that only ever sees one name.
//
// Measured against bedrock-panel v0.9.6, which is where this was found.
function macCompanionZips(names) {
  const stems = new Set(
    (names || []).filter((n) => /\.dmg$/i.test(n)).map((n) => n.replace(/\.dmg$/i, '').toLowerCase())
  );
  return new Set(
    (names || []).filter((n) => /\.zip$/i.test(n) && stems.has(n.replace(/\.zip$/i, '').toLowerCase()))
  );
}

const TABLES = { win32: win, darwin: mac, linux };

// The table for a platform key ('win32' | 'darwin' | 'linux'), defaulting to the
// running one. Anything unknown (freebsd, aix) falls back to the Linux conventions,
// which is what those platforms' release assets actually look like.
function assetTable(platform) {
  const key = platform || (typeof process !== 'undefined' && process.platform) || 'win32';
  return TABLES[key] || linux;
}

module.exports = { assetTable, macCompanionZips, TABLES, SETUP_TOKEN };
