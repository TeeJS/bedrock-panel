'use strict';

// The recording folder is usually a network share. These cover the three ways it can fail:
// unreachable when a recording starts, lost while recording, and lost while the file is closing.
// Each used to surface as an unhandled write-stream 'error', which quit the whole app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function load(disk) {
  class Window {
    constructor() { this.sent = []; this.webContents = { send: (ch, msg) => this.sent.push(msg) }; }
    isDestroyed() { return false; }
    on() {}
    loadURL() {}
  }
  const sandbox = { module: { exports: {} }, Buffer, Date,
    require(name) {
      if (name === 'electron') return { BrowserWindow: Window, session: { fromPartition() { return {}; } } };
      if (name === 'fs') return disk;
      if (name === 'path') return path;
      throw new Error('unexpected dependency ' + name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/meetingRecorder.js'), 'utf8'), sandbox);
  return sandbox.module.exports.createMeetingRecorder;
}

// Fake disk whose write stream is an EventEmitter the test can fail on demand.
function setup(options = {}) {
  const streams = [];
  const unlinked = [];
  const logs = [];
  const states = [];
  const discarded = [];
  const completed = [];
  const disk = {
    mkdirSync() { if (options.mkdirFails) { const e = new Error('UNKNOWN: unknown error, mkdir'); e.code = 'UNKNOWN'; throw e; } },
    writeFileSync() {},
    createWriteStream() {
      const s = new EventEmitter();
      s.write = () => {};
      s.destroy = () => { s.destroyed = true; };
      s.end = callback => { s.ending = callback; };
      streams.push(s);
      return s;
    },
    openSync() { return 1; },
    writeSync() {},
    closeSync() {},
    unlinkSync(p) { unlinked.push(p); },
  };
  const recorder = load(disk)({
    defaultFolder: () => path.join('M:', 'meetings', 'unprocessed'),
    recorderUrl: () => 'http://fake/recorder',
    log: m => logs.push(m),
    onState: s => states.push(s),
    onRecordingDiscarded: n => discarded.push(n),
    onRecordingComplete: n => completed.push(n),
  });
  recorder.ensureWindow();
  recorder.onReady();
  return { recorder, streams, unlinked, logs, states, discarded, completed };
}

function ioError(code) { const e = new Error(code + ': unknown error, open'); e.code = code; return e; }

test('start is refused, without opening a file, when the recording folder cannot be reached', () => {
  const s = setup({ mkdirFails: true });
  const st = s.recorder.start('auto', 'ms-teams.exe');
  assert.equal(st.recording, false);
  assert.match(st.error, /^Recording folder unavailable: /);
  assert.equal(s.streams.length, 0, 'no wav stream opened');
  assert.equal(s.recorder.getBusyFiles().length, 0);
  assert.equal(s.states.at(-1).error, st.error, 'state change published');
});

test('a wav open failure stops the recording and cleans up instead of throwing', () => {
  const s = setup();
  const file = s.recorder.start('auto', 'ms-teams.exe').file;
  assert.equal(s.recorder.getState().recording, true);
  assert.doesNotThrow(() => s.streams[0].emit('error', ioError('UNKNOWN')));
  const st = s.recorder.getState();
  assert.equal(st.recording, false);
  assert.equal(st.file, null);
  assert.match(st.error, /^Recording folder unavailable: /);
  assert.deepEqual(s.discarded, [file], 'main is told to drop the sidecars it owns');
  assert.ok(s.unlinked.some(p => p.endsWith('.capture.json')), 'capture sidecar removed');
  assert.equal(s.recorder.getBusyFiles().length, 0);
  assert.equal(s.states.at(-1).recording, false);
});

test('losing the folder mid-recording stops the recording but never deletes captured audio', () => {
  const s = setup();
  s.recorder.start('manual');
  s.recorder.onPcm(Buffer.alloc(8), { session: 1, micRms: 1, systemRms: 1 });
  assert.doesNotThrow(() => s.streams[0].emit('error', ioError('ENETUNREACH')));
  const st = s.recorder.getState();
  assert.equal(st.recording, false);
  assert.match(st.error, /^Recording stopped: lost the recording folder /);
  assert.deepEqual(s.unlinked, []);
  assert.deepEqual(s.discarded, []);
  assert.ok(s.logs.some(l => /recording aborted \(ENETUNREACH\) after 8 data bytes/.test(l)));
});

test('a write failure while the file is closing is logged and finalization still completes', () => {
  const s = setup();
  const file = s.recorder.start('manual').file;
  s.recorder.onPcm(Buffer.alloc(8), { session: 1, micRms: 1, systemRms: 1 });
  s.recorder.stop('call-ended');
  assert.doesNotThrow(() => s.streams[0].emit('error', ioError('ENETUNREACH')));
  s.streams[0].ending(ioError('ENETUNREACH'));
  assert.ok(s.logs.some(l => /wav write failed while closing \(ENETUNREACH\)/.test(l)));
  assert.deepEqual(s.completed, [file]);
  assert.equal(s.recorder.getBusyFiles().length, 0);
});

test('the next successful start clears the previous error', () => {
  const s = setup();
  s.recorder.start('manual');
  s.streams[0].emit('error', ioError('UNKNOWN'));
  assert.ok(s.recorder.getState().error);
  const st = s.recorder.start('manual');
  assert.equal(st.recording, true);
  assert.equal(st.error, '');
});

// Real fs.createWriteStream against a folder that is not there: the exact failure from the field,
// where mkdir "succeeded" but the open did not. Unfixed, this is an uncaughtException.
test('a real write stream that cannot open does not raise an unhandled error', { timeout: 5000 }, async () => {
  const missing = path.join(os.tmpdir(), 'bedrock-missing-' + process.pid + '-' + Date.now(), 'unprocessed');
  const disk = Object.assign({}, fs, { mkdirSync() {} });
  const states = [];
  const recorder = load(disk)({
    defaultFolder: () => missing, recorderUrl: () => 'http://fake/recorder', onState: s => states.push(s),
  });
  recorder.ensureWindow();
  recorder.onReady();
  assert.equal(recorder.start('auto', 'ms-teams.exe').recording, true);
  await new Promise(resolve => {
    const t = setInterval(() => { if (!recorder.getState().recording) { clearInterval(t); resolve(); } }, 5);
  });
  assert.match(recorder.getState().error, /^Recording folder unavailable: /);
  assert.equal(fs.existsSync(missing), false);
});
