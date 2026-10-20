'use strict';
// Per-persona voice in the speech pipeline. One turn = one WAV stream with ONE header, so the TTS
// target {host, port, voice} must be frozen for the whole turn (changing persona/page/voice mid-reply
// must not splice 16 kHz PCM under a 22 kHz header), the next turn must pick up the new values, and
// a persona voice that the server rejects may fall back to the default voice only BEFORE any audio
// has been committed -- never after output began, or a sentence would play twice.
const test = require('node:test');
const assert = require('node:assert');
const { createSpeechPipeline } = require('../app/claudevoice-speech');
const { wavHeader } = require('../app/claudevoice-wyoming');

function fakeRes() {
  const r = { status: null, chunks: [], ended: false };
  r.writeHead = s => { r.status = s; };
  r.write = b => r.chunks.push(Buffer.from(b));
  r.end = () => { r.ended = true; };
  return r;
}
const fakeReq = () => ({ on() {} });
const tick = (ms) => new Promise(r => setTimeout(r, ms || 25));
const FMT22 = { rate: 22050, width: 2, channels: 1 };
const FMT16 = { rate: 16000, width: 2, channels: 1 };

// A synthesize() double: records each call and answers with `behave(call, n)`; the default speaks one
// chunk named after the sentence in the format given.
function recorder(behave) {
  const calls = [];
  const fn = (opts) => {
    const n = calls.length;
    calls.push({ host: opts.host, port: opts.port, voice: opts.voice, text: opts.text });
    return behave ? behave(opts, n) : (opts.onFormat(FMT22), opts.onChunk(Buffer.from('pcm:' + opts.text)), Promise.resolve());
  };
  fn.calls = calls;
  return fn;
}
async function runTurn(p, sentences, onBegin) {
  const id = p.beginTurn();
  if (onBegin) onBegin();
  const res = fakeRes();
  p.attach(id, fakeReq(), res);
  for (const s of sentences) { p.feed(s); await tick(); }
  p.finish('');
  await tick(60);
  return res;
}

test('the persona voice from getTts reaches every synthesize call of the turn', async () => {
  const synth = recorder();
  const p = createSpeechPipeline({ synthesize: synth, wavHeader, getTts: () => ({ host: 'h', port: 1, voice: 'en_US-ryan-high' }), log: () => {}, onSpeechError: () => {} });
  await runTurn(p, ['First one. ', 'Second one. ']);
  assert.equal(synth.calls.length, 2);
  synth.calls.forEach(c => assert.equal(c.voice, 'en_US-ryan-high'));
});

test('no persona voice -> an empty voice (the server default), host and port unchanged', async () => {
  const synth = recorder();
  const p = createSpeechPipeline({ synthesize: synth, wavHeader, getTts: () => ({ host: 'h', port: 7 }), log: () => {}, onSpeechError: () => {} });
  await runTurn(p, ['Only one. ']);
  assert.equal(synth.calls.length, 1);
  assert.ok(!synth.calls[0].voice, 'voice must be blank, got ' + JSON.stringify(synth.calls[0].voice));
  assert.equal(synth.calls[0].host, 'h');
  assert.equal(synth.calls[0].port, 7);
});

test('host, port and voice are frozen for the whole turn, and the next turn picks up the new ones', async () => {
  const synth = recorder();
  let live = { host: 'a', port: 1, voice: 'voice-a' };
  const p = createSpeechPipeline({ synthesize: synth, wavHeader, getTts: () => live, log: () => {}, onSpeechError: () => {} });
  await runTurn(p, ['One. ', 'Two. ', 'Three. '], () => {});
  const turn1 = synth.calls.length;
  live = { host: 'b', port: 2, voice: 'voice-b' };      // turn 2 begins with b ...
  const id = p.beginTurn();
  const res = fakeRes();
  p.attach(id, fakeReq(), res);
  p.feed('Four. '); await tick();
  live = { host: 'c', port: 3, voice: 'voice-c' };      // ... and c, changed mid-turn, must NOT leak into its later sentences
  p.feed('Five. '); await tick();
  p.feed('Six. '); await tick();
  p.finish(''); await tick(60);
  const first = synth.calls.slice(0, turn1), second = synth.calls.slice(turn1);
  assert.equal(first.length, 3);
  first.forEach(c => assert.deepEqual([c.host, c.port, c.voice], ['a', 1, 'voice-a']));
  assert.equal(second.length, 3);
  second.forEach(c => assert.deepEqual([c.host, c.port, c.voice], ['b', 2, 'voice-b'], 'turn 2 sentence "' + c.text + '"'));
});

