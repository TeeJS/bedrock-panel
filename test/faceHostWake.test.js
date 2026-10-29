'use strict';
// Wake word through the host: /audio -> transcribe() -> the gate. STT is stubbed (the text "heard"
// is whatever the test says), the clock is mocked, no electron. Proves the three criteria:
// nothing unaddressed is shown or queued, the addressed command is the turn, and the page goes back
// to waiting on its own (one wake never keeps the page awake).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createVoicePanelHost } = require('../app/voicepanel-host');
const { ensurePersonas } = require('../app/face/persona');
const wyoming = require('../app/claudevoice-wyoming');

function make(options, log, noStart) {
  const grid = { id: 'wake-test', kind: 'app', app: 'ai-voice', options: { face: 'side', profilePick: 'chat', personaPick: 'jarvis', wakeWord: 'on', projectDir: __dirname } };
  Object.assign(grid.options, options || {});
  const config = { grids: [grid], settings: { aiProfiles: [{ id: 'chat', name: 'Chat', prompt: '' }] } };
  ensurePersonas(config);
  const adapter = new EventEmitter(); let running = false;
  const sent = [], events = [], starts = [];
  Object.assign(adapter, {
    start: () => { running = true; starts.push(1); return true; }, stop: () => { running = false; },
    isRunning: () => running, sendTurn: t => { sent.push(t); return true; }, setProfilePrompt: () => true,
    sessionId: () => 'wake-session', mode: () => 'default', currentModel: () => 'test', projectDir: () => __dirname,
    validModel: () => true, listModes: () => [], listModels: () => [],
  });
  const host = createVoicePanelHost({ appId: 'ai-voice', storageKey: 'wakeTest', adapter, branding: {}, log, deps: {
    activeServedAppConfig: () => ({ options: grid.options }), activeGrid: () => grid,
    getConfig: () => config, saveConfig: () => {}, setRingState: () => {}, clearRingOverride: () => {},
    getDocumentsPath: () => __dirname, voiceEndpoints: () => ({ sttHost: 'stt.test', sttPort: 10300 }),
  } });
  host.handlers.subscribe(new EventEmitter(), { writeHead() {}, write(line) { if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); } });
  if (!noStart) host.handlers.sessionStart();
  return { h: host.handlers, adapter, grid, sent, events, starts, cleanup: () => host.shutdown() };
}
// The STT stub: transcribe() returns the next "heard" text.
let heard = '';
const realTranscribe = wyoming.transcribe;
wyoming.transcribe = async () => heard;
test.after(() => { wyoming.transcribe = realTranscribe; });
async function hear(x, text, gen, startAgo) { heard = text; return x.h.transcribe(Buffer.alloc(320), gen, startAgo); }
function finishReply(x, text) { x.adapter.emit('assistant-start'); x.adapter.emit('assistant-delta', { text }); x.adapter.emit('turn-complete', { text, error: null }); }

test('wake off: STT text passes through unchanged, no wake field', async t => {
  const x = make({ wakeWord: 'off' }); t.after(x.cleanup);
  assert.deepEqual(await hear(x, 'what time is it'), { ok: true, text: 'what time is it' });
  assert.equal(x.h.getState().wake.enabled, false);
});

test('wake on: only the addressed command comes back; unaddressed speech is empty and never logged', async t => {
  const x = make(); t.after(x.cleanup);
  const armed = x.h.wakeArm(true);
  assert.equal(armed.wake.state, 'waiting'); assert.equal(armed.wake.phrase, 'hey jarvis');
  assert.deepEqual(await hear(x, 'so anyway I told him no', armed.gen), { ok: true, text: '', wake: 'waiting' });
  assert.deepEqual(await hear(x, 'Hey Jarvis, what time is it?', armed.gen), { ok: true, text: 'what time is it?', wake: 'addressed' });
  assert.equal(x.h.getState().transcript.length, 0);   // the host logs turns, not utterances: nothing was sent yet
  assert.equal(x.sent.length, 0);
});

test('arming the wake word pre-warms the session; tap-to-talk and re-arms do not start another', async t => {
  const x = make({}, null, true); t.after(x.cleanup);
  assert.equal(x.adapter.isRunning(), false);
  const armed = x.h.wakeArm(true);
  assert.equal(armed.wake.state, 'waiting');
  assert.equal(x.adapter.isRunning(), true);
  assert.deepEqual(x.starts, [1]);
  assert.ok(x.events.some(e => e.type === 'session-started'));
  x.h.wakeArm(true);                                   // hidden -> visible re-arm: already running
  assert.deepEqual(x.starts, [1]);
  x.h.wakeArm(false);                                  // mic closed: the session is not ended by disarming
  assert.equal(x.adapter.isRunning(), true);
  // The first addressed utterance is a plain turn on the warm session, not a lazy start.
  const r = await hear(x, 'hey jarvis what time is it', x.h.wakeArm(true).gen);
  x.h.onTurn(r.text, false);
  assert.deepEqual(x.starts, [1]); assert.deepEqual(x.sent, ['what time is it']);
  // Wake word off: arming is a no-op and the session stays lazy.
  const y = make({ wakeWord: 'off' }, null, true); t.after(y.cleanup);
  y.h.wakeArm(true);
  assert.equal(y.adapter.isRunning(), false);
});

