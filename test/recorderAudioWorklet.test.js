'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '..', 'app', name), 'utf8');

test('worklet PCM matches the former conversion and keeps channel order and gating', () => {
  let Processor, sent;
  class Base { constructor() { this.port = { postMessage: x => { sent = x; } }; } }
  vm.runInNewContext(source('recorder-audio-worklet.js'), { AudioWorkletProcessor: Base, registerProcessor: (_, c) => { Processor = c; }, Float32Array, Int16Array, Math });
  const mic = new Float32Array([-1.5, -1, -0.5, 0, 0.5, 1, 1.5]);
  const sys = new Float32Array([1, 0.5, 0, -0.5, -1, 1.2, -1.2]);
  const reference = gated => { const out = new Int16Array(mic.length * 2); for (let i = 0; i < mic.length; i++) { const m = Math.max(-1, Math.min(1, gated ? 0 : mic[i])); const s = Math.max(-1, Math.min(1, sys[i])); out[i * 2] = m < 0 ? m * 0x8000 : m * 0x7fff; out[i * 2 + 1] = s < 0 ? s * 0x8000 : s * 0x7fff; } return Buffer.from(out.buffer); };
  for (const gated of [false, true]) {
    const p = new Processor({ processorOptions: { echoGate: gated, threshold: 0.005, bufferSize: mic.length } });
    assert.equal(p.process([[mic, sys]]), true);
    assert.deepEqual(Buffer.from(sent.pcm), reference(gated));
    assert.equal(sent.meta.micGated, gated);
  }
});

test('recorder requests raw microphone constraints', async () => {
  const calls = [];
  const api = { onCommand: cb => { api.command = cb; }, ready() {}, sendState() {}, sendPcm() {}, sendError() {}, sendEnded() {} };
  class Capture { constructor(opts) { calls.push(opts); } start() { return Promise.resolve(); } stop() {} }
  const context = { window: { recorderAPI: api, SystemAudioCapture: Capture }, document: { getElementById: () => null }, navigator: {} };
  vm.runInNewContext(source('recorderview.js'), context);
  api.command({ type: 'start', session: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) assert.equal(calls[0].micConstraints[key], false);
});

test('capture uses silent sink, connects no speaker, and cleans up on module failure', async () => {
  const events = [];
  const track = () => ({ readyState: 'live', stop() { events.push('stop'); }, addEventListener() {}, removeEventListener() {} });
  const mic = track(), system = track(), video = track();
  const stream = t => ({ getTracks: () => [t], getAudioTracks: () => [t], getVideoTracks: () => [] });
  let fail = false;
  class AudioContext {
    constructor(opts) { events.push(opts); this.sinkId = opts.sinkId; this.audioWorklet = { addModule: async name => { events.push(name); if (fail) throw Error('module failed'); } }; }
    createMediaStreamSource() { return { connect() {} }; }
    createChannelMerger() { return { connect() {} }; }
    close() { events.push('close'); }
  }
  class AudioWorkletNode { constructor() { this.port = { close() {} }; } disconnect() {} }
  const context = { window: {}, AudioContext, AudioWorkletNode, Float32Array, Int16Array, Math,
    navigator: { mediaDevices: { enumerateDevices: async () => [], getUserMedia: async () => stream(mic), getDisplayMedia: async () => ({ getVideoTracks: () => [video], getAudioTracks: () => [system], getTracks: () => [system, video] }) } } };
  vm.runInNewContext(source('system-audio-capture.js'), context);
  const Capture = context.window.SystemAudioCapture;
  const c = new Capture({ onPcm() {} });
  await c.start();
  assert.equal(c.isRunning(), true);
  const options = events.find(x => x && x.sinkId);
  assert.equal(options.sampleRate, 16000);
  assert.equal(options.sinkId.type, 'none');
  assert.ok(events.includes('/recorder-audio-worklet.js'));
  c.stop();
  assert.ok(events.includes('close'));
  events.length = 0; fail = true;
  await assert.rejects(new Capture({ onPcm() {} }).start(), /module failed/);
  assert.equal(events.filter(x => x === 'stop').length, 4); // video is stopped again with the stream; both audio tracks are stopped
  assert.ok(events.includes('close'));
});




test('worklet batches render quanta and retains only complete blocks', () => {
  let Processor, messages = 0;
  class Base { constructor() { this.port = { postMessage() { messages++; } }; } }
  vm.runInNewContext(source('recorder-audio-worklet.js'), { AudioWorkletProcessor: Base, registerProcessor: (_, c) => { Processor = c; }, Float32Array, Int16Array, Math });
  const p = new Processor({ processorOptions: { bufferSize: 4096, threshold: 0.005 } });
  const frame = new Float32Array(128);
  for (let i = 0; i < 31; i++) p.process([[frame, frame]]);
  assert.equal(messages, 0);
  p.process([[frame, frame]]);
  assert.equal(messages, 1);
  p.process([[frame, frame]]);
  assert.equal(messages, 1);
});
