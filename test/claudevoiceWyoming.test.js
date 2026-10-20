'use strict';
// The Wyoming client against a loopback fake server: what synthesize() puts on the wire (the optional
// per-persona voice) and what describeVoices() makes of an `info` reply. Wire framing matches a real
// server: replies carry their data in a separate data_length block, audio chunks carry a payload.
// Protocol reference: OHF-Voice/wyoming (info.py: tts[].voices[]; the README shows the same level as
// `models`, so both are accepted) and synthesize's data { text, voice?: { name?, language?, speaker? } }.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { synthesize, describeVoices } = require('../app/claudevoice-wyoming');

// Reads client events: header line, optional data_length block, optional payload block. Our client
// writes its data inline in the header, which a real server also accepts.
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
      const ev = { type: pending.header.type, data: pending.data !== null ? pending.data : pending.header.data, raw: pending.header };
      pending = null;
      onEvent(ev);
    }
  });
}
// A reply the way a real Wyoming server frames it: data in its own block.
function send(socket, type, data, payload) {
  const body = data === undefined ? null : Buffer.from(JSON.stringify(data), 'utf8');
  const header = { type };
  if (body) header.data_length = body.length;
  if (payload) header.payload_length = payload.length;
  socket.write(JSON.stringify(header) + '\n');
  if (body) socket.write(body);
  if (payload) socket.write(payload);
}
function fakeServer(onEvent) {
  const seen = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    readEvents(socket, ev => { seen.push(ev); onEvent(socket, ev); });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    seen,
    close: () => new Promise(r => { sockets.forEach(s => s.destroy()); server.close(() => r()); }),
  })));
}
const speakOk = (socket, ev) => {
  if (ev.type !== 'synthesize') return;
  send(socket, 'audio-start', { rate: 22050, width: 2, channels: 1 });
  send(socket, 'audio-chunk', { rate: 22050, width: 2, channels: 1 }, Buffer.from([1, 2, 3, 4]));
  send(socket, 'audio-chunk', { rate: 22050, width: 2, channels: 1 }, Buffer.from([5, 6]));
  send(socket, 'audio-stop', {});
};

async function speak(extra) {
  const srv = await fakeServer(speakOk);
  try {
    const chunks = []; let format = null;
    await synthesize(Object.assign({ host: '127.0.0.1', port: srv.port, text: 'Hello there.', onFormat: f => { format = f; }, onChunk: c => chunks.push(c), timeoutMs: 3000 }, extra));
    return { event: srv.seen.find(e => e.type === 'synthesize'), format, audio: Buffer.concat(chunks) };
  } finally { await srv.close(); }
}

test('synthesize with a persona voice sends voice.name and still streams the audio back', async () => {
  const r = await speak({ voice: 'en_US-ryan-high' });
  assert.equal(r.event.data.text, 'Hello there.');
  assert.deepEqual(r.event.data.voice, { name: 'en_US-ryan-high' });
  assert.deepEqual(r.format, { rate: 22050, width: 2, channels: 1 });
  assert.deepEqual([...r.audio], [1, 2, 3, 4, 5, 6]);
});

test('synthesize without a voice sends NO voice key (the server default applies)', async () => {
  for (const voice of [undefined, '', null, '   ']) {
    const r = await speak(voice === undefined ? {} : { voice });
    assert.equal(r.event.data.text, 'Hello there.');
    assert.equal(Object.prototype.hasOwnProperty.call(r.event.data, 'voice'), false, 'voice=' + JSON.stringify(voice));
  }
});

test('synthesize trims the voice name and never sends credentials-shaped extras', async () => {
  const r = await speak({ voice: '  en_GB-alba-medium  ' });
  assert.deepEqual(r.event.data.voice, { name: 'en_GB-alba-medium' });
  assert.deepEqual(Object.keys(r.event.data).sort(), ['text', 'voice']);
});

function describeServer(info) {
  return fakeServer((socket, ev) => { if (ev.type === 'describe') send(socket, 'info', info); });
}
async function voicesFrom(info, opts) {
  const srv = await describeServer(info);
  try { return await describeVoices(Object.assign({ host: '127.0.0.1', port: srv.port, timeoutMs: 3000 }, opts)); }
  finally { await srv.close(); }
}

