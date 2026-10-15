'use strict';
// Three meeting folders, analyzer side: a transcript waiting in `transcribed` is published into
// `completed` (processed) by the MEETING's date — calendar start, else capture start, else the
// file-name stamp — with every source copied and verified before the .md is written and the
// originals removed only after. Failures before commit leave transcribed intact; failures after
// commit are reported as leftovers and cleared by the next run without another model call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, PassThrough } = require('node:stream');
const { createMeetingAnalyzer } = require('../app/meetingAnalyze');
const { readFrontmatter } = require('../app/meetingFrontmatter');

function fakeSpawn(behavior, counter) {
  return () => {
    if (counter) counter.n++;
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
    proc.kill = () => {};
    proc.stdin.on('data', () => {});
    setImmediate(() => { const b = behavior(); proc.stdout.write(b.stdout || ''); proc.stdout.end(); proc.stderr.end(); proc.emit('close', b.code === undefined ? 0 : b.code); });
    return proc;
  };
}
function drained(an) { return new Promise(r => { const t = setInterval(() => { const s = an.getState(); if (!s.running && !s.queue.length) { clearInterval(t); r(); } }, 10); }); }
const walk = root => {
  const out = [];
  const rec = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) rec(p); else out.push(path.relative(root, p).split(path.sep).join('/')); } };
  if (fs.existsSync(root)) rec(root);
  return out.sort();
};

const SEGMENTS = [
  { speaker: 'T.J. Schmitz', start: 0, end: 4, text: 'good morning everyone welcome to the weekly review' },
  { speaker: 'Speaker A', start: 4.5, end: 9, text: 'thanks lets start with the audit items' },
];
const TAIL = [
  '', '<!-- BEDROCK-STRUCTURED v1 -->',
  'KEY POINTS:', '- Audit on track', '', 'DECISIONS:', '- (none)', '', 'ACTION ITEMS:', '- (none)', '',
  'OPEN QUESTIONS:', '- (none)', '', 'COMMITMENTS:', '- (none)', '',
  'PARTICIPANTS:', '- T.J. Schmitz', '- Carl Tanner', '', 'SPEAKER MAP:', '- Speaker A -> Carl Tanner (direct address)', '',
  'TURNS:', '- 1: segments 0-0', '- 2: segments 1-1', '<!-- /BEDROCK-STRUCTURED -->', '',
].join('\n');
const OUTPUT = '# Meeting Analysis\n## Summary\nFirst pass.\n## Transcript\n'
  + '[T.J. Schmitz 0:00] Good morning everyone, welcome to the weekly review.\n'
  + '[Carl Tanner 0:04] Thanks, let\'s start with the audit items.\n' + TAIL;

// Calendar start 2026-03-31T23:30Z is 2026-04-01 in UTC+1 and later zones, 2026-03-31 in UTC and
// the Americas: the expected month is computed with the SAME local conversion the app uses.
const CAL_START = '2026-03-31T23:30:00+00:00';
const CAP_START = '2026-02-10T09:15:00-07:00';
const BASE = '2026-01-05-08-00-00-G1 Weekly Review';
function ym(iso) { const d = new Date(iso); return { y: String(d.getFullYear()), m: String(d.getMonth() + 1).padStart(2, '0') }; }

