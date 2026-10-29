'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMeetingBatch } = require('../app/meetingBatch');

// Fake services: one poll tick (the coordinator's sleep) starts the queue head, the next tick
// settles it through onOutcome — so rows pass through queued → running → done/failed as they do
// in the real services, and a Cancel can land between any two ticks.
function fakeService(kindOf) {
  const svc = { queue: [], current: null, phase: null, listeners: [], calls: [], outcomes: {} };
  svc.onOutcome = listener => { svc.listeners.push(listener); return () => { svc.listeners = svc.listeners.filter(l => l !== listener); }; };
  svc.emit = ev => { for (const l of svc.listeners.slice()) l(Object.assign({}, ev)); };
  svc.step = (at) => {
    if (svc.phase) return;
    if (svc.current) {
      const o = svc.outcomes[svc.current.name] || { status: 'done' };
      const ev = Object.assign({ name: svc.current.name, finishedAt: at, error: null }, kindOf(svc.current), o);
      svc.current = null;
      svc.emit(ev);
    } else if (svc.queue.length) {
      svc.current = Object.assign({ startedAt: at }, svc.queue.shift());
    }
  };
  return svc;
}

function setup(options = {}) {
  const calls = [];
  let t = 1000;
  const now = () => t;
  const tx = fakeService(() => ({}));
  const an = fakeService(cur => ({ kind: cur.kind }));
  const library = {
    listFiles(kind, dir) {
      calls.push(['list', kind, dir || '']);
      return options.list ? options.list(kind, dir || '') : { ok: true, dirs: [], files: [], meetings: [] };
    },
  };
  const transcriber = {
    onOutcome: tx.onOutcome,
    getState: () => ({ phase: tx.phase, current: tx.current ? { name: tx.current.name, startedAt: tx.current.startedAt } : null, queue: tx.queue.map(q => q.name) }),
    enqueue(name) {
      calls.push(['transcribe', name]);
      if (options.enqueueHook && options.enqueueHook(name, tx) === false) return { ok: false, error: 'not found' };
      if (tx.queue.some(q => q.name === name) || (tx.current && tx.current.name === name)) return { ok: false, error: 'already queued' };
      if (options.rejectTx) return { ok: false, error: 'not found' };
      tx.queue.push({ name });
      return { ok: true };
    },
    clearQueue(names) { calls.push(['clearTranscribe', names.slice()]); const before = tx.queue.length; tx.queue = tx.queue.filter(q => !names.includes(q.name)); return before - tx.queue.length; },
  };
  const analyzer = {
    onOutcome: an.onOutcome,
    getState: () => ({ running: !!an.current, name: an.current ? an.current.name : null, kind: an.current ? an.current.kind : null,
      startedAt: an.current ? an.current.startedAt : null, queue: an.queue.map(q => ({ name: q.name, kind: q.kind })) }),
    start(name, kind) {
      calls.push(['analyze', name, kind]);
      if (options.rejectAn) return { ok: false, error: 'not found' };
      an.queue.push({ name, kind });
      return { ok: true };
    },
    clearQueue(names, kind) { calls.push(['clearAnalyze', names.slice(), kind]); const before = an.queue.length; an.queue = an.queue.filter(q => !(q.kind === kind && names.includes(q.name))); return before - an.queue.length; },
  };
  let ticks = 0;
  const batch = createMeetingBatch({ library, transcriber, analyzer, now, getBusyFiles: options.getBusyFiles, pollMs: 1,
    sleep: async () => {
      ticks++; t += 10;
      if (ticks > 60) throw new Error('test queue did not drain');
      if (options.tick) options.tick({ tx, an, ticks, calls, batch, t });
      tx.step(t); an.step(t);
    },
  });
  return { batch, calls, tx, an, clock: () => t };
}

