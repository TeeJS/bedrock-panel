'use strict';
// Note style (Settings → Meeting → Advanced settings → Note style): Classic writes meetings exactly
// as 0.9.9 did and keeps 1.0.0's protections in <base>.bedrock.json; Minutes Compatible is the
// one-file format. Update defaults, the 0.9.9 golden comparison, hand-edit proposals and Apply,
// damaged records, style switches, exports, the Completed list, and the transcribed flow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, PassThrough } = require('node:stream');
const { createMeetingAnalyzer } = require('../app/meetingAnalyze');
const { createMeetingLibrary } = require('../app/meetingLibrary');
const { readFrontmatter } = require('../app/meetingFrontmatter');
const { migrateNoteStyle, filingOptionsFor, readRecord } = require('../app/meetingRecord');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'app', name), 'utf8');

// 0.9.9's writer, verbatim from c0f45d8 app/meetingAnalyze.js:233-245 (the split) and :246-248 (the
// write), reduced to the bytes it produced: the analysis .md and, with Separate Clean Transcript
// on, the clean transcript. The Classic writer must produce exactly these for the same AI text.
function writer099(markdown, separateTranscript) {
  let mdOut = markdown;
  let txt = null;
  if (separateTranscript) {
    const m = /^##\s*Transcript\s*$/im.exec(markdown);
    if (m) {
      mdOut = markdown.slice(0, m.index).trimEnd() + '\n';
      txt = markdown.slice(m.index + m[0].length).trim() + '\n';
    }
  }
  return { md: mdOut, txt };
}

function fakeSpawn(spawns, behavior) {
  return (cmd, args) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
    proc.kill = () => {};
    const rec = { args, stdin: '' };
    proc.stdin.on('data', d => { rec.stdin += d; });
    spawns.push(rec);
    setImmediate(() => { const b = behavior(); proc.stdout.write(b.stdout || ''); proc.stdout.end(); proc.stderr.end(); proc.emit('close', b.code === undefined ? 0 : b.code); });
    return proc;
  };
}
function drained(an) { return new Promise(r => { const t = setInterval(() => { const s = an.getState(); if (!s.running && !s.queue.length) { clearInterval(t); setTimeout(r, 30); } }, 10); }); }

const SEGMENTS = [
  { speaker: 'T.J. Schmitz', start: 0, end: 4, text: 'good morning everyone welcome to the weekly review' },
  { speaker: 'Speaker A', start: 4.5, end: 9, text: 'thanks lets start with the audit items' },
];
const TAIL = [
  '', '<!-- BEDROCK-STRUCTURED v1 -->',
  'KEY POINTS:', '- Audit on track', '',
  'DECISIONS:', '- HANA approved by the board', '',
  'ACTION ITEMS:', '- @Carl Tanner: Send the policy to Brad (by Friday)', '',
  'OPEN QUESTIONS:', '- (none)', '',
  'COMMITMENTS:', '- (none)', '',
  'PARTICIPANTS:', '- T.J. Schmitz', '- Carl Tanner', '',
  'SPEAKER MAP:', '- Speaker A -> Carl Tanner (direct address)', '',
  'TURNS:', '- 1: segments 0-0', '- 2: segments 1-1',
  '<!-- /BEDROCK-STRUCTURED -->', '',
].join('\n');
// What the AI writes under the 0.9.9 prompt (no structured block): "**Name:**" transcript turns.
function notes099(summary) {
  return '# Meeting Analysis\n\n## Summary\n' + summary + '\n\n## Attendees\nT.J. Schmitz\nCarl Tanner\n\n'
    + '## Decisions\n- HANA approved by the board\n\n## Action Items\n- Carl Tanner: Send the policy to Brad\n\n'
    + '## Transcript\n**T.J. Schmitz:** Good morning everyone, welcome to the weekly review.\n'
    + '**Carl Tanner:** Thanks, let\'s start with the audit items.\n';
}
const reply = summary => notes099(summary) + TAIL;   // the same text plus the block 1.0.0 asks for

