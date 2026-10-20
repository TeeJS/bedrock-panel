'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { busyReasons, isTranscribing, quitPrompt } = require('../app/quitGuard');

test('idle -> no reasons', () => {
  assert.deepStrictEqual(busyReasons({ recording: false, transcribing: false }), []);
  assert.deepStrictEqual(busyReasons(null), []);
});
test('recording and/or transcribing are reported', () => {
  assert.deepStrictEqual(busyReasons({ recording: true }), ['recording']);
  assert.deepStrictEqual(busyReasons({ transcribing: true }), ['transcription']);
  assert.deepStrictEqual(busyReasons({ recording: true, transcribing: true }), ['recording', 'transcription']);
});
test('isTranscribing: running job or queue counts', () => {
  assert.strictEqual(isTranscribing({ current: null, queue: [] }), false);
  assert.strictEqual(isTranscribing({ current: { name: 'a.wav' }, queue: [] }), true);
  assert.strictEqual(isTranscribing({ current: null, queue: [{ name: 'a.wav' }] }), true);
  assert.strictEqual(isTranscribing(null), false);
});
test('prompt text names what is running', () => {
  assert.match(quitPrompt(['recording']).message, /recording is in progress/i);
  assert.match(quitPrompt(['transcription']).message, /transcription is in progress/i);
  assert.match(quitPrompt(['recording', 'transcription']).message, /recording and a transcription/i);
});
