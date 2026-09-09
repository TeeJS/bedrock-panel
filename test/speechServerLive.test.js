'use strict';
// Live check of the built macOS speech helper through the app's own Wyoming client: it comes up,
// answers `describe`, and synthesizes real audio with a system voice. Runs only on a Mac where
// build-mac-helpers.js has produced app/native/mac/speech-server; skipped everywhere else. Speech
// recognition is not exercised here — it needs the Speech Recognition grant, which macOS asks for
// on first use inside the app (attributed to Bedrock Panel).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const wyoming = require('../app/claudevoice-wyoming');

const helper = path.join(__dirname, '..', 'app', 'native', 'mac', 'speech-server');
const skip = process.platform !== 'darwin' ? 'macOS only' : !fs.existsSync(helper) ? 'helper not built (npm run build:mac-helpers)' : false;
const STT = 20301, TTS = 20201;   // not the defaults: the app may be running its own helper

test('speech-server: ready line, describe → info, and a system voice synthesizes audio', { skip, timeout: 60000 }, async () => {
  const p = spawn(helper, ['--stt-port', String(STT), '--tts-port', String(TTS), '--language', 'en-US'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let ready = null;
  p.stdout.on('data', d => { for (const line of String(d).split('\n')) { if (!line.trim()) continue; lines.push(line); try { const j = JSON.parse(line); if (j.event === 'ready') ready = j; } catch (e) {} } });
  try {
    for (let i = 0; i < 100 && !ready; i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(ready, 'ready line within 10 s: ' + lines.join(' | '));
    assert.equal(ready.sttPort, STT);
    assert.ok(Array.isArray(ready.voices) && ready.voices.length > 0, 'lists system voices');
    assert.ok(['authorized', 'denied', 'restricted', 'notDetermined'].includes(ready.speechAuth));

    const info = await new Promise((resolve, reject) => {
      const s = net.connect(STT, '127.0.0.1', () => s.write('{"type":"describe"}\n'));
      let buf = Buffer.alloc(0);   // bytes, not characters: data_length counts UTF-8 bytes and voice names are not all ASCII
      s.on('data', d => {
        buf = Buffer.concat([buf, d]);
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        const h = JSON.parse(buf.subarray(0, nl).toString('utf8'));
        const need = nl + 1 + (h.data_length || 0);
        if (buf.length >= need) { s.destroy(); resolve({ h, data: JSON.parse(buf.subarray(nl + 1, need).toString('utf8')) }); }
      });
      s.on('error', reject);
      setTimeout(() => { s.destroy(); reject(new Error('describe timed out')); }, 5000);
    });
    assert.equal(info.h.type, 'info');
    assert.ok(info.data.tts[0].voices.length > 0);

    let bytes = 0, fmt = null;
    await wyoming.synthesize({ host: '127.0.0.1', port: TTS, text: 'Testing the built in voice.', onFormat: f => { fmt = f; }, onChunk: b => { bytes += b.length; }, timeoutMs: 30000 });
    assert.equal(fmt.width, 2);
    assert.ok(fmt.rate >= 8000 && fmt.channels >= 1, 'a real PCM format: ' + JSON.stringify(fmt));
    const seconds = bytes / 2 / fmt.channels / fmt.rate;
    assert.ok(seconds > 0.8 && seconds < 10, 'about two seconds of speech, got ' + seconds.toFixed(2) + ' s');
  } finally {
    try { p.stdin.end(); } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
    try { p.kill(); } catch (e) {}
  }
});

// Round trip: a system voice says a phrase, the STT side hears it back. On macOS 26 this runs through
// SpeechAnalyzer, which needs no Speech Recognition grant (so it can run here); older macOS is skipped
// because SFSpeechRecognizer would raise the authorization prompt.
const macMajor = process.platform === 'darwin' ? parseInt(require('os').release().split('.')[0], 10) : 0;   // Darwin 25 = macOS 26
test('speech-server: what the voice says comes back from STT (SpeechAnalyzer round trip)', { skip: skip || (macMajor < 25 && 'needs macOS 26 (SpeechAnalyzer)'), timeout: 120000 }, async () => {
  const p = spawn(helper, ['--stt-port', String(STT + 2), '--tts-port', String(TTS + 2), '--language', 'en-US'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const errs = [];
  p.stderr.on('data', d => errs.push(String(d)));
  let ready = null;
  p.stdout.on('data', d => { for (const line of String(d).split('\n')) { try { const j = JSON.parse(line); if (j.event === 'ready') ready = j; } catch (e) {} } });
  try {
    for (let i = 0; i < 100 && !ready; i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(ready, 'ready line');
    assert.equal(ready.engine, 'speechanalyzer');
    const chunks = []; let fmt = null;
    await wyoming.synthesize({ host: '127.0.0.1', port: TTS + 2, text: 'Good morning everyone, the meeting starts now.', onFormat: f => { fmt = f; }, onChunk: b => chunks.push(b), timeoutMs: 30000 });
    const audio = Buffer.concat(chunks);
    assert.ok(audio.length > 20000, 'synthesized audio');
    const t0 = Date.now();
    const text = await wyoming.transcribe({ host: '127.0.0.1', port: STT + 2, audio, rate: fmt.rate, width: 2, channels: fmt.channels, language: 'en-US', timeoutMs: 90000 });
    const heard = String(typeof text === 'string' ? text : (text && text.text) || '');
    assert.match(heard.toLowerCase(), /good morning/, 'heard: "' + heard + '" — stderr: ' + errs.join('').slice(-600));
    assert.ok(Date.now() - t0 < 60000, 'transcribed in ' + (Date.now() - t0) + ' ms');
  } finally {
    try { p.stdin.end(); } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
    try { p.kill(); } catch (e) {}
  }
});