// opts.calendar: object | 'none' | 'invalid'; opts.capture: false to omit; opts.shots: screenshots folder
function setup(opts) {
  opts = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-3f-'));
  const transcribed = path.join(root, 'transcribed'), processed = path.join(root, 'completed');
  fs.mkdirSync(transcribed); fs.mkdirSync(processed);
  const base = opts.base || BASE;
  fs.writeFileSync(path.join(transcribed, base + '-diarizer-response.json'), JSON.stringify({ segments: SEGMENTS }));
  fs.writeFileSync(path.join(transcribed, base + '.wav'), Buffer.alloc(2048, 7));
  if (opts.calendar !== 'none') {
    const cal = opts.calendar === 'invalid' ? { subject: 'G1 Weekly Review', start: 'not a date', is_recurring: !!opts.recurring }
      : Object.assign({ subject: 'G1 Weekly Review', start: CAL_START, required_attendees: ['Carl Tanner', 'T.J. Schmitz'], optional_attendees: [], is_recurring: !!opts.recurring }, opts.calendar || {});
    fs.writeFileSync(path.join(transcribed, base + '.json'), JSON.stringify(cal));
  }
  if (opts.capture !== false) fs.writeFileSync(path.join(transcribed, base + '.capture.json'), JSON.stringify({ schema: 1, started_at: CAP_START, tz: 'America/Denver', device: 'Mic' }));
  if (opts.vtt) fs.writeFileSync(path.join(transcribed, base + '.vtt'), 'WEBVTT\n\n00:00.000 --> 00:04.000\n<v T.J. Schmitz>Good morning\n');
  if (opts.shots) { fs.mkdirSync(path.join(transcribed, base + '-screenshots')); fs.writeFileSync(path.join(transcribed, base + '-screenshots', 'slide-001.png'), Buffer.alloc(64, 1)); }
  const counter = { n: 0 };
  const outputs = opts.outputs || [{ stdout: OUTPUT, code: 0 }];
  let i = 0;
  const logs = [];
  const an = createMeetingAnalyzer(Object.assign({
    resolveFolders: () => ({ unprocessed: path.join(root, 'unprocessed'), transcribed, processed }),
    resolveAi: () => 'claude',
    findClaudeExe: () => 'claude.exe', findCodexExe: () => null,
    spawn: fakeSpawn(() => outputs[Math.min(i++, outputs.length - 1)], counter),
    filingOptions: () => Object.assign({ useDetailsFolder: true, byDate: true, separateRecurring: false }, opts.filing || {}),
    resolveMyName: () => 'T.J. Schmitz',
    log: m => logs.push(m),
  }, opts.deps || {}));
  return { root, transcribed, processed, base, an, counter, logs, json: base + '-diarizer-response.json' };
}

test('transcribed → completed: filed by the calendar date (local), every source copied into details, transcribed emptied', async () => {
  const s = setup({ vtt: true, shots: true });
  assert.equal(s.an.start(s.json, 'transcribed').ok, true);
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
  const { y, m } = ym(CAL_START);
  const md = path.join(s.processed, y, m, s.base + '.md');
  assert.ok(fs.existsSync(md), 'meeting file in completed/YYYY/MM by the calendar date: ' + walk(s.processed).join(','));
  const fm = readFrontmatter(fs.readFileSync(md, 'utf8'));
  assert.equal(fm.ok, true);
  assert.equal(fm.data.bedrock.filing_date, 'calendar');
  assert.equal(fm.data.bedrock.filing_warning, undefined);
  assert.deepEqual(walk(path.join(s.processed, y, m, 'details')), [
    s.base + '-diarizer-response.json', s.base + '-screenshots/slide-001.png', s.base + '.capture.json', s.base + '.json', s.base + '.vtt', s.base + '.wav',
  ].sort());
  assert.deepEqual(walk(s.transcribed), [], 'transcribed is empty for this meeting');
  const done = s.an.getState().lastDone;
  assert.equal(done.kind, 'transcribed');
  assert.equal(done.md, [y, m, s.base + '.md'].join('/'));
  assert.equal(done.warning, undefined);
  // View from the (now gone) transcribed row shows the file it became
  const r = s.an.result(s.json, false, 'transcribed');
  assert.equal(r.ok, true);
  assert.match(r.markdown, /First pass\./);
});

test('Organize by date off: the meeting file lands in the completed root, sources in its details', async () => {
  const s = setup({ filing: { byDate: false } });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
  assert.ok(fs.existsSync(path.join(s.processed, s.base + '.md')));
  assert.ok(fs.existsSync(path.join(s.processed, 'details', s.base + '.wav')));
  assert.deepEqual(walk(s.transcribed), []);
});

test('recurring meeting: completed/YYYY/<Meeting-Name>/ with the year from the meeting date', async () => {
  const s = setup({ recurring: true, filing: { separateRecurring: true } });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
  const { y } = ym(CAL_START);
  assert.ok(fs.existsSync(path.join(s.processed, y, 'G1-Weekly-Review', s.base + '.md')), walk(s.processed).join(','));
  assert.ok(fs.existsSync(path.join(s.processed, y, 'G1-Weekly-Review', 'details', s.base + '.wav')));
});