const BASE = '2026-10-14-15-57-16-G1 Weekly Review';
function setup(outputs, filing, extra) {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-style-'));
  fs.writeFileSync(path.join(processed, BASE + '-diarizer-response.json'), JSON.stringify({ segments: SEGMENTS, speaker_report: { speakers: [{ label: 'T.J. Schmitz', identified: true }] } }));
  fs.writeFileSync(path.join(processed, BASE + '.json'), JSON.stringify({ subject: 'G1 Weekly Review', start: '2026-10-14T22:00:00+00:00', required_attendees: ['Carl Tanner', 'T.J. Schmitz'], optional_attendees: [] }));
  fs.writeFileSync(path.join(processed, BASE + '.wav'), Buffer.alloc(64));
  let i = 0;
  const spawns = [];
  let opts = Object.assign({ noteStyle: 'classic', useDetailsFolder: true }, filing || {});
  const an = createMeetingAnalyzer(Object.assign({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'claude',
    findClaudeExe: () => 'claude.exe', findCodexExe: () => null,
    spawn: fakeSpawn(spawns, () => ({ stdout: outputs[Math.min(i++, outputs.length - 1)], code: 0 })),
    filingOptions: () => opts,
    resolveMyName: () => 'T.J. Schmitz',
  }, extra || {}));
  const classicMd = path.join(processed, BASE + '-analysis.md');
  return { processed, an, spawns, classicMd, minutesMd: path.join(processed, BASE + '.md'), json: BASE + '-diarizer-response.json',
    setFiling: o => { opts = Object.assign({}, opts, o); }, rel: p => path.relative(processed, p).split(path.sep).join('/') };
}
async function analyze(s, name) {
  const r = s.an.start(name || s.json);
  assert.equal(r.ok, true, JSON.stringify(r));
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
}
const jsonIn = (s, rel) => fs.existsSync(path.join(s.processed, rel)) ? rel : null;
const transcriptRel = s => jsonIn(s, 'details/' + s.json) || s.json;

// ---- settings: update defaults and filing options ----

