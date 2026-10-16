'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMeetingBatch } = require('../app/meetingBatch');

function setup(options = {}) {
  const calls = [];
  const tx = { completed: 10, failed: 2, queue: [], current: null, phase: null };
  const an = { completed: 7, failed: 3, queue: [], running: false };
  let ticks = 0;
  const library = {
    listFiles(kind, dir) {
      calls.push(['list', kind, dir || '']);
      return options.list ? options.list(kind, dir || '') : { ok: true, dirs: [], files: [] };
    },
  };
  const transcriber = {
    getState: () => Object.assign({}, tx),
    enqueue(name) {
      calls.push(['transcribe', name]);
      if (tx.queue.includes(name) || tx.current?.name === name) return { ok: false, error: 'already queued' };
      if (options.rejectTx) return { ok: false, error: 'not found' };
      tx.queue.push(name);
      return { ok: true };
    },
  };
  const analyzer = {
    getState: () => Object.assign({}, an),
    clearQueue() { calls.push(['clearAnalysisQueue']); return an.queue.splice(0).length; },
    start(name, kind) {
      calls.push(['analyze', name, kind]);
      if (options.rejectAn) return { ok: false, error: 'not found' };
      an.queue.push(name);
      return { ok: true };
    },
  };
  const batch = createMeetingBatch({ library, transcriber, analyzer, now: options.now || (() => 123),
    getBusyFiles: options.getBusyFiles,
    pollMs: 1,
    sleep: async () => {
      ticks++;
      if (ticks > 20) throw new Error('test queue did not drain');
      if (options.tick) options.tick({ tx, an, ticks, calls });
      else {
        tx.completed += tx.queue.splice(0).length;
        an.completed += an.queue.splice(0).length;
      }
    },
  });
  return { batch, calls, tx, an };
}

