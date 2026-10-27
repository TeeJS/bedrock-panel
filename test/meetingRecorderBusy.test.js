'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Fake capture window and disk writes; control stream completion separately from stop().
function setup(onRecordingComplete, patchFails, onRecordingDiscarded) {
  const endings = [];
  const writes = [];
  const unlinked = [];
  let time = Date.UTC(2026, 9, 14);
  class Clock extends Date { constructor() { super(time); time += 1000; } }
  class Window {
    constructor() { this.webContents = { send() {} }; }
    isDestroyed() { return false; }
    on() {}
    loadURL() {}
  }
  const files = {};
  const disk = {
    mkdirSync() {},
    writeFileSync(p, data) { files[p] = String(data); },
    createWriteStream() { return { write() {}, end(callback) { endings.push(callback); } }; },
    openSync() { if (patchFails) throw new Error('patch failed'); return 1; },
    writeSync(fd, buffer, offset, length, position) { writes.push(position); },
    closeSync() {},
    unlinkSync(p) { unlinked.push(p); },
  };
  const sandbox = { module: { exports: {} }, Buffer, Date: Clock,
    require(name) {
      if (name === 'electron') return { BrowserWindow: Window, session: { fromPartition() { return {}; } } };
      if (name === 'fs') return disk;
      if (name === 'path') return path;
      throw new Error('unexpected dependency ' + name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/meetingRecorder.js'), 'utf8'), sandbox);
  const recorder = sandbox.module.exports.createMeetingRecorder({ defaultFolder: () => 'recordings',
    recorderUrl: () => 'http://fake/recorder', onRecordingComplete, onRecordingDiscarded,
  });
  recorder.ensureWindow();
  recorder.onReady();
  // Start a recording that receives one PCM frame, so stop() finalizes rather than discards.
  let sessions = 0;
  function record() {
    const file = recorder.start().file;
    recorder.onPcm(Buffer.alloc(4), { session: ++sessions, micRms: 1, systemRms: 1 });
    return file;
  }
  return { recorder, endings, writes, files, unlinked, record };
}

test('record start writes a capture sidecar with the local-offset start time beside the wav', () => {
  const s = setup(() => {});
  const wav = s.recorder.start('manual', 'ms-teams.exe').file;
  const sidecar = Object.keys(s.files).find(p => p.endsWith('.capture.json'));
  assert.ok(sidecar, 'capture sidecar written');
  assert.equal(path.basename(sidecar), path.basename(wav).replace(/\.wav$/i, '') + '.capture.json');
  const data = JSON.parse(s.files[sidecar]);
  assert.equal(data.schema, 1);
  assert.match(data.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);   // ISO-8601 with offset, never Z
  assert.equal(data.app, 'ms-teams.exe');
  assert.equal(data.reason, 'manual');
  assert.equal(typeof data.tz, 'string');
});

test('busy filenames cover active capture and finalization until after completion callback', () => {
  let duringComplete;
  const s = setup(() => { duringComplete = Array.from(s.recorder.getBusyFiles()); });
  assert.deepEqual(Array.from(s.recorder.getBusyFiles()), []);
  const active = s.record();
  assert.deepEqual(Array.from(s.recorder.getBusyFiles()), [active]);
  const copy = s.recorder.getBusyFiles();
  copy.length = 0;
  assert.equal(s.recorder.getBusyFiles().length, 1);
  s.recorder.stop();
  assert.equal(s.recorder.getState().recording, false);
  assert.equal(s.recorder.getState().file, null);
  assert.deepEqual(Array.from(s.recorder.getBusyFiles()), [active]);
  s.endings.shift()();
  assert.deepEqual(s.writes, [4, 40]);
  assert.deepEqual(duringComplete, [active]);
  assert.deepEqual(Array.from(s.recorder.getBusyFiles()), []);
});

test('multiple pending finalizations coexist with a new capture and clear independently', () => {
  const s = setup();
  const first = s.recorder.start().file;
  s.recorder.stop();
  const second = s.recorder.start().file;
  s.recorder.stop();
  const third = s.recorder.start().file;
  assert.deepEqual(Array.from(s.recorder.getBusyFiles()), [first, second, third]);
  s.endings.shift()();
  assert.deepEqual(Array.from(s.recorder.getBusyFiles()), [second, third]);
  s.endings.shift()();
  assert.deepEqual(Array.from(s.recorder.getBusyFiles()), [third]);
});

test('completion callback failure does not strand finalized recordings in busy set', () => {
  const s = setup(() => { throw new Error('rename failed'); });
  s.record();
  s.recorder.stop();
  s.endings.shift()();
  assert.deepEqual(Array.from(s.recorder.getBusyFiles()), []);
});

test('header patch failure still releases files after capture writes have ended', () => {
  const s = setup(undefined, true);
  s.record();
  s.recorder.stop();
  assert.equal(s.recorder.getBusyFiles().length, 1);
  s.endings.shift()();
  assert.deepEqual(Array.from(s.recorder.getBusyFiles()), []);
});

test('a recording that captured no audio is deleted with its capture sidecar instead of finalized', () => {
  const completed = [];
  const discarded = [];
  const s = setup(name => completed.push(name), false, name => discarded.push(name));
  const wav = s.recorder.start('auto', 'Zoom.exe').file;
  s.recorder.stop('call-ended');
  assert.deepEqual(Array.from(s.recorder.getBusyFiles()), [wav]);   // still busy until the stream closes
  s.endings.shift()();
  assert.deepEqual(s.writes, [], 'no header patch on a discarded file');
  assert.deepEqual(s.unlinked.map(p => path.basename(p)), [wav, wav.replace(/\.wav$/i, '') + '.capture.json']);
  assert.deepEqual(discarded, [wav]);
  assert.deepEqual(completed, []);
  assert.deepEqual(Array.from(s.recorder.getBusyFiles()), []);
});

test('a recording with audio is finalized and never deleted', () => {
  const discarded = [];
  const s = setup(() => {}, false, name => discarded.push(name));
  s.record();
  s.recorder.stop();
  s.endings.shift()();
  assert.deepEqual(s.writes, [4, 40]);
  assert.deepEqual(s.unlinked, []);
  assert.deepEqual(discarded, []);
});