test('no calendar sidecar: filed by the capture start', async () => {
  const s = setup({ calendar: 'none' });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
  const { y, m } = ym(CAP_START);
  const md = path.join(s.processed, y, m, s.base + '.md');
  assert.ok(fs.existsSync(md), walk(s.processed).join(','));
  assert.equal(readFrontmatter(fs.readFileSync(md, 'utf8')).data.bedrock.filing_date, 'capture');
});

test('unreadable calendar start: falls back to the capture date with a warning in the file', async () => {
  const s = setup({ calendar: 'invalid' });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
  const { y, m } = ym(CAP_START);
  const md = path.join(s.processed, y, m, s.base + '.md');
  assert.ok(fs.existsSync(md), walk(s.processed).join(','));
  const b = readFrontmatter(fs.readFileSync(md, 'utf8')).data.bedrock;
  assert.equal(b.filing_date, 'capture');
  assert.match(b.filing_warning, /not a readable date/);
});

test('no calendar, no capture: the file-name stamp decides; never the processing date', async () => {
  const s = setup({ calendar: 'none', capture: false, deps: { now: () => new Date('2031-12-25T12:00:00Z').getTime() } });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
  assert.ok(fs.existsSync(path.join(s.processed, '2026', '01', s.base + '.md')), walk(s.processed).join(','));
  assert.equal(walk(s.processed).some(p => p.startsWith('2031/')), false);
});

test('no usable date at all: an actionable error, nothing filed, the transcript stays in transcribed', async () => {
  const s = setup({ base: 'ad-hoc recording', calendar: 'none', capture: false });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  const st = s.an.getState();
  assert.match(st.error.error, /no usable date/);
  assert.equal(st.error.kind, 'transcribed');
  assert.deepEqual(walk(s.processed), []);
  assert.deepEqual(walk(s.transcribed), ['ad-hoc recording-diarizer-response.json', 'ad-hoc recording.wav']);
  assert.equal(s.counter.n, 0, 'no model call for a meeting that cannot be filed');
});

test('a failed analysis leaves transcribed intact and completed untouched', async () => {
  const s = setup({ outputs: [{ stdout: 'boom', code: 1 }] });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /exited 1/);
  assert.deepEqual(walk(s.processed), []);
  assert.equal(walk(s.transcribed).length, 4);
});

test('a copy failure before commit: no meeting file, the copies made are rolled back, transcribed intact', async () => {
  let fail = true;
  const fsx = Object.assign({}, fs, { promises: Object.assign({}, fs.promises, {
    copyFile: async (a, b) => { if (fail && /\.wav$/i.test(a)) throw new Error('disk full'); return fs.promises.copyFile(a, b); },
  }) });
  const s = setup({ deps: { fs: fsx } });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /disk full/);
  assert.equal(walk(s.processed).some(p => p.endsWith('.md')), false);
  assert.equal(walk(s.processed).filter(p => p.includes('/details/')).length, 0, 'staged copies rolled back: ' + walk(s.processed).join(','));
  assert.equal(walk(s.transcribed).length, 4);
  // retry succeeds
  fail = false;
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
  assert.deepEqual(walk(s.transcribed), []);
});

test('a .md write failure before commit rolls the copies back; transcribed intact', async () => {
  const fsx = Object.assign({}, fs, { promises: Object.assign({}, fs.promises, {
    writeFile: async (p, d) => { if (/\.md\.tmp$/i.test(p)) throw new Error('write denied'); return fs.promises.writeFile(p, d); },
  }) });
  const s = setup({ deps: { fs: fsx } });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /write denied/);
  assert.equal(walk(s.processed).filter(p => p.includes('/details/')).length, 0, walk(s.processed).join(','));
  assert.equal(walk(s.transcribed).length, 4);
});

