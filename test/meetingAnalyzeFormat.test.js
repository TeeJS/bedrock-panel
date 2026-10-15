'use strict';
// The one-file meeting format end to end through the analyzer: structured tail → frontmatter,
// ownership and revisions on re-analysis, stale-write refusal, legacy files never overwritten,
// and the Joplin export's persisted pending→succeeded state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, PassThrough } = require('node:stream');
const { createMeetingAnalyzer } = require('../app/meetingAnalyze');
const { readFrontmatter } = require('../app/meetingFrontmatter');

function fakeSpawn(behavior) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
    proc.kill = () => {};
    proc.stdin.on('data', () => {});
    setImmediate(() => { const b = behavior(); proc.stdout.write(b.stdout || ''); proc.stdout.end(); proc.stderr.end(); proc.emit('close', b.code === undefined ? 0 : b.code); });
    return proc;
  };
}
function drained(an) { return new Promise(r => { const t = setInterval(() => { const s = an.getState(); if (!s.running && !s.queue.length) { clearInterval(t); r(); } }, 10); }); }

const SEGMENTS = [
  { speaker: 'T.J. Schmitz', start: 0, end: 4, text: 'good morning everyone welcome to the weekly review' },
  { speaker: 'Speaker A', start: 4.5, end: 9, text: 'thanks lets start with the audit items' },
];
const TAIL = [
  '', '<!-- BEDROCK-STRUCTURED v1 -->',
  'KEY POINTS:', '- Audit on track', '',
  'DECISIONS:', '- HANA approved by the board', '',
  'ACTION ITEMS:', '- @Carl Tanner: Send the policy to Brad (by Friday)', '- Confirm there are no other versions', '',
  'OPEN QUESTIONS:', '- (none)', '',
  'COMMITMENTS:', '- (none)', '',
  'PARTICIPANTS:', '- T.J. Schmitz', '- Carl Tanner', '',
  'SPEAKER MAP:', '- Speaker A -> Carl Tanner (direct address)', '',
  'TURNS:', '- 1: segments 0-0', '- 2: segments 1-1',
  '<!-- /BEDROCK-STRUCTURED -->', '',
].join('\n');
function output(summary) {
  return '# Meeting Analysis\n## Summary\n' + summary + '\n## Transcript\n'
    + '[T.J. Schmitz 0:00] Good morning everyone, welcome to the weekly review.\n'
    + '[Carl Tanner 0:04] Thanks, let\'s start with the audit items.\n' + TAIL;
}

function setup(outputs, extra) {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-fmt-'));
  const base = '2026-10-14-15-57-16-G1 Weekly Review';
  fs.writeFileSync(path.join(processed, base + '-diarizer-response.json'), JSON.stringify({ segments: SEGMENTS, speaker_report: { speakers: [{ label: 'T.J. Schmitz', identified: true }] } }));
  fs.writeFileSync(path.join(processed, base + '.json'), JSON.stringify({ subject: 'G1 Weekly Review', start: '2026-10-14T22:00:00+00:00', required_attendees: ['Carl Tanner', 'T.J. Schmitz'], optional_attendees: [] }));
  fs.writeFileSync(path.join(processed, base + '.capture.json'), JSON.stringify({ schema: 1, started_at: '2026-10-14T15:57:16-07:00', tz: 'America/Los_Angeles', device: 'Mic' }));
  let i = 0;
  const an = createMeetingAnalyzer(Object.assign({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'claude',
    findClaudeExe: () => 'claude.exe', findCodexExe: () => null,
    spawn: fakeSpawn(() => ({ stdout: outputs[Math.min(i++, outputs.length - 1)], code: 0 })),
    filingOptions: () => ({ useDetailsFolder: true }),
    resolveMyName: () => 'T.J. Schmitz',
  }, extra || {}));
  return { processed, base, an, md: path.join(processed, base + '.md'), json: base + '-diarizer-response.json' };
}

