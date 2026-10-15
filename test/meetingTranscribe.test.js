'use strict';
// meetingTranscribe: FIFO order, one-at-a-time, dedupe, success filing (JSON written + WAV moved),
// error handling (WAV stays), and the never-fabricated health probe. Fake fetch, real fs in temp dirs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMeetingTranscriber } = require('../app/meetingTranscribe');
const { readFrontmatter } = require('../app/meetingFrontmatter');

const GOOD_RESPONSE = { speaker_report: { speaker_count: 1 }, segments: [{ speaker: 'T', start: 0, end: 1, text: 'hi' }] };

function setup(fetchImpl, httpPost) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-tx-'));
  const unprocessed = path.join(root, 'unprocessed');
  const processed = path.join(root, 'processed');
  fs.mkdirSync(unprocessed);
  const tx = createMeetingTranscriber({
    resolveFolders: () => ({ unprocessed, processed }),
    resolveBaseUrl: () => 'http://fake:1',
    fetchImpl: fetchImpl || (async () => jsonResponse(true, {})),   // health probe
    httpPost: httpPost || (async () => ({ status: 200, text: JSON.stringify(GOOD_RESPONSE) })),
    healthTtlMs: 0,
  });
  return { root, unprocessed, processed, tx };
}

function jsonResponse(ok, body, status) {
  return { ok, status: status || (ok ? 200 : 500), json: async () => body };
}
function addWav(dir, name) { fs.writeFileSync(path.join(dir, name), Buffer.from('RIFFxxxxWAVE')); }
function settle() { return new Promise(r => setTimeout(r, 50)); }
// Wait until the queue has fully drained (jobs are fast but not instant).
async function drained(tx, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    const st = tx.getState();
    if (!st.current && !st.queue.length) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('queue never drained');
    await new Promise(r => setTimeout(r, 20));
  }
}

test('success: JSON transcript written to processed, WAV moved, FIFO order kept', async () => {
  const uploads = [];
  const s = setup(null, async (url, filename, buf) => {
    uploads.push([String(url), filename, buf.length]);
    return { status: 200, text: JSON.stringify(GOOD_RESPONSE) };
  });
  addWav(s.unprocessed, 'a.wav');
  addWav(s.unprocessed, 'b.wav');
  assert.equal(s.tx.enqueue('a.wav').ok, true);
  assert.equal(s.tx.enqueue('b.wav').ok, true);
  await drained(s.tx);
  const st = s.tx.getState();
  assert.equal(st.current, null);
  assert.deepEqual(st.recent.map(j => [j.name, j.status]), [['b.wav', 'done'], ['a.wav', 'done']]);   // newest first = FIFO ran a then b
  for (const base of ['a', 'b']) {
    assert.equal(fs.existsSync(path.join(s.unprocessed, base + '.wav')), false, base + ' should have moved');
    assert.equal(fs.existsSync(path.join(s.processed, 'details', base + '.wav')), true);
    const j = JSON.parse(fs.readFileSync(path.join(s.processed, 'details', base + '-diarizer-response.json'), 'utf8'));
    assert.deepEqual(j.segments, GOOD_RESPONSE.segments);
  }
});

test('slide-capture folder travels with the WAV into processed', async () => {
  const s = setup(null, async () => ({ status: 200, text: JSON.stringify(GOOD_RESPONSE) }));
  addWav(s.unprocessed, 'm.wav');
  const shots = path.join(s.unprocessed, 'm-screenshots');
  fs.mkdirSync(shots);
  fs.writeFileSync(path.join(shots, '20260817-090001-slide001.png'), Buffer.from('PNG'));
  s.tx.enqueue('m.wav');
  await drained(s.tx);
  assert.equal(fs.existsSync(shots), false, 'screenshots folder should have left unprocessed');
  const moved = path.join(s.processed, 'details', 'm-screenshots', '20260817-090001-slide001.png');
  assert.equal(fs.existsSync(moved), true, 'slide should now sit beside the transcript');
});