test('describeVoices sends a bare describe event and reads tts[].voices[]', async () => {
  const srv = await describeServer({ tts: [{ name: 'piper', voices: [
    { name: 'en_US-lessac-medium', description: 'Lessac', installed: true, languages: ['en_US'], attribution: { name: 'x', url: 'y' } },
    { name: 'en_US-ryan-high', installed: true, languages: ['en_US'] },
  ] }] });
  try {
    const v = await describeVoices({ host: '127.0.0.1', port: srv.port, timeoutMs: 3000 });
    const d = srv.seen.find(e => e.type === 'describe');
    assert.ok(d, 'a describe event was sent');
    assert.ok(d.data === undefined || Object.keys(d.data).length === 0, 'describe carries no data');
    assert.deepEqual(v.map(x => x.name), ['en_US-lessac-medium', 'en_US-ryan-high']);
    assert.deepEqual(v[0].languages, ['en_US']);
  } finally { await srv.close(); }
});

test('describeVoices also accepts the README shape tts[].models[]', async () => {
  const v = await voicesFrom({ tts: [{ models: [{ name: 'en_US-amy-low', installed: true, languages: ['en_US'] }] }] });
  assert.deepEqual(v.map(x => x.name), ['en_US-amy-low']);
});

test('describeVoices flattens several programs, skips uninstalled and nameless voices, dedupes', async () => {
  const v = await voicesFrom({ tts: [
    { name: 'a', voices: [{ name: 'one', installed: true }, { name: 'gone', installed: false }, { installed: true }, { name: 'one', installed: true }] },
    { name: 'b', voices: [{ name: 'two' }] },
  ] });
  assert.deepEqual(v.map(x => x.name), ['one', 'two']);
});

test('describeVoices returns [] when the server lists no tts voices', async () => {
  assert.deepEqual(await voicesFrom({ asr: [{ name: 'whisper' }], tts: [] }), []);
  assert.deepEqual(await voicesFrom({}), []);
});

test('describeVoices rejects when the connection closes before an info event', async () => {
  const srv = await fakeServer((socket, ev) => { if (ev.type === 'describe') socket.end(); });
  try { await assert.rejects(() => describeVoices({ host: '127.0.0.1', port: srv.port, timeoutMs: 3000 })); }
  finally { await srv.close(); }
});

test('describeVoices rejects on timeout when the server never answers', async () => {
  const srv = await fakeServer(() => {});
  try { await assert.rejects(() => describeVoices({ host: '127.0.0.1', port: srv.port, timeoutMs: 250 }), /timed out/i); }
  finally { await srv.close(); }
});

test('describeVoices rejects when nothing is listening', async () => {
  const srv = await fakeServer(() => {});
  const port = srv.port;
  await srv.close();
  await assert.rejects(() => describeVoices({ host: '127.0.0.1', port, timeoutMs: 1500 }));
});

// A Wyoming server reports failure as an `error` event ({ text, code }) and may keep the socket open;
// the client must fail right away, not wait for the 30 s request timeout (an unknown persona voice
// on wyoming-piper ends this way).
test('synthesize rejects promptly on an error event, with the server text', async () => {
  const srv = await fakeServer((socket, ev) => { if (ev.type === 'synthesize') send(socket, 'error', { text: 'voice not found: nope', code: 'ValueError' }); });
  try {
    const t0 = Date.now();
    await assert.rejects(() => synthesize({ host: '127.0.0.1', port: srv.port, text: 'Hi.', voice: 'nope', timeoutMs: 5000 }), /voice not found: nope/);
    assert.ok(Date.now() - t0 < 2000, 'failed fast, not at the timeout');
  } finally { await srv.close(); }
});

test('describeVoices rejects promptly on an error event', async () => {
  const srv = await fakeServer((socket, ev) => { if (ev.type === 'describe') send(socket, 'error', { text: 'not supported' }); });
  try {
    const t0 = Date.now();
    await assert.rejects(() => describeVoices({ host: '127.0.0.1', port: srv.port, timeoutMs: 5000 }), /not supported/);
    assert.ok(Date.now() - t0 < 2000);
  } finally { await srv.close(); }
});