test('structured tail becomes validated frontmatter; prose and transcript stay; times come from cited segments', async () => {
  const s = setup([output('First pass.')]);
  assert.equal(s.an.start(s.json).ok, true);
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
  const text = fs.readFileSync(s.md, 'utf8');
  const fm = readFrontmatter(text);
  assert.equal(fm.ok, true);
  assert.equal(fm.data.title, 'G1 Weekly Review');
  assert.equal(fm.data.type, 'meeting');
  assert.equal(fm.data.date, '2026-10-14T15:57:16-07:00');            // capture sidecar, not the calendar start
  assert.equal(fm.data.status, 'complete');
  assert.equal(fm.data.recorded_by, 't-j-schmitz');
  assert.deepEqual(fm.data.action_items.map(a => [a.assignee, a.task, a.status, a.due]), [['Carl Tanner', 'Send the policy to Brad', 'open', 'Friday']]);
  assert.equal(fm.data.intents.length, 1);                              // the owner-less item is an intent, no invented assignee
  assert.equal(fm.data.intents[0].kind, 'action-item');
  assert.equal(fm.data.intents[0].who, undefined);
  assert.equal(fm.data.decisions[0].text, 'HANA approved by the board');
  assert.ok(fm.data.action_items.every(a => /^ai-/.test(a.id)) && fm.data.decisions.every(d => /^dc-/.test(d.id)));
  const map = Object.fromEntries(fm.data.speaker_map.map(m => [m.speaker_label, m]));
  assert.equal(map['Speaker A'].source, 'llm');
  assert.equal(map['Speaker A'].confidence, 'medium');
  assert.equal(map['T.J. Schmitz'].source, 'enrollment');
  assert.equal(fm.data.bedrock.revision, 1);
  assert.match(fm.data.bedrock.meeting_id, /^mt-/);
  assert.equal(fm.data.bedrock.extraction, 'ok');
  assert.equal(fm.data.bedrock.evidence, 'full');
  assert.equal(fm.data.bedrock.duration_source, 'diarizer');           // no wav in this fixture
  assert.match(fm.data.bedrock.input_hash, /^sha256:/);
  assert.deepEqual(fm.data.bedrock.ai_sections, ['Summary', 'Transcript']);
  assert.match(fm.body, /## Summary\nFirst pass\./);
  assert.match(fm.body, /\[Carl Tanner 0:04\] Thanks/);
  assert.doesNotMatch(fm.body, /BEDROCK-STRUCTURED/);                  // tail stripped from the human body
  assert.doesNotMatch(text, /\r/);
  // sources filed into details/, the .md at the folder level
  assert.equal(fs.existsSync(path.join(s.processed, 'details', s.base + '.capture.json')), true);
  assert.equal(fs.existsSync(path.join(s.processed, 'details', s.json)), true);
});

test('a malformed, notes-only reply keeps the prose, marks extraction malformed, and still carries the full transcript from the diarizer', async () => {
  const s = setup(['# Meeting Analysis\n## Summary\nno tail at all\n## Action Items\n- Carl: do the thing\n']);
  s.an.start(s.json);
  await drained(s.an);
  const fm = readFrontmatter(fs.readFileSync(s.md, 'utf8'));
  assert.equal(fm.ok, true);
  assert.equal(fm.data.bedrock.extraction, 'malformed');
  assert.deepEqual(fm.data.action_items, []);
  assert.match(fm.body, /- Carl: do the thing/);
  // the model wrote no transcript, so the file is never "complete" without one: raw diarizer turns appended
  assert.match(fm.body, /## Transcript\n\[T\.J\. Schmitz 0:00\] good morning everyone/);
  assert.match(fm.body, /\[Speaker A 0:04\] thanks lets start/);
  assert.equal(fm.data.bedrock.transcript_source, 'diarizer');
  assert.equal(fm.data.bedrock.evidence, 'limited');
});

test('task-list hand-off happens once per meeting, with a pending identity persisted before the list is written', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-tl-'));
  const s = setup([output('First pass.'), output('Second pass.')], { resolveTaskList: () => ({ enabled: true, folder }) });
  const flushed = () => new Promise(r => setTimeout(r, 200));   // the list is written after the queue drains
  s.an.start(s.json); await drained(s.an); await flushed();
  let lists = fs.readdirSync(folder).filter(f => f.endsWith('.md'));
  assert.equal(lists.length, 1);
  const tl = readFrontmatter(fs.readFileSync(s.md, 'utf8')).data.bedrock.exports.task_list;
  assert.equal(tl.state, 'succeeded');
  assert.equal(tl.file, lists[0]);
  s.an.start('details/' + s.json); await drained(s.an); await flushed();
  lists = fs.readdirSync(folder).filter(f => f.endsWith('.md'));
  assert.equal(lists.length, 1);                                        // the re-analysis was not handed off again
  assert.equal(readFrontmatter(fs.readFileSync(s.md, 'utf8')).data.bedrock.exports.task_list.file, tl.file);
});

test('task-list recovery: a crash after the list was written but before success reuses the pending file name', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-tl2-'));
  const s = setup([output('First pass.'), output('Second pass.')], { resolveTaskList: () => ({ enabled: true, folder }) });
  const flushed = () => new Promise(r => setTimeout(r, 200));
  s.an.start(s.json); await drained(s.an); await flushed();
  const first = fs.readdirSync(folder).filter(f => f.endsWith('.md'))[0];
  // simulate the crash window: the list exists, but the meeting still says pending
  fs.writeFileSync(s.md, fs.readFileSync(s.md, 'utf8').replace('state: "succeeded"', 'state: "pending"'));
  s.an.start('details/' + s.json); await drained(s.an); await flushed();
  const lists = fs.readdirSync(folder).filter(f => f.endsWith('.md'));
  assert.deepEqual(lists, [first]);                                      // reused, not a second list
  assert.deepEqual(readFrontmatter(fs.readFileSync(s.md, 'utf8')).data.bedrock.exports.task_list, { file: first, state: 'succeeded' });
});

