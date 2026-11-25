'use strict';

// Move existing meeting files when a Settings → Meeting folder changes. Two halves:
//   scan(kind, from, to, opts)  — what would move (sync, read-only), shown in the editor's dialog
//   run(scans, opts)            — the move itself (async, so the app stays responsive)
// Rules: never overwrite; a different-drive move is copy → checksum both → delete the original;
// links are never followed; files a running job holds are left and named; the old root stays.
// fs is injected (opts.fs) so tests can simulate a cross-drive rename (EXDEV).

const path = require('path');
const crypto = require('crypto');

const LABELS = { unprocessed: 'Unprocessed Recordings', transcribed: 'Transcribed Recordings', processed: 'Completed Meetings' };
// Top-level files of the Completed folder that belong to meetings; anything else there stays.
const COMPLETED_FILE = /\.(md|json|wav|vtt|txt)$/i;
const PART = '.bpmove-part';

function fold(p, platform) { return platform === 'win32' ? p.toLowerCase() : p; }
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
// '' when from → to is a usable pair, else the reason in plain words.
function pairError(from, to, platform) {
  const a = fold(path.resolve(from), platform), b = fold(path.resolve(to), platform);
  if (a === b) return 'same';
  if (inside(a, b)) return 'The new folder is inside the old one, so the files cannot be moved into it.';
  if (inside(b, a)) return 'The old folder is inside the new one, so the files cannot be moved out of it.';
  return '';
}

// Flat stages (unprocessed, transcribed): a meeting set is named after its recording or
// transcript; every top-level entry named "<base>.…" or "<base>-…" travels with it.
function flatBase(name) {
  if (/-diarizer-response\.json$/i.test(name)) return name.replace(/-diarizer-response\.json$/i, '');
  if (/\.wav$/i.test(name)) return name.replace(/\.wav$/i, '');
  return null;
}
function ownerOf(name, bases) {
  const n = name.toLowerCase();
  let best = null;
  for (const b of bases) {
    const l = b.toLowerCase();
    if ((n.startsWith(l + '.') || n.startsWith(l + '-')) && (!best || l.length > best.length)) best = b;
  }
  return best;
}

function treeStats(fsMod, abs) {
  // { bytes, files } for a file or a directory tree; links count as one entry and are not followed.
  const st = fsMod.lstatSync(abs);
  if (!st.isDirectory() || st.isSymbolicLink()) return { bytes: st.isFile() ? st.size : 0, files: 1 };
  let bytes = 0, files = 0;
  for (const leaf of fsMod.readdirSync(abs)) {
    const s = treeStats(fsMod, path.join(abs, leaf));
    bytes += s.bytes; files += s.files;
  }
  return { bytes, files };
}
// Completed meetings = the notes, not their revisions, proposals or sources.
function countNotes(fsMod, abs) {
  let n = 0;
  let entries = [];
  try { entries = fsMod.readdirSync(abs, { withFileTypes: true }); } catch (e) { return 0; }
  for (const ent of entries) {
    if (ent.isSymbolicLink && ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) { if (!/^(details|_system)$/i.test(ent.name) && ent.name[0] !== '.') n += countNotes(fsMod, path.join(abs, ent.name)); continue; }
    if (/\.md$/i.test(ent.name) && !/(\.rev[^/\\]*|\.proposed)\.md$/i.test(ent.name)) n++;
  }
  return n;
}

