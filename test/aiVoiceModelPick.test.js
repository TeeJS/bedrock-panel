'use strict';
// AI Voice page model and persona, as the page saves them (editor or panel Settings): the editor's
// Model list is the panel's list, a model saved in the editor reaches the running session before
// the next message, and arming the wake word brings a session started for another persona in line
// before the first request (not on it).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createVoicePanelHost } = require('../app/voicepanel-host');
const { ensurePersonas } = require('../app/face/persona');
const { CLAUDE_VOICE_MODEL_PICKS } = require('../app/claudevoice-adapter');

function make(options) {
  const grid = { id: 'model-test', kind: 'app', app: 'ai-voice', options: Object.assign({ profilePick: 'chat', projectDir: __dirname }, options || {}) };
  const config = { grids: [grid], settings: { aiProfiles: [{ id: 'chat', name: 'Chat', prompt: '' }] } };
  ensurePersonas(config);
  const adapter = new EventEmitter(); let running = false;
  const calls = [];
  Object.assign(adapter, {
    start: o => { running = true; calls.push(['start', o.model || '']); return true; },
    stop: () => { running = false; },
    isRunning: () => running, sendTurn: t => { calls.push(['send', t]); return true; }, setProfilePrompt: () => true,
    sessionId: () => 'model-session', mode: () => 'default', currentModel: () => 'test', projectDir: () => __dirname,
    validModel: m => CLAUDE_VOICE_MODEL_PICKS.includes(m), setModel: m => { calls.push(['setModel', m]); return true; },
    listModes: () => [], listModels: () => [],
  });
  const host = createVoicePanelHost({ appId: 'ai-voice', storageKey: 'modelTest', adapter, branding: {}, deps: {
    activeServedAppConfig: () => ({ options: grid.options }), activeGrid: () => grid,
    getConfig: () => config, saveConfig: () => {}, setRingState: () => {}, clearRingOverride: () => {},
    getDocumentsPath: () => __dirname, voiceEndpoints: () => ({ sttHost: 'stt.test', sttPort: 10300 }),
  } });
  return { h: host.handlers, grid, calls, adapter, cleanup: () => host.shutdown() };
}
// The reply to the turn in flight is over (no speech stream): the next onTurn dispatches at once.
function done(x) { x.adapter.emit('assistant-start'); x.adapter.emit('assistant-delta', { text: 'ok' }); x.adapter.emit('turn-complete', { text: 'ok', error: null }); }

test('the editor offers exactly the models the panel\'s Settings → Model offers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'config.js'), 'utf8');
  const m = /const CV_CLAUDE_MODELS = (\[.*?\]);/.exec(src);
  assert.ok(m, 'CV_CLAUDE_MODELS is defined in the editor');
  const editor = JSON.parse(m[1].replace(/'/g, '"')).map(e => e[0]);
  assert.deepEqual(editor, CLAUDE_VOICE_MODEL_PICKS);
});

test('a model saved in the editor reaches the running session before the next message, once', t => {
  const x = make({ modelPick: 'sonnet' }); t.after(x.cleanup);
  x.h.onTurn('first', false); done(x);
  assert.deepEqual(x.calls.slice(0, 2), [['start', 'sonnet'], ['send', 'first']]);
  x.grid.options.modelPick = 'haiku';            // the editor's Save
  x.calls.length = 0;
  x.h.onTurn('second', false); done(x);
  assert.deepEqual(x.calls, [['setModel', 'haiku'], ['send', 'second']]);
  x.calls.length = 0;
  x.h.onTurn('third', false);
  assert.deepEqual(x.calls, [['send', 'third']]);
});

test('a pick made on the panel (Settings → Model) is not applied a second time', t => {
  const x = make({ modelPick: '' }); t.after(x.cleanup);
  x.h.onTurn('first', false); done(x);
  assert.equal(x.h.setModel('opus'), true);      // the panel switches the live session...
  x.grid.options.modelPick = 'opus';             // ...and saves the same pick to the page
  x.calls.length = 0;
  x.h.onTurn('second', false);
  assert.deepEqual(x.calls, [['send', 'second']]);
});

test('back to the account default ("") from the editor is applied too', t => {
  const x = make({ modelPick: 'fable' }); t.after(x.cleanup);
  x.h.onTurn('first', false); done(x);
  x.grid.options.modelPick = '';
  x.calls.length = 0;
  x.h.onTurn('second', false);
  assert.deepEqual(x.calls, [['setModel', ''], ['send', 'second']]);
});

test('arming the wake word restarts a session started for another persona, so the first request does not', t => {
  const x = make({ personaPick: 'mimi', wakeWord: 'on' }); t.after(x.cleanup);
  x.h.wakeArm(true);                              // pre-warm: the session starts with Mimi
  assert.deepEqual(x.calls, [['start', '']]);
  x.grid.options.personaPick = 'jarvis';          // switched to a page / persona Jarvis
  x.calls.length = 0;
  x.h.wakeArm(true);                              // the page arms again
  assert.deepEqual(x.calls, [['start', '']], 'restarted at arm time');
  x.calls.length = 0;
  x.h.onTurn('what time is it', false);
  assert.deepEqual(x.calls, [['send', 'what time is it']], 'no restart on the first request');
});

test('arming with the same persona and model leaves the running session alone', t => {
  const x = make({ personaPick: 'jarvis', wakeWord: 'on', modelPick: 'sonnet' }); t.after(x.cleanup);
  x.h.wakeArm(true);
  x.calls.length = 0;
  x.h.wakeArm(true);
  assert.deepEqual(x.calls, []);
});

test('arming applies a model changed in the editor before anything is said', t => {
  const x = make({ personaPick: 'jarvis', wakeWord: 'on', modelPick: '' }); t.after(x.cleanup);
  x.h.wakeArm(true);
  x.grid.options.modelPick = 'sonnet';
  x.calls.length = 0;
  x.h.wakeArm(true);
  assert.deepEqual(x.calls, [['setModel', 'sonnet']]);
});
