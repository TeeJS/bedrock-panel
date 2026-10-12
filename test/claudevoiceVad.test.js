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
async function loadVad(opts, ctxState, neverResume, gumGate) {
  let processor = null, resumed = 0;
  const tracksStopped = [];
  const sandbox = {
    console, setTimeout, clearTimeout, Date, Float32Array, Int16Array, Math,
    navigator: { mediaDevices: { getUserMedia: async () => {
      if (gumGate) await gumGate;
      return { getTracks: () => [{ stop() { tracksStopped.push(1); } }], getAudioTracks: () => [{ label: 'Jabra' }] };
    } } },
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
  const started = vad.start(() => {}, pcm => shipped.push(pcm.length), () => {});
  if (!gumGate) await started;
  return {
    vad, shipped, started, resumed: () => resumed, tracksStopped, hasProcessor: () => !!processor,
    match: sandbox.window.matchMicLabel,
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

test('the short tail of a force-cut utterance still ships, but a tail of only noise does not', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const d = await loadVad({ hangoverMs: 400, maxUtteranceMs: 500 });
  const cut = () => { d.feed(256); t.mock.timers.tick(256); d.feed(256); t.mock.timers.tick(256); d.feed(256); };
  cut();         // 512ms in: force-cut ships the first part
  assert.equal(d.shipped.length, 1);
  d.feed(60);    // the last syllable after the cut, then the speaker stops
  d.feed(0);
  t.mock.timers.tick(400);
  assert.equal(d.shipped.length, 2);
  cut();
  assert.equal(d.shipped.length, 3);
  d.feed(20);    // a breath or click after the cut: nothing for Whisper to transcribe
  d.feed(0);
  t.mock.timers.tick(400);
  assert.equal(d.shipped.length, 3);
  d.vad.stop();
});

test('a quiet one-syllable word (about 100ms voiced) ships', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const d = await loadVad({ hangoverMs: 400 });
  d.feed(110);
  d.feed(0);
  t.mock.timers.tick(400);
  assert.equal(d.shipped.length, 1);
  d.vad.stop();
});

test('stop() while the mic is still opening releases it instead of leaving a capture running', async () => {
  let open;
  const gate = new Promise(r => { open = r; });
  const d = await loadVad({}, 'running', false, gate);
  d.vad.stop();                  // the user stopped before getUserMedia answered
  open();
  await d.started;               // resolves quietly, no TypeError
  assert.equal(d.tracksStopped.length, 1);
  assert.equal(d.hasProcessor(), false);
});

test('stop() during the resume wait does not crash start()', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const d = await loadVad({}, 'suspended', true, Promise.resolve());
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  d.vad.stop();                  // closes the context while start() waits on resume()
  t.mock.timers.tick(500);
  await d.started;               // no "Cannot read properties of null"
  assert.equal(d.hasProcessor(), false);
});