test('a config from before the setting gets Classic; the new-install seed keeps Minutes Compatible', () => {
  assert.equal(migrateNoteStyle({}).settings.meeting.noteStyle, 'classic');
  const old = migrateNoteStyle({ settings: { meeting: { folder: 'D:\\Rec', separateTranscript: true } } });
  assert.deepEqual(old.settings.meeting, { folder: 'D:\\Rec', separateTranscript: true, noteStyle: 'classic' });
  assert.equal(migrateNoteStyle({ settings: { meeting: { noteStyle: 'minutes' } } }).settings.meeting.noteStyle, 'minutes');
  for (const seedFile of ['config.default.json', 'config.default.mac.json', 'config.default.linux.json']) {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', seedFile), 'utf8'));
    assert.equal(migrateNoteStyle(seed).settings.meeting.noteStyle, 'minutes', seedFile);
  }
  // main runs the migration on every load, and its runtime fallback (no value at all) is Classic too.
  const main = read('main.js');
  const migration = main.slice(main.indexOf('function migrateConfig'), main.indexOf('function ensureSystemViewPage'));
  assert.match(migration, /migrateNoteStyle\(c\)/);
  assert.match(main, /const MEETING_DEFAULTS = \{[^\n]*noteStyle: 'classic'/);
  assert.match(main, /filingOptions: \(\) => require\('\.\/meetingRecord'\)\.filingOptionsFor\(meetingSettings\(\)\)/);
  assert.match(read('config.js'), /noteStyle: 'classic', separateTranscript: false, useDetailsFolder: false/);
});

test('Classic honours Separate Clean Transcript and Use Details Folder; Minutes Compatible files one way', () => {
  assert.deepEqual(filingOptionsFor({ noteStyle: 'classic', separateTranscript: true, useDetailsFolder: false, separateRecurring: true }),
    { separateRecurring: true, byDate: false, noteStyle: 'classic', separateTranscript: true, useDetailsFolder: false });
  assert.deepEqual(filingOptionsFor({ noteStyle: 'minutes', separateTranscript: true, useDetailsFolder: false, processedByDate: true }),
    { separateRecurring: false, byDate: true, noteStyle: 'minutes', separateTranscript: false, useDetailsFolder: true });
  assert.equal(filingOptionsFor({}).noteStyle, 'classic');
});

test('Settings → Meeting → Advanced settings carries Note style and the two Classic options', () => {
  const src = read('config.js');
  assert.match(src, /<select id="meNoteStyle"[^>]*><option value="classic"[^>]*>Classic<\/option><option value="minutes"[^>]*>Minutes Compatible<\/option>/);
  assert.match(src, /id="meSepTx"[^\n]*Separate Clean Transcript/);
  assert.match(src, /id="meDetails"[^\n]*Use Details Folder/);
  assert.match(src, /saveMe\(\{ noteStyle: e\.target\.value === 'minutes' \? 'minutes' : 'classic' \}\)/);
  assert.match(src, /getElementById\('meSepTx'\)\.onchange = e => saveMe\(\{ separateTranscript: e\.target\.checked \}\)/);
  assert.match(src, /getElementById\('meDetails'\)\.onchange = e => saveMe\(\{ useDetailsFolder: e\.target\.checked \}\)/);
});

// ---- Classic matches 0.9.9 ----

for (const split of [false, true]) {
  for (const details of [true, false]) {
    test('Classic writes 0.9.9\'s bytes (Separate Clean Transcript ' + (split ? 'on' : 'off') + ', Use Details Folder ' + (details ? 'on' : 'off') + ')', async () => {
      const s = setup([reply('First pass.')], { separateTranscript: split, useDetailsFolder: details });
      await analyze(s);
      const want = writer099(notes099('First pass.'), split);
      assert.equal(fs.readFileSync(s.classicMd, 'utf8'), want.md);
      assert.equal(fs.existsSync(s.minutesMd), false);
      const side = details ? path.join(s.processed, 'details') : s.processed;
      const txt = path.join(side, BASE + '-clean_transcript.txt');
      if (split) assert.equal(fs.readFileSync(txt, 'utf8'), want.txt);
      else assert.equal(fs.existsSync(txt), false);
      // The sources file as 0.9.9 filed them: into details\ only with Use Details Folder on.
      assert.equal(fs.existsSync(path.join(side, BASE + '.wav')), true);
      assert.equal(fs.existsSync(path.join(side, s.json)), true);
      if (details) assert.equal(fs.existsSync(path.join(s.processed, BASE + '.wav')), false);
      else assert.equal(fs.existsSync(path.join(s.processed, 'details')), false);
      // The record sits beside the sources and names this note.
      const rec = JSON.parse(fs.readFileSync(path.join(side, BASE + '.bedrock.json'), 'utf8'));
      assert.equal(rec.note, BASE + '-analysis.md');
      assert.equal(rec.data.bedrock.note_style, 'classic');
      assert.deepEqual(rec.data.action_items.map(a => [a.assignee, a.task, a.due]), [['Carl Tanner', 'Send the policy to Brad', 'Friday']]);
      assert.equal(rec.data.bedrock.revision, 1);
    });
  }
}

test('Classic asks for the structured block but not the [Name m:ss] transcript lines; Minutes asks for both', async () => {
  const c = setup([reply('x')]);
  await analyze(c);
  assert.match(c.spawns[0].stdin, /<!-- BEDROCK-STRUCTURED v1 -->/);
  assert.doesNotMatch(c.spawns[0].stdin, /Transcript lines: write each turn/);
  assert.match(c.spawns[0].stdin, /overrides only one earlier rule: "nothing after these sections"/);
  const m = setup([reply('x')], { noteStyle: 'minutes' });
  await analyze(m);
  assert.match(m.spawns[0].stdin, /Transcript lines: write each turn as "\[Name m:ss\] text"/);
  assert.equal(fs.existsSync(m.minutesMd), true);
  assert.equal(readFrontmatter(fs.readFileSync(m.minutesMd, 'utf8')).ok, true);
});

test('a filing caller that names no style still gets Minutes Compatible (the analyzer default)', async () => {
  const s = setup([reply('x')], { noteStyle: undefined });
  await analyze(s);
  assert.equal(fs.existsSync(s.minutesMd), true);
  assert.equal(fs.existsSync(s.classicMd), false);
});

// ---- re-analysis, hand edits, Apply ----

test('Classic re-analysis without edits replaces the note in place and keeps the previous as a revision', async () => {
  const s = setup([reply('First pass.'), reply('Second pass.')], { separateTranscript: true });
  await analyze(s);
  const first = fs.readFileSync(s.classicMd, 'utf8');
  const id = readRecord(fs, s.classicMd).data.bedrock.meeting_id;
  await analyze(s, transcriptRel(s));
  assert.equal(fs.readFileSync(s.classicMd, 'utf8'), writer099(notes099('Second pass.'), true).md);
  assert.equal(fs.readFileSync(path.join(s.processed, 'details', BASE + '.rev1.md'), 'utf8'), first);
  assert.equal(fs.existsSync(path.join(s.processed, 'details', BASE + '-clean_transcript.rev1.txt')), true);
  const r = readRecord(fs, s.classicMd);
  assert.equal(r.ok, true);
  assert.equal(r.data.bedrock.revision, 2);
  assert.equal(r.data.bedrock.meeting_id, id);
});

test('a hand edit to a Classic note saves the re-analysis for review; Apply writes exactly what a direct publish would', async () => {
  for (const details of [true, false]) {
    const s = setup([reply('First pass.'), reply('Second pass.')], { separateTranscript: true, useDetailsFolder: details });
    await analyze(s);
    const edited = fs.readFileSync(s.classicMd, 'utf8').replace('First pass.', 'First pass, edited by hand.');
    fs.writeFileSync(s.classicMd, edited);
    await analyze(s, transcriptRel(s));
    assert.equal(fs.readFileSync(s.classicMd, 'utf8'), edited);                       // the live note is kept
    assert.equal(s.an.getState().proposed.name, BASE);
    const lib = createMeetingLibrary({ resolveFolders: () => ({ processed: s.processed }) });
    assert.equal(lib.listMeetings().files.find(f => f.base === BASE).proposed, true);
    const view = s.an.result(path.basename(s.classicMd), true);
    assert.equal(view.ok, true);
    const applied = await s.an.applyProposed(path.basename(s.classicMd));
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const want = writer099(notes099('Second pass.'), true);
    assert.equal(fs.readFileSync(s.classicMd, 'utf8'), want.md);                      // no header, same bytes as a direct publish
    const side = details ? path.join(s.processed, 'details') : s.processed;
    assert.equal(fs.readFileSync(path.join(side, BASE + '-clean_transcript.txt'), 'utf8'), want.txt);
    assert.equal(fs.readFileSync(path.join(side, BASE + '.rev1.md'), 'utf8'), edited);   // the edited note is a revision
    assert.equal(fs.existsSync(path.join(side, BASE + '.proposed.md')), false);
    assert.equal(fs.existsSync(path.join(side, BASE + '.proposed-clean_transcript.txt')), false);
    assert.equal(readRecord(fs, s.classicMd).data.bedrock.revision, 2);
  }
});

test('a Classic note with no usable record is never overwritten: 0.9.9 file, corrupt, foreign, or two records', async () => {
  const cases = {
    'no record (a 0.9.9 analysis)': () => {},
    corrupt: s => fs.writeFileSync(path.join(s.processed, 'details', BASE + '.bedrock.json'), '{ not json'),
    'names another note': s => fs.writeFileSync(path.join(s.processed, 'details', BASE + '.bedrock.json'), JSON.stringify({ schema: 1, note: 'other-analysis.md', data: {} })),
    'two records': s => {
      const good = fs.readFileSync(path.join(s.processed, 'details', BASE + '.bedrock.json'));
      fs.writeFileSync(path.join(s.processed, BASE + '.bedrock.json'), good);
    },
  };
  for (const [label, damage] of Object.entries(cases)) {
    const s = setup([reply('First pass.'), reply('Second pass.')]);
    if (label === 'no record (a 0.9.9 analysis)') {
      fs.writeFileSync(s.classicMd, notes099('Written by 0.9.9.'));
    } else {
      await analyze(s);
      damage(s);
    }
    const before = fs.readFileSync(s.classicMd, 'utf8');
    await analyze(s, transcriptRel(s));
    assert.equal(fs.readFileSync(s.classicMd, 'utf8'), before, label);
    assert.equal(s.an.getState().proposed && s.an.getState().proposed.name, BASE, label);
  }
});

// ---- style switches ----

test('Classic to Minutes Compatible: the next analysis writes the header file and carries the record', async () => {
  const s = setup([reply('First pass.'), reply('Second pass.')]);
  await analyze(s);
  const id = readRecord(fs, s.classicMd).data.bedrock.meeting_id;
  s.setFiling({ noteStyle: 'minutes', useDetailsFolder: true });
  assert.equal(fs.existsSync(s.classicMd), true);                                     // the setting alone changes nothing
  await analyze(s, transcriptRel(s));
  const fm = readFrontmatter(fs.readFileSync(s.minutesMd, 'utf8'));
  assert.equal(fm.ok, true);
  assert.equal(fm.data.bedrock.meeting_id, id);
  assert.equal(fm.data.bedrock.revision, 2);
  assert.equal(fs.existsSync(s.classicMd), false);
  assert.equal(fs.existsSync(path.join(s.processed, 'details', BASE + '.rev1.md')), true);
  assert.equal(fs.existsSync(path.join(s.processed, 'details', BASE + '.bedrock.json')), false);
  assert.equal(fs.existsSync(path.join(s.processed, 'details', BASE + '.rev1.bedrock.json')), true);
});

test('Minutes Compatible to Classic: the next analysis writes -analysis.md plus its record and keeps the identity', async () => {
  const s = setup([reply('First pass.'), reply('Second pass.')], { noteStyle: 'minutes', useDetailsFolder: true });
  await analyze(s);
  const id = readFrontmatter(fs.readFileSync(s.minutesMd, 'utf8')).data.bedrock.meeting_id;
  s.setFiling({ noteStyle: 'classic', useDetailsFolder: true });
  await analyze(s, transcriptRel(s));
  assert.equal(fs.readFileSync(s.classicMd, 'utf8'), notes099('Second pass.'));
  assert.equal(fs.existsSync(s.minutesMd), false);
  const r = readRecord(fs, s.classicMd);
  assert.equal(r.ok, true);
  assert.equal(r.data.bedrock.meeting_id, id);
  assert.equal(r.data.bedrock.revision, 2);
});

test('an edited Minutes note re-analyzed under Classic (Use Details Folder off) shows Review new and applies as Classic', async () => {
  const s = setup([reply('First pass.'), reply('Second pass.')], { noteStyle: 'minutes', useDetailsFolder: true });
  await analyze(s);
  fs.writeFileSync(s.minutesMd, fs.readFileSync(s.minutesMd, 'utf8').replace('First pass.', 'Edited.'));
  s.setFiling({ noteStyle: 'classic', useDetailsFolder: false });
  await analyze(s, transcriptRel(s));
  assert.equal(fs.existsSync(path.join(s.processed, 'details', BASE + '.proposed.md')), true);
  const lib = createMeetingLibrary({ resolveFolders: () => ({ processed: s.processed }) });
  assert.equal(lib.listMeetings().files.find(f => f.base === BASE).proposed, true);
  const applied = await s.an.applyProposed(path.basename(s.minutesMd));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(fs.readFileSync(s.classicMd, 'utf8'), notes099('Second pass.'));
  assert.equal(fs.existsSync(s.minutesMd), false);
  assert.equal(readRecord(fs, s.classicMd).ok, true);
});

test('flipping Use Details Folder between analyses moves the record and never leaves two', async () => {
  const s = setup([reply('First pass.'), reply('Second pass.')], { useDetailsFolder: false });
  await analyze(s);
  assert.equal(fs.existsSync(path.join(s.processed, BASE + '.bedrock.json')), true);
  s.setFiling({ useDetailsFolder: true });
  await analyze(s, transcriptRel(s));
  assert.equal(fs.existsSync(path.join(s.processed, 'details', BASE + '.bedrock.json')), true);
  assert.equal(fs.existsSync(path.join(s.processed, BASE + '.bedrock.json')), false);
  assert.equal(readRecord(fs, s.classicMd).ok, true);
});

// ---- exports and the task list ----

test('Classic exports: Joplin gets the note once, Obsidian gets <name>-analysis.md and never the record', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-vault-'));
  const calls = [];
  const joplinNotes = {
    tagsFor: () => [],
    getNote: async () => null,
    createAnalysisNote: async o => { calls.push(o); return { id: o.id, applied: [], skipped: [] }; },
  };
  const s = setup([reply('First pass.'), reply('Second pass.')], {}, {
    joplinNotes, resolveJoplin: () => ({ enabled: true, url: 'http://j', token: 't', notebook: 'n' }),
    resolveObsidian: () => ({ enabled: true, vault }),
  });
  await analyze(s);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, notes099('First pass.'));                              // the note itself, no header
  const vaultCopy = path.join(vault, BASE + '-analysis.md');
  assert.equal(fs.readFileSync(vaultCopy, 'utf8'), notes099('First pass.'));
  assert.deepEqual(fs.readdirSync(vault).filter(f => /bedrock\.json$/.test(f)), []);
  const exp = readRecord(fs, s.classicMd).data.bedrock.exports;
  assert.equal(exp.joplin.state, 'succeeded');
  assert.equal(exp.obsidian.state, 'succeeded');
  // Edited in the vault: the re-analysis lands beside it, and Joplin is not exported twice.
  fs.writeFileSync(vaultCopy, 'edited in Obsidian');
  await analyze(s, transcriptRel(s));
  assert.equal(calls.length, 1);
  assert.equal(fs.readFileSync(vaultCopy, 'utf8'), 'edited in Obsidian');
  assert.equal(fs.existsSync(path.join(vault, BASE + '-analysis.conflict.md')), true);
});

