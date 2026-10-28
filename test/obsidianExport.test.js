'use strict';
// Obsidian export through the analyzer: a published meeting file is copied into the vault at its
// Completed-relative path (recurring folder included), re-exported on re-analysis while the vault
// copy is still Bedrock's, written beside an edited vault copy as .conflict.md, settled from
// `pending` by re-hashing after a crash, and refused outright when the vault is not there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, PassThrough } = require('node:stream');
const { createMeetingAnalyzer } = require('../app/meetingAnalyze');
const { readFrontmatter } = require('../app/meetingFrontmatter');
const { sha256 } = require('../app/meetingFile');
const obsidianExport = require('../app/obsidianExport');

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
  'DECISIONS:', '- (none)', '',
  'ACTION ITEMS:', '- (none)', '',
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

const BASE = '2026-10-14-15-57-16-G1 Weekly Review';
const REL = '2026/G1-Weekly-Review/' + BASE + '.md';   // the recurring folder, mirrored into the vault

// A completed root holding one recurring meeting's sources, a vault folder, and an analyzer with
// the Obsidian export on. `extra` overrides analyzer deps; `opts.vault` overrides the vault path.
function setup(outputs, extra, opts) {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-obs-'));
  const vault = (opts && opts.vault) || fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-vault-'));
  fs.writeFileSync(path.join(processed, BASE + '-diarizer-response.json'), JSON.stringify({ segments: SEGMENTS, speaker_report: { speakers: [{ label: 'T.J. Schmitz', identified: true }] } }));
  fs.writeFileSync(path.join(processed, BASE + '.json'), JSON.stringify({ subject: 'G1 Weekly Review', is_recurring: true, start: '2026-10-14T22:00:00+00:00', required_attendees: ['Carl Tanner', 'T.J. Schmitz'], optional_attendees: [] }));
  fs.writeFileSync(path.join(processed, BASE + '.capture.json'), JSON.stringify({ schema: 1, started_at: '2026-10-14T15:57:16-07:00', tz: 'America/Los_Angeles', device: 'Mic' }));
  const logs = [];
  let i = 0;
  const an = createMeetingAnalyzer(Object.assign({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'claude',
    findClaudeExe: () => 'claude.exe', findCodexExe: () => null,
    spawn: fakeSpawn(() => ({ stdout: outputs[Math.min(i++, outputs.length - 1)], code: 0 })),
    filingOptions: () => ({ useDetailsFolder: true, separateRecurring: true }),
    resolveMyName: () => 'T.J. Schmitz',
    resolveObsidian: () => ({ enabled: true, vault }),
    log: m => logs.push(m),
  }, extra || {}));
  const md = path.join(processed, '2026', 'G1-Weekly-Review', BASE + '.md');
  return { processed, vault, an, logs, md, vaultMd: path.join(vault, '2026', 'G1-Weekly-Review', BASE + '.md'),
    json: BASE + '-diarizer-response.json', jsonAgain: '2026/G1-Weekly-Review/details/' + BASE + '-diarizer-response.json' };
}
const fm = p => readFrontmatter(fs.readFileSync(p, 'utf8'));

test('first export: the vault gets the meeting file at its Completed-relative path, and the meeting file records where and what', async () => {
  const s = setup([output('First pass.')]);
  assert.equal(s.an.start(s.json).ok, true);
  await drained(s.an);
  assert.equal(s.an.getState().error, null);
  assert.equal(fs.existsSync(s.vaultMd), true);
  const vaultBytes = fs.readFileSync(s.vaultMd);
  const copy = fm(s.vaultMd);
  assert.equal(copy.ok, true);
  assert.equal(copy.data.title, 'G1 Weekly Review');
  assert.match(copy.body, /First pass\./);
  assert.equal(copy.data.bedrock.exports.obsidian, undefined);   // the copy is the file as published, before the export's own bookkeeping
  const rec = fm(s.md).data.bedrock.exports.obsidian;
  assert.deepEqual(rec, { state: 'succeeded', path: REL, hash: sha256(vaultBytes) });
  assert.equal(fm(s.md).body, copy.body);
  assert.equal(s.an.getState().obsidian.ok, true);
  assert.equal(s.an.getState().obsidian.path, REL);
  assert.equal(fs.existsSync(s.vaultMd + '.tmp'), false);
});

test('re-analysis re-exports while the vault copy is still what Bedrock wrote', async () => {
  const s = setup([output('First pass.'), output('Second pass.')]);
  s.an.start(s.json); await drained(s.an);
  const first = fm(s.md).data.bedrock.exports.obsidian;
  s.an.start(s.jsonAgain); await drained(s.an);
  assert.equal(s.an.getState().error, null);
  assert.match(fs.readFileSync(s.vaultMd, 'utf8'), /Second pass\./);
  const rec = fm(s.md).data.bedrock.exports.obsidian;
  assert.equal(rec.state, 'succeeded');
  assert.equal(rec.path, REL);
  assert.notEqual(rec.hash, first.hash);
  assert.equal(rec.hash, sha256(fs.readFileSync(s.vaultMd)));
  assert.equal(fs.readdirSync(path.dirname(s.vaultMd)).filter(f => /conflict/.test(f)).length, 0);
});

