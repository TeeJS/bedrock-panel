'use strict';

// Diarized-transcription client (docs/meetings-api.md): uploads unprocessed WAVs to the
// tts-sst / meeting-diarizer /transcribe endpoint, then files the results. One upload at a time
// through a FIFO queue — the diarizer runs one job anyway, and a single long-lived socket beats
// several 3600 s ones. On success the raw response JSON lands in the processed folder as
// <basename>.json and the WAV moves in next to it; on any failure the WAV stays in unprocessed
// and the error is kept for the panel to show.
//
// Everything external is injected (folders, base URL, fetch, fs, clock) so tests run with a fake
// diarizer and temp dirs — same DI shape as the other meeting services.

const path = require('path');
const http = require('http');
const https = require('https');
const { safeName } = require('./meetingLibrary');

function normalizeName(value) {
  const name = String(value || '').trim();
  const comma = name.indexOf(',');
  return comma < 0 ? name : (name.slice(comma + 1).trim() + ' ' + name.slice(0, comma).trim()).trim();
}

const TIMEOUT_MS = 3600000;      // the API doc's own guidance: budget a full hour
const HEALTH_TTL_MS = 10000;     // re-probe /health at most this often
const HEALTH_TIMEOUT_MS = 3000;
const RECENT_MAX = 20;
const HOOK_TIMEOUT_MS = 120000;      // pre/post shell command budget
const SERVER_WAIT_MS = 300000;       // after the pre hook: how long the server gets to become healthy
const SERVER_POLL_MS = 5000;

// Run a user-authored pre/post shell command. Written to a temp script and executed through the
// platform shell (a .cmd via cmd.exe on Windows, a .sh via /bin/sh elsewhere) so multi-line commands
// and full shell syntax work; output is logged, non-zero exit rejects with stderr.
function runShellHook(cmd, log, timeoutMs) {
  return new Promise((resolve, reject) => {
    const os = require('os');
    const fs = require('fs');
    const { execFile } = require('child_process');
    const win = process.platform === 'win32';
    const file = path.join(os.tmpdir(), 'oqx-meeting-hook-' + Date.now() + (win ? '.cmd' : '.sh'));
    const body = win
      ? '@echo off\r\n' + String(cmd).replace(/\r?\n/g, '\r\n') + '\r\n'
      : '#!/bin/sh\n' + String(cmd).replace(/\r\n/g, '\n') + '\n';
    try { fs.writeFileSync(file, body); }
    catch (e) { return reject(new Error('could not write hook script: ' + e.message)); }
    const [bin, args] = win ? ['cmd.exe', ['/d', '/s', '/c', file]] : ['/bin/sh', [file]];
    execFile(bin, args, { timeout: timeoutMs || HOOK_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(file); } catch (e) {}
      const out = String(stdout || '').trim();
      if (out) log('hook output: ' + out.slice(0, 400));
      if (err) reject(new Error((String(stderr || '').trim() || err.message).slice(0, 300)));
      else resolve();
    });
  });
}

// The upload deliberately does NOT use global fetch: undici enforces a hidden ~300 s
// headers timeout regardless of the abort signal, which killed any transcription needing
// more than 5 minutes of processing ("fetch failed" partway through). Raw http.request has
// no such ceiling — `timeout` below is socket INACTIVITY, so it only fires if the server
// goes silent for the full hour.
function httpPostWav(url, filename, buf, timeoutMs, fields) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad server URL: ' + url)); }
    const mod = u.protocol === 'https:' ? https : http;
    const boundary = '----BedrockPanelMeeting' + Math.random().toString(36).slice(2);
    const parts = [];
    for (const k of Object.keys(fields || {})) {   // text fields (threshold, attendees) before the file
      parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n'));
    }
    parts.push(Buffer.from(
      '--' + boundary + '\r\nContent-Disposition: form-data; name="audio"; filename="' + filename.replace(/"/g, '') + '"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n'));
    parts.push(buf);
    parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
    const body = Buffer.concat(parts);
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname,
      method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length },
    }, res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: out }));
    });
    req.on('timeout', () => req.destroy(new Error('no response after ' + Math.round(timeoutMs / 60000) + ' min')));
    req.on('error', e => reject(new Error(e.message || 'upload failed')));
    req.end(body);
  });
}

