'use strict';

// Merge several unprocessed recordings into ONE WAV (chronological order). The originals and their
// sidecars are MOVED into <unprocessed>/.backups/<stamp>/, never deleted. Everything is injected
// (fs) so it runs without Electron. The library listing skips directories, so .backups never shows
// up in Unprocessed, Batch, or the transcription queue.
//
// Refused (nothing touched): fewer than 2 files, a bad/missing name, a file the recorder or the
// transcriber is using, a header that is not plain PCM WAV, or parts whose formats differ (no resampling).

const path = require('path');
const nodeFs = require('fs');

const STAMP = /^(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})/;
const BACKUP_DIR = '.backups';
const COPY_CHUNK = 1024 * 1024;

// Parse the fmt + data chunk of a WAV file. Returns { fmt:{format,channels,rate,bits,align}, dataOffset, dataSize }.
// A header whose data size is 0 or past EOF (a recording cut off before the header patch) is read as
// "everything after the data chunk header".
function readWavInfo(fs, file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    fs.readSync(fd, head, 0, head.length, 0);
    if (head.length < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
    let off = 12, fmt = null;
    while (off + 8 <= head.length) {
      const id = head.toString('ascii', off, off + 4);
      const sz = head.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 24 <= head.length) {
        fmt = { format: head.readUInt16LE(off + 8), channels: head.readUInt16LE(off + 10), rate: head.readUInt32LE(off + 12),
          align: head.readUInt16LE(off + 20), bits: head.readUInt16LE(off + 22) };
      }
      if (id === 'data') {
        if (!fmt) return null;
        const dataOffset = off + 8;
        let dataSize = sz;
        if (!dataSize || dataOffset + dataSize > size) dataSize = size - dataOffset;
        return { fmt, dataOffset, dataSize };
      }
      off += 8 + sz + (sz % 2);
    }
    return null;
  } finally { fs.closeSync(fd); }
}