// busy: { unprocessed: Set<base>, transcribed: Set<base>, processed: '' | reason }
//   — the sets a running recording / transcription / analysis holds right now.
function scan(kind, from, to, opts = {}) {
  const fsMod = opts.fs || require('fs');
  const platform = opts.platform || process.platform;
  const busy = opts.busy || {};
  const out = { kind, label: LABELS[kind] || kind, from, to, error: '', entries: [], busy: [], others: [], meetings: 0, bytes: 0, files: 0 };
  const pe = pairError(from, to, platform);
  if (pe === 'same') return null;
  if (pe) { out.error = pe; return out; }
  let dirents;
  try { dirents = fsMod.readdirSync(from, { withFileTypes: true }); } catch (e) { return out; }   // old folder gone = nothing to move
  const add = (list, ent) => {
    const abs = path.join(from, ent.name);
    let s; try { s = treeStats(fsMod, abs); } catch (e) { s = { bytes: 0, files: 1 }; }
    list.push({ name: ent.name, isDir: ent.isDirectory(), bytes: s.bytes, files: s.files });
    return s;
  };
  if (kind === 'processed') {
    for (const ent of dirents) {
      if (ent.isSymbolicLink && ent.isSymbolicLink()) { out.others.push(ent.name); continue; }
      const mine = ent.isDirectory() ? (ent.name[0] !== '.' || ent.name.toLowerCase() === '.obsidian')
        : COMPLETED_FILE.test(ent.name) && !ent.name.endsWith(PART);
      if (!mine) { out.others.push(ent.name); continue; }
      if (busy.processed) { out.busy.push({ name: ent.name, reason: busy.processed }); continue; }
      const s = add(out.entries, ent);
      out.bytes += s.bytes; out.files += s.files;
      if (ent.isDirectory()) { if (!/^(details|_system)$/i.test(ent.name) && ent.name[0] !== '.') out.meetings += countNotes(fsMod, path.join(from, ent.name)); }
      else if (/\.md$/i.test(ent.name) && !/(\.rev[^/\\]*|\.proposed)\.md$/i.test(ent.name)) out.meetings++;
    }
    return out;
  }
  const bases = new Set();
  for (const ent of dirents) if (ent.isFile()) { const b = flatBase(ent.name); if (b) bases.add(b); }
  const held = busy[kind] instanceof Set ? busy[kind] : new Set();
  const heldLower = new Set([...held].map(b => b.toLowerCase()));
  const sets = new Set();
  for (const ent of dirents) {
    if (ent.isSymbolicLink && ent.isSymbolicLink()) { out.others.push(ent.name); continue; }
    const owner = ownerOf(ent.name, bases);
    if (!owner || ent.name.endsWith(PART)) { out.others.push(ent.name); continue; }
    if (heldLower.has(owner.toLowerCase())) { out.busy.push({ name: ent.name, reason: kind === 'unprocessed' ? 'being recorded or transcribed right now' : 'being transcribed or analyzed right now' }); continue; }
    const s = add(out.entries, ent);
    out.bytes += s.bytes; out.files += s.files;
    sets.add(owner.toLowerCase());
  }
  out.meetings = sets.size;
  return out;
}

