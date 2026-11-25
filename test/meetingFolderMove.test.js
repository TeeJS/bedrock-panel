'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan, run, pairError, changedPairs, crossError } = require('../app/meetingFolderMove');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-folder-move-'));
  // Everything lives under this temp root; nothing outside it is touched or removed.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, from: path.join(root, 'old'), to: path.join(root, 'new') };
}
function put(file, body = 'x') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
const names = list => list.map(e => e.name).sort();

// A filesystem whose renames between "drives" fail with EXDEV (only the .bpmove-part publish succeeds).
function crossDrive(over = {}) {
  const promises = Object.assign({}, fs.promises, {
    rename: async (a, b) => {
      if (String(a).endsWith('.bpmove-part')) return fs.promises.rename(a, b);
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    },
  }, over);
  return Object.assign({}, fs, { promises });
}

test('unprocessed: a recording moves with its sidecars; unrelated files stay', t => {
  const { from, to } = setup(t);
  put(path.join(from, '2026-11-18 SAP.wav'), 'wav');
  put(path.join(from, '2026-11-18 SAP.json'), '{}');
  put(path.join(from, '2026-11-18 SAP.capture.json'), '{}');
  put(path.join(from, '2026-11-18 SAP-screenshots', 'a.png'), 'png');
  put(path.join(from, 'notes.txt'), 'mine');
  const s = scan('unprocessed', from, to);
  assert.deepEqual(names(s.entries), ['2026-11-18 SAP-screenshots', '2026-11-18 SAP.capture.json', '2026-11-18 SAP.json', '2026-11-18 SAP.wav']);
  assert.deepEqual(s.others, ['notes.txt']);
  assert.equal(s.meetings, 1);
  assert.equal(s.files, 4);
});

test('overlapping names: each sidecar goes with its own (longest) recording', t => {
  const { from, to } = setup(t);
  put(path.join(from, 'a.wav')); put(path.join(from, 'a-b.wav')); put(path.join(from, 'a-b.json')); put(path.join(from, 'a.json'));
  const s = scan('unprocessed', from, to);
  assert.equal(s.meetings, 2);
  assert.equal(s.entries.length, 4);
});

test('transcribed: the whole waiting set moves, journal included', t => {
  const { from, to } = setup(t);
  for (const n of ['m-diarizer-response.json', 'm.wav', 'm.json', 'm.capture.json', 'm.completed.json', 'm.vtt']) put(path.join(from, n));
  const s = scan('transcribed', from, to);
  assert.equal(s.entries.length, 6);
  assert.equal(s.meetings, 1);
});

test('completed: notes, date folders and .obsidian move; other files and dot-folders stay', t => {
  const { from, to } = setup(t);
  put(path.join(from, '2026', '10', 'SAP.md'));
  put(path.join(from, '2026', '10', 'SAP.rev1.md'));
  put(path.join(from, '2026', '10', 'details', 'SAP.wav'));
  put(path.join(from, '2026', '11', 'Ops.md'));
  put(path.join(from, 'Loose.md'));
  put(path.join(from, '.obsidian', 'app.json'));
  put(path.join(from, '.git', 'HEAD'));
  put(path.join(from, 'budget.pdf'));
  const s = scan('processed', from, to);
  assert.deepEqual(names(s.entries), ['.obsidian', '2026', 'Loose.md']);
  assert.deepEqual(s.others.sort(), ['.git', 'budget.pdf']);
  assert.equal(s.meetings, 3);   // SAP, Ops, Loose — not the revision or the details source
});

test('files a running job holds are listed, not moved', t => {
  const { from, to } = setup(t);
  put(path.join(from, 'rec.wav')); put(path.join(from, 'rec.json')); put(path.join(from, 'other.wav'));
  const s = scan('unprocessed', from, to, { busy: { unprocessed: new Set(['REC']) } });
  assert.deepEqual(names(s.entries), ['other.wav']);
  assert.deepEqual(s.busy.map(b => b.name).sort(), ['rec.json', 'rec.wav']);
  put(path.join(from, 'c', '2026', 'x.md'));
  const p = scan('processed', path.join(from, 'c'), to, { busy: { processed: 'an analysis is running' } });
  assert.equal(p.entries.length, 0);
  assert.equal(p.busy[0].reason, 'an analysis is running');
});

test('same folder is no change; nested folders are refused both ways', t => {
  const { from } = setup(t);
  assert.equal(scan('unprocessed', from, from + path.sep), null);
  assert.match(pairError(from, path.join(from, 'sub'), process.platform), /new folder is inside the old one/);
  assert.match(pairError(path.join(from, 'sub'), from, process.platform), /old folder is inside the new one/);
  assert.match(scan('unprocessed', from, path.join(from, 'sub')).error, /inside/);
});

test('blank means the default folder, both directions', () => {
  const d = { unprocessed: 'C:\\D\\unprocessed', transcribed: 'C:\\D\\transcribed', processed: 'C:\\D\\processed' };
  assert.deepEqual(changedPairs({ processed: '' }, { processed: 'M:\\c' }, d, 'win32'), [{ kind: 'processed', from: d.processed, to: 'M:\\c' }]);
  assert.deepEqual(changedPairs({ unprocessed: 'M:\\u' }, { unprocessed: '' }, d, 'win32'), [{ kind: 'unprocessed', from: 'M:\\u', to: d.unprocessed }]);
  assert.deepEqual(changedPairs({ transcribed: 'M:\\T' }, { transcribed: 'm:\\t\\' }, d, 'win32'), []);
});

