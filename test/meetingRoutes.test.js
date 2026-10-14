'use strict';
// sysserver's meeting-library route surface: dispatch table, gating (same-origin, POST wall,
// foreign Host), and the Range-capable /meeting-audio streamer. Runs in its own process so
// start() gets meeting hooks without touching sysserver.test.js (the tripwire file).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sysserver = require('../app/sysserver');
const { createMeetingLibrary } = require('../app/meetingLibrary');

let port;
const libCalls = [];
let dirs;

test.before(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-routes-'));
  dirs = { unprocessed: path.join(root, 'unprocessed'), processed: path.join(root, 'processed') };
  fs.mkdirSync(dirs.unprocessed); fs.mkdirSync(dirs.processed);
  fs.writeFileSync(path.join(dirs.unprocessed, 'clip.wav'), Buffer.from('0123456789'));   // 10 bytes, headers don't matter for streaming
  const lib = createMeetingLibrary({ resolveFolders: () => dirs });
  port = await sysserver.start({
    onMeetingLibrary: (op, params) => { libCalls.push([op, params.kind, params.name]); return { ok: true, op }; },
    resolveMeetingAudio: (kind, name) => /\.wav$/i.test(String(name || '')) ? lib.resolvePath(kind, name) : null,
  });
});
test.after(() => sysserver.stop());
test.beforeEach(() => { libCalls.length = 0; });

const base = () => 'http://127.0.0.1:' + port;
const pageFetch = (p, opts = {}) =>
  fetch(base() + p, Object.assign({}, opts, { headers: Object.assign({ 'sec-fetch-site': 'same-origin' }, opts.headers || {}) }));

test('library routes dispatch to the right op with query params', async () => {
  const cases = [
    ['/meeting-files?kind=unprocessed', 'files', 'unprocessed', ''],
    ['/meeting-file-delete?kind=unprocessed&name=a.wav', 'delete', 'unprocessed', 'a.wav'],
    ['/meeting-transcribe/start?name=a.wav', 'transcribeStart', '', 'a.wav'],
    ['/meeting-transcribe/state', 'transcribeState', '', ''],
    ['/meeting-analyze/start?name=a.json', 'analyzeStart', '', 'a.json'],
    ['/meeting-analyze/state', 'analyzeState', '', ''],
    ['/meeting-batch/start', 'batchStart', '', ''],
    ['/meeting-batch/state', 'batchState', '', ''],
    ['/meeting-analysis?name=a.json', 'analysisResult', '', 'a.json'],
  ];
  for (const [route, op, kind, name] of cases) {
    const r = await pageFetch(route);
    assert.equal(r.status, 200, route);
    assert.deepEqual(await r.json(), { ok: true, op }, route);
  }
  assert.deepEqual(libCalls, cases.map(c => [c[1], c[2], c[3]]));
});

test('library + audio routes fail closed without same-origin evidence', async () => {
  for (const route of ['/meeting-files?kind=unprocessed', '/meeting-file-delete?kind=unprocessed&name=a.wav', '/meeting-audio?kind=unprocessed&name=clip.wav']) {
    const r = await fetch(base() + route, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(r.status, 403, route);
  }
  assert.deepEqual(libCalls, []);
});

test('POST hits the GET-only wall (405)', async () => {
  const r = await pageFetch('/meeting-transcribe/start?name=a.wav', { method: 'POST' });
  assert.equal(r.status, 405);
  assert.deepEqual(libCalls, []);
});

test('foreign Host header rejected (DNS-rebinding gate)', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/meeting-files?kind=unprocessed', headers: { Host: 'evil.example' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('meeting-audio serves the whole file with wav type and Accept-Ranges', async () => {
  const r = await pageFetch('/meeting-audio?kind=unprocessed&name=clip.wav');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /audio\/wav/);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(await r.text(), '0123456789');
});

test('meeting-audio honors a single byte range with 206', async () => {
  const r = await pageFetch('/meeting-audio?kind=unprocessed&name=clip.wav', { headers: { Range: 'bytes=2-5' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await r.text(), '2345');
  const openEnded = await pageFetch('/meeting-audio?kind=unprocessed&name=clip.wav', { headers: { Range: 'bytes=7-' } });
  assert.equal(openEnded.status, 206);
  assert.equal(await openEnded.text(), '789');
  const outOfRange = await pageFetch('/meeting-audio?kind=unprocessed&name=clip.wav', { headers: { Range: 'bytes=99-' } });
  assert.equal(outOfRange.status, 416);
});

test('meeting-audio 404s traversal names, non-wav, and missing files', async () => {
  for (const name of ['..%5C..%5Cconfig.json', 'clip.json', 'missing.wav', '..%2F..%2Fclip.wav']) {
    const r = await pageFetch('/meeting-audio?kind=unprocessed&name=' + name);
    assert.equal(r.status, 404, name);
  }
});
