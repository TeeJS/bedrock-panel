'use strict';
// Wake word, phase 1 (transcript gate): the matcher on STT-shaped text, the phrase resolver, and the
// page state machine on a fake clock. No microphone, no STT, no electron.

const test = require('node:test');
const assert = require('node:assert/strict');
const ww = require('../app/face/wakeword');

const jarvis = ww.createWakeMatcher({ phrase: 'hey jarvis', aliases: ['hey jarvus'] });
const norm = ww.createWakeMatcher({ phrase: 'hey norm', aliases: [] });

test('matcher: phrase at the start wakes, the command keeps its original text', () => {
  assert.deepEqual(jarvis.match('Hey Jarvis, what time is it?'), { wake: true, phrase: 'hey jarvis', commandText: 'what time is it?' });
  assert.deepEqual(jarvis.match('hey jarvis what time is it'), { wake: true, phrase: 'hey jarvis', commandText: 'what time is it' });
  assert.deepEqual(jarvis.match('Hey, Jarvis. Open main.js and keep the Case.'), { wake: true, phrase: 'hey jarvis', commandText: 'Open main.js and keep the Case.' });
  assert.deepEqual(jarvis.match('  HEY JARVIS!'), { wake: true, phrase: 'hey jarvis', commandText: '' });
});

test('matcher: aliases match, unknown spellings and near-misses do not', () => {
  assert.equal(jarvis.match('hey jarvus, lights').wake, true);
  assert.equal(jarvis.match('hey travis, lights').wake, false);
  assert.equal(jarvis.match('hey service, lights').wake, false);
  assert.equal(jarvis.match('jarvis, lights').wake, false);       // the "hey" is part of the phrase
});

test('matcher: the phrase must start the utterance and end on a word boundary', () => {
  assert.equal(jarvis.match('I said hey jarvis earlier').wake, false);
  assert.equal(norm.match('hey normal people').wake, false);
  assert.equal(norm.match("hey norm's desk").wake, false);
  assert.deepEqual(norm.match('hey norm. how are you'), { wake: true, phrase: 'hey norm', commandText: 'how are you' });
  assert.equal(jarvis.match('').wake, false);
  assert.equal(jarvis.match(null).wake, false);
});

test('resolvePhrase: page override, then persona wakeName, then page default; not-ready reasons', () => {
  assert.deepEqual(ww.resolvePhrase({ persona: { id: 'jarvis', name: 'Jarvis', wakeName: 'Jarvis', aliases: ['Hey Jarvus', 'hey jarvis'] } }), { ready: true, phrase: 'hey jarvis', aliases: ['hey jarvus'], reason: '' });
  assert.equal(ww.resolvePhrase({ persona: { id: 'jarvis', wakeName: 'Jarvis' }, pageOverride: 'Computer, please' }).phrase, 'computer please');
  const noName = ww.resolvePhrase({ persona: { id: 'crt', name: 'CRT Terminal' } });
  assert.equal(noName.ready, false); assert.match(noName.reason, /spoken name/);
  assert.equal(ww.resolvePhrase({ persona: null, pageDefault: 'hey panel' }).phrase, 'hey panel');
  assert.equal(ww.resolvePhrase({}).ready, false);
  const oneWord = ww.resolvePhrase({ pageOverride: 'Jarvis' });
  assert.equal(oneWord.ready, false); assert.match(oneWord.reason, /two words/);
});

test('autoWakeName only for one clean pronounceable word', () => {
  assert.equal(ww.autoWakeName('Jarvis'), 'jarvis');
  assert.equal(ww.autoWakeName('Mimi'), 'mimi');
  assert.equal(ww.autoWakeName('CRT Terminal'), '');
  assert.equal(ww.autoWakeName('J.A.R.V.I.S.'), '');
  assert.equal(ww.autoWakeName('Al'), '');
});

function clock() { let t = 1000; return { now: () => t, advance: ms => { t += ms; } }; }