test('transcription publishes one processing record with raw timed dialogue and carries capture metadata', async () => {
  const s = setup();
  addWav(s.unprocessed, 'm.wav');
  fs.writeFileSync(path.join(s.unprocessed, 'm.capture.json'), JSON.stringify({ started_at: '2026-10-15T10:12:00-06:00', device: 'Mic' }));
  s.tx.enqueue('m.wav');
  await drained(s.tx);
  assert.equal(s.tx.getState().recent[0].status, 'done');
  const parsed = readFrontmatter(fs.readFileSync(path.join(s.processed, 'm.md'), 'utf8'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.status, 'processing');
  assert.equal(parsed.data.date, '2026-10-15T10:12:00-06:00');
  assert.equal(parsed.data.bedrock.extraction, 'none');
  assert.match(parsed.body, /\[T 0:00\] hi/);
  assert.ok(fs.existsSync(path.join(s.processed, 'details', 'm.capture.json')));
  assert.equal(fs.existsSync(path.join(s.unprocessed, 'm.capture.json')), false);
});

test('stub creation never overwrites existing canonical or legacy complete notes', async () => {
  for (const filename of ['m.md', 'm-analysis.md']) {
    const s = setup();
    fs.mkdirSync(s.processed, { recursive: true });
    const body = '# My edited complete notes\n';
    fs.writeFileSync(path.join(s.processed, filename), body);
    addWav(s.unprocessed, 'm.wav');
    s.tx.enqueue('m.wav'); await drained(s.tx);
    assert.equal(fs.readFileSync(path.join(s.processed, filename), 'utf8'), body);
    if (filename !== 'm.md') assert.equal(fs.existsSync(path.join(s.processed, 'm.md')), false);
    assert.equal(s.tx.getState().recent[0].status, 'done');
  }
});

test('diarizer {detail} error: WAV stays in unprocessed, error recorded, queue continues', async () => {
  let call = 0;
  const s = setup(null, async () => {
    call++;
    if (call === 1) return { status: 400, text: JSON.stringify({ detail: 'unsupported audio' }) };
    return { status: 200, text: JSON.stringify(GOOD_RESPONSE) };
  });
  addWav(s.unprocessed, 'bad.wav');
  addWav(s.unprocessed, 'good.wav');
  s.tx.enqueue('bad.wav');
  s.tx.enqueue('good.wav');
  await drained(s.tx);
  const st = s.tx.getState();
  assert.deepEqual(st.recent.map(j => [j.name, j.status, j.error]), [
    ['good.wav', 'done', null],
    ['bad.wav', 'error', 'unsupported audio'],
  ]);
  assert.equal(fs.existsSync(path.join(s.unprocessed, 'bad.wav')), true);     // stays for retry
  assert.equal(fs.existsSync(path.join(s.processed, 'details', 'good.wav')), true);
  assert.equal(st.completed, 1);
  assert.equal(st.failed, 1);
});

test('lifetime outcome counters survive eviction from recent history', async () => {
  let call = 0;
  const s = setup(null, async () => (++call === 1
    ? { status: 400, text: JSON.stringify({ detail: 'unsupported audio' }) }
    : { status: 200, text: JSON.stringify(GOOD_RESPONSE) }));
  for (let i = 0; i < 25; i++) {
    const name = 'meeting-' + i + '.wav';
    addWav(s.unprocessed, name);
    s.tx.enqueue(name);
  }
  await drained(s.tx);
  const st = s.tx.getState();
  assert.equal(st.recent.length, 20);
  assert.equal(st.recent.some(job => job.status === 'error'), false);
  assert.equal(st.completed, 24);
  assert.equal(st.failed, 1);
});

test('network failure surfaces as an error state', async () => {
  const s = setup(async () => { throw new Error('refused'); },
    async () => { throw new Error('connect ECONNREFUSED'); });
  addWav(s.unprocessed, 'x.wav');
  s.tx.enqueue('x.wav');
  await drained(s.tx);
  assert.deepEqual(s.tx.getState().recent.map(j => [j.name, j.status]), [['x.wav', 'error']]);
  assert.equal(fs.existsSync(path.join(s.unprocessed, 'x.wav')), true);
});

test('enqueue validates names, requires the file, and dedupes against queue + current', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const s = setup(null, async () => {
    await gate;                                   // hold the first job "running"
    return { status: 200, text: JSON.stringify(GOOD_RESPONSE) };
  });
  addWav(s.unprocessed, 'a.wav');
  addWav(s.unprocessed, 'b.wav');
  assert.equal(s.tx.enqueue('..\\a.wav').ok, false);
  assert.equal(s.tx.enqueue('a.txt').ok, false);
  assert.equal(s.tx.enqueue('missing.wav').ok, false);
  assert.equal(s.tx.enqueue('a.wav').ok, true);
  await settle();
  assert.equal(s.tx.enqueue('a.wav').ok, false);   // already running
  assert.equal(s.tx.enqueue('b.wav').ok, true);
  assert.equal(s.tx.enqueue('b.wav').ok, false);   // already queued
  const st = s.tx.getState();
  assert.equal(st.current.name, 'a.wav');
  assert.deepEqual(st.queue, ['b.wav']);
  release();
  await drained(s.tx);
});

