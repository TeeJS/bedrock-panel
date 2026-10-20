'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createVoicePanelHost } = require('../app/voicepanel-host');
const { ensurePersonas } = require('../app/face/persona');

function make() {
  const grid = { id: 'face-test', kind: 'app', app: 'ai-voice', options: { face: 'side', profilePick: 'chat', personaPick: 'rocky', projectDir: __dirname } };
  const config = { grids: [grid], settings: { aiProfiles: [{ id: 'chat', name: 'Chat', prompt: '' }, { id: 'panel', name: 'Panel', prompt: '' }] } };
  ensurePersonas(config);
  const adapter = new EventEmitter(); let running = false;
  const starts = [], prompts = [], events = [];
  Object.assign(adapter, {
    start: opts => { starts.push(opts); running = true; return true; }, stop: () => { running = false; },
    isRunning: () => running, sendTurn: () => true, setProfilePrompt: p => { prompts.push(p); return true; },
    sessionId: () => 'face-session', mode: () => 'default', currentModel: () => 'test', projectDir: () => __dirname,
    validModel: () => true, listModes: () => [], listModels: () => [],
  });
  const host = createVoicePanelHost({ appId: 'ai-voice', storageKey: 'faceTest', adapter, branding: {}, deps: {
    activeServedAppConfig: () => ({ options: grid.options }), activeGrid: () => grid,
    getConfig: () => config, saveConfig: () => {}, setRingState: () => {}, clearRingOverride: () => {},
    getDocumentsPath: () => __dirname, voiceEndpoints: () => ({}),
  } });
  host.handlers.subscribe(new EventEmitter(), { writeHead() {}, write(line) { if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); } });
  host.handlers.sessionStart();
  return { h: host.handlers, adapter, grid, starts, prompts, events, cleanup: () => host.shutdown() };
}

test('reconnect state never exposes a raw emotion prefix from assistant-final', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('hello', false); x.adapter.emit('assistant-start');
  x.adapter.emit('assistant-delta', { text: '[happy] Hello.' });
  x.adapter.emit('assistant-final', { text: '[happy] Hello.' });
  assert.equal(x.h.getState().lastAssistantText, 'Hello.');
});

test('turns from a previously tag-instructed session stay clean after hiding face', t => {
  const x = make(); t.after(x.cleanup);
  x.h.setOption('face', 'off');
  x.h.onTurn('hello', false); x.adapter.emit('assistant-start');
  x.adapter.emit('assistant-delta', { text: '[happy] Hello.' });
  x.adapter.emit('turn-complete', { text: '[happy] Hello.', error: null });
  assert.equal(x.h.getState().transcript.at(-1).text, 'Hello.');
  assert.equal(x.events.filter(e => e.type === 'assistant-delta').map(e => e.text).join(''), 'Hello.');
});

test('a requested profile switch does not reroute the live prose turn', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('hello', false); x.adapter.emit('assistant-start');
  x.adapter.emit('assistant-delta', { text: '[happy] First ' });
  x.h.setProfile('panel');
  x.adapter.emit('assistant-delta', { text: 'second.' });
  assert.equal(x.events.filter(e => e.type === 'assistant-delta').map(e => e.text).join(''), 'First second.');
});

test('persona prompt switch waits for the live turn then starts a fresh conversation', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('hello', false); x.adapter.emit('assistant-start');
  x.h.setPersona('norm'); assert.equal(x.starts.length, 1);
  x.adapter.emit('assistant-delta', { text: '[neutral] Done.' });
  x.adapter.emit('turn-complete', { text: '[neutral] Done.', error: null });
  assert.equal(x.starts.length, 2);
  assert.match(x.starts[1].profilePrompt, /Norm/);
});
