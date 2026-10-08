'use strict';

// LucidType dictation: the pure pieces — STT endpoint resolution for the background dictation window
// (first lucidtype grid's own override over the global default) and the Whisper noise-phrase filter.
// The capture window, hotkeys, tray and paste are electron-coupled and covered by the manual E2E.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLucidEndpoints, isSttNoisePhrase, isVoiceChatNoise } = require('../app/voiceConfig');

const GLOBAL = { voice: { sttHost: 'stt.lan', sttPort: '10300', ttsHost: 'tts.lan', ttsPort: '10200' } };

test('resolveLucidEndpoints uses the global default when no lucidtype grid overrides', () => {
  const grids = [{ kind: 'app', app: 'lucidtype', options: {} }];
  assert.deepEqual(resolveLucidEndpoints(GLOBAL, grids),
    { sttHost: 'stt.lan', sttPort: '10300', ttsHost: 'tts.lan', ttsPort: '10200' });
});

test('resolveLucidEndpoints honors the lucidtype grid per-page override', () => {
  const grids = [
    { kind: 'app', app: 'meeting', options: {} },
    { kind: 'app', app: 'lucidtype', options: { voiceOverride: true, voiceSttHost: 'pi', voiceSttPort: '10300', voiceTtsHost: 'pi', voiceTtsPort: '10200' } },
  ];
  assert.deepEqual(resolveLucidEndpoints(GLOBAL, grids),
    { sttHost: 'pi', sttPort: '10300', ttsHost: 'pi', ttsPort: '10200' });
});

test('resolveLucidEndpoints falls back to global when there is no lucidtype grid', () => {
  assert.deepEqual(resolveLucidEndpoints(GLOBAL, [{ kind: 'app', app: 'music', options: {} }]),
    { sttHost: 'stt.lan', sttPort: '10300', ttsHost: 'tts.lan', ttsPort: '10200' });
  assert.deepEqual(resolveLucidEndpoints(GLOBAL, []).sttHost, 'stt.lan');
  assert.deepEqual(resolveLucidEndpoints({}, null).sttPort, '10300');   // defaults, no throw on null grids
});

test('isSttNoisePhrase drops whole-utterance hallucinations but keeps real sentences', () => {
  assert.equal(isSttNoisePhrase('Thanks for watching!'), true);
  assert.equal(isSttNoisePhrase('  thanks for watching  '), true);
  assert.equal(isSttNoisePhrase('thanks for watching the demo'), false);   // substring, not whole utterance
  assert.equal(isSttNoisePhrase('Send the report to Dana.'), false);
});

test('isSttNoisePhrase (dictation, translation) drops only what is never content', () => {
  for (const t of ['you', 'Mm-hmm.', 'Uh.', 'Subtitles by the Amara.org community', 'I\u2019ll see you next time.',
    'Thanks for watching! Please subscribe.']) {
    assert.equal(isSttNoisePhrase(t), true, t);
  }
  // A dictated or translated "Thank you." is real speech.
  for (const t of ['Thank you.', 'Thanks!', 'Bye.', 'Cool.', 'Thank you so much.', 'Yeah.', 'No.', '', '...']) {
    assert.equal(isSttNoisePhrase(t), false, t);
  }
});

test('isVoiceChatNoise (AI Voice) also drops the sign-offs Whisper invents, alone or strung together', () => {
  for (const t of ['Thank you.', 'Thank you so much.', 'Cool.', 'you', 'Bye-bye.', 'Mm-hmm.', 'Thanks!',
    'Cool. Thank you so much.', 'Thank you. Thank you.', 'Subtitles by the Amara.org community']) {
    assert.equal(isVoiceChatNoise(t), true, t);
  }
});

test('isVoiceChatNoise keeps bare answers and any utterance with real content', () => {
  for (const t of ['Yeah.', 'Okay.', 'Yes.', 'No.', 'Yeah. Thank you.', 'Thank you, run it again.',
    'Cool, now sort by name.', 'So what changed?', '\u6771\u4eac so', '', '   ', '...']) {
    assert.equal(isVoiceChatNoise(t), false, t);
  }
});