test('a proposal made for a legacy -analysis.md row applies onto the canonical <base>.md and retires the legacy file', async () => {
  const s = setup([output('New format.')]);
  const legacy = path.join(s.processed, s.base + '-analysis.md');
  fs.writeFileSync(legacy, '# Meeting Analysis\nold notes without frontmatter\n');
  s.an.start(s.json); await drained(s.an);
  const review = s.an.result(s.base + '-analysis.md', true);
  assert.equal(review.ok, true);
  assert.match(review.markdown, /New format\./);
  const r = await s.an.applyProposed(s.base + '-analysis.md');
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.existsSync(s.md), true);
  assert.equal(fs.existsSync(legacy), false);
  assert.match(fs.readFileSync(path.join(s.processed, 'details', s.base + '.rev0.md'), 'utf8'), /old notes without frontmatter/);
  assert.equal(readFrontmatter(fs.readFileSync(s.md, 'utf8')).data.bedrock.revision, 1);
  assert.equal(fs.existsSync(path.join(s.processed, 'details', s.base + '.proposed.md')), false);
});

test('applying a proposal whose base notes changed afterwards is refused', async () => {
  const s = setup([output('First pass.'), output('Second pass.')]);
  s.an.start(s.json); await drained(s.an);
  fs.writeFileSync(s.md, fs.readFileSync(s.md, 'utf8').replace('First pass.', 'First pass, edited.'));
  s.an.start('details/' + s.json); await drained(s.an);
  assert.equal(fs.existsSync(path.join(s.processed, 'details', s.base + '.proposed.md')), true);
  const later = fs.readFileSync(s.md, 'utf8').replace('status: "open"', 'status: "done"');   // the user completes an item after the proposal was made
  fs.writeFileSync(s.md, later);
  const r = await s.an.applyProposed(s.base + '.md');
  assert.equal(r.ok, false);
  assert.match(r.error, /changed after this proposal/);
  assert.equal(fs.readFileSync(s.md, 'utf8'), later);                    // nothing replaced, the completion kept
});

test('a differing file already at a source destination stops the job before anything is published', async () => {
  const s = setup([output('First pass.')]);
  fs.mkdirSync(path.join(s.processed, 'details'), { recursive: true });
  fs.writeFileSync(path.join(s.processed, 'details', s.json), JSON.stringify({ segments: [{ speaker: 'X', start: 0, end: 1, text: 'an older different transcript' }] }));
  s.an.start(s.json); await drained(s.an);
  assert.match(s.an.getState().error.error, /source filing conflict/);
  assert.equal(fs.existsSync(s.md), false);
  assert.match(fs.readFileSync(path.join(s.processed, 'details', s.json), 'utf8'), /older different/);   // untouched
});