test('organizeByDate files results into YYYY/MM under processed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-tx-date-'));
  const unprocessed = path.join(root, 'unprocessed');
  const processed = path.join(root, 'processed');
  fs.mkdirSync(unprocessed);
  const fixedNow = new Date(2026, 7, 14).getTime();   // Aug 14 2026 -> 2026/08
  const tx = createMeetingTranscriber({
    resolveFolders: () => ({ unprocessed, processed }),
    resolveBaseUrl: () => 'http://fake:1',
    organizeByDate: () => true,
    now: () => fixedNow,
    fetchImpl: async () => jsonResponse(true, {}),
    httpPost: async () => ({ status: 200, text: JSON.stringify(GOOD_RESPONSE) }),
    healthTtlMs: 0,
  });
  addWav(unprocessed, 'm.wav');
  tx.enqueue('m.wav');
  await drained(tx);
  assert.equal(fs.existsSync(path.join(processed, '2026', '08', 'details', 'm.wav')), true);
  assert.equal(fs.existsSync(path.join(processed, '2026', '08', 'details', 'm-diarizer-response.json')), true);
  assert.equal(fs.existsSync(path.join(unprocessed, 'm.wav')), false);
});

test('re-transcribing the same meeting files as _1, _2 — never overwrites', async () => {
  const s = setup();
  fs.mkdirSync(s.processed, { recursive: true });
  fs.writeFileSync(path.join(s.processed, 'm.wav'), 'ORIGINAL WAV');
  fs.writeFileSync(path.join(s.processed, 'm-diarizer-response.json'), '"ORIGINAL JSON"');
  addWav(s.unprocessed, 'm.wav');
  s.tx.enqueue('m.wav');
  await drained(s.tx);
  assert.equal(s.tx.getState().recent[0].status, 'done');
  assert.equal(fs.readFileSync(path.join(s.processed, 'm.wav'), 'utf8'), 'ORIGINAL WAV');                 // untouched
  assert.equal(fs.readFileSync(path.join(s.processed, 'm-diarizer-response.json'), 'utf8'), '"ORIGINAL JSON"');
  assert.equal(fs.existsSync(path.join(s.processed, 'details', 'm_1.wav')), true);
  assert.equal(fs.existsSync(path.join(s.processed, 'details', 'm_1-diarizer-response.json')), true);
  assert.equal(fs.existsSync(path.join(s.unprocessed, 'm.wav')), false);
  // a third run steps to _2
  addWav(s.unprocessed, 'm.wav');
  s.tx.enqueue('m.wav');
  await drained(s.tx);
  assert.equal(fs.existsSync(path.join(s.processed, 'details', 'm_2.wav')), true);
  assert.equal(fs.existsSync(path.join(s.processed, 'details', 'm_2-diarizer-response.json')), true);
});