test('wake on: the name alone opens a listening window; the next utterance is the request', async t => {
  const x = make(); t.after(x.cleanup);
  const armed = x.h.wakeArm(true);
  assert.deepEqual(await hear(x, 'Hey Jarvis.', armed.gen), { ok: true, text: '', wake: 'listening' });
  assert.equal(x.h.getState().wake.state, 'listening');
  assert.ok(x.h.getState().wake.until > Date.now());
  assert.deepEqual(await hear(x, 'turn on the lights', armed.gen, 0), { ok: true, text: 'turn on the lights', wake: 'addressed' });   // began now, inside the window
});

test('one wake, one request: active while the reply runs, back to waiting after it (follow-up 0)', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const x = make(); t.after(x.cleanup);
  const armed = x.h.wakeArm(true);
  const r = await hear(x, 'hey jarvis what is two plus two', armed.gen);
  x.h.onTurn(r.text, false);
  assert.equal(x.h.getState().wake.state, 'active');
  assert.deepEqual(await hear(x, 'hey jarvis again', armed.gen), { ok: true, text: '', wake: 'active' });
  finishReply(x, 'Four.');                       // no speech stream: turn-complete is the reply end
  assert.equal(x.h.getState().wake.state, 'cooldown');
  assert.deepEqual(await hear(x, 'four', armed.gen), { ok: true, text: '', wake: 'cooldown' });   // the speaker's echo
  t.mock.timers.tick(1300);
  assert.equal(x.h.getState().wake.state, 'waiting');
  assert.deepEqual(await hear(x, 'and what about five', armed.gen), { ok: true, text: '', wake: 'waiting' });
});

test('follow-up window: the human may answer without the name, then it closes on its own', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const x = make({ wakeFollowUpSeconds: '10', wakeFollowUpWhen: 'always' }); t.after(x.cleanup);
  const armed = x.h.wakeArm(true);
  x.h.onTurn((await hear(x, 'hey jarvis pick a number', armed.gen)).text, false);
  finishReply(x, 'Seven.');
  t.mock.timers.tick(1300);
  const w = x.h.getState().wake;
  assert.equal(w.state, 'followup'); assert.equal(w.followUpMs, 10000); assert.ok(w.until > Date.now());
  assert.deepEqual(await hear(x, 'why seven', armed.gen), { ok: true, text: 'why seven', wake: 'followup' });   // no phrase, no chime
  x.h.onTurn('why seven', false); finishReply(x, 'Luck.');
  t.mock.timers.tick(1300 + 10000);
  assert.equal(x.h.getState().wake.state, 'waiting');
  assert.deepEqual(await hear(x, 'because', armed.gen, 0), { ok: true, text: '', wake: 'waiting' });   // began after the window closed
});

test('a spoken reply ends at the page\'s playback end, not at turn-complete', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const x = make(); t.after(x.cleanup);
  const armed = x.h.wakeArm(true);
  x.h.onTurn((await hear(x, 'hey jarvis tell me a joke', armed.gen)).text, true);   // speak = a speech stream opens
  finishReply(x, 'Knock knock.');
  assert.equal(x.h.getState().wake.state, 'active');   // still playing on the page
  t.mock.timers.tick(5000);
  assert.equal(x.h.getState().wake.state, 'active');
  x.h.wakeReplyEnd();
  assert.equal(x.h.getState().wake.state, 'cooldown');
  t.mock.timers.tick(1300);
  assert.equal(x.h.getState().wake.state, 'waiting');
});

test('a reply cut short on the host settles the gate instead of leaving the page deaf', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const x = make(); t.after(x.cleanup);
  const armed = x.h.wakeArm(true);
  x.h.onTurn((await hear(x, 'hey jarvis go on', armed.gen)).text, true);
  x.adapter.emit('error', { message: 'boom' });
  t.mock.timers.tick(1300);
  assert.equal(x.h.getState().wake.state, 'waiting');
});

