'use strict';
// meetingLibrary: filename validation (the HTTP-facing gate), listing, and the
// delete-unprocessed-only rule. Uses real fs against temp dirs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMeetingLibrary, safeName, safeRelPath, wavDurationMs } = require('../app/meetingLibrary');
const { serializeFrontmatter } = require('../app/meetingFrontmatter');

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-lib-'));
  const unprocessed = path.join(root, 'unprocessed');
  const processed = path.join(root, 'processed');
  fs.mkdirSync(unprocessed); fs.mkdirSync(processed);
  return { root, unprocessed, processed };
}

// Minimal valid WAV: 16kHz mono 16-bit, one second of silence.
function makeWav(seconds) {
  const byteRate = 16000 * 2;
  const data = Buffer.alloc(byteRate * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('safeName accepts real meeting-subject names and rejects traversal/junk', () => {
  assert.equal(safeName('2026-08-14-09-30-00.wav'), '2026-08-14-09-30-00.wav');
  assert.equal(safeName('My Meeting (2).json'), 'My Meeting (2).json');
  assert.equal(safeName('notes.md'), 'notes.md');
  // deny-list, not allow-list: subjects carry #, &, [ ], ', commas… (a # once hid a recording)
  assert.equal(safeName('2026-08-15-21-47-10-Recording Test #1.wav'), '2026-08-15-21-47-10-Recording Test #1.wav');
  assert.equal(safeName("[EXTERNAL]SAP & Friends, Dave's Q4.wav"), "[EXTERNAL]SAP & Friends, Dave's Q4.wav");
  for (const bad of ['../x.wav', '..\\x.wav', 'a/b.wav', 'a\\b.wav', 'x.exe', 'x', '', null, 'x.wav.exe', 'con|.wav', ' padded.wav']) {
    assert.equal(safeName(bad), null, 'should reject: ' + JSON.stringify(bad));
  }
  assert.equal(safeName('bell' + String.fromCharCode(7) + '.wav'), null);   // control chars
});

test('sanitizeSubjectForFilename mirrors the validation rules', () => {
  const { sanitizeSubjectForFilename: san } = require('../app/meetingLibrary');
  assert.equal(san('Basis/Titan Admins Thurs Check-in'), 'BasisTitan Admins Thurs Check-in');   // the pipeline convention
  assert.equal(san('Q&A #4: review?'), 'Q&A #4 review');
  assert.equal(san('  spaced  '), 'spaced');
  assert.equal(san('Follow up...'), 'Follow up');
  assert.equal(san('a<b>c:"d"|e*f\\g'), 'abcdef g'.replace(' ', ''));   // all illegal chars dropped
  assert.equal(san('bell' + String.fromCharCode(7) + 'x'), 'bellx');
  assert.equal(san(''), '');
  // whatever comes out must survive safeName once embedded in a recording name
  for (const subj of ['Basis/Titan #1', 'Trailing dot.', 'Q&A: huh?', '[EXT] & more']) {
    const out = san(subj);
    assert.ok(safeName('2026-08-15-21-00-00-' + out + '.wav'), 'safeName must accept: ' + out);
  }
});

test('wavDurationMs parses a real header and rejects non-RIFF data', () => {
  assert.equal(wavDurationMs(makeWav(3)), 3000);
  assert.equal(wavDurationMs(Buffer.from('ID3not a wav at all, definitely mp3 data')), null);
  assert.equal(wavDurationMs(Buffer.alloc(10)), null);
});

test('listFiles returns WAV metadata with duration, newest first; missing folder is empty not error', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  fs.writeFileSync(path.join(dirs.unprocessed, 'a.wav'), makeWav(2));
  fs.writeFileSync(path.join(dirs.unprocessed, 'b.wav'), makeWav(1));
  fs.writeFileSync(path.join(dirs.unprocessed, 'ignore.txt'), 'x');
  const r = lib.listFiles('unprocessed');
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map(f => f.name).sort(), ['a.wav', 'b.wav']);
  assert.equal(r.files.find(f => f.name === 'a.wav').durationMs, 2000);

  const empty = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: path.join(dirs.root, 'nope'), processed: dirs.processed }) });
  assert.deepEqual(empty.listFiles('unprocessed'), { ok: true, dirs: [], files: [], byDate: false });
  assert.equal(lib.listFiles('bogus').ok, false);
});

test('listFiles(processed) includes transcripts and analysis markdown', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  fs.writeFileSync(path.join(dirs.processed, 'm.wav'), makeWav(1));
  fs.writeFileSync(path.join(dirs.processed, 'm.json'), '{}');
  fs.writeFileSync(path.join(dirs.processed, 'm.md'), '# notes');
  assert.deepEqual(lib.listFiles('processed').files.map(f => f.name).sort(), ['m.json', 'm.md', 'm.wav']);
});