test('attendees from the sidecar and the threshold setting ride the upload', async () => {
  const captured = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-tx-att-'));
  const unprocessed = path.join(root, 'unprocessed');
  fs.mkdirSync(unprocessed);
  const tx = createMeetingTranscriber({
    resolveFolders: () => ({ unprocessed, processed: path.join(root, 'processed') }),
    resolveBaseUrl: () => 'http://fake:1',
    resolveThreshold: () => '0.7',
    resolveMyName: () => 'T.J. Schmitz',
    fetchImpl: async () => jsonResponse(true, {}),
    httpPost: async (url, filename, buf, timeoutMs, fields) => {
      captured.push({ filename, fields });
      return { status: 200, text: JSON.stringify(GOOD_RESPONSE) };
    },
    healthTtlMs: 0,
  });
  addWav(unprocessed, 'with-info.wav');
  // Old-format sidecar (pre-flip build): "Last, First" names + a My-name variant — the transcriber
  // must normalize, not trust it (comma-format names comma-joined corrupt the whole field).
  fs.writeFileSync(path.join(unprocessed, 'with-info.json'), JSON.stringify({
    organizer: 'Schmitz, TJ',
    required_attendees: ['Mastalski, David', 'T.J. Schmitz', 'Carl Tanner'],   // organizer variant -> deduped to enrolled spelling
    optional_attendees: ['Monica Paras'],
  }));
  addWav(unprocessed, 'ad-hoc.wav');
  tx.enqueue('with-info.wav');
  tx.enqueue('ad-hoc.wav');
  await drained(tx);
  assert.equal(captured.length, 2);
  const withInfo = captured.find(c => c.filename === 'with-info.wav');
  assert.deepEqual(withInfo.fields, {
    threshold: '0.7',
    me_name: 'T.J. Schmitz',                                              // channel-guided ID (left = mic)
    attendees: 'T.J. Schmitz,David Mastalski,Carl Tanner,Monica Paras',   // flipped, My-name-corrected, deduped, comma-safe
  });
  const adHoc = captured.find(c => c.filename === 'ad-hoc.wav');
  assert.deepEqual(adHoc.fields, { threshold: '0.7', me_name: 'T.J. Schmitz' });   // no sidecar -> no attendees field
});

test('Outlook meeting-info sidecar travels with the WAV (and joins the collision rename)', async () => {
  const s = setup();
  addWav(s.unprocessed, 'm.wav');
  fs.writeFileSync(path.join(s.unprocessed, 'm.json'), '{"subject":"weekly"}');
  s.tx.enqueue('m.wav');
  await drained(s.tx);
  assert.equal(fs.readFileSync(path.join(s.processed, 'details', 'm.json'), 'utf8'), '{"subject":"weekly"}');
  assert.equal(fs.existsSync(path.join(s.unprocessed, 'm.json')), false);
  // re-run: existing m.json at dest forces the _1 rename, sidecar follows as m_1.json
  addWav(s.unprocessed, 'm.wav');
  fs.writeFileSync(path.join(s.unprocessed, 'm.json'), '{"subject":"weekly take 2"}');
  s.tx.enqueue('m.wav');
  await drained(s.tx);
  assert.equal(fs.readFileSync(path.join(s.processed, 'details', 'm_1.json'), 'utf8'), '{"subject":"weekly take 2"}');
  assert.equal(fs.existsSync(path.join(s.processed, 'details', 'm_1.wav')), true);
  assert.equal(fs.readFileSync(path.join(s.processed, 'details', 'm.json'), 'utf8'), '{"subject":"weekly"}');   // first set untouched
});