function createMeetingTranscriber(deps) {
  const fsMod = deps.fs || require('fs');
  const fsp = fsMod.promises;
  const fetchImpl = deps.fetchImpl || fetch;         // health probe only (short, cheap)
  const httpPost = deps.httpPost || httpPostWav;     // the long-running upload
  const resolveFolders = deps.resolveFolders;   // () => { unprocessed, processed }
  const resolveBaseUrl = deps.resolveBaseUrl;   // () => 'http://127.0.0.1:10301'
  const organizeByDate = deps.organizeByDate || (() => false);   // () => bool: file results into YYYY/MM subfolders
  const resolveThreshold = deps.resolveThreshold || (() => '');  // () => speaker cutoff ('' = server default)
  const resolveMyName = deps.resolveMyName || (() => '');        // () => operator's enrolled name ('' = off)
  // Engine: 'server' (the diarizer at resolveBaseUrl) or 'local' (localTranscribe(wavPath, { myName })
  // → the same { segments, speaker_report } shape, produced on this machine — macOS's built-in
  // speech). With 'local' there is no health probe, no server wait, and no pre/post hooks.
  const resolveEngine = deps.resolveEngine || (() => 'server');
  const localTranscribe = deps.localTranscribe || null;
  const isLocal = () => resolveEngine() === 'local' && typeof localTranscribe === 'function';
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;
  const healthTtlMs = deps.healthTtlMs === undefined ? HEALTH_TTL_MS : deps.healthTtlMs;
  // Pre/post hooks: user shell commands that start/stop the transcription server around a batch
  // (e.g. docker start/stop over ssh — the diarizer holds ~3.4 GB of GPU memory while loaded).
  const resolveHooks = deps.resolveHooks || (() => ({}));   // () => { enabled, pre, post }
  const execHook = deps.execHook || ((cmd, label) => runShellHook(cmd, m => log('[' + label + '] ' + m), deps.hookTimeoutMs || HOOK_TIMEOUT_MS));
  const serverWaitMs = deps.serverWaitMs || SERVER_WAIT_MS;
  const serverPollMs = deps.serverPollMs || SERVER_POLL_MS;

  const queue = [];          // names waiting
  let current = null;        // { name, startedAt } while a job runs
  const recent = [];         // newest first: { name, status: 'done'|'error', error?, finishedAt }
  let health = 'unknown';    // 'ok' | 'down' | 'unknown' — never fabricated, stays unknown until a probe answers
  let healthAt = 0;
  let healthBusy = false;
  let batchActive = false;   // the pre hook has run for the jobs currently flowing; post runs when drained
  let hookRunning = false;   // a pre (incl. health wait) or post hook is in flight — pump waits
  let hookPhase = null;      // 'pre' | 'waiting' | 'post' | null — surfaced to the panel, never fabricated

  function probeHealth() {
    if (isLocal()) { health = 'ok'; healthAt = now(); return; }   // nothing to probe: the engine is a local process
    if (healthBusy || (now() - healthAt) < healthTtlMs) return;
    healthBusy = true;
    fetchImpl(resolveBaseUrl() + '/health', { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      .then(r => { health = r.ok ? 'ok' : 'down'; })
      .catch(() => { health = 'down'; })
      .finally(() => { healthAt = now(); healthBusy = false; });
  }

  function getState() {
    probeHealth();   // throttled; updates the cached value in the background
    return {
      ok: true,
      health,
      engine: isLocal() ? 'local' : 'server',
      hooksEnabled: !isLocal() && !!(resolveHooks() || {}).enabled,
      phase: hookPhase,
      current: current ? { name: current.name, status: 'running', startedAt: current.startedAt } : null,
      queue: queue.slice(),
      recent: recent.slice(),
    };
  }

  // After the pre hook: give the server time to come up (container start + model load) before the
  // first upload. Resolves as soon as /health answers ok; throws past the deadline.
  async function waitForServer() {
    const deadline = now() + serverWaitMs;
    for (;;) {
      try {
        const r = await fetchImpl(resolveBaseUrl() + '/health', { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        if (r.ok) { health = 'ok'; healthAt = now(); return; }
      } catch (e) { /* not up yet */ }
      health = 'down'; healthAt = now();
      if (now() >= deadline) throw new Error('server did not become healthy within ' + Math.round(serverWaitMs / 60000) + ' min of the start command');
      await new Promise(r => setTimeout(r, serverPollMs));
    }
  }

  function enqueue(name) {
    const n = safeName(name);
    if (!n || !/\.wav$/i.test(n)) return { ok: false, error: 'bad name' };
    if ((current && current.name === n) || queue.includes(n)) return { ok: false, error: 'already queued' };
    const src = path.join(resolveFolders().unprocessed, n);
    if (!fsMod.existsSync(src)) return { ok: false, error: 'not found' };
    queue.push(n);
    log('transcribe queued: ' + n);
    pump();
    return Object.assign({}, getState());
  }

  function finish(name, status, error) {
    recent.unshift({ name, status, error: error || null, finishedAt: now() });
    if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
    current = null;
    maybeRunPostHook();
    pump();
  }

  // Queue fully drained with a batch active -> run the post hook once (e.g. stop the container).
  // Jobs arriving while it runs wait (hookRunning) and trigger a fresh pre hook afterwards —
  // start/stop commands never overlap.
  function maybeRunPostHook() {
    if (!batchActive || queue.length || current) return;
    batchActive = false;
    const hooks = resolveHooks() || {};
    if (!hooks.enabled || !String(hooks.post || '').trim()) return;
    hookRunning = true;
    hookPhase = 'post';
    log('running post-transcription command');
    execHook(hooks.post, 'post-hook')
      .catch(e => log('post-transcription command failed: ' + e.message))
      .finally(() => { hookRunning = false; hookPhase = null; pump(); });
  }

  function pump() {
    if (current || hookRunning || !queue.length) return;
    const hooks = isLocal() ? {} : (resolveHooks() || {});   // local engine: no server to start or stop
    // Idle -> active with a pre hook configured: start the server, wait for it to answer, then
    // flow the queue. Failure fails every queued job (they'd all hit the same dead server) and
    // leaves the WAVs in place for retry.
    if (hooks.enabled && !batchActive && String(hooks.pre || '').trim()) {
      hookRunning = true;
      hookPhase = 'pre';
      log('running pre-transcription command');
      execHook(hooks.pre, 'pre-hook')
        .then(() => { hookPhase = 'waiting'; return waitForServer(); })
        .then(() => { batchActive = true; })
        .catch(e => {
          const msg = 'transcription-server start failed: ' + e.message;
          log(msg);
          while (queue.length) {
            recent.unshift({ name: queue.shift(), status: 'error', error: msg, finishedAt: now() });
          }
          if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
        })
        .finally(() => { hookRunning = false; hookPhase = null; pump(); });
      return;
    }
    if (hooks.enabled && !batchActive) batchActive = true;   // post-only config still batches
    const name = queue.shift();
    current = { name, startedAt: now() };
    runJob(name)
      .then(() => { log('transcribe done: ' + name); finish(name, 'done'); })
      .catch(e => {
        const msg = (e && e.name === 'TimeoutError') ? 'timed out after ' + Math.round(timeoutMs / 60000) + ' min' : (e && e.message) || 'failed';
        log('transcribe failed: ' + name + ' — ' + msg);
        finish(name, 'error', msg);
      });
  }

  async function runJob(name) {
    const folders = resolveFolders();
    const src = path.join(folders.unprocessed, name);
    if (isLocal()) {
      const myName = String(resolveMyName() || '').trim();
      log('transcribing on this machine: ' + name);
      const result = await localTranscribe(src, { myName, log: m => log('[local] ' + m) });
      if (!result || !Array.isArray(result.segments)) throw new Error('local transcription returned no segments');
      await fileResult(name, folders, result);
      return;
    }
    const buf = await fsp.readFile(src);
    const fields = {};
    const th = String(resolveThreshold() || '').trim();
    if (th) fields.threshold = th;
    // Channel-guided identification: our stereo layout is fixed (left = the operator's mic), so
    // sending me_name lets the service label the mic channel's cluster with certainty — no cosine
    // wobble. me_channel is omitted: the service default (left) matches our layout.
    const myName = String(resolveMyName() || '').trim();
    if (myName) fields.me_name = myName;
    // Attendees from the Outlook meeting-info sidecar, OpenHiNotes-style: organizer first, then
    // required, then optional — ordered, de-duplicated. Names are normalized HERE, not trusted
    // from the sidecar: a "Last, First" name comma-joined into the attendees field corrupts the
    // whole list (the server then matches zero attendees and penalizes every enrolled speaker
    // 0.15 — seen live 2026-08-17: raw 0.74/0.80 scores dropped below the 0.7 threshold). Flip is
    // idempotent, so sidecars from current builds pass through unchanged; names canonically
    // matching the My-name setting are sent with the exact enrolled spelling.
    try {
      const sidecarPath = path.join(folders.unprocessed, name.replace(/\.wav$/i, '') + '.json');
      if (fsMod.existsSync(sidecarPath)) {
        const meta = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
        const canon = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const seen = {};
        const ordered = [];
        const add = n => {
          let t = normalizeName(n);
          if (!t) return;
          if (myName && canon(t) === canon(myName)) t = myName;
          if (!seen[t]) { seen[t] = true; ordered.push(t); }
        };
        add(meta.organizer);
        (meta.required_attendees || []).forEach(add);
        (meta.optional_attendees || []).forEach(add);
        if (ordered.length) {
          fields.attendees = ordered.join(',');
          log('attendees passed (' + ordered.length + '): ' + fields.attendees);
        }
      }
    } catch (e) { log('meeting-info sidecar unreadable — no attendees passed: ' + e.message); }
    const res = await httpPost(resolveBaseUrl() + '/transcribe', name, buf, timeoutMs, fields);
    if (res.status !== 200) {
      let detail = '';
      try { detail = JSON.parse(res.text).detail || ''; } catch (e) {}
      throw new Error(detail || ('diarizer returned HTTP ' + res.status));
    }
    let result = null;
    try { result = JSON.parse(res.text); } catch (e) {}
    if (!result || !Array.isArray(result.segments)) throw new Error('diarizer response missing segments');
    await fileResult(name, folders, result);
  }

  // File the results: transcript JSON first (atomic tmp+rename, same discipline as saveConfig),
  // then move the WAV. If the move fails the transcript still exists and the WAV stays visible
  // in unprocessed — nothing is lost either way. With Organize-by-date on, both land in
  // <processed>/YYYY/MM/ keyed to the processing date. Shared by both engines.
  async function fileResult(name, folders, result) {
    const src = path.join(folders.unprocessed, name);
    let destDir = folders.processed;
    if (organizeByDate()) {
      const d = new Date(now());
      destDir = path.join(destDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'));
    }
    await fsp.mkdir(destDir, { recursive: true });
    // Re-tests of the same meeting must never overwrite an existing set: if <base>.wav or its
    // transcript already exists at the destination, file this run as <base>_1, <base>_2, …
    const base = name.replace(/\.wav$/i, '');
    let finalBase = base;
    for (let i = 1;
      fsMod.existsSync(path.join(destDir, finalBase + '.wav'))
      || fsMod.existsSync(path.join(destDir, finalBase + '-diarizer-response.json'))
      || fsMod.existsSync(path.join(destDir, finalBase + '.json'));   // Outlook meeting-info sidecar
      i++) {
      finalBase = base + '_' + i;
    }
    if (finalBase !== base) log('destination exists — filing as ' + finalBase);
    const jsonPath = path.join(destDir, finalBase + '-diarizer-response.json');
    const tmp = jsonPath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(result, null, 2));
    await fsp.rename(tmp, jsonPath);
    // The Outlook meeting-info sidecar (<base>.json, written at record start) travels with the
    // recording. Best-effort: a failed sidecar move never fails the job.
    const sidecar = path.join(folders.unprocessed, base + '.json');
    if (fsMod.existsSync(sidecar)) {
      const sidecarDest = path.join(destDir, finalBase + '.json');
      try {
        try { await fsp.rename(sidecar, sidecarDest); }
        catch (e) { await fsp.copyFile(sidecar, sidecarDest); await fsp.unlink(sidecar); }
      } catch (e) { log('meeting-info sidecar move failed: ' + e.message); }
    }
    // The slide-capture folder (<base>-screenshots\) travels with the recording too. Best-effort;
    // a failed move never fails the transcription job. Cross-volume falls back to recursive copy.
    const shots = path.join(folders.unprocessed, base + '-screenshots');
    if (fsMod.existsSync(shots)) {
      const shotsDest = path.join(destDir, finalBase + '-screenshots');
      try {
        try { await fsp.rename(shots, shotsDest); }
        catch (e) { await fsp.cp(shots, shotsDest, { recursive: true }); await fsp.rm(shots, { recursive: true, force: true }); }
      } catch (e) { log('screenshots folder move failed: ' + e.message); }
    }
    const dest = path.join(destDir, finalBase + '.wav');
    try {
      await fsp.rename(src, dest);
    } catch (e) {   // cross-volume folders — copy+unlink
      await fsp.copyFile(src, dest);
      await fsp.unlink(src);
    }
  }

  return { enqueue, getState };
}

module.exports = { createMeetingTranscriber, runShellHook };