async function finish(batch) {
  for (let i = 0; i < 400 && batch.getState().running; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(batch.getState().running, false);
  return batch.getState();
}

const wav = (name, size = 1000) => ({ name, size });
const row = name => ({ name, analyzed: false, readOnly: false, jsonName: name });
const listing = (files = [], meetings = []) => ({ ok: true, files, dirs: [], meetings });
const names = (st, stage) => st.items.filter(it => it.stage === stage).map(it => it.name + ':' + it.status);

test('transcribes every WAV, then analyzes every Not-analyzed row; the ledger keeps every outcome in order', async () => {
  const { batch, calls, tx } = setup({
    list: kind => kind === 'unprocessed' ? listing([wav('a.wav'), wav('b.wav'), wav('notes.txt')])
      : listing([], [row('a-diarizer-response.json'), row('b-diarizer-response.json'), { name: 'old-diarizer-response.json', analyzed: true, jsonName: 'x' }]),
  });
  tx.outcomes['b.wav'] = { status: 'error', error: 'upload failed: 502' };
  const first = batch.start();
  assert.equal(first.running, true);
  assert.equal(first.phase, 'transcribing');
  assert.deepEqual(first.items, []);          // the scan happens after start() returns
  const st = await finish(batch);
  assert.equal(st.phase, 'done');
  assert.deepEqual(names(st, 'transcribe'), ['a.wav:done', 'b.wav:failed']);
  assert.deepEqual(names(st, 'analyze'), ['a-diarizer-response.json:done', 'b-diarizer-response.json:done']);
  assert.equal(st.items[1].error, 'upload failed: 502');
  assert.deepEqual(st.counts, { transcribe: { total: 2, done: 1, failed: 1, notStarted: 0 }, analyze: { total: 2, done: 2, failed: 0, notStarted: 0 } });
  assert.equal(st.transcribed, 1); assert.equal(st.transcribeErrors, 1); assert.equal(st.analyzed, 2); assert.equal(st.analyzeErrors, 0);
  assert.equal(st.last.name, 'b-diarizer-response.json');
  assert.equal(st.now, null); assert.equal(st.next, null);
  assert.deepEqual(calls.filter(c => c[0] === 'analyze'), [['analyze', 'a-diarizer-response.json', 'transcribed'], ['analyze', 'b-diarizer-response.json', 'transcribed']]);
});

test('last / now / next follow the queue while it runs, and the elapsed clock comes from the service', async () => {
  const seen = [];
  const { batch } = setup({
    list: kind => kind === 'unprocessed' ? listing([wav('a.wav'), wav('b.wav'), wav('c.wav')]) : listing(),
    tick: ({ batch }) => { const s = batch.getState(); seen.push([s.last && s.last.name, s.now && s.now.name, s.now && s.now.startedAt, s.next && (s.next.name || s.next.stage)]); },
  });
  batch.start();
  await finish(batch);
  // The fake settles a job on one tick and starts the next on the following one, so every file
  // shows an idle gap: nothing running, the next file still queued. Once the last WAV runs, the
  // analysis stage is what comes next (the stage ends on c's outcome without another poll).
  assert.deepEqual(seen.slice(0, 6), [
    [null, null, null, 'a.wav'],
    [null, 'a.wav', 1010, 'b.wav'],
    ['a.wav', null, null, 'b.wav'],
    ['a.wav', 'b.wav', 1030, 'c.wav'],
    ['b.wav', null, null, 'c.wav'],
    ['b.wav', 'c.wav', 1050, 'analyze'],
  ]);
});

test('a job already queued by hand is adopted; a stranger in the queue is shown but never waited on', async () => {
  let mid = null;
  const { batch, tx, calls } = setup({
    list: kind => kind === 'unprocessed' ? listing([wav('mine.wav')]) : listing(),
    tick: ({ ticks, batch }) => { if (ticks === 2) mid = batch.getState(); },   // theirs.wav is running
  });
  tx.queue.push({ name: 'theirs.wav' }, { name: 'mine.wav' });   // started from the Unprocessed screen
  batch.start();
  const st = await finish(batch);
  assert.equal(mid.now.name, 'theirs.wav'); assert.equal(mid.now.mine, false);
  assert.deepEqual(names(mid, 'transcribe'), ['mine.wav:queued']);
  assert.deepEqual(names(st, 'transcribe'), ['mine.wav:done']);
  assert.equal(calls.filter(c => c[0] === 'transcribe').length, 1);
});

test('an outcome delivered synchronously inside enqueue finds its row and is not overwritten', async () => {
  const { batch, tx } = setup({
    list: kind => kind === 'unprocessed' ? listing([wav('a.wav'), wav('b.wav')]) : listing(),
    enqueueHook: (name, svc) => { if (name === 'a.wav') { svc.emit({ name, status: 'error', error: 'meeting folders misconfigured', finishedAt: 999 }); return false; } },
  });
  tx.outcomes['b.wav'] = { status: 'done' };
  batch.start();
  const st = await finish(batch);
  assert.deepEqual(names(st, 'transcribe'), ['a.wav:failed', 'b.wav:done']);
  assert.equal(st.items[0].error, 'meeting folders misconfigured');
});

test('cancel during transcription drops the pending jobs, lets the running one settle, lists what analysis would have done', async () => {
  const { batch, calls, tx } = setup({
    list: kind => kind === 'unprocessed' ? listing([wav('a.wav'), wav('b.wav'), wav('c.wav')]) : listing([], [row('a-diarizer-response.json')]),
    // tick 1 starts a, tick 2 settles a, tick 3 starts b; the cancel lands with b running
    tick: ({ ticks, tx, batch }) => { if (ticks === 4) { assert.equal(tx.current.name, 'b.wav'); const s = batch.cancel(); assert.equal(s.phase, 'cancelling'); assert.equal(s.cancelRequested, true); } },
  });
  tx.outcomes['b.wav'] = { status: 'error', error: 'timed out after 60 min' };
  batch.start();
  const st = await finish(batch);
  assert.equal(st.phase, 'cancelled');
  assert.deepEqual(names(st, 'transcribe'), ['a.wav:done', 'b.wav:failed', 'c.wav:notStarted']);
  assert.deepEqual(names(st, 'analyze'), ['a-diarizer-response.json:notStarted']);
  assert.deepEqual(calls.filter(c => c[0] === 'clearTranscribe'), [['clearTranscribe', ['c.wav']]]);
  assert.equal(calls.filter(c => c[0] === 'analyze').length, 0, 'the analysis stage never starts after a cancel');
  assert.deepEqual(st.counts.transcribe, { total: 3, done: 1, failed: 1, notStarted: 1 });
});

test('cancel between polls keeps the job that just started: it is not dropped and the summary waits for it', async () => {
  const { batch, calls, tx } = setup({
    list: kind => kind === 'unprocessed' ? listing([wav('a.wav'), wav('b.wav'), wav('c.wav')]) : listing(),
    tick: ({ ticks, tx, batch }) => {
      if (ticks === 3) {
        tx.step(2000); tx.step(2001);   // a settles and b starts before the coordinator polls again
        batch.cancel();
        assert.equal(tx.current.name, 'b.wav', 'the running job is untouched');
      }
    },
  });
  batch.start();
  const st = await finish(batch);
  assert.deepEqual(names(st, 'transcribe'), ['a.wav:done', 'b.wav:done', 'c.wav:notStarted']);
  assert.deepEqual(calls.filter(c => c[0] === 'clearTranscribe'), [['clearTranscribe', ['c.wav']]]);
  assert.equal(tx.queue.length, 0);
});

test('the same between-polls start during analysis keeps the transcribed job that just began', async () => {
  const { batch, calls, an } = setup({
    list: kind => kind === 'unprocessed' ? listing() : listing([], [row('a-diarizer-response.json'), row('b-diarizer-response.json'), row('c-diarizer-response.json')]),
    tick: ({ ticks, an, batch }) => {
      if (ticks === 3) {
        an.step(2000); an.step(2001);   // a settles and b starts before the coordinator polls again
        batch.cancel();
        assert.equal(an.current.name, 'b-diarizer-response.json');
      }
    },
  });
  batch.start();
  const st = await finish(batch);
  assert.deepEqual(names(st, 'analyze'), ['a-diarizer-response.json:done', 'b-diarizer-response.json:done', 'c-diarizer-response.json:notStarted']);
  assert.deepEqual(calls.filter(c => c[0] === 'clearAnalyze'), [['clearAnalyze', ['c-diarizer-response.json'], 'transcribed']]);
});

test('cancel right after start, before anything was queued, lists every file as not started', async () => {
  const { batch, calls } = setup({ list: kind => kind === 'unprocessed' ? listing([wav('a.wav')]) : listing([], [row('t-diarizer-response.json')]) });
  batch.start();
  batch.cancel();
  const st = await finish(batch);
  assert.equal(st.phase, 'cancelled');
  assert.deepEqual(names(st, 'transcribe'), ['a.wav:notStarted']);
  assert.deepEqual(names(st, 'analyze'), ['t-diarizer-response.json:notStarted']);
  assert.equal(calls.filter(c => c[0] === 'transcribe' || c[0] === 'analyze').length, 0);
});

test('cancel during analysis drops only this batch\'s transcribed jobs and settles the running one', async () => {
  const { batch, calls, an } = setup({
    list: kind => kind === 'unprocessed' ? listing() : listing([], [row('a-diarizer-response.json'), row('b-diarizer-response.json'), row('c-diarizer-response.json')]),
    tick: ({ ticks, an, batch }) => {
      if (ticks === 1) an.queue.push({ name: 'manual.md', kind: 'processed' });   // a re-analysis started from Completed
      if (ticks === 4) { assert.equal(an.current.name, 'b-diarizer-response.json'); batch.cancel(); }
    },
  });
  an.outcomes['b-diarizer-response.json'] = { status: 'done', warning: 'committed, with leftovers' };
  batch.start();
  const st = await finish(batch);
  assert.equal(st.phase, 'cancelled');
  assert.deepEqual(names(st, 'analyze'), ['a-diarizer-response.json:done', 'b-diarizer-response.json:done', 'c-diarizer-response.json:notStarted']);
  assert.equal(st.items[1].note, 'committed, with leftovers');
  assert.deepEqual(calls.filter(c => c[0] === 'clearAnalyze'), [['clearAnalyze', ['c-diarizer-response.json'], 'transcribed']]);
  assert.equal(an.queue.some(q => q.name === 'manual.md'), true, 'the manual job stays queued');
});

test('a sign-in failure halts the batch: pending analyses are dropped, the ledger stays, the error names the fix', async () => {
  const { batch, calls, an } = setup({
    list: kind => kind === 'unprocessed' ? listing() : listing([], [row('a-diarizer-response.json'), row('b-diarizer-response.json'), row('c-diarizer-response.json')]),
  });
  an.outcomes['a-diarizer-response.json'] = { status: 'error', error: 'Claude needs sign-in. On this PC run: claude auth login — then try again.', authRequired: true };
  batch.start();
  const st = await finish(batch);
  assert.equal(st.phase, 'error'); assert.equal(st.halted, true);
  assert.equal(st.error, 'Claude needs sign-in. On this PC run: claude auth login');
  assert.deepEqual(names(st, 'analyze'), ['a-diarizer-response.json:failed', 'b-diarizer-response.json:notStarted', 'c-diarizer-response.json:notStarted']);
  assert.deepEqual(calls.filter(c => c[0] === 'clearAnalyze'), [['clearAnalyze', ['b-diarizer-response.json', 'c-diarizer-response.json'], 'transcribed']]);
  assert.equal(an.queue.length, 0);
  // A later batch is a fresh run: the stale halt does not carry over.
  const again = batch.start();
  assert.equal(again.halted, false);
  await finish(batch);
});

test('an empty first batch completes; an empty batch after a summary keeps that summary', async () => {
  let files = [wav('a.wav')];
  const { batch } = setup({ list: kind => kind === 'unprocessed' ? listing(files) : listing() });
  const empty = setup({ list: () => listing() });
  empty.batch.start();
  const e = await finish(empty.batch);
  assert.equal(e.phase, 'done'); assert.deepEqual(e.items, []);

  batch.start();
  const first = await finish(batch);
  assert.deepEqual(names(first, 'transcribe'), ['a.wav:done']);
  files = [];
  const again = batch.start();
  assert.equal(again.empty, true);
  assert.equal(again.running, false);
  assert.deepEqual(names(again, 'transcribe'), ['a.wav:done'], 'the previous summary is still there');
});

test('a second tap while running returns the live state instead of starting over', async () => {
  const { batch } = setup({ list: kind => kind === 'unprocessed' ? listing([wav('a.wav')]) : listing(), tick: ({ batch }) => { const s = batch.start(); assert.equal(s.running, true); } });
  batch.start();
  const st = await finish(batch);
  assert.deepEqual(names(st, 'transcribe'), ['a.wav:done']);
});

test('enqueue rejections become failed rows and do not stop the rest; recorder-busy and header-only files are left out', async () => {
  const { batch } = setup({
    list: kind => kind === 'unprocessed' ? listing([wav('a.wav'), wav('live.wav'), wav('empty.wav', 44), wav('b.wav')]) : listing(),
    getBusyFiles: () => ['live.wav'],
    enqueueHook: name => name === 'a.wav' ? false : undefined,
  });
  batch.start();
  const st = await finish(batch);
  assert.deepEqual(names(st, 'transcribe'), ['a.wav:failed', 'b.wav:done']);
  assert.equal(st.items[0].error, 'not found');
  assert.equal(st.phase, 'done');
});

test('hook phases hold the stage and show as the current step', async () => {
  const seen = [];
  const { batch } = setup({
    list: kind => kind === 'unprocessed' ? listing([wav('a.wav')]) : listing(),
    tick: ({ ticks, tx, batch }) => {
      if (ticks === 1) tx.phase = 'pre';
      if (ticks === 2) tx.phase = 'waiting';
      if (ticks === 3) tx.phase = null;
      const n = batch.getState().now; seen.push(n ? n.step : null);
    },
  });
  batch.start();
  await finish(batch);
  // the hook runs before each step: pre, waiting, then idle (nothing started yet), then a.wav transcribing
  assert.deepEqual(seen.slice(0, 4), ['starting server', 'waiting for server', null, 'transcribing']);
});

test('a listing failure ends with an error and permits a retry', async () => {
  let fail = true;
  const { batch } = setup({ list: kind => fail ? { ok: false, error: 'disk gone' } : listing() });
  const st = batch.start();
  assert.equal(st.running, false); assert.equal(st.phase, 'error'); assert.equal(st.error, 'disk gone');
  fail = false;
  batch.start();
  assert.equal((await finish(batch)).phase, 'done');
});
