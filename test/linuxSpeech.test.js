'use strict';
// The built-in Linux speech engine: where it looks for an engine and voices, how it supervises the
// Wyoming helper, and what it does when someone else already serves the port. Nothing here spawns
// python or touches the network, so it runs on any platform.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createLinuxSpeech, helperScript, layout, voiceModel } = require('../app/linuxSpeech');

const BASE = '/home/someone/.config/bedrock-panel';
const VOICE = path.join(BASE, 'speech', 'voices', 'en_US-amy-low', 'en_US-amy-low.onnx');
const PIPER = path.join(BASE, 'speech', 'piper', 'piper');

function fakeChild() {
  const writes = [], handlers = {};
  return {
    writes, handlers,
    stdin: { destroyed: false, write(s) { writes.push(s.trim()); return true; }, end() { this.destroyed = true; } },
    stdout: { on(ev, fn) { handlers['stdout:' + ev] = fn; } },
    stderr: { on(ev, fn) { handlers['stderr:' + ev] = fn; } },
    on(ev, fn) { handlers[ev] = fn; },
    kill() { this.killed = true; },
  };
}

function speechWith(extra) {
  const child = fakeChild();
  const logs = [], spawned = [];
  const onDisk = (extra && extra.onDisk) || [PIPER, VOICE];
  const speech = createLinuxSpeech(Object.assign({
    baseDir: BASE,
    spawn: (...a) => { spawned.push(a); return child; },
    log: m => logs.push(m),
    exists: p => onDisk.includes(p),
    readdir: () => ['en_US-amy-low'],
  }, extra));
  return { speech, child, logs, spawned };
}

test('the engine and voices live outside the app, so an upgrade never touches them', () => {
  const l = layout(BASE);
  assert.equal(l.root, path.join(BASE, 'speech'));
  assert.equal(l.piperBinary, PIPER);
  assert.equal(l.voicesDir, path.join(BASE, 'speech', 'voices'));
});

test('a voice is found by name, or falls back to the only one installed', () => {
  const readdir = () => ['en_US-amy-low', 'en_GB-alan-low'];
  const exists = p => p.endsWith('en_US-amy-low.onnx');
  assert.equal(voiceModel(BASE, 'en_US-amy-low', readdir, exists), VOICE);
  assert.equal(voiceModel(BASE, '', readdir, exists), VOICE, 'no name given -> the installed one');
  assert.equal(voiceModel(BASE, 'de_DE-nobody', readdir, exists), VOICE, 'unknown name -> still finds one');
  assert.equal(voiceModel(BASE, '', () => [], exists), null, 'nothing installed');
  assert.equal(voiceModel(BASE, '', () => { throw new Error('ENOENT'); }, exists), null, 'no speech folder yet');
});

test('nothing is installed on a fresh machine, and nothing is spawned', () => {
  const { speech, spawned, logs } = speechWith({ onDisk: [] });
  assert.equal(speech.installed(), false);
  speech.start();
  assert.equal(spawned.length, 0, 'a missing engine is not a reason to spawn python');
  assert.match(logs.join(' '), /not installed yet/);
  assert.equal(speech.available(), false);
});

test('with an engine and a voice on disk it spawns the helper and points it at both', () => {
  const { speech, child, spawned } = speechWith();
  assert.equal(speech.installed(), true);
  speech.start();
  assert.equal(spawned.length, 1);
  const [bin, args] = spawned[0];
  assert.equal(bin, 'python3');
  assert.match(args[0], /speech-server\.py$/);
  assert.equal(args[args.indexOf('--piper') + 1], PIPER);
  assert.equal(args[args.indexOf('--model') + 1], VOICE);
  assert.equal(args[args.indexOf('--config') + 1], VOICE + '.json');
  assert.equal(args[args.indexOf('--port') + 1], '10200', 'the port every Wyoming client expects');
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1', 'loopback by default, like the Windows helper');
  assert.equal(speech.isReady(), false);
  child.handlers['stdout:data']('ready\n');
  assert.equal(speech.isReady(), true);
  assert.equal(speech.available(), true);
});

test('the endpoint is the standard loopback pair, so nothing downstream has to know', () => {
  const { speech } = speechWith();
  assert.deepEqual(speech.endpoint(), { host: '127.0.0.1', port: 10200 });
});

test("someone else's Wyoming server on the port wins, and that is success, not failure", () => {
  const { speech, child, logs } = speechWith();
  speech.start();
  child.handlers.exit(3);
  assert.equal(speech.deferredToExisting(), true);
  assert.equal(speech.available(), true, 'speech still works — it is just not ours');
  assert.equal(speech.failure(), null, 'nothing failed');
  assert.match(logs.join(' '), /already serves 127\.0\.0\.1:10200 — using it/);
});

test('a helper that cannot run is a real failure and is not retried per utterance', () => {
  const { speech, child, logs } = speechWith();
  speech.start();
  child.handlers.exit(2);
  assert.equal(speech.available(), false);
  assert.match(speech.failure(), /refused to start/);
  assert.match(logs.join(' '), /built-in speech unavailable/);
});

test('a python3 that is not installed fails once and stays failed', () => {
  const logs = [];
  const speech = createLinuxSpeech({
    baseDir: BASE, log: m => logs.push(m),
    exists: () => true, readdir: () => ['en_US-amy-low'],
    spawn: () => { throw new Error('spawn python3 ENOENT'); },
  });
  speech.start();
  assert.match(speech.failure(), /cannot start python3/);
  assert.equal(speech.available(), false);
});

test('the helper path reaches outside the asar, since python cannot open a file inside it', () => {
  assert.match(helperScript('/opt/app/resources/app.asar/app'), /app\.asar\.unpacked\/app\/linux\/speech-server\.py$/);
});

// ---- the helper's own contract, asserted against its source the way the mac helpers are ----

test('the speech helper answers the two Wyoming events the app and Home Assistant need', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'linux', 'speech-server.py'), 'utf8');
  for (const event of ['describe', 'info', 'synthesize', 'audio-start', 'audio-chunk', 'audio-stop']) {
    assert.ok(src.includes("'" + event + "'"), event + ' is not handled by the helper');
  }
  assert.match(src, /--json-input/, 'the end-of-utterance signal depends on piper JSON mode');
  assert.match(src, /return 3/, 'a taken port must exit 3, which is what linuxSpeech reads as deferred');
});
