'use strict';
// The Test-speech route (host.handlers.synthesize) must follow the same voice rule as real
// replies: a persona voice the server rejects before any audio falls back once to the default
// voice; once anything has been written, a failure is a failure. The Wyoming client is replaced
// on its module object before the host is built, so no socket is involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const wyoming = require('../app/claudevoice-wyoming');
const { createVoicePanelHost } = require('../app/voicepanel-host');

function fakeAdapter() {
  const handlers = {};
  return {
    on: (evt, fn) => { handlers[evt] = fn; }, emit: (evt, p) => { if (handlers[evt]) handlers[evt](p); },
    isRunning: () => true, start: () => true, sendTurn: () => true, stop: () => {}, setModel: () => {},
    sessionId: () => 's', setPermissionMode: () => {}, setProfilePrompt: () => true, projectDir: () => '', mode: () => '',
    currentModel: () => '', validModel: () => true, cancelApprovals: () => {}, decideApproval: () => true,
  };
}
function makeHost(personaVoice) {
  const grid = { id: 'g1', kind: 'app', app: 'ai-voice', options: { personaPick: 'v' } };
  const config = { grids: [grid], settings: { personas: [{ id: 'v', name: 'V', voice: personaVoice }] } };
  const events = [];
  const host = createVoicePanelHost({
    appId: 'ai-voice', storageKey: 't', log: () => {}, adapter: fakeAdapter(), branding: {},
    deps: {
      activeServedAppConfig: () => ({ options: grid.options }), voiceEndpoints: () => ({ ttsHost: 'h', ttsPort: 1 }),
      activeGrid: () => grid, getConfig: () => config, saveConfig: () => {}, setRingState: () => {}, clearRingOverride: () => {}, getDocumentsPath: () => '.',
    },
  });
  return { host, events };
}
function fakeRes() {
  const r = { heads: [], chunks: [], ended: false, writeHead(code) { r.heads.push(code); }, write(b) { r.chunks.push(b); }, end() { r.ended = true; } };
  return r;
}

test('Test speech: a rejected persona voice retries once with the default, one WAV, one header', async () => {
  const calls = [];
  const real = wyoming.synthesize;
  wyoming.synthesize = async opts => {
    calls.push(opts.voice || '');
    if (opts.voice) throw new Error('voice not found');
    opts.onFormat({ rate: 22050, width: 2, channels: 1 });
    opts.onChunk(Buffer.from('pcm'));
  };
  try {
    const { host } = makeHost('nope');
    const res = fakeRes();
    await host.handlers.synthesize('Hello there.', res);
    assert.deepEqual(calls, ['nope', '']);
    assert.deepEqual(res.heads, [200]);
    assert.equal(res.chunks.length, 2);   // header + one chunk
    assert.equal(res.ended, true);
  } finally { wyoming.synthesize = real; }
});

test('Test speech: after output has started a failure is not retried', async () => {
  const calls = [];
  const real = wyoming.synthesize;
  wyoming.synthesize = async opts => {
    calls.push(opts.voice || '');
    opts.onFormat({ rate: 22050, width: 2, channels: 1 });
    opts.onChunk(Buffer.from('half'));
    throw new Error('reset');
  };
  try {
    const { host } = makeHost('v1');
    const res = fakeRes();
    await host.handlers.synthesize('Hello.', res);
    assert.deepEqual(calls, ['v1']);
    assert.deepEqual(res.heads, [200]);
    assert.equal(res.ended, true);
  } finally { wyoming.synthesize = real; }
});

test('Test speech: no persona voice means no voice field and no retry on failure', async () => {
  const calls = [];
  const real = wyoming.synthesize;
  wyoming.synthesize = async opts => { calls.push(opts.voice); throw new Error('down'); };
  try {
    const { host } = makeHost('');
    const res = fakeRes();
    await host.handlers.synthesize('Hello.', res);
    assert.deepEqual(calls, ['']);
    assert.deepEqual(res.heads, [502]);
  } finally { wyoming.synthesize = real; }
});
