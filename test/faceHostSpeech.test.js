'use strict';
// "Test speech" (host.handlers.synthesize) must agree with real replies about a persona's Piper voice:
// blank voice -> no voice key on the wire; a voice the server rejects BEFORE any audio -> one retry
// with the default voice, one WAV header, one audio response; once a format/chunk has been written
// -> never retried (no duplicated audio). Runs the real host against a loopback fake Wyoming server.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { createVoicePanelHost } = require('../app/voicepanel-host');
const { ensurePersonas } = require('../app/face/persona');

// ---- fake Wyoming server (client events in, server-framed replies out) --------------------------
function readEvents(socket, onEvent) {
  let buf = Buffer.alloc(0), pending = null;
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (!pending) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        pending = { header: JSON.parse(buf.subarray(0, nl).toString('utf8')), data: null };
        buf = buf.subarray(nl + 1);
      }
      if (pending.header.data_length && pending.data === null) {
        if (buf.length < pending.header.data_length) return;
        pending.data = JSON.parse(buf.subarray(0, pending.header.data_length).toString('utf8'));
        buf = buf.subarray(pending.header.data_length);
      }
      const need = pending.header.payload_length || 0;
      if (buf.length < need) return;
      buf = buf.subarray(need);
      const ev = { type: pending.header.type, data: pending.data !== null ? pending.data : pending.header.data };
      pending = null;
      onEvent(ev);
    }
  });
}
function send(socket, type, data, payload) {
  const body = data === undefined ? null : Buffer.from(JSON.stringify(data), 'utf8');
  const header = { type };
  if (body) header.data_length = body.length;
  if (payload) header.payload_length = payload.length;
  socket.write(JSON.stringify(header) + '\n');
  if (body) socket.write(body);
  if (payload) socket.write(payload);
}
const FMT = { rate: 22050, width: 2, channels: 1 };
function fakePiper(script) {
  const synths = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    readEvents(socket, ev => { if (ev.type === 'synthesize') { synths.push(ev.data); script(socket, ev.data, synths.length - 1); } });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, synths,
    close: () => new Promise(r => { sockets.forEach(s => s.destroy()); server.close(() => r()); }),
  })));
}
const speak = (socket, tag) => { send(socket, 'audio-start', FMT); send(socket, 'audio-chunk', FMT, Buffer.from('pcm-' + tag)); send(socket, 'audio-stop', {}); };

// ---- the host under test ------------------------------------------------------------------------
function makeHost(port, personaVoice, personaPick) {
  const grid = { id: 'sp', kind: 'app', app: 'ai-voice', options: { face: 'side', profilePick: 'chat', personaPick: personaPick === undefined ? 'kawaii' : personaPick, projectDir: __dirname } };
  const config = { grids: [grid], settings: { aiProfiles: [{ id: 'chat', name: 'Chat', prompt: '' }] } };
  ensurePersonas(config);
  const rocky = config.settings.personas.find(p => p.id === 'kawaii');
  rocky.voice = personaVoice;
  const adapter = new EventEmitter(); let running = false;
  Object.assign(adapter, {
    start: () => { running = true; return true; }, stop: () => { running = false; }, isRunning: () => running, sendTurn: () => true,
    setProfilePrompt: () => true, sessionId: () => 's', mode: () => 'default', currentModel: () => 'test', projectDir: () => __dirname,
    validModel: () => true, listModes: () => [], listModels: () => [], cancelApprovals() {},
  });
  const events = [];
  const host = createVoicePanelHost({ appId: 'ai-voice', storageKey: 'faceSpeechTest', adapter, branding: {}, deps: {
    activeServedAppConfig: () => ({ options: grid.options }), activeGrid: () => grid,
    getConfig: () => config, saveConfig: () => {}, setRingState: () => {}, clearRingOverride: () => {},
    getDocumentsPath: () => __dirname, voiceEndpoints: () => ({ ttsHost: '127.0.0.1', ttsPort: port }),
  } });
  host.handlers.subscribe(new EventEmitter(), { writeHead() {}, write(line) { if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); } });
  host.handlers.sessionStart();
  return { h: host.handlers, events, cleanup: () => host.shutdown() };
}
function fakeRes() {
  const r = { status: null, writes: [], ended: false, headCalls: 0 };
  r.writeHead = s => { r.status = s; r.headCalls++; };
  r.write = b => { r.writes.push(Buffer.from(b)); return true; };
  r.end = () => { r.ended = true; };
  return r;
}
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