test('listFiles reports byDate from organizeByDate, processed only', () => {
  const dirs = tempDirs();
  const on = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }), organizeByDate: () => true });
  assert.equal(on.listFiles('processed').byDate, true);      // panel auto-opens the current YYYY/MM
  assert.equal(on.listFiles('unprocessed').byDate, false);   // unprocessed is always flat
  const off = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  assert.equal(off.listFiles('processed').byDate, false);
});

test('deleteFile removes only from unprocessed and only validated names', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  fs.writeFileSync(path.join(dirs.unprocessed, 'x.wav'), makeWav(1));
  fs.writeFileSync(path.join(dirs.processed, 'y.wav'), makeWav(1));

  assert.equal(lib.deleteFile('processed', 'y.wav').ok, false);   // archive is off-limits
  assert.equal(lib.deleteFile('unprocessed', '..\\y.wav').ok, false);
  assert.equal(lib.deleteFile('unprocessed', 'missing.wav').ok, false);
  assert.equal(lib.deleteFile('unprocessed', 'x.wav').ok, true);
  assert.equal(fs.existsSync(path.join(dirs.unprocessed, 'x.wav')), false);
  assert.equal(fs.existsSync(path.join(dirs.processed, 'y.wav')), true);
});

test('deleting a WAV also removes its Outlook meeting-info sidecar', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  fs.writeFileSync(path.join(dirs.unprocessed, 'm.wav'), makeWav(1));
  fs.writeFileSync(path.join(dirs.unprocessed, 'm.json'), '{"subject":"weekly"}');
  assert.equal(lib.deleteFile('unprocessed', 'm.wav').ok, true);
  assert.equal(fs.existsSync(path.join(dirs.unprocessed, 'm.json')), false);
});

test('resolvePath stays inside the folder', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  assert.equal(lib.resolvePath('unprocessed', 'ok.wav'), path.join(dirs.unprocessed, 'ok.wav'));
  assert.equal(lib.resolvePath('unprocessed', '..\\..\\config.json'), null);
  assert.equal(lib.resolvePath('nope', 'ok.wav'), null);
  // processed accepts the YYYY/MM layout; unprocessed stays flat
  assert.equal(lib.resolvePath('processed', '2026/08/m.json'), path.join(dirs.processed, '2026', '08', 'm.json'));
  assert.equal(lib.resolvePath('unprocessed', '2026/08/m.wav'), null);
  assert.equal(lib.resolvePath('processed', '../08/m.json'), null);
});

test('safeRelPath allows up to 3 folder levels (details layout) but nothing sneaky', () => {
  assert.equal(safeRelPath('2026/08/m.json'), '2026/08/m.json');
  assert.equal(safeRelPath('2026/Weekly-Sync/details/m.json'), '2026/Weekly-Sync/details/m.json');
  assert.equal(safeRelPath('m.json'), 'm.json');
  for (const bad of ['../m.json', '2026/../m.json', 'a/b/c/d/e.json', '2026\\08\\m.json', '2026/08/m.exe', '2026//m.json']) {
    assert.equal(safeRelPath(bad), null, 'should reject: ' + bad);
  }
});

test('listFiles flags transcripts analyzed, including the details layout (md one level up)', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  const home = path.join(dirs.processed, '2026', 'Weekly');
  fs.mkdirSync(path.join(home, 'details'), { recursive: true });
  fs.writeFileSync(path.join(home, 'details', 'a-diarizer-response.json'), '{}');
  fs.writeFileSync(path.join(home, 'a-analysis.md'), '# notes');                  // md at folder level
  fs.writeFileSync(path.join(home, 'details', 'b-diarizer-response.json'), '{}'); // no md anywhere
  const r = lib.listFiles('processed', '2026/Weekly/details');
  const byName = {};
  r.files.forEach(f => { byName[f.name.split('/').pop()] = f; });
  assert.equal(byName['a-diarizer-response.json'].analyzed, true);
  assert.equal(byName['b-diarizer-response.json'].analyzed, false);
});