test('re-analysis: revision bumps, previous file kept as rev1, ids and done status carried, user section preserved', async () => {
  const s = setup([output('First pass.'), output('Second pass.')]);
  s.an.start(s.json); await drained(s.an);
  // the user marks the action done and adds their own section (outside the AI headings)
  const first = fs.readFileSync(s.md, 'utf8').replace('status: "open"', 'status: "done"').replace(/\n$/, '\n\n## My Notes\nremember the ROI deck\n');
  fs.writeFileSync(s.md, first);
  const id1 = readFrontmatter(first).data.action_items[0].id;
  s.an.start('details/' + s.json); await drained(s.an);
  assert.equal(s.an.getState().error, null);
  const text = fs.readFileSync(s.md, 'utf8');
  const fm = readFrontmatter(text);
  assert.equal(fm.data.bedrock.revision, 2);
  assert.equal(fm.data.action_items[0].id, id1);
  assert.equal(fm.data.action_items[0].status, 'done');               // completion survives the re-extraction
  assert.match(fm.body, /## Summary\nSecond pass\./);
  assert.match(fm.body, /## My Notes\nremember the ROI deck/);          // user-owned section came along
  assert.equal(fs.existsSync(path.join(s.processed, 'details', s.base + '.rev1.md')), true);
  assert.equal(s.an.getState().proposed, null);
});

test('re-analysis after a hand edit INSIDE an AI section lands as a proposal; the edited file is untouched', async () => {
  const s = setup([output('First pass.'), output('Second pass.')]);
  s.an.start(s.json); await drained(s.an);
  const edited = fs.readFileSync(s.md, 'utf8').replace('First pass.', 'First pass, corrected by hand.');
  fs.writeFileSync(s.md, edited);
  s.an.start('details/' + s.json); await drained(s.an);
  assert.equal(fs.readFileSync(s.md, 'utf8'), edited);
  const proposed = path.join(s.processed, 'details', s.base + '.proposed.md');
  assert.equal(fs.existsSync(proposed), true);
  assert.match(fs.readFileSync(proposed, 'utf8'), /Second pass\./);
  assert.equal(s.an.getState().proposed.name, s.base);
  assert.equal(s.an.getState().error, null);                          // a proposal is a success, not a failure
  // applying the reviewed proposal: current file becomes rev1, proposal becomes the file, revision 2
  const r = await s.an.applyProposed(s.base + '.md');
  assert.equal(r.ok, true, r.error);
  const applied = readFrontmatter(fs.readFileSync(s.md, 'utf8'));
  assert.match(applied.body, /Second pass\./);
  assert.equal(applied.data.bedrock.revision, 2);
  assert.equal(fs.existsSync(proposed), false);
  assert.match(fs.readFileSync(path.join(s.processed, 'details', s.base + '.rev1.md'), 'utf8'), /corrected by hand/);
  assert.equal(s.an.getState().proposed, null);
});

test('recurring meetings publish straight into the recurring folder; sources follow; nothing lands in the date folder first', async () => {
  const s = setup([output('First pass.')], { filingOptions: () => ({ useDetailsFolder: true, separateRecurring: true }) });
  fs.writeFileSync(path.join(s.processed, s.base + '.json'), JSON.stringify({ subject: 'G1 Weekly Review', is_recurring: true, required_attendees: ['Carl Tanner'], optional_attendees: [] }));
  s.an.start(s.json); await drained(s.an);
  assert.equal(s.an.getState().error, null);
  const home = path.join(s.processed, '2026', 'G1-Weekly-Review');
  assert.equal(fs.existsSync(path.join(home, s.base + '.md')), true);
  assert.equal(fs.existsSync(path.join(home, 'details', s.json)), true);
  assert.equal(fs.existsSync(s.md), false);
  assert.equal(fs.existsSync(path.join(s.processed, 'details', s.base + '.md')), false);
});

test('an oversized transcript is refused up front, never analyzed as if complete', async () => {
  const s = setup([output('x')]);
  fs.writeFileSync(path.join(s.processed, s.json), JSON.stringify({ segments: [{ speaker: 'A', start: 0, end: 1, text: 'y'.repeat(2100000) }] }));
  s.an.start(s.json); await drained(s.an);
  assert.match(s.an.getState().error.error, /too large/);
  assert.equal(fs.existsSync(s.md), false);
});

test('a pending Joplin export from an interrupted run is reconciled by id on the next analysis, with no second note', async () => {
  const created = [];
  const s = setup([output('First pass.'), output('Second pass.')], {
    resolveJoplin: () => ({ enabled: true, url: 'box:41184', token: 't', notebook: 'NW Pipe' }),
    joplinNotes: {
      tagsFor: () => [],
      createAnalysisNote: async args => { created.push(args.id); throw new Error('socket hang up'); },   // note created remotely, reply lost
      getNote: async ({ id }) => (created.includes(id) ? { id, title: 'x' } : null),
    },
  });
  s.an.start(s.json); await drained(s.an);
  assert.equal(readFrontmatter(fs.readFileSync(s.md, 'utf8')).data.bedrock.exports.joplin.state, 'pending');
  s.an.start('details/' + s.json); await drained(s.an);
  assert.equal(created.length, 1);
  assert.equal(readFrontmatter(fs.readFileSync(s.md, 'utf8')).data.bedrock.exports.joplin.state, 'succeeded');
});

test('a pre-format <base>-analysis.md is never overwritten: the new analysis is a proposal', async () => {
  const s = setup([output('New format.')]);
  const legacy = path.join(s.processed, s.base + '-analysis.md');
  fs.writeFileSync(legacy, '# Meeting Analysis\nold notes without frontmatter\n');
  s.an.start(s.json); await drained(s.an);
  assert.equal(fs.readFileSync(legacy, 'utf8'), '# Meeting Analysis\nold notes without frontmatter\n');
  assert.equal(fs.existsSync(s.md), false);
  assert.equal(fs.existsSync(path.join(s.processed, 'details', s.base + '.proposed.md')), true);
});

test('a file that changes while the model runs is not published', async () => {
  const s = setup([output('First pass.'), output('Second pass.')]);
  s.an.start(s.json); await drained(s.an);
  // swap the spawn so the second run mutates the file mid-flight
  let touched = false;
  const sneaky = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: s.processed, processed: s.processed }), resolveAi: () => 'claude',
    findClaudeExe: () => 'claude.exe', findCodexExe: () => null, filingOptions: () => ({ useDetailsFolder: true }),
    spawn: fakeSpawn(() => { if (!touched) { touched = true; fs.appendFileSync(s.md, '\nedited while running\n'); } return { stdout: output('Second pass.'), code: 0 }; }),
  });
  sneaky.start('details/' + s.json); await drained(sneaky);
  assert.match(sneaky.getState().error.error, /changed during analysis/);
  assert.match(fs.readFileSync(s.md, 'utf8'), /edited while running/);
  assert.doesNotMatch(fs.readFileSync(s.md, 'utf8'), /Second pass/);
});