test('a new folder that was another stage\'s old folder is refused', () => {
  const old = { unprocessed: 'C:\\u', transcribed: 'C:\\t', processed: 'C:\\p' };
  assert.match(crossError([{ kind: 'unprocessed', from: 'C:\\u', to: 'C:\\t' }], old, 'win32'), /overlaps the old Transcribed/);
  assert.equal(crossError([{ kind: 'unprocessed', from: 'C:\\u', to: 'D:\\u' }], old, 'win32'), '');
});

test('same drive: everything moves, times are kept, the old root stays (emptied)', async t => {
  const { from, to } = setup(t);
  put(path.join(from, 'm.wav'), 'wav'); put(path.join(from, 'm.json'), '{}');
  const past = new Date('2026-10-01T10:00:00Z');
  fs.utimesSync(path.join(from, 'm.wav'), past, past);
  const progress = [];
  const r = await run([scan('unprocessed', from, to)], { onProgress: p => progress.push(p) });
  assert.equal(r.moved, 2); assert.deepEqual(r.left, []);
  assert.equal(fs.readFileSync(path.join(to, 'm.wav'), 'utf8'), 'wav');
  assert.equal(fs.statSync(path.join(to, 'm.wav')).mtimeMs, past.getTime());
  assert.deepEqual(fs.readdirSync(from), []);
  assert.deepEqual(progress[progress.length - 1], { done: 2, total: 2, current: progress[progress.length - 1].current });
});

test('different drive: copy, checksum, then delete; date folders rebuilt and emptied', async t => {
  const { from, to } = setup(t);
  put(path.join(from, '2026', '10', 'SAP.md'), 'note');
  put(path.join(from, '2026', '10', 'details', 'SAP.wav'), Buffer.alloc(300000, 7));
  const past = new Date('2026-10-02T09:00:00Z');
  fs.utimesSync(path.join(from, '2026', '10', 'SAP.md'), past, past);
  const fsX = crossDrive();
  const r = await run([scan('processed', from, to, { fs: fsX })], { fs: fsX });
  assert.deepEqual(r.left, []); assert.equal(r.moved, 2);
  assert.equal(fs.readFileSync(path.join(to, '2026', '10', 'SAP.md'), 'utf8'), 'note');
  assert.equal(fs.readFileSync(path.join(to, '2026', '10', 'details', 'SAP.wav')).length, 300000);
  assert.equal(fs.statSync(path.join(to, '2026', '10', 'SAP.md')).mtimeMs, past.getTime());
  assert.deepEqual(fs.readdirSync(from), []);   // 2026\10\details\ removed once empty; the root itself stays
});

test('never overwrite: a clash is left in place and named; folders merge around it', async t => {
  const { from, to } = setup(t);
  put(path.join(from, '2026', '10', 'A.md'), 'old A');
  put(path.join(from, '2026', '10', 'B.md'), 'old B');
  put(path.join(to, '2026', '10', 'A.md'), 'new A');
  put(path.join(to, '2026', '09', 'Z.md'), 'z');
  const r = await run([scan('processed', from, to)]);
  assert.equal(r.moved, 1);
  assert.equal(r.left.length, 1);
  assert.match(r.left[0].reason, /already in the new folder/);
  assert.equal(fs.readFileSync(path.join(to, '2026', '10', 'A.md'), 'utf8'), 'new A');
  assert.equal(fs.readFileSync(path.join(from, '2026', '10', 'A.md'), 'utf8'), 'old A');
  assert.equal(fs.readFileSync(path.join(to, '2026', '10', 'B.md'), 'utf8'), 'old B');
  assert.ok(fs.existsSync(path.join(to, '2026', '09', 'Z.md')));
});

test('a bad copy is discarded and the original kept', async t => {
  const { from, to } = setup(t);
  put(path.join(from, 'm.wav'), 'real audio');
  const fsX = crossDrive({ copyFile: async (a, b) => fs.promises.writeFile(b, 'garbage', { flag: 'wx' }) });
  const r = await run([scan('unprocessed', from, to, { fs: fsX })], { fs: fsX });
  assert.equal(r.moved, 0);
  assert.match(r.left[0].reason, /did not match.*original was kept/);
  assert.equal(fs.readFileSync(path.join(from, 'm.wav'), 'utf8'), 'real audio');
  assert.deepEqual(fs.readdirSync(to), []);
});

test('copied but the original is locked: reported, both copies exist', async t => {
  const { from, to } = setup(t);
  put(path.join(from, 'm.wav'), 'a');
  const fsX = crossDrive({ unlink: async p => { if (/m\.wav$/.test(p)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.promises.unlink(p); } });
  const r = await run([scan('unprocessed', from, to, { fs: fsX })], { fs: fsX });
  assert.match(r.left[0].reason, /copied to the new folder, but the original could not be removed \(EBUSY\)/);
  assert.ok(fs.existsSync(path.join(from, 'm.wav')) && fs.existsSync(path.join(to, 'm.wav')));
});

test('same drive, file locked by another program: left and named', async t => {
  const { from, to } = setup(t);
  put(path.join(from, 'm.wav'), 'a');
  const fsX = Object.assign({}, fs, { promises: Object.assign({}, fs.promises, { rename: async () => { throw Object.assign(new Error('perm'), { code: 'EPERM' }); } }) });
  const r = await run([scan('unprocessed', from, to)], { fs: fsX });
  assert.match(r.left[0].reason, /EPERM.*open in another program/);
  assert.ok(fs.existsSync(path.join(from, 'm.wav')));
});

test('a missing old folder means nothing to move', () => {
  const s = scan('transcribed', path.join(os.tmpdir(), 'bp-does-not-exist-' + Date.now()), path.join(os.tmpdir(), 'x'));
  assert.equal(s.entries.length, 0);
});
