'use strict';
// Voice-activity detector shared by the voice panels, LucidType dictation, and Live Translate. The
// minimum-speech gate counts VOICED audio, so a click or knock is dropped before it reaches Whisper
// (which would otherwise hallucinate "Thank you." for it) while short real words still ship.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'claudevoice-vad.js'), 'utf8');
const RATE = 16000, BUF = 4096;

// Loads the page script against a fake Web Audio graph and returns a driver that feeds 256ms buffers.
async function loadVad(opts, ctxState, neverResume) {
  let processor = null, resumed = 0;
  const sandbox = {
    console, setTimeout, clearTimeout, Date, Float32Array, Int16Array, Math,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [{ label: 'Jabra' }] }) } },
    window: {},
  };
  sandbox.window.AudioContext = function () {
    return {
      state: ctxState || 'running', sampleRate: RATE,
      resume() { resumed++; if (neverResume) return new Promise(() => {}); this.state = 'running'; return Promise.resolve(); },
      destination: {},
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      createScriptProcessor: () => (processor = { connect() {}, disconnect() {}, onaudioprocess: null }),
      createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
      close() {},
    };
  };
  vm.runInNewContext(SRC, sandbox, { filename: 'claudevoice-vad.js' });
  const vad = sandbox.window.createClaudeVoiceVAD(opts);
  const shipped = [];
  await vad.start(() => {}, pcm => shipped.push(pcm.length), () => {});
  return {
    vad, shipped, resumed: () => resumed,
    // One 256ms buffer whose first `loudMs` are a 0.3-amplitude tone and the rest silence.
    feed(loudMs) {
      const data = new Float32Array(BUF);
      const loud = Math.min(BUF, Math.round(loudMs * RATE / 1000));
      for (let i = 0; i < loud; i++) data[i] = 0.3 * Math.sin(i / 3);
      processor.onaudioprocess({ inputBuffer: { getChannelData: () => data } });
    },
  };
}

test('a lone click is dropped even though the hangover makes the clip long', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const d = await loadVad({ hangoverMs: 400 });
  d.feed(20);    // 20ms knock: the whole buffer still crosses the RMS threshold
  d.feed(0);     // silence starts the hangover
  t.mock.timers.tick(400);
  assert.deepEqual(d.shipped, []);
  d.vad.stop();
});

test('a short real word ships', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const d = await loadVad({ hangoverMs: 400 });
  d.feed(200);   // ~200ms of voicing -- a quick "yes"
  d.feed(0);
  t.mock.timers.tick(400);
  assert.equal(d.shipped.length, 1);
  assert.equal(d.shipped[0], 2 * BUF);   // the word plus its trailing silence buffer
  d.vad.stop();
});

test('voiced time accumulates across buffers within one utterance', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const d = await loadVad({ hangoverMs: 400, minSpeechMs: 150 });
  d.feed(100);   // 100ms + 100ms: neither alone clears 150ms, together they do
  d.feed(100);
  d.feed(0);
  t.mock.timers.tick(400);
  assert.equal(d.shipped.length, 1);
  d.vad.stop();
});

test('the short tail of a force-cut utterance still ships', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const d = await loadVad({ hangoverMs: 400, maxUtteranceMs: 500 });
  d.feed(256);
  t.mock.timers.tick(256);
  d.feed(256);
  t.mock.timers.tick(256);
  d.feed(256);   // 512ms in: force-cut ships the first part
  assert.equal(d.shipped.length, 1);
  d.feed(20);    // a sliver of voicing after the cut, then the speaker stops
  d.feed(0);
  t.mock.timers.tick(400);
  assert.equal(d.shipped.length, 2);
  d.vad.stop();
});

test('a context that comes up suspended is resumed, and info() reports what was opened', async () => {
  const d = await loadVad({}, 'suspended');
  assert.equal(d.resumed(), 1);
  assert.deepEqual({ ...d.vad.info() }, { label: 'Jabra', state: 'running', sampleRate: RATE, threshold: 0.02 });
  d.vad.stop();
  assert.equal(d.vad.info().state, 'closed');
});

test('a context the browser refuses to resume does not hang start()', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let done = false;
  const pending = loadVad({}, 'suspended', true).then(d => { done = true; return d; });
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(done, false);
  t.mock.timers.tick(500);
  const d = await pending;
  assert.equal(d.vad.info().state, 'suspended');   // reported, so LucidType can say so
  d.vad.stop();
});