test('cleanup failure after commit: "committed, with leftovers"; the next run clears them with no model call', async () => {
  let block = true;
  const fsx = Object.assign({}, fs, { promises: Object.assign({}, fs.promises, {
    rm: async (p, o) => { if (block && /\.wav$/i.test(p)) throw new Error('EBUSY'); return fs.promises.rm(p, o); },
  }) });
  const s = setup({ deps: { fs: fsx } });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  const st = s.an.getState();
  assert.equal(st.error, null, 'not a failed analysis');
  assert.match(st.lastDone.warning, /committed, with leftovers in transcribed: .*\.wav/);
  const { y, m } = ym(CAL_START);
  assert.ok(fs.existsSync(path.join(s.processed, y, m, s.base + '.md')));
  // The cleanup stopped at the first failure: the date sidecars and the transcript (the row) are
  // still there, so the retry resolves the SAME home instead of filing a second meeting elsewhere.
  assert.deepEqual(walk(s.transcribed), [s.json, s.base + '.capture.json', s.base + '.completed.json', s.base + '.json', s.base + '.wav'].sort(), 'the leftover set is still visible as a row, with the cleanup journal');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.transcribed, s.base + '.completed.json'), 'utf8')).md, [y, m, s.base + '.md'].join('/'));
  assert.equal(s.counter.n, 1);
  block = false;
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
  assert.match(s.an.getState().lastDone.warning, /already completed; leftovers cleared/);
  assert.deepEqual(walk(s.transcribed), []);
  assert.equal(s.counter.n, 1, 'no second model call');
});

test('late cleanup failure (sidecars gone, transcript stuck): the retry follows the journal to the SAME file, no second model call', async () => {
  // Codex's reproducer: the calendar date is March, the file-name stamp January. Without the
  // journal the retry would re-derive January from the file name and publish a duplicate.
  let block = true;
  const fsx = Object.assign({}, fs, { promises: Object.assign({}, fs.promises, {
    rm: async (p, o) => { if (block && /-diarizer-response\.json$/i.test(p)) throw new Error('EBUSY'); return fs.promises.rm(p, o); },
  }) });
  const s = setup({ deps: { fs: fsx } });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
  assert.match(s.an.getState().lastDone.warning, /committed, with leftovers/);
  assert.deepEqual(walk(s.transcribed), [s.json, s.base + '.completed.json'].sort(), 'date sidecars are gone; only the row and the journal remain');
  block = false;
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
  assert.match(s.an.getState().lastDone.warning, /already completed; leftovers cleared/);
  assert.deepEqual(walk(s.transcribed), []);
  assert.equal(s.counter.n, 1, 'no second model call');
  assert.equal(walk(s.processed).filter(p => p.endsWith('.md')).length, 1, 'exactly one meeting file: ' + walk(s.processed).join(','));
  assert.equal(walk(s.processed).some(p => p.startsWith('2026/01/')), false, 'nothing re-filed under the file-name month');
});

test('captions: a waiting transcript uses only its exact .vtt — a neighbour sharing the time stamp is never taken', async () => {
  const s = setup();
  const other = s.base.slice(0, 19) + '-Different Meeting.vtt';   // same 19-char stamp, another meeting's captions
  fs.writeFileSync(path.join(s.transcribed, other), 'WEBVTT\n\n00:00.000 --> 00:01.000\n<v Someone Else>Not this meeting\n');
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
  assert.deepEqual(walk(s.transcribed), [other], 'the neighbour\'s captions stay where they were');
  assert.equal(walk(s.processed).some(p => p.endsWith('.vtt')), false, 'no captions were filed with this meeting');
  assert.equal(s.logs.some(l => /companion VTT found/.test(l)), false, 'and none reached the prompt');
});

test('links are refused: a symlinked source is never copied or removed', { skip: process.platform === 'win32' && !canSymlink() }, async () => {
  const s = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-3f-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.wav'), Buffer.alloc(64, 3));
  fs.rmSync(path.join(s.transcribed, s.base + '.wav'));
  fs.symlinkSync(path.join(outside, 'secret.wav'), path.join(s.transcribed, s.base + '.wav'), 'file');
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /is a link — refused/);
  assert.equal(walk(s.processed).some(p => p.includes('/details/')), false, 'nothing copied');
  assert.ok(fs.existsSync(path.join(outside, 'secret.wav')), 'the link target is untouched');
  assert.ok(fs.lstatSync(path.join(s.transcribed, s.base + '.wav')).isSymbolicLink(), 'the link itself is untouched');
  assert.equal(s.counter.n, 0);
});

test('a copy that dies halfway (partial bytes) is rolled back too', async () => {
  const fsx = Object.assign({}, fs, { promises: Object.assign({}, fs.promises, {
    copyFile: async (a, b, flags) => { if (/\.wav$/i.test(a)) { fs.writeFileSync(b, Buffer.alloc(10, 7)); throw new Error('EIO'); } return fs.promises.copyFile(a, b, flags); },
  }) });
  const s = setup({ deps: { fs: fsx } });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /EIO/);
  assert.equal(walk(s.processed).filter(p => p.includes('/details/')).length, 0, 'the partial copy was removed: ' + walk(s.processed).join(','));
  assert.equal(walk(s.transcribed).length, 4);
});