test('state: one wake, one request, back to waiting; unaddressed speech is dropped', () => {
  const c = clock();
  const s = ww.createWakeState({ now: c.now, matcher: jarvis });
  assert.equal(s.snapshot().state, 'off');
  assert.equal(s.onUtterance('hello there').action, 'pass');   // off = today's behaviour
  s.arm();
  assert.equal(s.snapshot().state, 'waiting');
  assert.deepEqual(s.onUtterance('what is the weather'), { action: 'drop', reason: 'unaddressed' });
  const d = s.onUtterance('Hey Jarvis, what is the weather?');
  assert.equal(d.action, 'turn'); assert.equal(d.commandText, 'what is the weather?');
  s.onTurnStart();
  assert.equal(s.snapshot().state, 'active');
  assert.equal(s.onUtterance('hey jarvis stop').action, 'drop');   // nothing is queued while active
  s.onReplyEnd();
  assert.equal(s.snapshot().state, 'cooldown');
  assert.equal(s.onUtterance('hey jarvis again').action, 'drop');  // echo guard
  c.advance(1300);
  assert.equal(s.snapshot().state, 'waiting');
  assert.equal(s.onUtterance('hey jarvis again').action, 'turn');
});

test('state: phrase alone opens a window to START speaking; it expires back to waiting', () => {
  const c = clock();
  const s = ww.createWakeState({ now: c.now, matcher: jarvis, windowMs: 8000 });
  s.arm();
  assert.deepEqual(s.onUtterance('hey jarvis'), { action: 'listen', reason: 'phrase-alone' });
  assert.equal(s.snapshot().state, 'listening');
  assert.equal(s.snapshot().until, 9000);
  c.advance(3000);
  assert.deepEqual(s.onUtterance('turn on the lights'), { action: 'turn', commandText: 'turn on the lights', reason: 'listening' });
  s.onTurnStart(); s.onReplyEnd(); c.advance(2000);
  assert.deepEqual(s.onUtterance('hey jarvis'), { action: 'listen', reason: 'phrase-alone' });
  c.advance(8001);
  assert.equal(s.snapshot().state, 'waiting');
  assert.equal(s.onUtterance('turn on the lights').action, 'drop');
});

test('state: follow-up window only when configured, counted while waiting for the human, visible, and it ends', () => {
  const c = clock();
  const s = ww.createWakeState({ now: c.now, matcher: jarvis, followUpMs: 10000, cooldownMs: 1000 });
  s.arm();
  s.onUtterance('hey jarvis, what time is it'); s.onTurnStart();
  c.advance(30000);                        // a long reply: the window does not run during it
  s.onReplyEnd(); c.advance(1000);
  assert.equal(s.snapshot().state, 'followup');
  assert.equal(s.snapshot().until, c.now() + 10000);
  c.advance(4000);
  assert.deepEqual(s.onUtterance('and tomorrow?'), { action: 'turn', commandText: 'and tomorrow?', reason: 'followup' });
  s.onTurnStart(); s.onReplyEnd(); c.advance(1000);
  assert.equal(s.snapshot().state, 'followup');
  c.advance(10001);
  assert.equal(s.snapshot().state, 'waiting');                 // one morning wake never lasts all day
  assert.equal(s.onUtterance('and the day after?').action, 'drop');
  s.setFollowUpMs(0);
  s.onUtterance('hey jarvis, hi'); s.onTurnStart(); s.onReplyEnd(); c.advance(1001);
  assert.equal(s.snapshot().state, 'waiting');
});

test('state: stale utterances (older generation) are dropped; disarm passes nothing', () => {
  const c = clock();
  const s = ww.createWakeState({ now: c.now, matcher: jarvis });
  const g1 = s.arm();
  const g2 = s.arm();                                           // mic toggled off/on: new generation
  assert.notEqual(g1, g2);
  assert.deepEqual(s.onUtterance('hey jarvis, hi', g1), { action: 'drop', reason: 'stale' });
  assert.equal(s.onUtterance('hey jarvis, hi', g2).action, 'turn');
  s.disarm();
  assert.equal(s.snapshot().state, 'off');
  assert.equal(s.onUtterance('hey jarvis, hi').action, 'pass');
});

test('state: a persona switch (new matcher) returns to waiting with a new generation', () => {
  const c = clock();
  const s = ww.createWakeState({ now: c.now, matcher: jarvis });
  const g = s.arm();
  s.onUtterance('hey jarvis');
  assert.equal(s.snapshot().state, 'listening');
  const g2 = s.setMatcher(norm);
  assert.notEqual(g, g2);
  assert.equal(s.snapshot().state, 'waiting');
  assert.equal(s.onUtterance('hey jarvis, hi').action, 'drop');
  assert.equal(s.onUtterance('hey norm, hi').action, 'turn');
});