test('stale generation is dropped; mic off disarms; a persona switch re-resolves the phrase', async t => {
  const x = make(); t.after(x.cleanup);
  const first = x.h.wakeArm(true);
  const second = x.h.wakeArm(true);
  assert.notEqual(first.gen, second.gen);
  assert.deepEqual(await hear(x, 'hey jarvis hello', first.gen), { ok: true, text: '', wake: 'waiting' });
  x.h.setPersona('kawaii');
  assert.equal(x.h.getState().wake.phrase, 'hey mimi');
  const g = x.h.getState().wake.gen;
  assert.deepEqual(await hear(x, 'hey jarvis hello', g), { ok: true, text: '', wake: 'waiting' });
  assert.deepEqual(await hear(x, 'hey mimi hello', g), { ok: true, text: 'hello', wake: 'addressed' });
  const off = x.h.wakeArm(false);
  assert.equal(off.wake.state, 'off');
  assert.deepEqual(await hear(x, 'hey mimi hello', off.gen), { ok: true, text: '', wake: 'off' });   // mic closed: the gate stays shut
});

test('not ready: a persona without a wake name closes the gate and says why; a page phrase fixes it', async t => {
  const x = make({ personaPick: 'crt' }); t.after(x.cleanup);
  const wake = x.h.getState().wake;
  assert.equal(wake.ready, true); assert.equal(wake.phrase, 'hey crt');   // the built-in CRT persona has a wake name
  assert.equal(wake.state, 'off');                                              // enabled, not armed: the page has not opened its mic
  const x2 = make({ personaPick: 'nobody' }); t.after(x2.cleanup);
  x2.grid.options.personaPick = ''; x2.h.setPersona('');
  assert.equal(x2.h.getState().wake.phrase, 'hey panel');   // no persona: the page default
  assert.equal(x2.h.setOption('wakePhrase', 'computer please'), true);
  assert.equal(x2.h.getState().wake.phrase, 'computer please');
  assert.equal(x2.h.setOption('wakePhrase', 'computer'), true);
  const nr = x2.h.getState().wake;
  assert.equal(nr.ready, false); assert.equal(nr.state, 'not-ready'); assert.match(nr.reason, /two words/);
  const armed = x2.h.wakeArm(true);
  assert.deepEqual(await hear(x2, 'computer hello', armed.gen), { ok: true, text: '', wake: 'off' });
  assert.equal(armed.wake.state, 'not-ready');
});

test('options: wakeWord off disarms at once; follow-up seconds and chime validate and broadcast', async t => {
  const x = make(); t.after(x.cleanup);
  const armed = x.h.wakeArm(true);
  assert.equal(x.h.setOption('wakeFollowUpSeconds', '9999'), false);
  assert.equal(x.h.setOption('wakeFollowUpSeconds', '30'), true);
  assert.equal(x.h.getState().wake.followUpMs, 30000);
  assert.equal(x.h.setOption('wakeChime', 'true'), true);
  assert.equal(x.grid.options.wakeChime, true);
  x.events.length = 0;
  assert.equal(x.h.setOption('wakeWord', 'off'), true);
  assert.equal(x.events.at(-1).type, 'wake-state'); assert.equal(x.events.at(-1).wake.enabled, false);
  assert.deepEqual(await hear(x, 'hey jarvis hello', armed.gen), { ok: true, text: 'hey jarvis hello' });
});

test('a cancelled or failed reply gets no follow-up window; a completed one does', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const x = make({ wakeFollowUpSeconds: '10', wakeFollowUpWhen: 'always' }); t.after(x.cleanup);
  const armed = x.h.wakeArm(true);
  x.h.onTurn((await hear(x, 'hey jarvis go on', armed.gen)).text, true);
  finishReply(x, 'Going.');
  x.h.wakeReplyEnd(false);                        // the page stopped the sound early (Stop speaking / mute)
  t.mock.timers.tick(1300);
  assert.equal(x.h.getState().wake.state, 'waiting');
  x.h.onTurn((await hear(x, 'hey jarvis again', armed.gen)).text, false);
  x.adapter.emit('turn-complete', { text: '', error: 'model failed' });
  t.mock.timers.tick(1300);
  assert.equal(x.h.getState().wake.state, 'waiting');
  x.h.onTurn((await hear(x, 'hey jarvis once more', armed.gen)).text, true);
  finishReply(x, 'Done.'); x.h.wakeReplyEnd(true);
  t.mock.timers.tick(1300);
  assert.equal(x.h.getState().wake.state, 'followup');
});

test('the page dates each utterance: begun before the listening window opened is dropped, begun inside it counts after expiry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const x = make(); t.after(x.cleanup);
  const armed = x.h.wakeArm(true);
  assert.equal((await hear(x, 'hey jarvis', armed.gen, 600)).wake, 'listening');
  assert.deepEqual(await hear(x, 'blah blah from before', armed.gen, 5000), { ok: true, text: '', wake: 'listening' });   // began 5 s ago: before the phrase
  t.mock.timers.tick(8500);                                                                                              // the window expired
  assert.equal(x.h.getState().wake.state, 'waiting');
  assert.deepEqual(await hear(x, 'what time is it', armed.gen, 1200), { ok: true, text: 'what time is it', wake: 'addressed' });   // began at 7.3 s: inside
});