test('a destination file that appears during filing is never ours: conflict reported, the foreign file survives, our copies go', async () => {
  let s;
  const fsx = Object.assign({}, fs, { promises: Object.assign({}, fs.promises, {
    copyFile: async (a, b, flags) => {
      if (/\.wav$/i.test(a)) { fs.writeFileSync(b, 'someone else wrote this'); const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }   // a foreign writer won the race
      return fs.promises.copyFile(a, b, flags);
    },
  }) });
  s = setup({ deps: { fs: fsx } });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /appeared in .* during filing/);
  const { y, m } = ym(CAL_START);
  const foreign = path.join(s.processed, y, m, 'details', s.base + '.wav');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'someone else wrote this', 'the other writer\'s file is untouched');
  assert.deepEqual(walk(s.processed), [[y, m, 'details', s.base + '.wav'].join('/')], 'only the foreign file remains: our copies were rolled back');
  assert.equal(walk(s.transcribed).length, 4);
});

test('a foreign screenshots folder that appears during filing is left alone too', async () => {
  let s;
  const { y, m } = ym(CAL_START);
  const fsx = Object.assign({}, fs, { promises: Object.assign({}, fs.promises, {
    cp: async (a, b, o) => {
      const r = await fs.promises.cp(a, b, o);
      const foreign = path.join(s.processed, y, m, 'details', s.base + '-screenshots');
      fs.mkdirSync(foreign, { recursive: true }); fs.writeFileSync(path.join(foreign, 'theirs.png'), 'x');   // appears after our staging copy
      return r;
    },
  }) });
  s = setup({ shots: true, deps: { fs: fsx } });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /appeared in .* during filing/);
  assert.ok(fs.existsSync(path.join(s.processed, y, m, 'details', s.base + '-screenshots', 'theirs.png')), 'the foreign folder survives');
  assert.equal(walk(s.processed).some(p => /staging-/.test(p)), false, 'our staging copy is gone');
  assert.equal(walk(s.transcribed).length, 5);
});

test('the cleanup journal cannot be written: nothing is removed; committed, with the whole set left', async () => {
  const fsx = Object.assign({}, fs, { promises: Object.assign({}, fs.promises, {
    writeFile: async (p, d) => { if (/\.completed\.json\.tmp$/i.test(p)) throw new Error('EACCES'); return fs.promises.writeFile(p, d); },
  }) });
  const s = setup({ deps: { fs: fsx } });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  const st = s.an.getState();
  assert.equal(st.error, null);
  assert.match(st.lastDone.warning, /committed, with leftovers in transcribed: /);
  const { y, m } = ym(CAL_START);
  assert.ok(fs.existsSync(path.join(s.processed, y, m, s.base + '.md')));
  assert.equal(walk(s.transcribed).length, 4, 'nothing removed without a journal');
});

test('a meeting file that appears while the sources are being copied stops the commit; copies rolled back', async () => {
  const { y, m } = ym(CAL_START);
  let s;
  const fsx = Object.assign({}, fs, { promises: Object.assign({}, fs.promises, {
    copyFile: async (a, b, flags) => {
      const r = await fs.promises.copyFile(a, b, flags);
      if (/\.wav$/i.test(a)) fs.writeFileSync(path.join(s.processed, y, m, s.base + '.md'), '---\ntitle: someone else\n---\n');   // appears mid-copy
      return r;
    },
  }) });
  s = setup({ deps: { fs: fsx } });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /appeared during analysis/);
  assert.equal(fs.readFileSync(path.join(s.processed, y, m, s.base + '.md'), 'utf8'), '---\ntitle: someone else\n---\n', 'the other file is untouched');
  assert.equal(walk(s.processed).filter(p => p.includes('/details/')).length, 0, 'copies rolled back');
  assert.equal(walk(s.transcribed).length, 4);
});