test('a vault copy edited there is never overwritten: the new analysis lands beside it as .conflict.md', async () => {
  const s = setup([output('First pass.'), output('Second pass.')]);
  s.an.start(s.json); await drained(s.an);
  const edited = fs.readFileSync(s.vaultMd, 'utf8').replace('Carl Tanner', 'Carl Tanner-Edited');
  fs.writeFileSync(s.vaultMd, edited);   // the phone fixed a speaker name
  s.an.start(s.jsonAgain); await drained(s.an);
  assert.equal(s.an.getState().error, null);   // the analysis itself still succeeds
  assert.equal(fs.readFileSync(s.vaultMd, 'utf8'), edited);
  const conflict = path.join(path.dirname(s.vaultMd), BASE + '.conflict.md');
  assert.match(fs.readFileSync(conflict, 'utf8'), /Second pass\./);
  const rec = fm(s.md).data.bedrock.exports.obsidian;
  assert.equal(rec.state, 'conflict');
  assert.equal(rec.path, REL);
  assert.equal(rec.conflict, '2026/G1-Weekly-Review/' + BASE + '.conflict.md');
  assert.equal(rec.hash, sha256(fs.readFileSync(conflict)));
  const st = s.an.getState().obsidian;
  assert.equal(st.ok, false);
  assert.match(st.error, /edited there/);
  assert.match(fs.readFileSync(s.md, 'utf8'), /Second pass\./);   // Completed moved on; the vault is what waits for a merge
});

test('a missing vault folder is reported and nothing is written or recorded; the analysis still publishes', async () => {
  const s = setup([output('First pass.')], {}, { vault: path.join(os.tmpdir(), 'oqx-no-such-vault-' + process.pid) });
  s.an.start(s.json); await drained(s.an);
  assert.equal(s.an.getState().error, null);
  assert.equal(fs.existsSync(s.md), true);
  assert.equal(fs.existsSync(s.vault), false);
  assert.equal(fm(s.md).data.bedrock.exports.obsidian, undefined);
  const st = s.an.getState().obsidian;
  assert.equal(st.ok, false);
  assert.match(st.error, /vault folder not found/);
  // Not set at all is the same refusal with its own message.
  const unset = setup([output('First pass.')], { resolveObsidian: () => ({ enabled: true, vault: '' }) });
  unset.an.start(unset.json); await drained(unset.an);
  assert.match(unset.an.getState().obsidian.error, /not set/);
  assert.equal(fm(unset.md).data.bedrock.exports.obsidian, undefined);
});

test('a crash after the copy but before the record is settled as succeeded on the next analysis by re-hashing the vault copy', async () => {
  let crashOnce = true;
  const s = setup([output('First pass.'), output('Second pass.')], {
    obsidianExport: Object.assign({}, obsidianExport, {
      exportMeetingFile: async args => { const r = await obsidianExport.exportMeetingFile(args); if (crashOnce) { crashOnce = false; throw new Error('power cut'); } return r; },
    }),
  });
  s.an.start(s.json); await drained(s.an);
  const left = fm(s.md).data.bedrock.exports.obsidian;
  assert.equal(left.state, 'pending');
  assert.equal(left.hash, sha256(fs.readFileSync(s.vaultMd)));   // the copy landed; only the record did not
  s.an.start(s.jsonAgain); await drained(s.an);
  assert.ok(s.logs.some(m => /obsidian export reconciled as succeeded/.test(m)));
  const rec = fm(s.md).data.bedrock.exports.obsidian;
  assert.equal(rec.state, 'succeeded');   // and the re-analysis then re-exported over its own bytes, no conflict
  assert.match(fs.readFileSync(s.vaultMd, 'utf8'), /Second pass\./);
  assert.equal(fs.existsSync(path.join(path.dirname(s.vaultMd), BASE + '.conflict.md')), false);
});

test('export is off by default: nothing is written and nothing recorded', async () => {
  const s = setup([output('First pass.')], { resolveObsidian: () => ({}) });
  s.an.start(s.json); await drained(s.an);
  assert.equal(fs.existsSync(s.vaultMd), false);
  assert.equal(fm(s.md).data.bedrock.exports.obsidian, undefined);
  assert.equal(s.an.getState().obsidian, null);
});

test('vault paths never escape the vault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-vault-'));
  assert.throws(() => obsidianExport.vaultPathFor(root, '../outside.md'), /bad vault path|escapes/);
  assert.throws(() => obsidianExport.vaultPathFor(root, ''), /bad vault path/);
  assert.equal(obsidianExport.vaultPathFor(root, '2026/10/x.md'), path.join(root, '2026', '10', 'x.md'));
});