function wavHeader(fmt, dataBytes) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(fmt.format, 20);
  buf.writeUInt16LE(fmt.channels, 22);
  buf.writeUInt32LE(fmt.rate, 24);
  buf.writeUInt32LE(fmt.rate * fmt.align, 28);
  buf.writeUInt16LE(fmt.align, 32);
  buf.writeUInt16LE(fmt.bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

// Chronological order: the timestamp the recorder put in the name, then name as a tiebreak.
function chronoSort(names) {
  const key = n => (STAMP.exec(n) || [null, ''])[1];
  return names.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

// Merged name: the earliest recording's timestamp, plus the meeting name when every part carries the same one.
function mergedBase(sortedNames) {
  const bases = sortedNames.map(n => n.replace(/\.wav$/i, ''));
  const first = STAMP.exec(bases[0]);
  if (!first) return bases[0];
  const suffixes = bases.map(b => b.slice(19));
  const shared = suffixes.every(s => s === suffixes[0]) ? suffixes[0] : '';
  return first[1] + shared;
}

function stampNow(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
}

// deps: { fs, dir, safeName(name)->name|null, isBusy(name)->bool, now(), log }
function mergeRecordings(deps, names) {
  const fs = deps.fs || nodeFs;
  const dir = deps.dir;
  const log = deps.log || (() => {});
  const isBusy = deps.isBusy || (() => false);
  const fail = error => ({ ok: false, error });

  if (!Array.isArray(names)) return fail('bad request');
  const uniq = Array.from(new Set(names.map(String)));
  if (uniq.length < 2) return fail('select at least 2 recordings');
  const sorted = chronoSort(uniq);
  for (const n of sorted) {
    if (!/\.wav$/i.test(n) || (deps.safeName && !deps.safeName(n))) return fail('bad name: ' + n);
    if (!fs.existsSync(path.join(dir, n))) return fail('not found: ' + n);
    if (isBusy(n)) return fail(n + ' is being recorded or transcribed');
  }

  let infos;
  try {
    infos = sorted.map(n => {
      const info = readWavInfo(fs, path.join(dir, n));
      if (!info) throw new Error(n + ' is not a plain WAV file');
      if (info.fmt.format !== 1) throw new Error(n + ' is not PCM audio');
      return info;
    });
  } catch (e) { return fail(e.message); }
  const f0 = infos[0].fmt;
  for (let i = 1; i < infos.length; i++) {
    const f = infos[i].fmt;
    if (f.channels !== f0.channels || f.rate !== f0.rate || f.bits !== f0.bits || f.align !== f0.align) {
      return fail('recordings have different audio formats (' + sorted[0] + ': ' + f0.rate + ' Hz/' + f0.channels + ' ch, ' + sorted[i] + ': ' + f.rate + ' Hz/' + f.channels + ' ch) and cannot be merged');
    }
  }
  const total = infos.reduce((s, i) => s + i.dataSize, 0);
  if (total > 0xFFFFFFFF - 64) return fail('merged recording would exceed the 4 GB WAV limit');

  const stamp = stampNow(deps.now ? deps.now() : new Date());
  const backupRoot = path.join(dir, BACKUP_DIR);
  const backupDir = path.join(backupRoot, stamp);
  const tmp = path.join(backupRoot, '.merge-' + stamp + '.tmp');

  // 1. Write the merged audio to a temp file inside .backups (invisible to every list) and verify it.
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const out = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(out, wavHeader(f0, total));
      const buf = Buffer.alloc(COPY_CHUNK);
      for (let i = 0; i < sorted.length; i++) {
        const fd = fs.openSync(path.join(dir, sorted[i]), 'r');
        try {
          let pos = infos[i].dataOffset, left = infos[i].dataSize;
          while (left > 0) {
            const n = fs.readSync(fd, buf, 0, Math.min(buf.length, left), pos);
            if (n <= 0) throw new Error('short read from ' + sorted[i]);
            fs.writeSync(out, buf, 0, n);
            pos += n; left -= n;
          }
        } finally { fs.closeSync(fd); }
      }
    } finally { fs.closeSync(out); }
    if (fs.statSync(tmp).size !== 44 + total) throw new Error('merged file size check failed');
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* nothing written */ }
    return fail('merge failed: ' + e.message);
  }

  // 2. Read the sidecars we carry over (earliest first) BEFORE the originals move.
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
  const bases = sorted.map(n => n.replace(/\.wav$/i, ''));
  let capture = null, meetingInfo = null;
  for (const b of bases) {
    if (!capture) capture = readJson(path.join(dir, b + '.capture.json'));
    if (!meetingInfo) meetingInfo = readJson(path.join(dir, b + '.json'));
  }

  // 3. Move originals + sidecars into the backup folder; undo everything if any move fails.
  const moved = [];
  const move = leaf => {
    const from = path.join(dir, leaf);
    if (!fs.existsSync(from)) return;
    const to = path.join(backupDir, leaf);
    fs.renameSync(from, to);
    moved.push([from, to]);
  };
  try {
    for (const b of bases) for (const leaf of [b + '.wav', b + '.json', b + '.capture.json', b + '-screenshots']) move(leaf);
  } catch (e) {
    for (const [from, to] of moved.reverse()) { try { fs.renameSync(to, from); } catch (e2) { log('merge rollback failed for ' + to + ': ' + e2.message); } }
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    return fail('merge failed while moving originals: ' + e.message);
  }

  // 4. Name the merged file and put it (and its sidecars) in place.
  let base = mergedBase(sorted);
  for (let i = 1; fs.existsSync(path.join(dir, base + '.wav')); i++) base = mergedBase(sorted) + '_' + i;
  try {
    fs.renameSync(tmp, path.join(dir, base + '.wav'));
    if (meetingInfo) fs.writeFileSync(path.join(dir, base + '.json'), JSON.stringify(meetingInfo, null, 2));
    if (capture) fs.writeFileSync(path.join(dir, base + '.capture.json'), JSON.stringify(Object.assign({}, capture, { merged_from: sorted }), null, 2));
  } catch (e) {
    return fail('merged file is at ' + path.join(BACKUP_DIR, stamp, '..', path.basename(tmp)) + ' but could not be placed: ' + e.message + ' (originals are in ' + path.join(BACKUP_DIR, stamp) + ')');
  }
  log('merged ' + sorted.length + ' recordings -> ' + base + '.wav (originals in ' + path.join(BACKUP_DIR, stamp) + ')');
  return { ok: true, name: base + '.wav', merged: sorted, backup: path.join(BACKUP_DIR, stamp) };
}

module.exports = { mergeRecordings, readWavInfo, chronoSort, mergedBase, BACKUP_DIR };
