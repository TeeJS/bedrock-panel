'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mergeRecordings, readWavInfo, chronoSort, mergedBase } = require('../app/meetingMerge');
const { createMeetingLibrary, safeName } = require('../app/meetingLibrary');

function wav(rate, channels, payload) {
  const align = channels * 2;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + payload.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * align, 28); h.writeUInt16LE(align, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(payload.length, 40);
  return Buffer.concat([h, payload]);
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
const deps = dir => ({ dir, safeName, now: () => new Date(2026, 9, 20, 9, 0, 0) });

test('merges in chronological order, header sizes right, originals moved to .backups', () => {
  const dir = tmpDir();
  // given out of order on purpose
  fs.writeFileSync(path.join(dir, '2026-10-20-07-22-39.wav'), wav(16000, 2, Buffer.from([3, 3, 3, 3])));
  fs.writeFileSync(path.join(dir, '2026-10-20-06-59-15.wav'), wav(16000, 2, Buffer.from([1, 1, 1, 1, 2, 2, 2, 2])));
  fs.writeFileSync(path.join(dir, '2026-10-20-06-59-15.capture.json'), JSON.stringify({ started_at: 'X' }));
  fs.writeFileSync(path.join(dir, '2026-10-20-06-59-15.json'), JSON.stringify({ subject: 'Titan' }));
  const r = mergeRecordings(deps(dir), ['2026-10-20-07-22-39.wav', '2026-10-20-06-59-15.wav']);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.name, '2026-10-20-06-59-15.wav');
  const out = fs.readFileSync(path.join(dir, r.name));
  assert.deepStrictEqual([...out.slice(44)], [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  assert.equal(out.readUInt32LE(40), 12);
  assert.equal(out.readUInt32LE(4), 48);
  const info = readWavInfo(fs, path.join(dir, r.name));
  assert.equal(info.dataSize, 12);
  // originals + sidecars are in .backups, not deleted
  const bk = path.join(dir, r.backup);
  assert.deepStrictEqual(fs.readdirSync(bk).sort(), ['2026-10-20-06-59-15.capture.json', '2026-10-20-06-59-15.json', '2026-10-20-06-59-15.wav', '2026-10-20-07-22-39.wav']);
  // carried-over sidecars
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '2026-10-20-06-59-15.json'))).subject, 'Titan');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, '2026-10-20-06-59-15.capture.json'))).merged_from, ['2026-10-20-06-59-15.wav', '2026-10-20-07-22-39.wav']);
  // no temp file left behind
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.backups')).filter(n => n.endsWith('.tmp')), []);
});

test('library listing ignores .backups', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '2026-10-20-06-59-15.wav'), wav(16000, 2, Buffer.alloc(8)));
  fs.writeFileSync(path.join(dir, '2026-10-20-07-22-39.wav'), wav(16000, 2, Buffer.alloc(8)));
  mergeRecordings(deps(dir), ['2026-10-20-06-59-15.wav', '2026-10-20-07-22-39.wav']);
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dir, transcribed: dir, processed: dir }) });
  const files = lib.listFiles('unprocessed').files.map(f => f.name);
  assert.deepStrictEqual(files, ['2026-10-20-06-59-15.wav']);
});

test('shared meeting name is kept; differing names fall back to the timestamp', () => {
  assert.equal(mergedBase(['2026-10-20-06-59-15-Titan.wav', '2026-10-20-07-22-39-Titan.wav']), '2026-10-20-06-59-15-Titan');
  assert.equal(mergedBase(['2026-10-20-06-59-15-Titan.wav', '2026-10-20-07-22-39.wav']), '2026-10-20-06-59-15');
  assert.deepStrictEqual(chronoSort(['b-2026-10-20-07-22-39.wav', '2026-10-20-06-59-15.wav']).length, 2);
});

test('mismatched formats are refused and nothing moves', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '2026-10-20-06-59-15.wav'), wav(16000, 2, Buffer.alloc(8)));
  fs.writeFileSync(path.join(dir, '2026-10-20-07-22-39.wav'), wav(44100, 2, Buffer.alloc(8)));
  const r = mergeRecordings(deps(dir), ['2026-10-20-06-59-15.wav', '2026-10-20-07-22-39.wav']);
  assert.equal(r.ok, false);
  assert.match(r.error, /different audio formats/);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['2026-10-20-06-59-15.wav', '2026-10-20-07-22-39.wav']);
});

test('busy (recording/transcribing) file is refused', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '2026-10-20-06-59-15.wav'), wav(16000, 2, Buffer.alloc(8)));
  fs.writeFileSync(path.join(dir, '2026-10-20-07-22-39.wav'), wav(16000, 2, Buffer.alloc(8)));
  const r = mergeRecordings(Object.assign(deps(dir), { isBusy: n => n === '2026-10-20-07-22-39.wav' }), ['2026-10-20-06-59-15.wav', '2026-10-20-07-22-39.wav']);
  assert.equal(r.ok, false);
  assert.match(r.error, /being recorded or transcribed/);
  assert.equal(fs.existsSync(path.join(dir, '.backups')), false);
});

test('needs 2+ distinct, valid, existing files', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.wav'), wav(16000, 2, Buffer.alloc(8)));
  assert.equal(mergeRecordings(deps(dir), ['a.wav']).ok, false);
  assert.equal(mergeRecordings(deps(dir), ['a.wav', 'a.wav']).ok, false);
  assert.equal(mergeRecordings(deps(dir), ['a.wav', 'missing.wav']).ok, false);
  assert.equal(mergeRecordings(deps(dir), ['a.wav', '../x.wav']).ok, false);
  assert.equal(mergeRecordings(deps(dir), 'nope').ok, false);
});

test('a recording cut off before its header patch (data size 0) still merges', () => {
  const dir = tmpDir();
  const cut = wav(16000, 2, Buffer.from([9, 9, 9, 9]));
  cut.writeUInt32LE(0, 40); cut.writeUInt32LE(0, 4);
  fs.writeFileSync(path.join(dir, '2026-10-20-06-59-15.wav'), cut);
  fs.writeFileSync(path.join(dir, '2026-10-20-07-22-39.wav'), wav(16000, 2, Buffer.from([4, 4, 4, 4])));
  const r = mergeRecordings(deps(dir), ['2026-10-20-06-59-15.wav', '2026-10-20-07-22-39.wav']);
  assert.equal(r.ok, true, r.error);
  assert.deepStrictEqual([...fs.readFileSync(path.join(dir, r.name)).slice(44)], [9, 9, 9, 9, 4, 4, 4, 4]);
});
