'use strict';

// Minimal tar reader. Node has no built-in one, and the alternative — handing the
// archive to 7-Zip — loses the thing that matters most off Windows: the Unix mode
// bits. A Linux or macOS build that extracts without its executable bit does not
// fail during the update, it fails silently the first time the user tries to launch
// it, so the modes are the whole point of doing this here.
//
// Supports the subset real release tarballs use: regular files, directories,
// symlinks, GNU long names, and pax extended headers. Gzip is handled by Node's own
// zlib; xz and bzip2 are decompressed to a plain .tar by the caller first.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK = 512;

const str = (buf, off, len) => {
  const end = buf.indexOf(0, off);
  const stop = end >= 0 && end < off + len ? end : off + len;
  return buf.toString('utf8', off, stop);
};

const octal = (buf, off, len) => {
  const s = str(buf, off, len).replace(/[^0-7]/g, '');
  return s ? parseInt(s, 8) : 0;
};

// Lexical containment is NOT sufficient on its own. If a path component at the
// destination already exists as a SYMLINK pointing outside destDir, an entirely
// innocent-looking entry name ("cfg/keep.txt" — no "..", no absolute path) writes
// straight through it. That is the shape of CVE-2026-76845 in adm-zip, and it applies
// to any extractor that resolves paths as strings and then calls writeFileSync.
//
// So every write is also checked against the REAL path of its deepest existing
// ancestor. Directories this extractor creates itself are always real directories, so
// once the deepest existing ancestor is known to be inside destDir, the rest is safe.
// Returns `full` when the write is contained, or null to skip the entry.
function realContained(destDir, full) {
  return containmentChecker(destDir)(full);
}

// Memoized form, for extracting a whole archive. The check costs one realpath syscall
// per entry, but entries overwhelmingly share parent directories — a 4000-file build
// typically has a couple of hundred — so resolving per DIRECTORY instead of per entry
// turns seconds of syscalls into milliseconds.
//
// Caching a positive verdict is sound: this extractor only ever creates real
// directories, and it refuses to create a symlink whose target leaves destDir, so a
// directory known to be inside cannot later come to point outside.
function containmentChecker(destDir) {
  let root = null;
  const seen = new Map();
  return (full) => {
    if (root === null) {
      try {
        root = fs.realpathSync(destDir);
      } catch {
        return null; // destDir itself is gone — write nothing
      }
    }
    const key = path.dirname(full);
    const hit = seen.get(key);
    if (hit !== undefined) return hit ? full : null;
    let dir = key;
    for (;;) {
      try {
        const real = fs.realpathSync(dir);
        const ok = real === root || real.startsWith(root + path.sep);
        seen.set(key, ok);
        return ok ? full : null;
      } catch {
        const parent = path.dirname(dir); // not created yet — check its parent instead
        if (parent === dir) {
          seen.set(key, false);
          return null;
        }
        dir = parent;
      }
    }
  };
}