function canSymlink() {
  try { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-ln-')); fs.writeFileSync(path.join(d, 'a'), 'a'); fs.symlinkSync(path.join(d, 'a'), path.join(d, 'b'), 'file'); return true; } catch (e) { return false; }
}

test('a DIFFERENT meeting with the same name already completed: refused, nothing moved', async () => {
  const s = setup();
  const { y, m } = ym(CAL_START);
  fs.mkdirSync(path.join(s.processed, y, m, 'details'), { recursive: true });
  fs.writeFileSync(path.join(s.processed, y, m, s.base + '.md'), '---\ntitle: x\n---\nold\n');
  fs.writeFileSync(path.join(s.processed, y, m, 'details', s.base + '.wav'), Buffer.alloc(2048, 9));   // other bytes
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /already exists/);
  assert.equal(walk(s.transcribed).length, 4);
  assert.equal(fs.readFileSync(path.join(s.processed, y, m, s.base + '.md'), 'utf8'), '---\ntitle: x\n---\nold\n');
  assert.equal(s.counter.n, 0);
});

test('every job names its root: queue identity, isBusy, and transcribed names are flat transcripts only', async () => {
  const s = setup({ outputs: [{ stdout: OUTPUT, code: 0 }] });
  // the same base name in BOTH roots: two distinct jobs
  const { y, m } = ym(CAL_START);
  fs.mkdirSync(path.join(s.processed, 'old', 'details'), { recursive: true });
  fs.writeFileSync(path.join(s.processed, 'old', 'details', s.json), JSON.stringify({ segments: SEGMENTS }));
  assert.equal(s.an.start('sub/' + s.json, 'transcribed').error, 'bad name');
  assert.equal(s.an.start(s.base + '.md', 'transcribed').error, 'bad name');
  assert.equal(s.an.start('missing-diarizer-response.json', 'transcribed').error, 'not found');
  const first = s.an.start(s.json, 'transcribed');
  assert.equal(first.ok, true);
  const second = s.an.start('old/details/' + s.json, 'processed');
  assert.equal(second.ok, true);
  assert.deepEqual(second.queue, [{ name: 'old/details/' + s.json, kind: 'processed' }]);
  assert.equal(s.an.getState().kind, 'transcribed');
  assert.equal(s.an.isBusy(s.json, 'transcribed'), true);
  assert.equal(s.an.isBusy('old/details/' + s.json, 'processed'), true);
  assert.equal(s.an.isBusy('old/details/' + s.json, 'transcribed'), false);
  assert.equal(s.an.start(s.json, 'transcribed').error, 'already queued');
  await drained(s.an);
  assert.equal(s.an.isBusy(s.json, 'transcribed'), false);
  assert.ok(fs.existsSync(path.join(s.processed, y, m, s.base + '.md')));
  assert.ok(fs.existsSync(path.join(s.processed, 'old', s.base + '.md')), 'the completed-kind job published in its own folder');
});

test('roots re-checked as each queued job starts: an overlap introduced meanwhile fails the job, nothing moves', async () => {
  let bad = '';
  const s = setup({ deps: { foldersError: () => bad } });
  // queue two; the first runs clean, then the settings "change" before the second starts
  const other = s.base.replace('G1', 'G2');
  fs.writeFileSync(path.join(s.transcribed, other + '-diarizer-response.json'), JSON.stringify({ segments: SEGMENTS }));
  fs.writeFileSync(path.join(s.transcribed, other + '.capture.json'), JSON.stringify({ schema: 1, started_at: CAP_START }));
  s.an.start(s.json, 'transcribed');
  s.an.start(other + '-diarizer-response.json', 'transcribed');
  bad = 'Transcribed folder is inside the Completed folder';
  await drained(s.an);
  const st = s.an.getState();
  assert.match(st.error.error, /meeting folders misconfigured: Transcribed folder is inside/);
  assert.equal(st.error.name, other + '-diarizer-response.json');
  assert.equal(st.completed, 1);
  assert.equal(st.failed, 1);
  assert.ok(fs.existsSync(path.join(s.transcribed, other + '-diarizer-response.json')), 'the refused job\'s sources stay put');
  assert.equal(s.counter.n, 1, 'no model call for the refused job');
});

test('a transcribed job never carries sources through a date folder first: nothing but the final home is written', async () => {
  const s = setup({ recurring: true, filing: { separateRecurring: true } });
  s.an.start(s.json, 'transcribed');
  await drained(s.an);
  const { y, m } = ym(CAL_START);
  assert.equal(fs.existsSync(path.join(s.processed, y, m)), false);
});