test('a VAD-dated start is exact: speech begun during the cooldown is dropped; an estimated one gets the tolerance', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const x = make({ wakeFollowUpSeconds: '10', wakeFollowUpWhen: 'always' }); t.after(x.cleanup);
  const armed = x.h.wakeArm(true);
  x.h.onTurn((await hear(x, 'hey jarvis go', armed.gen, 0)).text, false);
  finishReply(x, 'Gone.');
  t.mock.timers.tick(1300);
  assert.equal(x.h.getState().wake.state, 'followup');
  assert.deepEqual(await hear(x, 'echo tail', armed.gen, 400), { ok: true, text: '', wake: 'followup' });   // began 300 ms before the follow-up opened
  assert.deepEqual(await hear(x, 'echo tail', armed.gen), { ok: true, text: 'echo tail', wake: 'followup' }); // undated: estimate, tolerant
});

test('follow-up opens only after a question by default; "after every reply" opens it always', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const x = make({ wakeFollowUpSeconds: '10' }); t.after(x.cleanup);
  const armed = x.h.wakeArm(true);
  x.h.onTurn((await hear(x, 'hey jarvis time', armed.gen, 0)).text, false); finishReply(x, 'It is 3:15.');
  t.mock.timers.tick(1300);
  assert.equal(x.h.getState().wake.state, 'waiting');                       // a statement: no window
  x.h.onTurn((await hear(x, 'hey jarvis lights', armed.gen, 0)).text, false); finishReply(x, 'Done. Want the lights on too?');
  t.mock.timers.tick(1300);
  assert.equal(x.h.getState().wake.state, 'followup');                      // a question: window
  t.mock.timers.tick(10100);
  assert.equal(x.h.setOption('wakeFollowUpWhen', 'always'), true);
  assert.equal(x.h.setOption('wakeFollowUpWhen', 'sometimes'), false);
  x.h.onTurn((await hear(x, 'hey jarvis time', armed.gen, 0)).text, false); finishReply(x, 'It is 3:16.');
  t.mock.timers.tick(1300);
  assert.equal(x.h.getState().wake.state, 'followup');                      // every reply
});

test('a close phrase in a follow-up window sends nothing, closes it and updates the page', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const x = make({ wakeFollowUpSeconds: '10', wakeFollowUpWhen: 'always' }); t.after(x.cleanup);
  const armed = x.h.wakeArm(true);
  x.h.onTurn((await hear(x, 'hey jarvis time', armed.gen, 0)).text, false); finishReply(x, 'It is 3:15.');
  t.mock.timers.tick(1300);
  assert.equal(x.h.getState().wake.state, 'followup');
  x.events.length = 0;
  assert.deepEqual(await hear(x, 'Thanks, Jarvis.', armed.gen, 0), { ok: true, text: '', wake: 'closed' });
  assert.equal(x.h.getState().wake.state, 'waiting');
  assert.equal(x.events.at(-1).type, 'wake-state'); assert.equal(x.events.at(-1).wake.state, 'waiting');
  assert.equal(x.sent.length, 1);                                           // only the first request ever reached the model
});

test('wake test log: off by default (unaddressed speech is never logged); on, every utterance and decision is', async t => {
  const lines = [];
  const off = make({}, l => lines.push(l)); t.after(off.cleanup);
  const g0 = off.h.wakeArm(true).gen;
  await hear(off, 'so anyway I told him no', g0);
  assert.deepEqual(lines.filter(l => /wake test|told him/.test(l)), []);

  const on = make({ wakeLog: true, personaPick: '', wakePhrase: 'hey norm' }, l => lines.push(l)); t.after(on.cleanup);
  const g = on.h.wakeArm(true).gen;
  await hear(on, 'so anyway I told him no', g);
  await hear(on, 'A norm.', g);
  await hear(on, 'Hey Nord, what time is it?', g, 0);   // began now, inside the listening window
  const logged = lines.filter(l => l.startsWith('wake test: '));
  assert.equal(logged.length, 3);
  assert.match(logged[0], /^wake test: 0\.01 s while waiting, heard "so anyway I told him no" -> drop \(unaddressed\)$/);
  assert.match(logged[1], /heard "A norm\." -> listen \(phrase-alone\) \(matched "a norm"\)$/);
  assert.match(logged[2], /while listening, heard "Hey Nord, what time is it\?" -> turn \(listening\) \(matched "hey norm", near spelling of the name\)$/);
});