test('a persona voice the server accepts is sent as voice.name, one request, one WAV header', async t => {
  const srv = await fakePiper((s) => speak(s, 'ok')); t.after(() => srv.close());
  const x = makeHost(srv.port, 'en_US-ryan-high'); t.after(x.cleanup);
  const res = fakeRes();
  await x.h.synthesize('Hello there.', res);
  assert.equal(srv.synths.length, 1);
  assert.deepEqual(srv.synths[0].voice, { name: 'en_US-ryan-high' });
  assert.equal(res.status, 200);
  assert.equal(res.writes[0].length, 44);
  assert.equal(res.writes[0].toString('ascii', 0, 4), 'RIFF');
  assert.equal(Buffer.concat(res.writes.slice(1)).toString(), 'pcm-ok');
  assert.equal(res.ended, true);
});

test('blank persona voice, or no persona, sends NO voice key', async t => {
  const srv = await fakePiper((s) => speak(s, 'ok')); t.after(() => srv.close());
  const a = makeHost(srv.port, ''); t.after(a.cleanup);
  await a.h.synthesize('Hello.', fakeRes());
  const b = makeHost(srv.port, 'en_US-ryan-high', ''); t.after(b.cleanup);   // personaPick '' = no persona at all
  await b.h.synthesize('Hello.', fakeRes());
  assert.equal(srv.synths.length, 2);
  srv.synths.forEach(d => assert.equal(hasKey(d, 'voice'), false, JSON.stringify(d)));
});

test('an unknown persona voice errors before any audio: retried ONCE without the voice, one WAV header, one audio body', async t => {
  const srv = await fakePiper((s, data) => {
    if (data.voice && data.voice.name === 'nope') send(s, 'error', { text: 'voice not found: nope', code: 'ValueError' });
    else speak(s, 'default');
  });
  t.after(() => srv.close());
  const x = makeHost(srv.port, 'nope'); t.after(x.cleanup);
  const res = fakeRes();
  await x.h.synthesize('Hello there.', res);
  assert.equal(srv.synths.length, 2, 'exactly one retry');
  assert.deepEqual(srv.synths[0].voice, { name: 'nope' });
  assert.equal(hasKey(srv.synths[1], 'voice'), false, 'the retry omits the voice');
  assert.equal(srv.synths[1].text, srv.synths[0].text, 'same sentence');
  assert.equal(res.status, 200);
  assert.equal(res.headCalls, 1, 'one response header');
  assert.equal(res.writes.filter(w => w.length === 44 && w.toString('ascii', 0, 4) === 'RIFF').length, 1, 'exactly one WAV header');
  assert.equal(Buffer.concat(res.writes.slice(1)).toString(), 'pcm-default', 'the audio is not doubled');
  assert.equal(res.ended, true);
  assert.equal(x.events.filter(e => e.type === 'speech-error').length, 1, 'the fallback is surfaced once');
});

test('once audio has been committed a failure is NOT retried and nothing is duplicated', async t => {
  const srv = await fakePiper((s) => { send(s, 'audio-start', FMT); send(s, 'audio-chunk', FMT, Buffer.from('half')); send(s, 'error', { text: 'boom mid-sentence' }); });
  t.after(() => srv.close());
  const x = makeHost(srv.port, 'en_US-ryan-high'); t.after(x.cleanup);
  const res = fakeRes();
  await x.h.synthesize('Hello there.', res);
  assert.equal(srv.synths.length, 1, 'no retry after output began');
  assert.equal(res.status, 200);
  assert.equal(res.headCalls, 1);
  assert.equal(Buffer.concat(res.writes.slice(1)).toString(), 'half');
  assert.equal(res.ended, true);
});

test('if the default voice fails too the response is a clean 502 after exactly two tries', async t => {
  const srv = await fakePiper((s) => send(s, 'error', { text: 'synthesis failed' })); t.after(() => srv.close());
  const x = makeHost(srv.port, 'nope'); t.after(x.cleanup);
  const res = fakeRes();
  await x.h.synthesize('Hello there.', res);
  assert.equal(srv.synths.length, 2);
  assert.equal(res.status, 502);
  assert.equal(res.writes.length, 0, 'no audio bytes');
  assert.equal(res.ended, true);
});

test('with no persona voice a failing server is not retried', async t => {
  const srv = await fakePiper((s) => send(s, 'error', { text: 'synthesis failed' })); t.after(() => srv.close());
  const x = makeHost(srv.port, ''); t.after(x.cleanup);
  const res = fakeRes();
  await x.h.synthesize('Hello there.', res);
  assert.equal(srv.synths.length, 1);
  assert.equal(res.status, 502);
});

test('Test speech with no TTS server configured or empty text is a 400, never a request', async t => {
  const srv = await fakePiper((s) => speak(s, 'ok')); t.after(() => srv.close());
  const x = makeHost(srv.port, 'en_US-ryan-high'); t.after(x.cleanup);
  const empty = fakeRes();
  await x.h.synthesize('   ', empty);
  assert.equal(empty.status, 400);
  assert.equal(srv.synths.length, 0);
});
