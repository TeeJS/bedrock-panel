'use strict';
// The emotion-tag protocol for the AI Voice face: a leading "[happy]" is stripped by the host before
// speech and transcript, even when it arrives split across stream deltas; everything that is not a
// recognized tag passes through untouched, with at most a bounded first-delta delay.

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripEmotionTag, createTagParser, emotionInstruction, EMOTIONS, MAX_PREFIX } = require('../app/face/emotion-tag');

test('stripEmotionTag strips a known tag and keeps the rest exactly', () => {
  assert.deepEqual(stripEmotionTag('[happy] Yes yes yes. It work.'), { text: 'Yes yes yes. It work.', emotion: 'happy' });
  assert.deepEqual(stripEmotionTag('  [Surprised]Amaze!'), { text: 'Amaze!', emotion: 'surprised' });
});

test('stripEmotionTag leaves unknown bracket words and untagged text alone', () => {
  assert.deepEqual(stripEmotionTag('[note] see below'), { text: '[note] see below', emotion: null });
  assert.deepEqual(stripEmotionTag('Plain reply.'), { text: 'Plain reply.', emotion: null });
  assert.deepEqual(stripEmotionTag(''), { text: '', emotion: null });
  assert.deepEqual(stripEmotionTag(null), { text: '', emotion: null });
});

test('a tag only counts in the persona vocabulary that was given', () => {
  assert.deepEqual(stripEmotionTag('[happy] hi', ['neutral']), { text: '[happy] hi', emotion: null });
});

function run(parser, deltas) {
  parser.start();
  const out = [];
  let emotion = null, emotionCount = 0;
  deltas.forEach(d => { const r = parser.push(d); if (r.text) out.push(r.text); if (r.emotion) { emotion = r.emotion; emotionCount++; } });
  const tail = parser.flush();
  if (tail) out.push(tail);
  return { text: out.join(''), emotion, emotionCount };
}

test('a tag split across deltas is stripped and reported once', () => {
  const p = createTagParser();
  assert.deepEqual(run(p, ['[', 'hap', 'py] Yes ', 'yes yes.']), { text: 'Yes yes yes.', emotion: 'happy', emotionCount: 1 });
});

test('a tag that arrives whole in the first delta is stripped', () => {
  const p = createTagParser();
  assert.deepEqual(run(p, ['[thinking] Answer: pin wrong.']), { text: 'Answer: pin wrong.', emotion: 'thinking', emotionCount: 1 });
});

test('an untagged reply passes through byte for byte', () => {
  const p = createTagParser();
  assert.deepEqual(run(p, ['Hello', ' there.']), { text: 'Hello there.', emotion: null, emotionCount: 0 });
});

test('code and markdown openings are not mistaken for a tag', () => {
  const p = createTagParser();
  assert.deepEqual(run(p, ['```js\n', 'const a = [1];\n```']), { text: '```js\nconst a = [1];\n```', emotion: null, emotionCount: 0 });
  assert.deepEqual(run(p, ['# Title\n', '- item']), { text: '# Title\n- item', emotion: null, emotionCount: 0 });
});

test('a bracket that never closes is released once the prefix window is exhausted', () => {
  const p = createTagParser({ maxPrefix: 8 });
  const r = run(p, ['[abc', 'defgh', 'ij', ' more']);
  assert.equal(r.text, '[abcdefghij more');
  assert.equal(r.emotion, null);
});

test('a short reply held in the window is released by flush', () => {
  const p = createTagParser();
  p.start();
  assert.deepEqual(p.push('[ha'), { text: '', emotion: null });
  assert.equal(p.pending(), '[ha');
  assert.equal(p.flush(), '[ha');
  assert.equal(p.pending(), '');
});

test('a malformed tag ("[happy" then prose with the bracket much later) is not swallowed', () => {
  const p = createTagParser();
  const r = run(p, ['[happy no close here, this goes on and on', ' ] end']);
  assert.equal(r.text, '[happy no close here, this goes on and on ] end');
  assert.equal(r.emotion, null);
});

test('the parser resets per turn: a second start() forgets the first turn', () => {
  const p = createTagParser();
  run(p, ['[sad] one']);
  assert.deepEqual(run(p, ['two']), { text: 'two', emotion: null, emotionCount: 0 });
});

test('flush() resets, so a host that misses start() still strips the next message\'s tag', () => {
  const p = createTagParser();
  p.start();
  p.push('plain');
  p.flush();
  assert.deepEqual(p.push('[sad] b'), { text: 'b', emotion: 'sad' });
});

test('all whitespace after the tag is dropped and custom vocab is case-insensitive', () => {
  assert.deepEqual(stripEmotionTag('[happy]  hi'), { text: 'hi', emotion: 'happy' });
  assert.deepEqual(stripEmotionTag('[Happy]\n\nhi'), { text: 'hi', emotion: 'happy' });
  assert.deepEqual(stripEmotionTag('[grin] hi', ['Grin']), { text: 'hi', emotion: 'grin' });
});

test('the instruction names every emotion in the vocabulary', () => {
  const s = emotionInstruction();
  EMOTIONS.forEach(e => assert.ok(s.indexOf(e) !== -1, e));
  assert.ok(MAX_PREFIX >= 12);   // room for "[surprised] "
});
