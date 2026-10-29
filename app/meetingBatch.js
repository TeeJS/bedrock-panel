'use strict';

// Main-process orchestration survives panel reloads. The coordinator keeps a ledger of the files
// it enqueued, in scheduled order; each file's outcome arrives through the services' onOutcome
// hooks (never from their 20-entry recent lists), so a long batch keeps every error. Cancel is
// cooperative: pending ledger jobs leave the queues, the running job finishes, then the summary
// is final. State lasts for this application session, not a restart.
function createMeetingBatch(deps) {
  const { library, transcriber, analyzer } = deps;
  const now = deps.now || Date.now;
  const pollMs = deps.pollMs === undefined ? 1000 : deps.pollMs;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const getBusyFiles = deps.getBusyFiles || (() => []);
  const fresh = () => ({
    ok: true, running: false, phase: 'idle', startedAt: null, finishedAt: null,
    cancelRequested: false, halted: false, error: null,
  });
  let state = fresh();
  let items = [];           // ledger: { name, stage, status, error, note, startedAt, finishedAt }
  let activeStage = null;   // 'transcribe' | 'analyze' while a stage runs or cancels
  let unsubscribe = [];

  // ---- ledger helpers ----
  const STEP_FOR_PHASE = { pre: 'starting server', waiting: 'waiting for server', post: 'stopping server' };
  const open = it => it.status === 'queued' || it.status === 'running';
  const mine = (stage, name) => !!name && items.some(it => it.stage === stage && it.name === name && open(it));
  const pending = stage => items.filter(it => it.stage === stage && it.status === 'queued').map(it => it.name);

  function tally(stage) {
    const t = { total: 0, done: 0, failed: 0, notStarted: 0, skipped: 0 };
    for (const it of items) {
      if (it.stage !== stage) continue;
      if (it.status === 'skipped') { t.skipped++; continue; }   // listed, not part of the batch's work
      t.total++;
      if (it.status === 'done') t.done++;
      else if (it.status === 'failed') t.failed++;
      else if (it.status === 'notStarted') t.notStarted++;
    }
    return t;
  }

  function last() {
    let best = null;
    for (const it of items) {
      if (it.status !== 'done' && it.status !== 'failed') continue;
      if (!best || it.finishedAt >= best.finishedAt) best = it;
    }
    return best ? Object.assign({}, best) : null;
  }

  function next() {
    const it = items.find(i => i.status === 'queued');
    if (it) return { name: it.name, stage: it.stage };
    // Last transcription running: the analysis stage is what comes next.
    if (state.phase === 'transcribing' && !state.cancelRequested) return { name: null, stage: 'analyze' };
    return null;
  }

  // What the active service is doing right now, from its live state: a job the batch did not
  // queue (started by hand from a screen) still shows, flagged, because it holds the queue.
  function current() {
    if (!state.running) return null;
    if (activeStage === 'transcribe') {
      const s = transcriber.getState();
      if (s.phase && STEP_FOR_PHASE[s.phase]) return { name: null, stage: 'transcribe', step: STEP_FOR_PHASE[s.phase], startedAt: null, mine: true };
      if (s.current) return { name: s.current.name, stage: 'transcribe', step: 'transcribing', startedAt: s.current.startedAt || null, mine: mine('transcribe', s.current.name) };
      return null;
    }
    if (activeStage === 'analyze') {
      const s = analyzer.getState();
      if (s.running) return { name: s.name, stage: 'analyze', step: 'analyzing', startedAt: s.startedAt || null, mine: s.kind === 'transcribed' && mine('analyze', s.name) };
    }
    return null;
  }

  function getState() {
    const transcribe = tally('transcribe');
    const analyze = tally('analyze');
    return Object.assign({}, state, {
      // the topbar's counts; same numbers as the ledger
      transcribed: transcribe.done, transcribeErrors: transcribe.failed,
      analyzed: analyze.done, analyzeErrors: analyze.failed,
      counts: { transcribe, analyze },
      last: last(),
      now: current(),
      next: next(),
      items: items.map(it => Object.assign({}, it)),
    });
  }

  // ---- outcomes ----
  function settle(stage, ev) {
    const it = items.find(i => i.stage === stage && i.name === ev.name && open(i));
    if (!it) return;   // a job queued by hand, or a repeat
    it.status = ev.status === 'done' ? 'done' : 'failed';
    it.error = it.status === 'failed' ? String(ev.error || 'failed') : null;
    it.note = ev.warning ? String(ev.warning) : null;
    it.finishedAt = ev.finishedAt || now();
    if (stage === 'analyze' && ev.authRequired && !state.halted) {
      // The CLI needs sign-in: every further analysis would fail the same way. Pending jobs leave
      // the queue; an already running job has no cancellation API.
      dropPending('analyze');
      state.halted = true;
      state.phase = 'error';
      state.error = String(ev.error || 'Analysis needs sign-in. Sign in on this PC, then try again.')
        .replace(/ — then try again\.$/, '');
    }
  }

  function listen() {
    const on = (service, stage, filter) => (typeof service.onOutcome === 'function')
      ? service.onOutcome(ev => { if (ev && (!filter || filter(ev))) settle(stage, ev); })
      : () => {};
    unsubscribe = [
      on(transcriber, 'transcribe'),
      on(analyzer, 'analyze', ev => !ev.kind || ev.kind === 'transcribed'),
    ];
  }

  function unlisten() {
    for (const off of unsubscribe) { try { off(); } catch (e) { /* listener already gone */ } }
    unsubscribe = [];
  }

  // Remove this batch's queued jobs from a service and mark them not started. The running job
  // is never touched; it settles through its outcome like any other. The service's live state
  // decides which job that is — a job may have started since the last poll.
  function dropPending(stage) {
    let runningName = null;
    if (stage === 'transcribe') {
      const s = transcriber.getState();
      if (s.current) { runningName = s.current.name; markRunning(stage, s.current.name, s.current.startedAt); }
    } else {
      const s = analyzer.getState();
      if (s.running && s.kind === 'transcribed') { runningName = s.name; markRunning(stage, s.name, s.startedAt); }
    }
    const names = pending(stage).filter(n => n !== runningName);
    if (names.length) {
      if (stage === 'transcribe' && typeof transcriber.clearQueue === 'function') transcriber.clearQueue(names);
      if (stage === 'analyze') analyzer.clearQueue(names, 'transcribed');
    }
    for (const it of items) {
      if (it.stage === stage && it.status === 'queued' && it.name !== runningName) { it.status = 'notStarted'; it.finishedAt = now(); }
    }
  }

  // ---- stages ----
  function list(kind, dir) {
    const result = library.listFiles(kind, dir);
    if (!result || !result.ok) throw new Error((result && result.error) || 'could not list meetings');
    return result;
  }

  function transcripts() {
    // Same flat logical rows as the Analysis screen; no completed/archive scan.
    const result = list('transcribed', '');
    return (result.meetings || []).filter(file => /-diarizer-response\.json$/i.test(file.name)
      && file.analyzed === false && !file.readOnly && !!file.jsonName).map(file => file.name);
  }

  function wavs() {
    const busy = new Set(getBusyFiles());
    const names = [], skipped = [];
    for (const file of list('unprocessed').files) {
      if (!/\.wav$/i.test(file.name)) continue;
      // A recording still being written stays for the next batch; a 44-byte WAV is the recorder's
      // header alone (a capture that never got audio) and could only fail upload. Both are listed
      // as skipped, with the reason, so the page says why a file the Unprocessed screen shows is
      // not in the batch.
      if (busy.has(file.name)) skipped.push({ name: file.name, note: 'recording still being written' });
      else if (file.size === 44) skipped.push({ name: file.name, note: 'empty recording, no audio' });
      else names.push(file.name);
    }
    return { names, skipped };
  }

  function markRunning(stage, name, startedAt) {
    const it = items.find(i => i.stage === stage && i.name === name && i.status === 'queued');
    if (it) { it.status = 'running'; it.startedAt = startedAt || now(); }
  }

  async function stage(name, names, enqueue, busy) {
    activeStage = name;
    for (const file of new Set(names)) {
      const it = { name: file, stage: name, status: 'queued', error: null, note: null, startedAt: null, finishedAt: null };
      items.push(it);
      // Cancelled before this stage queued anything: list the file, never start it.
      if (state.cancelRequested) { it.status = 'notStarted'; it.finishedAt = now(); continue; }
      // The row exists before enqueue: a service may settle the job synchronously (its folder
      // check fails the whole queue at once) and that outcome must find its row.
      let result;
      try { result = enqueue(file); } catch (e) { result = { ok: false, error: (e && e.message) || 'could not queue' }; }
      // A job already queued by hand for the same file is adopted: the screen would run it anyway.
      const queued = result && (result.ok || result.error === 'already queued');
      if (!queued && open(it)) { it.status = 'failed'; it.error = (result && result.error) || 'could not queue'; it.finishedAt = now(); }
    }
    for (;;) {
      const s = busy();
      if (!s) return;
      await sleep(pollMs);
      if (state.halted) return;
    }
  }

  function transcribeBusy() {
    const s = transcriber.getState();
    if (s.current) markRunning('transcribe', s.current.name, s.current.startedAt);
    // Hook phases hold the server for everyone; otherwise only this batch's own jobs count.
    return !!s.phase || mine('transcribe', s.current && s.current.name) || (s.queue || []).some(n => mine('transcribe', n));
  }

  function analyzeBusy() {
    const s = analyzer.getState();
    if (s.running && s.kind === 'transcribed') markRunning('analyze', s.name, s.startedAt);
    return (!!s.running && s.kind === 'transcribed' && mine('analyze', s.name))
      || (s.queue || []).some(q => q.kind === 'transcribed' && mine('analyze', q.name));
  }

  async function run(work) {
    try {
      listen();
      for (const file of work.wavs.skipped) items.push({ name: file.name, stage: 'transcribe', status: 'skipped', error: null, note: file.note, startedAt: null, finishedAt: now() });
      await stage('transcribe', work.wavs.names, name => transcriber.enqueue(name), transcribeBusy);
      if (state.cancelRequested) {
        // What the analysis stage would have picked up: listed so the summary is complete.
        for (const name of transcripts()) items.push({ name, stage: 'analyze', status: 'notStarted', error: null, note: null, startedAt: null, finishedAt: now() });
        state.phase = 'cancelled';
        return;
      }
      state.phase = 'analyzing';
      await stage('analyze', transcripts(), name => analyzer.start(name, 'transcribed'), analyzeBusy);
      if (state.halted) return;
      state.phase = state.cancelRequested ? 'cancelled' : 'done';
    } catch (e) {
      state.phase = 'error';
      state.error = (e && e.message) || 'batch failed';
    } finally {
      unlisten();
      activeStage = null;
      state.running = false;
      state.finishedAt = now();
    }
  }

  function start() {
    if (state.running) return getState();
    let work;
    try { work = { wavs: wavs(), transcripts: transcripts() }; }
    catch (e) {
      state = Object.assign(fresh(), { phase: 'error', error: (e && e.message) || 'batch failed', startedAt: now(), finishedAt: now() });
      items = [];
      return getState();
    }
    // Nothing to do: keep the previous summary on the page instead of replacing it with an
    // empty one. A first-ever Batch still records an empty run so the page has something to say.
    if (!work.wavs.names.length && !work.wavs.skipped.length && !work.transcripts.length && (state.phase === 'done' || state.phase === 'cancelled')) {
      return Object.assign(getState(), { empty: true });
    }
    state = Object.assign(fresh(), { running: true, phase: 'transcribing', startedAt: now() });
    items = [];
    // Reserve the running state synchronously, but always return before doing the work.
    Promise.resolve().then(() => run(work));
    return getState();
  }

  function cancel() {
    if (!state.running || state.cancelRequested) return getState();
    state.cancelRequested = true;
    state.phase = 'cancelling';
    dropPending('transcribe');
    dropPending('analyze');
    return getState();
  }

  return { start, cancel, getState };
}

module.exports = { createMeetingBatch };