// STT-shaped fixtures: what Whisper tends to hand back for a spoken name (capitalization, commas,
// run-on words, fillers) and what must NOT wake the page. One row per case: [phrase, text, expect].
const FIXTURES = [
  ['hey jarvis', 'Hey Jarvis, what time is it?', 'what time is it?'],
  ['hey jarvis', 'hey jarvis', ''],
  ['hey jarvis', 'Hey, Jarvis! Lights on.', 'Lights on.'],
  ['hey jarvis', 'HEY JARVIS ... are you there', 'are you there'],
  ['hey jarvis', 'Hey Jarvis. Hey Jarvis. Hello?', 'Hello?'],   // a repeated phrase is stripped; the request is what follows
  ['hey jarvis', 'Hey Jarvis what time is it', 'what time is it'],
  ['hey jarvis', 'hey jarvis.', ''],
  ['hey jarvis', 'Hey Jarvis?', ''],
  ['hey mimi', 'Hey Mimi, sing a song', 'sing a song'],
  ['hey terminal', 'Hey terminal, run the tests', 'run the tests'],
  ['computer please', 'Computer, please. Open the door.', 'Open the door.'],
  ['hey jarvis', 'Jarvis, what time is it?', null],          // no "hey": not the phrase
  ['hey jarvis', 'Hey Travis, what time is it?', null],
  ['hey jarvis', 'Say hey jarvis for me', null],              // not at the start
  ['hey jarvis', "hey jarvis's desk", null],                  // possessive: a different word
  ['hey jarvis', 'hey jarvisss what', null],                  // not a word boundary
  ['hey norm', 'Hey, normal people say hi', null],
  // Measured on the live panel (Whisper): the "hey" is what gets misheard, the name is right.
  ['hey norm', 'A norm.', ''],
  ['hey norm', 'pain norm.', ''],
  ['hey norm', 'Hey Norm.', ''],
  ['hey norm', 'a norm, what time is it', 'what time is it'],
  ['hey norm', 'Enorm.', ''],                                 // a fast "Hey Norm" fused into one word
  ['hey norm', 'Enorm, what time is it', 'what time is it'],
  ['hey norm', 'enormous', null],                             // fused form still ends on a word boundary
  ['hey norm', 'What time is it?', null],
  // Second live test (Whisper, per built-in persona).
  ['hey mimi', 'Say Mimi.', ''],
  ['hey mimi', 'Hey Mimi. Hey Mimi. Hey Mimi.', ''],             // the phrase said three times is the phrase alone, not a request
  ['hey terminal', 'Hey terminal, hey terminal.', ''],
  ['hey intern', 'Hey intern, hey intern.', ''],
  ['hey intern', 'a intern.', ''],
  ['hey jarvis', 'Jarvis.', ''],                                  // a quick "hey" dropped: the bare name alone wakes
  ['hey terminal', 'terminal.', ''],
  ['hey terminal', 'The terminal is slow', null],                 // the bare name must be the WHOLE utterance
  ['hey terminal', 'terminal, run the tests', null],              // ...and never carries a command
  ['hey rocky', 'Hey, Rocky.', ''],
  ['hey norm', 'you', null],
  ['hey norm', 'A normal day', null],                         // the name must still match exactly
  ['hey norm', 'Pain is normal', null],
  ['computer please', 'a computer please', null],             // only "hey ..." phrases get the variants
  ['hey jarvis', '', null],
  ['hey jarvis', '   ', null],
];
test('fixtures: STT-shaped texts wake (or not) exactly as expected', () => {
  for (const [phrase, text, expect] of FIXTURES) {
    const m = ww.createWakeMatcher({ phrase, aliases: [] }).match(text);
    if (expect === null) assert.equal(m.wake, false, JSON.stringify(text) + ' must not wake ' + phrase);
    else { assert.equal(m.wake, true, JSON.stringify(text) + ' must wake ' + phrase); assert.equal(m.commandText, expect, JSON.stringify(text)); }
  }
});