async function sha256(fsMod, file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fsMod.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

// Move every scanned entry. Returns { moved, left: [{ path, reason }] } where moved counts files.
async function run(scans, opts = {}) {
  const fsMod = opts.fs || require('fs');
  const fsp = fsMod.promises;
  const onProgress = opts.onProgress || (() => {});
  const log = opts.log || (() => {});
  const total = scans.reduce((n, s) => n + (s && !s.error ? s.files : 0), 0);
  let done = 0, moved = 0;
  const left = [];
  const exists = async p => { try { await fsp.lstat(p); return true; } catch (e) { return false; } };
  const tick = (name, n) => { done += n; onProgress({ done, total, current: name }); };
  const leave = (p, reason, n = 1) => { left.push({ path: p, reason }); tick(path.basename(p), n); };

  async function moveFile(src, dst, st) {
    if (await exists(dst)) return leave(src, 'a file with that name is already in the new folder');
    try { await fsp.rename(src, dst); moved++; return tick(path.basename(src), 1); }
    catch (e) { if (e.code !== 'EXDEV') return leave(src, 'could not be moved (' + (e.code || e.message) + ') — it may be open in another program'); }
    // Different drive: copy beside the target, check both checksums, then publish and delete the original.
    const part = dst + PART;
    try {
      await fsp.copyFile(src, part, fsMod.constants.COPYFILE_EXCL);
      const [a, b] = await Promise.all([sha256(fsMod, src), sha256(fsMod, part)]);
      if (a !== b) throw Object.assign(new Error('the copy did not match the original'), { check: true });
      if (await exists(dst)) throw Object.assign(new Error('a file with that name appeared in the new folder'), { check: true });
      await fsp.rename(part, dst);
      try { await fsp.utimes(dst, st.atime, st.mtime); } catch (e) { /* keep the copy's own times */ }
    } catch (e) {
      try { await fsp.unlink(part); } catch (e2) { /* nothing was written */ }
      return leave(src, e.check ? e.message + '; the original was kept' : 'could not be copied (' + (e.code || e.message) + '); the original was kept');
    }
    try { await fsp.unlink(src); moved++; tick(path.basename(src), 1); }
    catch (e) { leave(src, 'was copied to the new folder, but the original could not be removed (' + (e.code || e.message) + ')'); }
  }

  async function moveEntry(src, dst, files) {
    let st;
    try { st = await fsp.lstat(src); } catch (e) { return leave(src, 'was no longer there', files); }
    if (st.isSymbolicLink()) return leave(src, 'is a link, which is never moved', files);
    if (!st.isDirectory()) return moveFile(src, dst, st);
    if (!(await exists(dst))) {
      try { await fsp.rename(src, dst); moved += files; return tick(path.basename(src), files); }
      catch (e) { /* different drive or a locked file inside: go file by file below */ }
    } else {
      let dstSt; try { dstSt = await fsp.lstat(dst); } catch (e) { dstSt = null; }
      if (!dstSt || !dstSt.isDirectory() || dstSt.isSymbolicLink()) return leave(src, 'a file with that name is already in the new folder', files);
    }
    try { await fsp.mkdir(dst, { recursive: true }); } catch (e) { return leave(src, 'could not create the folder in the new location (' + (e.code || e.message) + ')', files); }
    for (const leaf of await fsp.readdir(src)) {
      const child = path.join(src, leaf);
      let n = 1;
      try { n = treeStats(fsMod, child).files; } catch (e) { /* counted as one */ }
      await moveEntry(child, path.join(dst, leaf), n);
    }
    try { await fsp.rmdir(src); } catch (e) { /* something stayed behind; it is listed */ }
  }

  for (const s of scans) {
    if (!s || s.error) continue;
    try { await fsp.mkdir(s.to, { recursive: true }); }
    catch (e) { for (const ent of s.entries) leave(path.join(s.from, ent.name), 'the new folder could not be created (' + (e.code || e.message) + ')', ent.files); continue; }
    for (const ent of s.entries) await moveEntry(path.join(s.from, ent.name), path.join(s.to, ent.name), ent.files);
    log('moved ' + s.label + ': ' + s.from + ' -> ' + s.to);
  }
  return { ok: true, moved, left };
}

// The stage folders that changed between two settings snapshots. Blank means the default folder,
// so default → custom and custom → blank both count. fields: { unprocessed, transcribed, processed }.
function changedPairs(before, after, defaults, platform = process.platform) {
  const res = (f, k) => String((f || {})[k] || '').trim() || defaults[k];
  const out = [];
  for (const kind of ['unprocessed', 'transcribed', 'processed']) {
    const from = res(before, kind), to = res(after, kind);
    if (fold(path.resolve(from), platform) !== fold(path.resolve(to), platform)) out.push({ kind, from, to });
  }
  return out;
}

// A new folder must not be another stage's old folder (a swap): its files would be mixed in.
function crossError(pairs, oldFolders, platform = process.platform) {
  for (const p of pairs) {
    for (const kind of Object.keys(oldFolders)) {
      if (kind === p.kind) continue;
      const a = fold(path.resolve(p.to), platform), b = fold(path.resolve(oldFolders[kind]), platform);
      if (a === b || inside(a, b) || inside(b, a)) return 'The new ' + LABELS[p.kind] + ' folder overlaps the old ' + LABELS[kind] + ' folder, so moving would mix the two. Nothing was moved.';
    }
  }
  return '';
}

module.exports = { scan, run, pairError, changedPairs, crossError, LABELS };
