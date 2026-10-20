'use strict';
// Persona switch lifecycle on the host (T.J.: "doesn't seem to change personalities when personas is
// changed in the app"; screenshot: the face changed to Jarvis, the old transcript stayed, and the next
// reply was still Norm). A persona change must (a) re-assemble the prompt with ONLY the new persona's
// text, (b) restart the backend's session so the old character's history is gone, (c) wait for a live
// turn to finish but then really apply, however that turn ended, and (d) never leave the page showing
// one persona while the model keeps playing another.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createVoicePanelHost } = require('../app/voicepanel-host');
const { ensurePersonas } = require('../app/face/persona');

function make(opts) {
  const o = opts || {};
  const grid = { id: 'sw-test', kind: 'app', app: 'ai-voice', options: { face: 'side', profilePick: 'chat', personaPick: 'jarvis', projectDir: __dirname } };
  const config = { grids: [grid], settings: { aiProfiles: [{ id: 'chat', name: 'Chat', prompt: '' }, { id: 'panel', name: 'Panel', prompt: '' }] } };
  ensurePersonas(config);
  const adapter = new EventEmitter();
  let running = false;
  const starts = [], prompts = [], sent = [], events = [];
  Object.assign(adapter, {
    start: s => { starts.push(s); running = true; return true; },
    stop: () => { running = false; },
    isRunning: () => running,
    sendTurn: text => { sent.push(text); return true; },
    setProfilePrompt: p => { prompts.push(p); return true; },
    sessionId: () => 'sw-session', mode: () => 'default', currentModel: () => 'test', projectDir: () => __dirname,
    validModel: () => true, listModes: () => [], listModels: () => [], cancelApprovals() {},
  });
  if (o.notRunningAtSwitch) adapter.isRunning = () => running;
  const host = createVoicePanelHost({ appId: 'ai-voice', storageKey: 'switchTest', adapter, branding: {}, deps: {
    activeServedAppConfig: () => ({ options: grid.options }), activeGrid: () => grid,
    getConfig: () => config, saveConfig: () => {}, setRingState: () => {}, clearRingOverride: () => {},
    getDocumentsPath: () => __dirname, voiceEndpoints: () => ({}),
  } });
  host.handlers.subscribe(new EventEmitter(), { writeHead() {}, write(line) { if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); } });
  host.handlers.sessionStart();
  return {
    h: host.handlers, adapter, grid, starts, prompts, sent, events,
    stopRunning: () => { running = false; },
    lastPrompt: () => (starts.length ? starts[starts.length - 1].profilePrompt : ''),
    cleanup: () => host.shutdown(),
  };
}
const full = (x, text) => { x.adapter.emit('assistant-start'); x.adapter.emit('assistant-delta', { text }); x.adapter.emit('assistant-final', { text }); };
const done = (x, text, error) => x.adapter.emit('turn-complete', { text, error: error || null });
const JARVIS = /You are Jarvis/, MIMI = /You are Mimi/;

test('the session starts with the picked persona\'s prompt only', t => {
  const x = make(); t.after(x.cleanup);
  assert.equal(x.starts.length, 1);
  assert.match(x.lastPrompt(), JARVIS);
  assert.doesNotMatch(x.lastPrompt(), MIMI);
});

test('idle switch: restarts the session with ONLY the new persona and a clean transcript', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('hello', false); full(x, '[happy] Good evening, sir.'); done(x, '[happy] Good evening, sir.');
  assert.ok(x.h.getState().transcript.length >= 2);
  assert.equal(x.h.setPersona('kawaii'), true);
  assert.equal(x.starts.length, 2, 'a fresh session was started');
  assert.match(x.lastPrompt(), MIMI);
  assert.doesNotMatch(x.lastPrompt(), JARVIS, 'the old persona text must not ride along');
  assert.deepEqual(x.h.getState().transcript, [], 'the old character\'s conversation is gone');
  assert.ok(x.events.some(e => e.type === 'session-started'));
  assert.equal(x.prompts.length, 0, 'no resume-style prompt swap that would keep the history');
});

test('switch after a tool-using turn (several assistant messages) applies once the turn completes', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('check the site', false);
  full(x, 'Let me look.'); full(x, 'The counter reads 91,054.');
  done(x, 'The counter reads 91,054.');
  x.h.setPersona('kawaii');
  assert.equal(x.starts.length, 2);
  assert.match(x.lastPrompt(), MIMI);
});

test('switch mid-turn is deferred, then applied exactly once when the turn completes', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('tell me a story', false); x.adapter.emit('assistant-start'); x.adapter.emit('assistant-delta', { text: 'Once ' });
  x.h.setPersona('kawaii');
  assert.equal(x.starts.length, 1, 'not restarted under a live turn');
  x.adapter.emit('assistant-delta', { text: 'upon a time.' }); x.adapter.emit('assistant-final', { text: 'Once upon a time.' });
  done(x, 'Once upon a time.');
  assert.equal(x.starts.length, 2);
  assert.match(x.lastPrompt(), MIMI);
  assert.deepEqual(x.h.getState().transcript, []);
});

