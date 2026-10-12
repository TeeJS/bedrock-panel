'use strict';
// The hidden LucidType capture page (lucidtype-dictate.js) reports what it opened and whether it
// hears anything. Loaded in a vm against a fake VAD and media-devices list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'lucidtype-dictate.js'), 'utf8');
const VAD_SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'claudevoice-vad.js'), 'utf8');   // supplies window.matchMicLabel
const flush = () => new Promise(r => setImmediate(r));

// Like Chromium, the fake names devices only while a capture is live; once every track is stopped
// enumerateDevices returns them nameless.
function load({ devices = [], startError = null } = {}) {
  const statuses = [], logs = [], pcm = [];
  let onCmd = null, vadInst = null, live = 0;
  const sandbox = {
    console, setTimeout, clearTimeout, Promise, Uint8Array,
    navigator: { mediaDevices: {
      getUserMedia: async () => { live++; let on = true; return { getTracks: () => [{ stop() { if (on) { on = false; live--; } } }] }; },
      enumerateDevices: async () => devices.map(d => (live > 0 ? d : Object.assign({}, d, { label: '' }))),
    } },
    window: {
      lucidDictate: {
        onCommand(cb) { onCmd = cb; },
        sendPcm(b) { pcm.push(b.length); },
        status(st) { statuses.push(st); },
        log(m) { logs.push(m); },
      },
      fakeVAD() {
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
  vm.createContext(sandbox);
  vm.runInContext(VAD_SRC, sandbox, { filename: 'claudevoice-vad.js' });   // the real window.matchMicLabel
  sandbox.window.createClaudeVoiceVAD = sandbox.window.fakeVAD;             // a scripted detector instead of the real one
  vm.runInContext(SRC, sandbox, { filename: 'lucidtype-dictate.js' });
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

test('the saved mic is found by name even though Chromium hides names once the probe stream stops', async () => {
  // Windows lists the system default twice: as "Default - <name>" and under its own name.
  const p = load({ devices: [
    { kind: 'audioinput', label: 'Default - Microphone (3- Insta360 Link) (2e1a:4c01)', deviceId: 'default' },
    { kind: 'audioinput', label: 'Microphone (3- Insta360 Link) (2e1a:4c01)', deviceId: 'cam' },
    { kind: 'audioinput', label: 'Microphone (Jabra SPEAK 410 USB) (0b0e:0412)', deviceId: 'jab' },
  ] });
  p.cmd({ type: 'start', micDevice: 'Microphone (Jabra SPEAK 410 USB) (0b0e:0412)' });
  await flush(); await flush(); await flush();
  assert.equal(p.vad().deviceId, 'jab');      // not '' (which opened the Windows default, the Insta360)
  assert.equal(p.statuses[0].matched, true);
});