async function finish(batch) {
  for (let i = 0; i < 100 && batch.getState().running; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(batch.getState().running, false);
  return batch.getState();
}

const listing = (files = [], dirs = []) => ({ ok: true, files, dirs, meetings: files });
const transcript = name => ({ name, jsonName: name, analyzed: false });

test('waits for transcription and post hook, then analyzes every flat transcribed row', async () => {
  let created = false;
  const s = setup({
    list: (kind, dir) => {
      assert.equal(dir, '');
      if (kind === 'unprocessed') return listing([{ name: 'new.WAV' }, { name: 'new.json' }]);
      assert.equal(kind, 'transcribed', 'never scans completed or date/archive folders');
      assert.equal(created, true, 'scan waits for transcription and its post hook');
      return Object.assign(listing([transcript('new-diarizer-response.json'), transcript('old-diarizer-response.json')], ['2026']), { byDate: true });
    },
    tick: ({ tx, an, ticks }) => {
      if (ticks === 1) { tx.completed++; tx.queue = []; tx.phase = 'post'; }
      else if (ticks === 2) { tx.phase = null; created = true; }
      else an.completed += an.queue.splice(0).length;
    },
  });
  assert.equal(s.batch.start().phase, 'transcribing');
  const st = await finish(s.batch);
  assert.deepEqual([st.phase, st.transcribed, st.analyzed], ['done', 1, 2]);
  assert.deepEqual(s.calls.filter(c => c[0] === 'analyze'), [
    ['analyze', 'new-diarizer-response.json', 'transcribed'], ['analyze', 'old-diarizer-response.json', 'transcribed'],
  ]);
  assert.deepEqual(s.calls.filter(c => c[0] === 'list'), [['list', 'unprocessed', ''], ['list', 'transcribed', '']]);
});

test('logical transcribed rows drive Batch; raw files and completed notes are never analyzed', async () => {
  const s = setup({ list: kind => kind === 'unprocessed' ? listing() : Object.assign(listing([
    transcript('raw-diarizer-response.json'),
  ]), { meetings: [
    transcript('todo-diarizer-response.json'),
    { name: 'done-diarizer-response.json', jsonName: 'done-diarizer-response.json', analyzed: true },
    { name: 'readonly-diarizer-response.json', jsonName: 'readonly-diarizer-response.json', analyzed: false, readOnly: true },
    { name: 'notes.md', jsonName: null, analyzed: false },
  ] }) });
  s.batch.start();
  assert.equal((await finish(s.batch)).analyzed, 1);
  assert.deepEqual(s.calls.filter(c => c[0] === 'analyze'), [['analyze', 'todo-diarizer-response.json', 'transcribed']]);
});

test('no WAVs still analyzes stragglers; a second click shares the active batch', async () => {
  const s = setup({ list: kind => kind === 'unprocessed' ? listing() : listing([transcript('old-diarizer-response.json')]) });
  assert.deepEqual(s.batch.start(), s.batch.start());
  assert.equal((await finish(s.batch)).analyzed, 1);
  assert.equal(s.calls.filter(c => c[0] === 'analyze').length, 1);
  const copy = s.batch.getState();
  copy.phase = 'broken';
  assert.equal(s.batch.getState().phase, 'done');
});

test('empty batch completes and can be started again', async () => {
  const s = setup();
  s.batch.start();
  let st = await finish(s.batch);
  assert.deepEqual([st.phase, st.transcribed, st.analyzed, st.startedAt, st.finishedAt], ['done', 0, 0, 123, 123]);
  s.batch.start();
  st = await finish(s.batch);
  assert.equal(st.phase, 'done');
  assert.equal(s.calls.filter(c => c[0] === 'list').length, 4);
});

test('counts all failures between polls and continues analysis after failed transcription', async () => {
  const s = setup({
    list: kind => kind === 'unprocessed' ? listing([{ name: 'a.wav' }]) : listing([transcript('old-diarizer-response.json')]),
    tick: ({ tx, an }) => {
      if (tx.queue.length) { tx.queue = []; tx.failed += 35; tx.completed += 40; }
      if (an.queue.length) { an.queue = []; an.failed += 4; an.completed += 3; }
    },
  });
  s.batch.start();
  const st = await finish(s.batch);
  assert.deepEqual([st.phase, st.transcribed, st.transcribeErrors, st.analyzed, st.analyzeErrors, st.error],
    ['done', 40, 35, 3, 4, null]);
});

test('waits for existing current jobs, pre/waiting hooks and analysis jobs, without duplicate failure', async () => {
  const s = setup({
    list: kind => kind === 'unprocessed' ? listing([{ name: 'active.wav' }]) : listing(),
    tick: ({ tx, an, ticks }) => {
      if (ticks === 1) tx.phase = 'waiting';
      if (ticks === 2) { tx.phase = null; tx.current = { name: 'active.wav' }; }
      if (ticks === 3) { tx.current = null; tx.completed++; }
      if (ticks === 4) { an.running = false; an.completed++; }
    },
  });
  s.tx.current = { name: 'active.wav' };
  s.tx.phase = 'pre';
  s.an.running = true;
  s.batch.start();
  const st = await finish(s.batch);
  assert.deepEqual([st.transcribed, st.transcribeErrors, st.analyzed], [1, 0, 1]);
});

test('enqueue rejections are counted and do not abort remaining stages', async () => {
  const s = setup({ rejectTx: true, rejectAn: true,
    list: kind => kind === 'unprocessed' ? listing([{ name: 'gone.wav' }]) : listing([transcript('gone-diarizer-response.json')]),
  });
  s.batch.start();
  const st = await finish(s.batch);
  assert.deepEqual([st.phase, st.transcribeErrors, st.analyzeErrors], ['done', 1, 1]);
});

test('active and finalizing recordings stay for the next batch without counting as errors', async () => {
  let busy = ['active.wav', 'finalizing.wav'];
  const s = setup({ getBusyFiles: () => busy,
    list: kind => kind === 'unprocessed'
      ? listing([{ name: 'active.wav' }, { name: 'finalizing.wav' }, { name: 'ready.wav' }]) : listing(),
  });
  s.batch.start();
  let st = await finish(s.batch);
  assert.deepEqual(s.calls.filter(c => c[0] === 'transcribe').map(c => c[1]), ['ready.wav']);
  assert.deepEqual([st.transcribed, st.transcribeErrors], [1, 0]);
  busy = [];
  s.batch.start();
  st = await finish(s.batch);
  assert.deepEqual([st.transcribed, st.transcribeErrors], [3, 0]);
});

test('listing failure ends with coordinator error and permits retry', async () => {
  let fail = true;
  const s = setup({ list: () => {
    if (fail) throw new Error('library unavailable');
    return listing();
  } });
  s.batch.start();
  assert.equal((await finish(s.batch)).error, 'library unavailable');
  assert.equal(s.batch.getState().phase, 'error');
  fail = false;
  s.batch.start();
  assert.equal((await finish(s.batch)).phase, 'done');
  assert.equal(s.batch.getState().error, null);
});

test('new authentication failure halts batch and clears pending analysis, without cancelling active job', async () => {
  let failAuth = true;
  const s = setup({
    list: kind => kind === 'unprocessed' ? listing() : listing([
      transcript('a-diarizer-response.json'), transcript('b-diarizer-response.json'), transcript('c-diarizer-response.json'),
    ]),
    tick: ({ an }) => {
      if (failAuth) {
        an.failed++;
        an.queue.shift();
        an.running = true;   // queue pump may already have started another job by the next poll
        an.error = { authRequired: true, finishedAt: 123,
          error: 'Claude needs sign-in. On this PC run: claude auth login — then try again.' };
      } else {
        an.completed += an.queue.splice(0).length;
        an.running = false;
        an.error = null;
      }
    },
  });
  s.batch.start();
  let st = await finish(s.batch);
  assert.deepEqual([st.phase, st.halted, st.analyzed, st.analyzeErrors], ['error', true, 0, 1]);
  assert.equal(st.error, 'Claude needs sign-in. On this PC run: claude auth login');
  assert.deepEqual(s.an.queue, []);
  assert.equal(s.an.running, true, 'queue clearing does not claim to cancel the active job');
  assert.equal(s.calls.filter(c => c[0] === 'clearAnalysisQueue').length, 1);
  failAuth = false;
  s.an.running = false;
  s.batch.start();
  st = await finish(s.batch);
  assert.deepEqual([st.phase, st.halted, st.error, st.analyzed, st.analyzeErrors], ['done', false, null, 3, 0]);
});

test('a stale auth marker, even with the same timestamp, does not halt a fresh analysis stage', async () => {
  const s = setup({ list: kind => kind === 'unprocessed' ? listing() : listing([transcript('a-diarizer-response.json')]) });
  s.an.error = { authRequired: true, finishedAt: 123 };
  s.batch.start();
  const st = await finish(s.batch);
  assert.deepEqual([st.phase, st.halted, st.analyzed], ['done', false, 1]);
  assert.equal(s.calls.some(c => c[0] === 'clearAnalysisQueue'), false);
});

test('halting another provider preserves its sign-in guidance', async () => {
  const message = 'Codex needs sign-in. Sign in to it on this PC, then try again.';
  const s = setup({
    list: kind => kind === 'unprocessed' ? listing() : listing([transcript('a-diarizer-response.json')]),
    tick: ({ an }) => {
      an.failed++;
      an.queue.shift();
      an.error = { authRequired: true, finishedAt: 123, error: message };
    },
  });
  s.batch.start();
  const st = await finish(s.batch);
  assert.equal(st.halted, true);
  assert.equal(st.error, message);
});