test('a sentence whose audio format differs from the turn header is not spliced into the stream', async () => {
  const errors = [];
  const synth = recorder((opts, n) => {
    opts.onFormat(n === 0 ? FMT22 : FMT16);
    opts.onChunk(Buffer.from('pcm' + n));
    return Promise.resolve();
  });
  const p = createSpeechPipeline({ synthesize: synth, wavHeader, getTts: () => ({ host: 'h', port: 1, voice: 'v' }), log: () => {}, onSpeechError: m => errors.push(m) });
  const res = await runTurn(p, ['First. ', 'Second. ']);
  const header = res.chunks[0];
  assert.equal(header.readUInt32LE(24), 22050, 'the one header is the first sentence\'s format');
  const body = Buffer.concat(res.chunks.slice(1)).toString();
  assert.ok(body.indexOf('pcm0') !== -1, 'first sentence audio is there');
  assert.equal(body.indexOf('pcm1'), -1, '16 kHz audio must not follow a 22 kHz header');
  assert.equal(errors.length, 1, 'the skipped sentence is reported once');
  assert.equal(res.ended, true);
});

test('a persona voice the server rejects before any audio retries ONCE with the default voice', async () => {
  const errors = [];
  const synth = recorder((opts) => {
    if (opts.voice) return Promise.reject(new Error('voice not found: ' + opts.voice));
    opts.onFormat(FMT22); opts.onChunk(Buffer.from('pcm:' + opts.text));
    return Promise.resolve();
  });
  const p = createSpeechPipeline({ synthesize: synth, wavHeader, getTts: () => ({ host: 'h', port: 1, voice: 'nope' }), log: () => {}, onSpeechError: m => errors.push(m) });
  const res = await runTurn(p, ['Hello there. ']);
  assert.deepEqual(synth.calls.map(c => c.voice || ''), ['nope', ''], 'one try with the voice, one without');
  assert.equal(Buffer.concat(res.chunks.slice(1)).toString(), 'pcm:Hello there.');
  assert.equal(res.status, 200);
  assert.ok(errors.length <= 1, 'the fallback is surfaced at most once');
});

test('after audio has started a failure is never retried (no duplicated speech)', async () => {
  const synth = recorder((opts) => {
    opts.onFormat(FMT22); opts.onChunk(Buffer.from('half'));
    return Promise.reject(new Error('connection reset mid-sentence'));
  });
  const p = createSpeechPipeline({ synthesize: synth, wavHeader, getTts: () => ({ host: 'h', port: 1, voice: 'v' }), log: () => {}, onSpeechError: () => {} });
  const res = await runTurn(p, ['Only sentence. ']);
  assert.equal(synth.calls.length, 1, 'the sentence is not synthesized a second time');
  assert.equal(Buffer.concat(res.chunks.slice(1)).toString(), 'half');
});

test('with no persona voice a failing server is not retried', async () => {
  const synth = recorder(() => Promise.reject(new Error('ECONNREFUSED')));
  const p = createSpeechPipeline({ synthesize: synth, wavHeader, getTts: () => ({ host: 'h', port: 1 }), log: () => {}, onSpeechError: () => {} });
  await runTurn(p, ['Hello. ']);
  assert.equal(synth.calls.length, 1);
});