test('state: a request begun inside a window counts even when STT returns after the window closed', () => {
  let t = 1000; const st = ww.createWakeState({ now: () => t, windowMs: 8000, cooldownMs: 1200, followUpMs: 0, matcher: jarvis });
  st.arm();
  assert.equal(st.onUtterance('hey jarvis', st.gen).action, 'listen');          // window until 9000
  t = 11000;                                                                     // STT took its time: the human began at 8500
  assert.deepEqual(st.onUtterance('what time is it', st.gen, 8500), { action: 'turn', commandText: 'what time is it', reason: 'listening' });
  st.onTurnStart(); st.onReplyEnd(); t = 13000;
  assert.equal(st.current(), 'waiting');
  st.onUtterance('hey jarvis', st.gen); t = 25000;                               // window until 21000; this one began after it
  assert.equal(st.onUtterance('too late', st.gen, 22000).action, 'drop');
  assert.equal(st.current(), 'waiting');
});

test('state: the window survives the host timer ticking it to waiting before a late STT result lands', () => {
  let t = 1000; const st = ww.createWakeState({ now: () => t, windowMs: 8000, cooldownMs: 1200, followUpMs: 5000, matcher: jarvis });
  st.arm();
  st.onUtterance('hey jarvis', st.gen);                                   // listening until 9000
  t = 9001; assert.equal(st.tick(), 'waiting');                           // the host's timer fires at the deadline
  t = 11000;
  assert.equal(st.onUtterance('what time is it', st.gen, 8500).action, 'turn');   // began at 8.5 s: still counts
  st.onTurnStart(); st.onReplyEnd(false); t = 13000;                      // cancelled: no follow-up window
  assert.equal(st.current(), 'waiting');
  st.onUtterance('hey jarvis go', st.gen); st.onTurnStart(); st.onReplyEnd(true); t = 15000;
  assert.equal(st.current(), 'followup');                                 // completed: the configured window
  t = 19201; assert.equal(st.tick(), 'waiting');
  assert.equal(st.onUtterance('one more', st.gen, 19100).action, 'turn');  // began inside the follow-up
  st.onTurnStart(); st.onReplyEnd(true); t = 30000;
  assert.equal(st.onUtterance('way later', st.gen, 29000).action, 'drop'); // a used window does not come back
});

test('state: a request counts only when it BEGAN inside the window (lower bound at the phrase receipt, upper at expiry)', () => {
  let t = 1000; const st = ww.createWakeState({ now: () => t, windowMs: 8000, cooldownMs: 1200, followUpMs: 5000, matcher: jarvis });
  st.arm();
  // The phrase utterance arrived at 1000 (its speech had ended); STT returned at 2000 and opened the window.
  t = 2000; assert.equal(st.onUtterance('hey jarvis', st.gen, 200, 1000).action, 'listen');
  // Ambient speech that straddled the phrase (begun long before it): not for us.
  t = 3000; assert.equal(st.onUtterance('so I was saying', st.gen, 0, 2900).action, 'drop');
  // The human went on talking 200 ms after the phrase shipped, before STT was back: inside.
  t = 3500; assert.deepEqual(st.onUtterance('what time is it', st.gen, 1200, 3400).action, 'turn');
  st.onTurnStart(); st.onReplyEnd(true);
  t = 3700 + 1200; assert.equal(st.tick(), 'followup');                       // opened at the cooldown's end (4900)
  assert.equal(st.onUtterance('echo tail', st.gen, 4000, 5000).action, 'drop'); // began during the cooldown: the speaker
  t = 9901; assert.equal(st.tick(), 'waiting');                              // follow-up expired at 9900
  t = 11000; assert.equal(st.onUtterance('late but inside', st.gen, 9500, 10900).action, 'turn');
  st.onTurnStart(); st.onReplyEnd(true); t = 20000; st.tick(); t = 30000;
  assert.equal(st.onUtterance('before that window', st.gen, 10000, 29900).action, 'drop');
});

