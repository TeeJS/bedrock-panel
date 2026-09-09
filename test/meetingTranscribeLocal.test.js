'use strict';
// The transcription queue with the local engine (macOS built-in speech): no health probe, no hooks,
// the injected localTranscribe runs against the WAV path, and the result is filed exactly like a
// diarizer response (transcript JSON beside the moved WAV). Real temp folders, fake engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMeetingTranscriber } = require('../app/meetingTranscribe');

function folders() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-meet-'));
  const f = { unprocessed: path.join(root, 'unprocessed'), processed: path.join(root, 'processed') };
  fs.mkdirSync(f.unprocessed, { recursive: true }); fs.mkdirSync(f.processed, { recursive: true });
  return f;
}
const settle = () => new Promise(r => setTimeout(r, 30));

test('local engine: transcribes on this machine, files the transcript and the WAV, skips the server entirely', async () => {
  const f = folders();
  fs.writeFileSync(path.join(f.unprocessed, 'standup.wav'), Buffer.alloc(64));
  fs.writeFileSync(path.join(f.unprocessed, 'standup.json'), JSON.stringify({ organizer: 'Someone' }));   // meeting-info sidecar travels too
  const calls = [], logs = [];
  let fetched = 0, posted = 0, hooks = 0;
  const q = createMeetingTranscriber({
    resolveFolders: () => f,
    resolveBaseUrl: () => 'http://127.0.0.1:10301',
    resolveEngine: () => 'local',
    localTranscribe: async (wavPath, { myName, log }) => {
      calls.push([wavPath, myName]);
      log('analyzing');
      return { engine: 'speechanalyzer', segments: [{ speaker: myName, start: 0, end: 1.5, text: 'hello' }, { speaker: 'Others', start: 2, end: 3, text: 'hi' }], speaker_report: { speaker_count: 2 } };
    },
    resolveMyName: () => 'T.J.',
    resolveHooks: () => { hooks++; return { enabled: true, pre: 'echo start', post: 'echo stop' }; },
    execHook: async () => { throw new Error('hooks must not run for the local engine'); },
    fetchImpl: async () => { fetched++; return { ok: true }; },
    httpPost: async () => { posted++; throw new Error('no upload for the local engine'); },
    log: m => logs.push(m),
    healthTtlMs: 0,
  });
  const st = q.getState();
  assert.equal(st.engine, 'local');
  assert.equal(st.health, 'ok', 'local engine reports healthy without probing');
  assert.equal(st.hooksEnabled, false);
  assert.equal(fetched, 0, 'no /health probe');
  const r = q.enqueue('standup.wav');
  assert.equal(r.ok, true);
  for (let i = 0; i < 50 && q.getState().current; i++) await settle();
  await settle();
  const state = q.getState();
  assert.equal(state.recent[0].status, 'done', JSON.stringify(state.recent[0]));
  assert.deepEqual(calls, [[path.join(f.unprocessed, 'standup.wav'), 'T.J.']]);
  assert.equal(posted, 0);
  assert.ok(logs.some(l => l.includes('[local] analyzing')), 'engine log lines are relayed');
  const filed = JSON.parse(fs.readFileSync(path.join(f.processed, 'standup-diarizer-response.json'), 'utf8'));
  assert.equal(filed.segments[0].speaker, 'T.J.');
  assert.ok(fs.existsSync(path.join(f.processed, 'standup.wav')), 'WAV moved beside the transcript');
  assert.ok(fs.existsSync(path.join(f.processed, 'standup.json')), 'sidecar moved too');
  assert.ok(!fs.existsSync(path.join(f.unprocessed, 'standup.wav')));
});

test('local engine: a failed or empty transcription leaves the WAV in place and reports the error', async () => {
  const f = folders();
  fs.writeFileSync(path.join(f.unprocessed, 'a.wav'), Buffer.alloc(8));
  fs.writeFileSync(path.join(f.unprocessed, 'b.wav'), Buffer.alloc(8));
  const q = createMeetingTranscriber({
    resolveFolders: () => f, resolveBaseUrl: () => 'http://x', resolveEngine: () => 'local',
    localTranscribe: async wavPath => { if (wavPath.endsWith('a.wav')) throw new Error('local transcription failed: model missing'); return { segments: 'nope' }; },
    log: () => {}, healthTtlMs: 0,
  });
  q.enqueue('a.wav'); q.enqueue('b.wav');
  for (let i = 0; i < 80 && (q.getState().current || q.getState().queue.length); i++) await settle();
  await settle();
  const recent = q.getState().recent;
  assert.equal(recent.length, 2);
  assert.match(recent.find(r => r.name === 'a.wav').error, /model missing/);
  assert.match(recent.find(r => r.name === 'b.wav').error, /no segments/);
  assert.ok(fs.existsSync(path.join(f.unprocessed, 'a.wav')) && fs.existsSync(path.join(f.unprocessed, 'b.wav')), 'both WAVs stay for retry');
});

test('server engine is unchanged: the health probe and the upload still happen', async () => {
  const f = folders();
  fs.writeFileSync(path.join(f.unprocessed, 'c.wav'), Buffer.alloc(8));
  let fetched = 0, posted = 0;
  const q = createMeetingTranscriber({
    resolveFolders: () => f, resolveBaseUrl: () => 'http://127.0.0.1:10301', resolveEngine: () => 'server',
    localTranscribe: async () => { throw new Error('must not be used'); },
    fetchImpl: async () => { fetched++; return { ok: true }; },
    httpPost: async () => { posted++; return { status: 200, text: JSON.stringify({ segments: [] }) }; },
    log: () => {}, healthTtlMs: 0,
  });
  assert.equal(q.getState().engine, 'server');
  q.enqueue('c.wav');
  for (let i = 0; i < 50 && q.getState().current; i++) await settle();
  await settle();
  assert.equal(posted, 1);
  assert.ok(fetched >= 1);
  assert.equal(q.getState().recent[0].status, 'done');
});
