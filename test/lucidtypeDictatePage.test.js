'use strict';
// The hidden LucidType capture page (lucidtype-dictate.js) reports what it opened and whether it
// hears anything. Loaded in a vm against a fake VAD and media-devices list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'lucidtype-dictate.js'), 'utf8');
const flush = () => new Promise(r => setImmediate(r));

function load({ devices = [], startError = null } = {}) {
  const statuses = [], logs = [], pcm = [];
  let onCmd = null, vadInst = null;
  const sandbox = {
    console, setTimeout, clearTimeout, Promise, Uint8Array,
    navigator: { mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      enumerateDevices: async () => devices,
    } },
    window: {
      lucidDictate: {
        onCommand(cb) { onCmd = cb; },
        sendPcm(b) { pcm.push(b.length); },
        status(st) { statuses.push(st); },
        log(m) { logs.push(m); },
      },
      createClaudeVoiceVAD() {
        vadInst = {
          deviceId: null, stopped: false, cbs: null,
          setInputDevice(id) { this.deviceId = id; },
          async start(a, b, c) { if (startError) throw startError; this.cbs = { end: b, level: c }; },
          stop() { this.stopped = true; },
          info() { return { label: this.deviceId === 'jab' ? 'Jabra' : 'Default mic', state: 'running', sampleRate: 16000, threshold: 0.02 }; },
        };
        return vadInst;
      },
    },
  };
  vm.runInNewContext(SRC, sandbox, { filename: 'lucidtype-dictate.js' });
  return { statuses, logs, pcm, cmd: m => onCmd(m), vad: () => vadInst };
}

test('start reports the mic it opened and whether the saved label matched', async () => {
  const p = load({ devices: [{ kind: 'audioinput', label: 'Jabra', deviceId: 'jab' }] });
  p.cmd({ type: 'start', micDevice: 'Jabra' });
  await flush(); await flush();
  assert.equal(p.vad().deviceId, 'jab');
  assert.deepEqual({ ...p.statuses[0] }, { type: 'started', mic: 'Jabra', wanted: 'Jabra', matched: true, context: 'running', rate: 16000 });

  const q = load({ devices: [{ kind: 'audioinput', label: 'Laptop', deviceId: 'lap' }] });
  q.cmd({ type: 'start', micDevice: 'Jabra' });
  await flush(); await flush();
  assert.equal(q.statuses[0].matched, false);
  assert.equal(q.statuses[0].mic, 'Default mic');
});

test('a mic that fails to open is reported, not just logged', async () => {
  const err = new Error('Could not start audio source'); err.name = 'NotReadableError';
  const p = load({ startError: err });
  p.cmd({ type: 'start', micDevice: '' });
  await flush(); await flush();
  assert.deepEqual({ ...p.statuses[0] }, { type: 'error', message: 'Could not start audio source' });
  assert.equal(p.vad().stopped, true);
});

test('after a few seconds it says whether it hears nothing at all or only quiet audio', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const quiet = load();
  quiet.cmd({ type: 'start' });
  await flush(); await flush();
  quiet.vad().cbs.level(0.004);
  t.mock.timers.tick(8000);
  assert.deepEqual({ ...quiet.statuses[1] }, { type: 'silent', mic: 'Default mic', peak: 0.004 });

  const dead = load();
  dead.cmd({ type: 'start' });
  await flush(); await flush();
  t.mock.timers.tick(8000);
  assert.equal(dead.statuses[1].type, 'no-audio');

  const fine = load();
  fine.cmd({ type: 'start' });
  await flush(); await flush();
  fine.vad().cbs.level(0.2);
  fine.vad().cbs.end(new Int16Array(16000));
  t.mock.timers.tick(8000);
  assert.equal(fine.statuses.length, 1);              // speech shipped: no warning
  assert.deepEqual(fine.pcm, [32000]);
  fine.cmd({ type: 'stop' });
  assert.match(fine.logs.at(-1), /stopped: 1 clip\(s\) sent, 1 audio buffers, loudest level 0\.200/);
});