test('switch mid-turn is still applied when the turn ENDS IN AN ERROR', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('hello', false); x.adapter.emit('assistant-start');
  x.h.setPersona('kawaii');
  assert.equal(x.starts.length, 1);
  x.adapter.emit('error', { message: 'backend hiccup' });
  assert.equal(x.starts.length, 2, 'an error must not leave the switch pending forever');
  assert.match(x.lastPrompt(), MIMI);
});

test('switch mid-turn when the turn result carries an error is still applied', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('hello', false); x.adapter.emit('assistant-start');
  x.h.setPersona('kawaii');
  done(x, '', 'API Error: 500');
  assert.equal(x.starts.length, 2);
  assert.match(x.lastPrompt(), MIMI);
});

test('two switches during one turn: one restart, the LAST persona wins', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('hello', false); x.adapter.emit('assistant-start');
  x.h.setPersona('kawaii'); x.h.setPersona('crt');
  done(x, 'ok');
  assert.equal(x.starts.length, 2);
  assert.doesNotMatch(x.lastPrompt(), MIMI);
  assert.doesNotMatch(x.lastPrompt(), JARVIS);
  assert.match(x.lastPrompt(), /CRT|terminal|monitor/i);
});

test('a queued voice turn sent during the old reply is not lost or answered by the old persona', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('first', false); x.adapter.emit('assistant-start');
  const q = x.h.onTurn('second', false);
  assert.equal(q.queued, true);
  x.h.setPersona('kawaii');
  full(x, 'one'); done(x, 'one');
  assert.equal(x.starts.length, 2, 'restarted for the new persona');
  assert.match(x.lastPrompt(), MIMI);
  assert.ok(x.sent.includes('second'), 'the queued turn must still reach the (new) session: sent=' + JSON.stringify(x.sent));
});

test('switch while NO session is running: the next turn starts a fresh session with the new persona', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('hello', false); full(x, 'hi'); done(x, 'hi');
  x.h.sessionStop(); x.stopRunning();
  x.h.setPersona('kawaii');
  x.h.onTurn('who are you?', false);
  assert.match(x.lastPrompt(), MIMI);
  assert.doesNotMatch(x.lastPrompt(), JARVIS);
  assert.ok(!x.h.getState().transcript.some(m => /^hi$/.test(m.text)), 'the old session\'s messages are not carried over');
});

test('the page is told which persona to draw AND the model-side change really happens (no face/model mismatch)', t => {
  const x = make(); t.after(x.cleanup);
  x.h.setPersona('kawaii');
  const ev = x.events.filter(e => e.type === 'persona').pop();
  assert.ok(ev && ev.persona && ev.persona.id === 'kawaii');
  assert.match(x.lastPrompt(), MIMI);
});

test('no persona: a restart with neither persona text', t => {
  const x = make(); t.after(x.cleanup);
  x.h.setPersona('');
  assert.equal(x.starts.length, 2);
  assert.doesNotMatch(x.lastPrompt(), JARVIS);
  assert.doesNotMatch(x.lastPrompt(), MIMI);
});

test('an unknown persona id changes nothing', t => {
  const x = make(); t.after(x.cleanup);
  assert.equal(x.h.setPersona('does-not-exist'), false);
  assert.equal(x.starts.length, 1);
  assert.match(x.lastPrompt(), JARVIS);
});

test('picking the persona that is already active does not restart (and does not wipe the conversation)', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('hello', false); full(x, 'hi'); done(x, 'hi');
  assert.equal(x.h.setPersona('jarvis'), true);
  assert.equal(x.starts.length, 1);
  assert.ok(x.h.getState().transcript.length >= 2);
});

test('a deferred switch is visible to the page while it waits (so the user is not left guessing)', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('hello', false); x.adapter.emit('assistant-start');
  x.h.setPersona('kawaii');
  const pending = x.events.some(e => e.type === 'persona-pending') || !!(x.h.getState().personaPending || x.h.getState().pendingPersona);
  assert.ok(pending, 'expected a persona-pending broadcast or a personaPending field in /state while the switch is deferred');
});

// The editor (Settings -> page options -> Persona) saves personaPick straight into the page's options;
// it does not go through the panel picker's setPersona. The face then shows the new persona (meta is read
// from the options) while the running session still carries the old prompt and history.
test('a persona changed through the saved page options is applied to the session on the next turn', t => {
  const x = make(); t.after(x.cleanup);
  x.h.onTurn('hello', false); full(x, 'Good evening, sir.'); done(x, 'Good evening, sir.');
  x.grid.options.personaPick = 'kawaii';            // what the editor's Save & apply does
  assert.equal(x.h.getState().meta.persona && x.h.getState().meta.persona.id, 'kawaii', 'the face side already follows the option');
  x.h.onTurn('who are you?', false);
  assert.equal(x.starts.length, 2, 'the session must restart with the new persona before the turn is sent (else the model keeps the old character)');
  assert.match(x.lastPrompt(), MIMI);
  assert.doesNotMatch(x.lastPrompt(), JARVIS);
  assert.ok(x.sent.includes('who are you?'));
});