test('Classic task list: listed once, recorded in the tracking file', async () => {
  const tasks = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-tasks-'));
  const s = setup([reply('First pass.'), reply('Second pass.')], {}, { resolveTaskList: () => ({ enabled: true, folder: tasks }) });
  await analyze(s);
  const lists = fs.readdirSync(tasks);
  assert.equal(lists.length, 1);
  assert.match(fs.readFileSync(path.join(tasks, lists[0]), 'utf8'), /-analysis\.md`/);
  assert.equal(readRecord(fs, s.classicMd).data.bedrock.exports.task_list.state, 'succeeded');
  await analyze(s, transcriptRel(s));
  assert.equal(fs.readdirSync(tasks).length, 1);
});

// ---- the Completed list ----

test('Completed shows a tracked Classic note like a Minutes note; an untracked one as pre-format', async () => {
  const s = setup([reply('First pass.')]);
  await analyze(s);
  fs.writeFileSync(path.join(s.processed, 'old-sync-analysis.md'), notes099('From 0.9.9.'));
  const lib = createMeetingLibrary({ resolveFolders: () => ({ processed: s.processed }) });
  const rows = lib.listMeetings().files;
  const tracked = rows.find(f => f.base === BASE);
  assert.deepEqual([tracked.analyzed, tracked.legacy, tracked.readOnly, tracked.status, tracked.proposed], [true, false, false, 'complete', false]);
  const old = rows.find(f => f.base === 'old-sync');
  assert.deepEqual([old.legacy, old.readOnly], [true, false]);
});

// ---- from Transcribed Recordings ----

test('Classic from Transcribed Recordings with Use Details Folder off files the sources beside the note', async () => {
  const transcribed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-tr-'));
  const completed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-done-'));
  fs.writeFileSync(path.join(transcribed, BASE + '-diarizer-response.json'), JSON.stringify({ segments: SEGMENTS }));
  fs.writeFileSync(path.join(transcribed, BASE + '.wav'), Buffer.alloc(64));
  fs.writeFileSync(path.join(transcribed, BASE + '.json'), JSON.stringify({ subject: 'G1 Weekly Review', start: '2026-10-14T22:00:00+00:00' }));
  const spawns = [];
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: transcribed, transcribed, processed: completed }),
    resolveAi: () => 'claude', findClaudeExe: () => 'claude.exe', findCodexExe: () => null,
    spawn: fakeSpawn(spawns, () => ({ stdout: reply('From the waiting room.'), code: 0 })),
    filingOptions: () => ({ noteStyle: 'classic', useDetailsFolder: false, separateTranscript: true }),
  });
  assert.equal(an.start(BASE + '-diarizer-response.json', 'transcribed').ok, true);
  await drained(an);
  assert.equal(an.getState().error, null);
  const want = writer099(notes099('From the waiting room.'), true);
  assert.equal(fs.readFileSync(path.join(completed, BASE + '-analysis.md'), 'utf8'), want.md);
  assert.equal(fs.readFileSync(path.join(completed, BASE + '-clean_transcript.txt'), 'utf8'), want.txt);
  for (const leaf of [BASE + '.wav', BASE + '.json', BASE + '-diarizer-response.json', BASE + '.bedrock.json']) {
    assert.equal(fs.existsSync(path.join(completed, leaf)), true, leaf);
  }
  assert.equal(fs.existsSync(path.join(completed, 'details')), false);
  assert.deepEqual(fs.readdirSync(transcribed), []);
});