test('hooks: pre runs once before a batch (after health), post once after the drain', async () => {
  const events = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-tx-hook-'));
  const unprocessed = path.join(root, 'unprocessed');
  fs.mkdirSync(unprocessed);
  let serverUp = false;
  const tx = createMeetingTranscriber({
    resolveFolders: () => ({ unprocessed, processed: path.join(root, 'processed') }),
    resolveBaseUrl: () => 'http://fake:1',
    resolveHooks: () => ({ enabled: true, pre: 'START', post: 'STOP' }),
    execHook: async (cmd) => { events.push('hook:' + cmd); if (cmd === 'START') serverUp = true; if (cmd === 'STOP') serverUp = false; },
    fetchImpl: async url => {
      if (url.endsWith('/health')) { if (!serverUp) throw new Error('refused'); return jsonResponse(true, {}); }
      throw new Error('unexpected fetch');
    },
    httpPost: async (url, filename) => { events.push('upload:' + filename); return { status: 200, text: JSON.stringify(GOOD_RESPONSE) }; },
    serverPollMs: 10, serverWaitMs: 2000, healthTtlMs: 999999,
  });
  addWav(unprocessed, 'a.wav');
  addWav(unprocessed, 'b.wav');
  tx.enqueue('a.wav');
  tx.enqueue('b.wav');
  await drained(tx);
  await settle();   // let the post hook fire after the drain
  assert.deepEqual(events, ['hook:START', 'upload:a.wav', 'upload:b.wav', 'hook:STOP']);   // one start, one stop per batch
  // a second batch starts the server again
  addWav(unprocessed, 'c.wav');
  tx.enqueue('c.wav');
  await drained(tx);
  await settle();
  assert.deepEqual(events.slice(4), ['hook:START', 'upload:c.wav', 'hook:STOP']);
});

test('hooks: pre-command failure errors every queued job; WAVs stay for retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-tx-hookfail-'));
  const unprocessed = path.join(root, 'unprocessed');
  fs.mkdirSync(unprocessed);
  const tx = createMeetingTranscriber({
    resolveFolders: () => ({ unprocessed, processed: path.join(root, 'processed') }),
    resolveBaseUrl: () => 'http://fake:1',
    resolveHooks: () => ({ enabled: true, pre: 'START', post: '' }),
    execHook: async () => { throw new Error('ssh: connect refused'); },
    fetchImpl: async () => { throw new Error('down'); },
    httpPost: async () => { throw new Error('must not upload'); },
    serverPollMs: 10, serverWaitMs: 200, healthTtlMs: 999999,
  });
  addWav(unprocessed, 'a.wav');
  addWav(unprocessed, 'b.wav');
  tx.enqueue('a.wav');
  tx.enqueue('b.wav');
  await drained(tx);
  const st = tx.getState();
  assert.equal(st.recent.length, 2);
  assert.equal(st.completed, 0);
  assert.equal(st.failed, 2);
  st.recent.forEach(j => {
    assert.equal(j.status, 'error');
    assert.match(j.error, /transcription-server start failed: ssh: connect refused/);
  });
  assert.equal(fs.existsSync(path.join(unprocessed, 'a.wav')), true);
  assert.equal(fs.existsSync(path.join(unprocessed, 'b.wav')), true);
});

test('hooks disabled: no hook calls, behavior unchanged', async () => {
  const events = [];
  const s = setup(null, async (url, filename) => { events.push('upload:' + filename); return { status: 200, text: JSON.stringify(GOOD_RESPONSE) }; });
  addWav(s.unprocessed, 'a.wav');
  s.tx.enqueue('a.wav');
  await drained(s.tx);
  await settle();
  assert.deepEqual(events, ['upload:a.wav']);
});

test('health is unknown until a probe answers, then reflects reality', async () => {
  let healthy = false;
  const s = setup(async () => {
    if (!healthy) throw new Error('refused');
    return jsonResponse(true, { status: 'ok' });
  });
  assert.equal(s.tx.getState().health, 'unknown');   // triggers the first probe
  await settle();
  assert.equal(s.tx.getState().health, 'down');
  healthy = true;
  await settle();                                     // ttl=0 -> next getState re-probes
  s.tx.getState();
  await settle();
  assert.equal(s.tx.getState().health, 'ok');
});
