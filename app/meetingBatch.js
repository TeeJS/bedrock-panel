'use strict';

// Main-process orchestration survives panel reloads. Each stage drains the shared queue,
// including existing/manual jobs; monotonic queue counters keep outcomes exact even when
// many jobs finish between polls. State lasts for this application session, not a restart.
function createMeetingBatch(deps) {
  const { library, transcriber, analyzer } = deps;
  const now = deps.now || Date.now;
  const pollMs = deps.pollMs === undefined ? 1000 : deps.pollMs;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const getBusyFiles = deps.getBusyFiles || (() => []);
  let state = {
    ok: true, running: false, phase: 'idle', startedAt: null, finishedAt: null,
    transcribed: 0, transcribeErrors: 0, analyzed: 0, analyzeErrors: 0, error: null, halted: false,
  };

  function getState() { return Object.assign({}, state); }

  function list(kind, dir) {
    const result = library.listFiles(kind, dir);
    if (!result || !result.ok) throw new Error((result && result.error) || 'could not list meetings');
    return result;
  }

  function transcripts() {
    let result = list('processed', '');
    // Match the Analysis overlay's initial directory, without sweeping archive/details folders.
    if (result.byDate) {
      const date = new Date(now());
      const dir = String(date.getFullYear()) + '/' + String(date.getMonth() + 1).padStart(2, '0');
      result = list('processed', dir);
    }
    return result.files.filter(file => /-diarizer-response\.json$/i.test(file.name) && file.analyzed === false)
      .map(file => file.name);
  }

  async function stage(service, names, enqueue, busy, doneKey, errorKey, haltOnAuth) {
    const stageStartedAt = now();
    const initial = service.getState();
    let rejected = 0;
    for (const name of new Set(names)) {
      const result = enqueue(name);
      if (!result || (!result.ok && result.error !== 'already queued')) rejected++;
    }
    for (;;) {
      const current = service.getState();
      state[doneKey] = current.completed - initial.completed;
      state[errorKey] = rejected + current.failed - initial.failed;
      if (haltOnAuth && current.failed > initial.failed && current.error && current.error.authRequired
          && current.error.finishedAt >= stageStartedAt) {
        // Pending jobs are removed; an already running job has no cancellation API.
        service.clearQueue();
        state.phase = 'error';
        state.halted = true;
        state.error = String(current.error.error || 'Analysis needs sign-in. Sign in on this PC, then try again.')
          .replace(/ — then try again\.$/, '');
        return;
      }
      if (!busy(current)) return;
      await sleep(pollMs);
    }
  }

  async function run() {
    try {
      const busy = new Set(getBusyFiles());
      const wavs = list('unprocessed').files
        .filter(file => /\.wav$/i.test(file.name) && !busy.has(file.name)).map(file => file.name);
      await stage(transcriber, wavs, name => transcriber.enqueue(name),
        s => !!(s.current || s.phase || s.queue.length), 'transcribed', 'transcribeErrors');
      state.phase = 'analyzing';
      await stage(analyzer, transcripts(), name => analyzer.start(name),
        s => !!(s.running || s.queue.length), 'analyzed', 'analyzeErrors', true);
      if (state.halted) return;
      state.phase = 'done';
    } catch (e) {
      state.phase = 'error';
      state.error = (e && e.message) || 'batch failed';
    } finally {
      state.running = false;
      state.finishedAt = now();
    }
  }

  function start() {
    if (state.running) return getState();
    state = {
      ok: true, running: true, phase: 'transcribing', startedAt: now(), finishedAt: null,
      transcribed: 0, transcribeErrors: 0, analyzed: 0, analyzeErrors: 0, error: null, halted: false,
    };
    // Reserve the running state synchronously, but always return before doing the scan/work.
    Promise.resolve().then(run);
    return getState();
  }

  return { start, getState };
}

module.exports = { createMeetingBatch };