// Reject anything that would land outside destDir — absolute paths, drive letters and
// "../" traversal alike. Returns the resolved absolute path, or null to skip the entry.
function safeJoin(destDir, name) {
  const cleaned = String(name || '').replace(/\\/g, '/');
  if (!cleaned || cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null;
  const full = path.resolve(destDir, cleaned);
  const root = path.resolve(destDir);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

// Where a link's target is allowed to point. The target is resolved relative to `baseDir`
// and then validated against destDir — NOT against baseDir.
//
// Validating against the link's own directory, which is what this originally did, rejects
// any target containing ".." even when it resolves well inside the extraction root. That
// silently drops the upward links every .app bundle and framework is built from:
//
//   Contents/MacOS/libfoo.dylib -> ../Frameworks/libfoo.dylib
//
// which is ordinary and has to survive. The result was a macOS build that extracted
// clean, reported a successful update, and then failed at first launch — precisely the
// failure this module exists to prevent.
//
// baseDir differs by link type: a symlink's target is relative to the symlink's own
// directory, while a tar hardlink's is relative to the archive root.
function safeLinkTarget(destDir, baseDir, linkname) {
  const cleaned = String(linkname || '').replace(/\\/g, '/');
  if (!cleaned || cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null;
  const resolved = path.resolve(baseDir, cleaned);
  const root = path.resolve(destDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

// pax extended headers are "<len> <key>=<value>\n" records; we only care about "path".
function paxPath(buf) {
  const text = buf.toString('utf8');
  const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec('\n' + text);
  return m ? m[1] : null;
}

// Extract `buf` (an uncompressed tar) into destDir. Returns one record per entry
// written: { path, mode, type } with the path relative to destDir. The mode is
// reported even on Windows, where chmod is a no-op — that keeps the permission
// handling testable from any host, which matters because a lost executable bit only
// shows up when a user tries to launch the app.
function extractTarBuffer(buf, destDir) {
  const contained = containmentChecker(destDir);
  const written = [];
  const dirModes = [];
  let off = 0;
  let longName = null; // from a GNU 'L' or pax 'x' header that precedes the real entry

  while (off + BLOCK <= buf.length) {
    const head = buf.subarray(off, off + BLOCK);
    // Two consecutive zero blocks terminate the archive; one is enough to stop on.
    if (head.every((b) => b === 0)) break;
    off += BLOCK;

    const prefix = str(head, 345, 155);
    let name = str(head, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const mode = octal(head, 100, 8);
    const size = octal(head, 124, 12);
    const type = String.fromCharCode(head[156]) || '0';
    const linkname = str(head, 157, 100);

    const dataLen = Math.ceil(size / BLOCK) * BLOCK;
    const data = buf.subarray(off, off + size);
    off += dataLen;

    if (type === 'L') {
      // GNU long name: this entry's data IS the next entry's path.
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x' || type === 'X') {
      longName = paxPath(data) || longName;
      continue;
    }
    if (type === 'g') continue; // global pax header, not per-entry

    if (longName) {
      name = longName;
      longName = null;
    }
    if (!name) continue;

    const full = safeJoin(destDir, name);
    if (!full) continue; // path traversal attempt — drop the entry, keep going

    if (type === '5') {
      if (!contained(full)) continue;
      fs.mkdirSync(full, { recursive: true });
      // Directory modes are applied last: a read-only dir would block writing into it.
      if (mode) dirModes.push([full, mode & 0o7777]);
      continue;
    }
    if (type === '2' || type === '1') {
      // Symlink / hard link. A .app bundle's Contents/Frameworks is full of these, and
      // dropping them silently corrupts the bundle — so a bad target is skipped, never
      // rewritten. The target must stay inside destDir but is free to point upward
      // within it. A symlink's target is relative to its own directory; a tar hardlink's
      // is relative to the archive root.
      const base = type === '2' ? path.dirname(full) : destDir;
      const target = safeLinkTarget(destDir, base, linkname);
      if (!target || !contained(full)) continue;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      try {
        fs.rmSync(full, { force: true });
        if (type === '2') fs.symlinkSync(linkname, full);
        else fs.linkSync(target, full);
        written.push({ path: path.relative(destDir, full), mode: mode & 0o7777, type });
      } catch {}
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') continue; // char/block/fifo: not ours

    if (!contained(full)) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
    if (mode && process.platform !== 'win32') {
      try {
        fs.chmodSync(full, mode & 0o7777);
      } catch {}
    }
    written.push({ path: path.relative(destDir, full), mode: mode & 0o7777, type: '0' });
  }

  if (process.platform !== 'win32') {
    for (const [dir, mode] of dirModes) {
      try {
        fs.chmodSync(dir, mode);
      } catch {}
    }
  }
  return written;
}

// Extract a .tar or .tar.gz/.tgz file. Anything else must be decompressed to a plain
// .tar first (see install.js, which routes .tar.xz / .tar.bz2 through 7z-wasm).
function extractTar(archivePath, destDir) {
  let buf = fs.readFileSync(archivePath);
  if (/\.(tgz|tar\.gz)$/i.test(archivePath) || (buf[0] === 0x1f && buf[1] === 0x8b)) {
    buf = zlib.gunzipSync(buf);
  }
  return extractTarBuffer(buf, destDir);
}

module.exports = { extractTar, extractTarBuffer, safeJoin, safeLinkTarget, realContained, containmentChecker };