test('a context that comes up suspended is resumed, and info() reports what was opened', async () => {
  const d = await loadVad({}, 'suspended');
  assert.equal(d.resumed(), 1);
  assert.deepEqual({ ...d.vad.info() }, { label: 'Jabra', fellBack: false, state: 'running', sampleRate: RATE, threshold: 0.02 });
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

// openMicStream against a scripted mediaDevices: records every constraint set it is asked for.
function loadOpenMic(behaviour) {
  const asked = [];
  const sandbox = { console, setTimeout, clearTimeout, Date, Float32Array, Int16Array, Math, window: {},
    navigator: { mediaDevices: { getUserMedia: async c => { asked.push(JSON.parse(JSON.stringify(c.audio))); return behaviour(c.audio); } } } };   // plain copies: sandbox objects have another realm's prototypes
  vm.runInNewContext(SRC, sandbox, { filename: 'claudevoice-vad.js' });
  return { open: (audio, id) => sandbox.window.openMicStream(sandbox.navigator.mediaDevices, audio, id), asked };
}
const stream = label => ({ getAudioTracks: () => [{ label }], getTracks: () => [] });
const err = name => Object.assign(new Error(name), { name });

test('openMicStream asks for the chosen mic with an exact deviceId (ideal opened the Windows default)', async () => {
  const m = loadOpenMic(a => stream(a.deviceId ? 'Jabra' : 'Default - Insta360'));
  const r = await m.open({ channelCount: 1, sampleRate: RATE }, 'jab');
  assert.deepEqual(m.asked, [{ channelCount: 1, sampleRate: RATE, deviceId: { exact: 'jab' } }]);
  assert.equal(r.stream.getAudioTracks()[0].label, 'Jabra');
  assert.equal(r.fellBack, false);
});

test('openMicStream falls back to the system default when the chosen mic cannot be opened, and says so', async () => {
  for (const name of ['OverconstrainedError', 'NotFoundError', 'NotReadableError']) {
    const m = loadOpenMic(a => { if (a.deviceId) throw err(name); return stream('Default - Insta360'); });
    const r = await m.open({ channelCount: 1, sampleRate: RATE }, 'gone');
    assert.deepEqual(m.asked, [{ channelCount: 1, sampleRate: RATE, deviceId: { exact: 'gone' } }, { channelCount: 1, sampleRate: RATE }], name);
    assert.equal(r.stream.getAudioTracks()[0].label, 'Default - Insta360', name);
    assert.equal(r.fellBack, true, name);
  }
});

test('openMicStream does not hide a permission failure behind the fallback', async () => {
  const m = loadOpenMic(() => { throw err('NotAllowedError'); });
  await assert.rejects(m.open({ channelCount: 1 }, 'jab'), { name: 'NotAllowedError' });
  assert.equal(m.asked.length, 1);
});

test('openMicStream with no deviceId opens the default once, with the other constraints kept', async () => {
  const m = loadOpenMic(() => stream('Default - Insta360'));
  const r = await m.open({ channelCount: 1, sampleRate: RATE }, '');
  assert.deepEqual(m.asked, [{ channelCount: 1, sampleRate: RATE }]);
  assert.equal(r.fellBack, false);
  const n = loadOpenMic(() => stream('Default - Insta360'));
  await n.open(true, '');
  assert.deepEqual(n.asked, [true]);
});

test('the detector reports a fallback through info().fellBack so pages can show it', async () => {
  // Same driver as the other detector tests, but the fake mic refuses the exact id.
  const sandbox = { console, setTimeout, clearTimeout, Date, Float32Array, Int16Array, Math, window: {},
    navigator: { mediaDevices: { getUserMedia: async c => { if (c.audio.deviceId) throw err('NotFoundError'); return stream('Default - Insta360'); } } } };
  sandbox.window.AudioContext = function () { return { state: 'running', sampleRate: RATE, destination: {}, resume: () => Promise.resolve(),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), createScriptProcessor: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }), close() {} }; };
  vm.runInNewContext(SRC, sandbox, { filename: 'claudevoice-vad.js' });
  const vad = sandbox.window.createClaudeVoiceVAD({});
  vad.setInputDevice('gone');
  await vad.start(() => {}, () => {}, () => {});
  assert.equal(vad.info().fellBack, true);
  assert.equal(vad.info().label, 'Default - Insta360');
  vad.stop();
});

test('matchMicLabel finds a saved mic by name across Windows default entries and id suffixes', async () => {
  const d = await loadVad({});
  const match = d.match;
  const devices = [
    { kind: 'audioinput', label: 'Default - Microphone (3- Insta360 Link) (2e1a:4c01)', deviceId: 'default' },
    { kind: 'audioinput', label: 'Communications - Microphone (Jabra SPEAK 410 USB) (0b0e:0412)', deviceId: 'communications' },
    { kind: 'audioinput', label: 'Microphone (3- Insta360 Link) (2e1a:4c01)', deviceId: 'cam' },
    { kind: 'audioinput', label: 'Microphone (Jabra SPEAK 410 USB) (0b0e:0412)', deviceId: 'jab' },
    { kind: 'audiooutput', label: 'Speakers (Jabra SPEAK 410 USB) (0b0e:0412)', deviceId: 'spk' },
  ];
  assert.equal(match(devices, 'Microphone (Jabra SPEAK 410 USB) (0b0e:0412)'), 'jab');
  assert.equal(match(devices, 'Default - Microphone (3- Insta360 Link) (2e1a:4c01)'), 'cam');   // the real device, not the moving "default" alias
  assert.equal(match(devices, 'Microphone (Jabra SPEAK 410 USB)'), 'jab');                      // saved without the id suffix
  assert.equal(match(devices, 'microphone (jabra speak 410 usb) (0b0e:0412)'), 'jab');
  assert.equal(match(devices, 'Microphone (Blue Yeti)'), '');                                   // unplugged: system default
  assert.equal(match(devices, ''), '');
  assert.equal(match(devices.map(x => Object.assign({}, x, { label: '' })), 'Microphone (Jabra SPEAK 410 USB) (0b0e:0412)'), '');
  d.vad.stop();
});
