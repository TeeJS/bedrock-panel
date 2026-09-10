'use strict';
// app/macSpeech.js against a fake spawn: start only when wanted and the helper exists, status from the
// helper's stdout lines, restart after a crash, restart on a changed voice, clean stop.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createMacSpeech } = require('../app/macSpeech');

function fakeSpawn() {
  const procs = [];
  const spawn = (file, args) => {
    const p = new EventEmitter();
    p.file = file; p.args = args;
    p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new PassThrough();
    p.stdin.ended = false; p.stdin.end = () => { p.stdin.ended = true; };
    p.killed = false; p.kill = () => { p.killed = true; };
    p.say = obj => p.stdout.write(JSON.stringify(obj) + '\n');
    procs.push(p);
    return p;
  };
  return { procs, spawn };
}
const tick = () => new Promise(r => setImmediate(r));

test('no helper on this platform = nothing spawned, status says unavailable', () => {
  const { procs, spawn } = fakeSpawn();
  const m = createMacSpeech({ platform: 'win32', spawn, helperPath: null });
  m.apply(true, {});
  assert.equal(procs.length, 0);
  assert.equal(m.available, false);
  assert.equal(m.status().wanted, false);
});

test('starts when wanted with the port/voice arguments, reports ready and voices, and stops on stdin EOF', async () => {
  const { procs, spawn } = fakeSpawn();
  const logs = [], statuses = [];
  const m = createMacSpeech({ platform: 'darwin', spawn, helperPath: '/x/speech-server', log: l => logs.push(l), onStatus: s => statuses.push(s.ready) });
  m.apply(false, {});
  assert.equal(procs.length, 0, 'not wanted yet');
  m.apply(true, { sttPort: 10300, ttsPort: 10200, voice: 'Samantha' });
  assert.equal(procs.length, 1);
  assert.deepEqual(procs[0].args, ['--host', '127.0.0.1', '--stt-port', '10300', '--tts-port', '10200', '--voice', 'Samantha']);
  assert.equal(m.status().running, true);
  assert.equal(m.status().ready, false);
  procs[0].say({ event: 'ready', host: '127.0.0.1', sttPort: 10300, ttsPort: 10200, speechAuth: 'notDetermined', onDevice: true, recognizerAvailable: true, voices: [{ name: 'Samantha', language: 'en-US' }], language: 'en-US', voice: 'Samantha' });
  await tick();
  const st = m.status();
  assert.equal(st.ready, true);
  assert.equal(st.speechAuth, 'notDetermined');
  assert.equal(st.onDevice, true);
  assert.deepEqual(st.voices, [{ name: 'Samantha', language: 'en-US' }]);
  assert.match(logs.find(l => l.startsWith('ready')), /1 voices/);
  procs[0].say({ event: 'auth', speechAuth: 'authorized' });
  await tick();
  assert.equal(m.status().speechAuth, 'authorized');
  m.stop();
  assert.equal(procs[0].stdin.ended, true, 'the helper exits on stdin EOF');
  assert.equal(m.status().running, false);
});

test('a crash restarts the helper after the delay; a changed voice restarts it at once; turning it off ends it', async () => {
  const { procs, spawn } = fakeSpawn();
  const m = createMacSpeech({ platform: 'darwin', spawn, helperPath: '/x/speech-server', restartDelay: 5 });
  m.apply(true, { voice: '' });
  assert.equal(procs.length, 1);
  procs[0].emit('exit', 1, null);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(procs.length, 2, 'restarted after the crash');
  m.apply(true, { voice: 'Eddy' });
  assert.equal(procs[1].stdin.ended, true, 'old helper asked to exit');
  procs[1].emit('exit', 0, null);
  await tick();
  assert.equal(procs.length, 3, 'new helper with the new voice');
  assert.ok(procs[2].args.includes('Eddy'));
  m.apply(false, {});
  assert.equal(procs[2].stdin.ended, true);
  procs[2].emit('exit', 0, null);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(procs.length, 3, 'not wanted: no restart');
  assert.equal(m.status().wanted, false);
});

test('rescan restarts the helper once the old one has exited, so a newly downloaded voice is read', async () => {
  const { procs, spawn } = fakeSpawn();
  const m = createMacSpeech({ platform: 'darwin', spawn, helperPath: '/x/speech-server', restartDelay: 1 });
  m.apply(true, {});
  assert.equal(procs.length, 1);
  procs[0].say({ event: 'ready', host: '127.0.0.1', sttPort: 10300, ttsPort: 10200, voices: [{ name: 'Daniel', language: 'en-GB', quality: 'default' }] });
  await tick();
  assert.equal(m.status().voices.length, 1);
  assert.equal(m.rescan(), true);
  assert.equal(procs[0].stdin.ended, true, 'the old helper is asked to exit');
  assert.equal(procs.length, 1, 'no second helper before the first has gone (the ports must be free)');
  procs[0].emit('exit', 0, null);
  await tick();
  assert.equal(procs.length, 2, 'a fresh helper reads the installed voices again');
  procs[1].say({ event: 'ready', host: '127.0.0.1', sttPort: 10300, ttsPort: 10200, voices: [{ name: 'Daniel', language: 'en-GB', quality: 'default' }, { name: 'Serena (Premium)', language: 'en-GB', quality: 'premium' }] });
  await tick();
  assert.equal(m.status().voices.length, 2);
  m.stop();
});