test('state: the lower bound is exact for a VAD-dated start; the 500 ms tolerance applies only to an estimated one', () => {
  let t = 1000; const st = ww.createWakeState({ now: () => t, windowMs: 8000, cooldownMs: 1200, followUpMs: 5000, matcher: jarvis });
  st.arm();
  st.onUtterance('hey jarvis go', st.gen, 500, 1000); st.onTurnStart(); st.onReplyEnd(true);
  t = 2300; assert.equal(st.tick(), 'followup');                                   // the cooldown ended at 2200: openedAt
  t = 3000;
  assert.equal(st.onUtterance('tail', st.gen, 2100, 2900).action, 'drop');           // VAD-dated, 100 ms into the cooldown: early
  assert.equal(st.onUtterance('tail', st.gen, 2100, 2900, true).action, 'turn');     // estimated start: within the tolerance
  assert.equal(st.onUtterance('tail', st.gen, 1600, 2900, true).action, 'drop');     // estimated, 600 ms early: still early
});

test('sprite aliases: what Whisper wrote for "Hey Sprite" in the live test all wake', () => {
  const { SPRITE_PERSONA: sprite } = require('../app/face/persona');
  assert.ok(sprite, 'built-in sprite persona');
  const r = ww.resolvePhrase({ persona: sprite });
  const m = ww.createWakeMatcher(r);
  for (const t of ['Hastebrite.', 'Haste bright.', 'taste bright.', 'Peace, Bright.', 'Hey Sprite.']) assert.equal(m.match(t).wake, true, t);
});

test('replyInvitesAnswer: a question or an offer opens the follow-up, a plain statement does not', () => {
  for (const t of ['Want the lights on too?', 'It is 3:15. Anything else?', 'Done. Let me know if you want it shorter.', 'I can do either. Which one would you like', 'Should I continue?"', 'Do you want me to run the tests?)']) assert.equal(ww.replyInvitesAnswer(t), true, t);
  for (const t of ['It is 3:15.', 'Done.', 'I opened the file and fixed the typo.', 'Why would that be? Because the cache was stale.', '', null]) assert.equal(ww.replyInvitesAnswer(t), false, String(t));
});

test('isClosePhrase: the whole utterance must be a closer; a request that merely starts with one is not', () => {
  for (const t of ['Thanks.', 'thank you!', 'That’s all.', "That's it", 'Never mind.', 'OK, thanks', 'go to sleep', 'Thanks Jarvis']) assert.equal(ww.isClosePhrase(t, ['jarvis']), true, t);
  for (const t of ['Thanks for the update on the build', 'Never mind the typo, fix the rest', 'what time is it', 'nothing works', '']) assert.equal(ww.isClosePhrase(t, ['jarvis']), false, t);
});

test('state: a close phrase ends a follow-up window, sends nothing, and the page waits for the name', () => {
  let t = 1000; const st = ww.createWakeState({ now: () => t, windowMs: 8000, cooldownMs: 1200, followUpMs: 10000, matcher: jarvis, closeNames: ['jarvis'] });
  st.arm(); st.onUtterance('hey jarvis go', st.gen, 900, 1000); st.onTurnStart(); st.onReplyEnd(true);
  t = 3000; assert.equal(st.tick(), 'followup');
  assert.deepEqual(st.onUtterance('Thanks, Jarvis.', st.gen, 3000, 3100), { action: 'drop', reason: 'closed' });
  assert.equal(st.current(), 'waiting');
  assert.equal(st.onUtterance('one more thing', st.gen, 3200, 3300).action, 'drop');                    // the window is gone
  assert.deepEqual(st.onUtterance('Hey Jarvis, never mind', st.gen, 3400, 3500), { action: 'drop', reason: 'closed' });   // no turn for a goodbye
  st.onUtterance('hey jarvis', st.gen, 3600, 3700);                                                      // listening window open
  assert.equal(st.onUtterance('that is all', st.gen, 3800, 3900).reason, 'closed');
  assert.equal(st.current(), 'waiting');
});

test('state: a reply that does not invite an answer opens no follow-up window', () => {
  let t = 1000; const st = ww.createWakeState({ now: () => t, windowMs: 8000, cooldownMs: 1200, followUpMs: 10000, matcher: jarvis });
  st.arm(); st.onUtterance('hey jarvis go', st.gen, 900, 1000); st.onTurnStart(); st.onReplyEnd(true && ww.replyInvitesAnswer('It is 3:15.'));
  t = 3000; assert.equal(st.tick(), 'waiting');
  st.onUtterance('hey jarvis again', st.gen, 3100, 3200); st.onTurnStart(); st.onReplyEnd(ww.replyInvitesAnswer('Want the lights on too?'));
  t = 5000; assert.equal(st.tick(), 'followup');
});
