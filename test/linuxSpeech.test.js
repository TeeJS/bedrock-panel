'use strict';
// The built-in Linux speech engine: where it looks for an engine and voices, how it supervises the
// Wyoming helper, and what it does when someone else already serves the port. Nothing here spawns
// python or touches the network, so it runs on any platform.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createLinuxSpeech, helperScript, layout, voiceModel, sttModelDir } = require('../app/linuxSpeech');

const BASE = '/home/someone/.config/bedrock-panel';
const VOICE = path.join(BASE, 'speech', 'voices', 'en_US-amy-low', 'en_US-amy-low.onnx');
const PIPER = path.join(BASE, 'speech', 'piper', 'piper');
const STT_BIN = path.join(BASE, 'speech', 'sherpa', 'bin', 'sherpa-onnx-offline');
const STT_TOKENS = path.join(BASE, 'speech', 'stt', 'moonshine-tiny-en', 'tokens.txt');

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
  const dirs = (extra && extra.dirs) || { voices: ['en_US-amy-low'], stt: ['moonshine-tiny-en'] };
  const speech = createLinuxSpeech(Object.assign({
    baseDir: BASE,
    spawn: (...a) => { spawned.push(a); return child; },
    log: m => logs.push(m),
    exists: p => onDisk.includes(p),
    readdir: dir => (String(dir).endsWith('stt') ? dirs.stt : dirs.voices),
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
  assert.match(logs.join(' '), /already serves these ports on 127\.0\.0\.1 — using it/);
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

// ---- listening, which installs and runs independently of speaking -----------------------------

test('a recognition model is found by its folder, and only when it is complete', () => {
  const readdir = () => ['moonshine-tiny-en'];
  assert.equal(sttModelDir(BASE, '', readdir, p => p === STT_TOKENS),
    path.join(BASE, 'speech', 'stt', 'moonshine-tiny-en'));
  assert.equal(sttModelDir(BASE, '', readdir, () => false), null, 'a folder without tokens is half a download');
  assert.equal(sttModelDir(BASE, '', () => { throw new Error('ENOENT'); }, () => true), null);
});

test('the two halves install separately, and either one alone still starts the helper', () => {
  const speakOnly = speechWith({ onDisk: [PIPER, VOICE] });
  assert.equal(speakOnly.speech.installed(), true);
  assert.equal(speakOnly.speech.sttInstalled(), false);
  speakOnly.speech.start();
  let args = speakOnly.spawned[0][1];
  assert.ok(args.includes('--piper'), 'speaking is configured');
  assert.ok(!args.includes('--stt-binary'), 'listening is not, because it is not installed');

  const hearOnly = speechWith({ onDisk: [STT_BIN, STT_TOKENS] });
  assert.equal(hearOnly.speech.installed(), false);
  assert.equal(hearOnly.speech.sttInstalled(), true);
  hearOnly.speech.start();
  args = hearOnly.spawned[0][1];
  assert.ok(args.includes('--stt-binary'), 'listening is configured');
  assert.ok(!args.includes('--piper'), 'speaking is not');
  assert.equal(args[args.indexOf('--stt-port') + 1], '10300');
});

test('with both installed the helper is told about both, and reports which it served', () => {
  const { speech, child, spawned } = speechWith({ onDisk: [PIPER, VOICE, STT_BIN, STT_TOKENS] });
  speech.start();
  const args = spawned[0][1];
  assert.ok(args.includes('--piper') && args.includes('--stt-binary'));
  child.handlers['stdout:data']('ready tts stt\n');
  assert.deepEqual(speech.servingHalves(), ['tts', 'stt']);
  assert.deepEqual(speech.sttEndpoint(), { host: '127.0.0.1', port: 10300 });
});

test('a helper that could only take one port says so, and the other half is simply not served', () => {
  const { speech, child } = speechWith({ onDisk: [PIPER, VOICE, STT_BIN, STT_TOKENS] });
  speech.start();
  child.handlers['stdout:data']('ready tts\n');
  assert.deepEqual(speech.servingHalves(), ['tts'], 'listening went to whoever already had 10300');
  assert.equal(speech.available(), true);
});

test('nothing installed at all spawns nothing, even now that there are two halves', () => {
  const { speech, spawned } = speechWith({ onDisk: [] });
  speech.start();
  assert.equal(spawned.length, 0);
});

test('a half the user points at their own server is not served by us either', () => {
  // main.js turns a half off when the person configured their own host for it; the helper must then
  // not be told about that half at all, or it would take the port their server wants.
  const { speech, spawned } = speechWith({ onDisk: [PIPER, VOICE, STT_BIN, STT_TOKENS] });
  speech.start({ speak: true, hear: false });
  const args = spawned[0][1];
  assert.ok(args.includes('--piper'));
  assert.ok(!args.includes('--stt-binary'), 'listening was turned off, so the port is left alone');
});

test('turning both halves off starts nothing at all', () => {
  const { speech, spawned } = speechWith({ onDisk: [PIPER, VOICE, STT_BIN, STT_TOKENS] });
  speech.start({ speak: false, hear: false });
  assert.equal(spawned.length, 0);
});