test('listFiles(processed) shows one folder at a time with navigable subdirs', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  fs.mkdirSync(path.join(dirs.processed, '2026', '08'), { recursive: true });
  fs.mkdirSync(path.join(dirs.processed, '.archive'));
  fs.writeFileSync(path.join(dirs.processed, '2026', '08', 'm.json'), '{}');
  fs.writeFileSync(path.join(dirs.processed, '2026', '08', 'm-analysis.md'), '# x');
  fs.writeFileSync(path.join(dirs.processed, 'legacy.json'), '{}');

  const root = lib.listFiles('processed');
  assert.deepEqual(root.dirs, ['2026']);                                       // dot-folders hidden, no recursion
  assert.deepEqual(root.files.map(f => f.name), ['legacy.json']);
  const y = lib.listFiles('processed', '2026');
  assert.deepEqual(y.dirs, ['08']);
  assert.deepEqual(y.files, []);
  const m = lib.listFiles('processed', '2026/08');
  assert.deepEqual(m.dirs, []);                                                // depth limit: no deeper navigation
  assert.deepEqual(m.files.map(f => f.name).sort(), ['2026/08/m-analysis.md', '2026/08/m.json']);

  assert.equal(lib.listFiles('processed', '../x').ok, false);                  // traversal rejected
  assert.equal(lib.listFiles('processed', 'a/b/c/d').ok, false);               // too deep (3 dirs max)
  // unprocessed stays flat: dir param ignored, subfolders invisible
  fs.mkdirSync(path.join(dirs.unprocessed, 'sub'));
  fs.writeFileSync(path.join(dirs.unprocessed, 'sub', 'x.wav'), makeWav(1));
  assert.deepEqual(lib.listFiles('unprocessed', 'sub'), { ok: true, dirs: [], files: [], byDate: false });
});

test('logical meetings deduplicate new/legacy names, use status and resolve details sources without sweeping', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => dirs });
  fs.mkdirSync(path.join(dirs.processed, 'details'));
  fs.mkdirSync(path.join(dirs.processed, '_system'));
  const note = (base, status) => fs.writeFileSync(path.join(dirs.processed, base + '.md'), '---\n' + serializeFrontmatter({
    title: base, type: 'meeting', date: '2026-10-15T10:00:00Z', duration: '1m', status,
  }) + '---\n## Transcript\nWords');
  note('done', 'complete'); note('todo', 'processing');
  fs.writeFileSync(path.join(dirs.processed, 'done-analysis.md'), '# old');
  fs.writeFileSync(path.join(dirs.processed, 'legacy-analysis.md'), '# legacy complete');
  fs.writeFileSync(path.join(dirs.processed, 'done.rev1.md'), '# backup');
  fs.writeFileSync(path.join(dirs.processed, 'done.proposed.md'), '# proposed');
  fs.writeFileSync(path.join(dirs.processed, 'details', 'todo-diarizer-response.json'), '{"segments":[]}');
  fs.writeFileSync(path.join(dirs.processed, 'details', 'hidden.md'), '# not a meeting');
  fs.writeFileSync(path.join(dirs.processed, 'orphan-diarizer-response.json'), '{"segments":[]}');
  fs.writeFileSync(path.join(dirs.processed, 'm.capture.json'), '{}');
  const result = lib.listFiles('processed');
  assert.equal(result.files.some(f => /capture/.test(f.name)), false);
  assert.deepEqual(result.meetings.map(f => f.name).sort(), ['done.md', 'legacy-analysis.md', 'orphan-diarizer-response.json', 'todo.md']);
  const todo = result.meetings.find(f => f.base === 'todo');
  assert.equal(todo.analyzed, false); assert.equal(todo.jsonName, 'details/todo-diarizer-response.json');
  assert.equal(result.meetings.find(f => f.base === 'done').analyzed, true);
  assert.equal(result.meetings.find(f => f.base === 'legacy').legacy, true);
  assert.equal(lib.listMeetings().dirs.includes('details'), false);
  assert.deepEqual(lib.listFiles('processed', 'details').meetings, []);
});

test('unsupported frontmatter is visible read-only and capture metadata is excluded/deleted with recording', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => dirs });
  fs.writeFileSync(path.join(dirs.processed, 'edited.md'), '---\ntitle: |\n  multiline\n---\n## Summary\nEdit');
  const row = lib.listMeetings().files[0];
  assert.equal(row.readOnly, true); assert.equal(row.analyzed, true); assert.equal(row.status, 'unreadable-frontmatter');
  fs.writeFileSync(path.join(dirs.unprocessed, 'm.wav'), 'WAV');
  fs.writeFileSync(path.join(dirs.unprocessed, 'm.capture.json'), '{}');
  assert.deepEqual(lib.listFiles('unprocessed').files.map(f => f.name), ['m.wav']);
  assert.equal(lib.deleteFile('unprocessed', 'm.wav').ok, true);
  assert.equal(fs.existsSync(path.join(dirs.unprocessed, 'm.capture.json')), false);
});

test('meeting source resolution and browsing refuse a junction outside the chosen root', t => {
  const dirs = tempDirs();
  const outside = path.join(dirs.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret-diarizer-response.json'), '{"segments":[]}');
  try { fs.symlinkSync(outside, path.join(dirs.processed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) { t.skip('junction unavailable'); return; } throw e; }
  const lib = createMeetingLibrary({ resolveFolders: () => dirs });
  assert.equal(lib.resolvePath('processed', 'escape/secret-diarizer-response.json'), null);
  assert.equal(lib.listFiles('processed', 'escape').ok, false);
  assert.equal(lib.listFiles('processed').dirs.includes('escape'), false);
});