test('joplin export: id persisted as pending before the request, created with that id, then succeeded; not re-exported', async () => {
  const calls = [];
  const s = setup([output('First pass.'), output('Second pass.')], {
    resolveJoplin: () => ({ enabled: true, url: 'box:41184', token: 't', notebook: 'NW Pipe' }),
    joplinNotes: {
      tagsFor: () => ['meeting notes'],
      createAnalysisNote: async args => {
        calls.push(args);
        const during = readFrontmatter(fs.readFileSync(s.md, 'utf8')).data.bedrock.exports.joplin;
        assert.equal(during.state, 'pending');
        assert.equal(during.id, args.id);
        return { id: args.id, applied: ['meeting notes'], skipped: [] };
      },
    },
  });
  s.an.start(s.json); await drained(s.an);
  assert.equal(calls.length, 1);
  assert.match(calls[0].id, /^[0-9a-f]{32}$/);
  const after = readFrontmatter(fs.readFileSync(s.md, 'utf8')).data.bedrock.exports.joplin;
  assert.equal(after.state, 'succeeded');
  assert.equal(after.id, calls[0].id);
  s.an.start('details/' + s.json); await drained(s.an);
  assert.equal(calls.length, 1);                                       // a re-analysis does not export again
  assert.equal(readFrontmatter(fs.readFileSync(s.md, 'utf8')).data.bedrock.exports.joplin.state, 'succeeded');
});
