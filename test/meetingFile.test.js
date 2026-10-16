'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../app/meetingFile');

const SEGS = [
  { start: 0, end: 3, text: 'good morning everyone welcome to the weekly review' },
  { start: 3.5, end: 9, text: 'thanks carl lets start with the audit items' },
  { start: 9.2, end: 14, text: 'sure the interim testing is on track' },
  { start: 14.5, end: 20, text: 'and the policy question from hannah' },
];
const BODY = '# Meeting Analysis\n## Summary\nx\n## Transcript\n'
  + '[Carl Tanner 0:00] Good morning everyone, welcome to the weekly review.\n'
  + '[Brad Albrich 0:03] Thanks Carl, let\'s start with the audit items.\n'
  + '[Brad Albrich 0:09] Sure, the interim testing is on track and the policy question from Hannah.\n';

test('turn times come from the cited segments; a turn that does not match its citation loses its time', () => {
  const r = f.applyTurnTimes(BODY, [
    { turn: 1, segmentStart: 0, segmentEnd: 0 }, { turn: 2, segmentStart: 1, segmentEnd: 1 }, { turn: 3, segmentStart: 2, segmentEnd: 3 },
  ], SEGS);
  assert.equal(r.evidence, 'full');
  assert.equal(r.verified, 3);
  assert.match(r.body, /\[Brad Albrich 0:09\] Sure/);
  // wrong citation (points at the greeting) -> no time, evidence limited, nothing invented
  const bad = f.applyTurnTimes(BODY, [
    { turn: 1, segmentStart: 0, segmentEnd: 0 }, { turn: 2, segmentStart: 1, segmentEnd: 1 }, { turn: 3, segmentStart: 0, segmentEnd: 0 },
  ], SEGS);
  assert.equal(bad.evidence, 'limited');
  assert.match(bad.body, /\[Brad Albrich\] Sure/);
  assert.doesNotMatch(bad.body, /\[Brad Albrich 0:09\]/);
});

test('turn times: missing or out-of-range or backwards citations are never applied', () => {
  const r = f.applyTurnTimes(BODY, [{ turn: 1, segmentStart: 0, segmentEnd: 0 }, { turn: 3, segmentStart: 9, segmentEnd: 9 }], SEGS);
  assert.equal(r.unverified, 2);
  assert.match(r.body, /\[Carl Tanner 0:00\]/);
  assert.match(r.body, /\[Brad Alblich?\] Thanks|\[Brad Albrich\] Thanks/);
  const back = f.applyTurnTimes(BODY, [{ turn: 1, segmentStart: 2, segmentEnd: 2 }, { turn: 2, segmentStart: 0, segmentEnd: 0 }], [
    { start: 0, end: 3, text: 'thanks carl lets start with the audit items' },
    { start: 3.5, end: 9, text: 'x' },
    { start: 9.2, end: 14, text: 'good morning everyone welcome to the weekly review' },
  ]);
  assert.match(back.body, /\[Carl Tanner 0:09\] Good morning/);
  assert.match(back.body, /\[Brad Albrich\] Thanks/);   // earlier than the previous verified turn -> dropped
});

test('formatTime renders m:ss and h:mm:ss', () => {
  assert.equal(f.formatTime(0), '0:00');
  assert.equal(f.formatTime(65.9), '1:05');
  assert.equal(f.formatTime(3725), '1:02:05');
});

test('ownership: user-owned sections survive, AI sections are regenerated, baseline hash tracks AI text only', () => {
  const prev = '# T\n## Summary\nold summary\n## My Notes\nkeep me exactly\n## Transcript\n[A 0:00] hi\n';
  const ai = ['Summary', 'Transcript'];
  const merged = f.mergeOwnership(prev, '# T\n## Summary\nnew summary\n## Transcript\n[A 0:00] hi again\n', ai);
  assert.match(merged, /new summary/);
  assert.match(merged, /## My Notes\nkeep me exactly/);
  assert.doesNotMatch(merged, /old summary/);
  const h1 = f.baselineHash(prev, ai);
  assert.equal(f.baselineHash(prev.replace('keep me exactly', 'keep me EDITED'), ai), h1);   // user section edit: baseline unchanged
  assert.notEqual(f.baselineHash(prev.replace('old summary', 'old summary, edited by hand'), ai), h1);   // AI section edit: baseline moved
  assert.deepEqual(f.aiHeadingsOf(prev), ['Summary', 'My Notes', 'Transcript']);
});

test('item ids: exact text keeps the id and its done status; reworded done item keeps both; uncertain never transfers done', () => {
  const previous = {
    action_items: [
      { id: 'ai-1', assignee: 'Carl Tanner', task: 'Send the pricing doc to Brad', status: 'done' },
      { id: 'ai-2', assignee: 'Matt Masters', task: 'Send draft', status: 'done' },
      { id: 'ai-3', assignee: 'Brad Albrich', task: 'Confirm policy versions', status: 'open' },
    ],
    decisions: [{ id: 'dc-1', text: 'HANA approved by the board' }],
    intents: [],
  };
  const fm = f.assignItemIds({
    action_items: [
      { assignee: 'Carl Tanner', task: 'send the pricing doc to brad', status: 'open' },   // same text, different case
      { assignee: 'Matt Masters', task: 'Send approved version', status: 'open' },        // not the same task
      { assignee: 'Brad Albrich', task: 'Confirm the policy versions', status: 'open' },   // lightly reworded (above the 0.8 similarity bar)
    ],
    decisions: [{ text: 'HANA approved by the board' }, { text: 'Automated testing deferred 18 months' }],
    intents: [],
  }, previous, 1000);
  const by = t => fm.action_items.find(i => i.task === t);
  assert.equal(by('send the pricing doc to brad').id, 'ai-1');
  assert.equal(by('send the pricing doc to brad').status, 'done');                 // completion survives
  assert.notEqual(by('Send approved version').id, 'ai-2');
  assert.equal(by('Send approved version').status, 'open');                        // done NOT transferred
  const carried = fm.action_items.find(i => i.id === 'ai-2');
  assert.equal(carried.carried, true);
  assert.equal(carried.status, 'done');
  assert.equal(by('Confirm the policy versions').id, 'ai-3');                      // unique high-similarity match, same owner
  // a heavier rewording (below the bar) is a NEW item, flagged for review
  const far = f.assignItemIds({ action_items: [{ assignee: 'Brad Albrich', task: 'Confirm the policy versions floating around the company', status: 'open' }], decisions: [], intents: [] }, previous, 1000);
  assert.notEqual(far.action_items[0].id, 'ai-3');
  assert.equal(far.action_items[0].review, true);
  assert.equal(fm.decisions[0].id, 'dc-1');
  assert.match(fm.decisions[1].id, /^dc-/);
  assert.ok(fm.action_items.every(i => /^ai-/.test(i.id)));
});

test('item ids: two similar open tasks for one person are new items flagged for review, not guessed matches', () => {
  const previous = { action_items: [{ id: 'ai-1', assignee: 'Carl Tanner', task: 'Review the Q3 audit evidence list', status: 'done' }], decisions: [], intents: [] };
  const fm = f.assignItemIds({ action_items: [
    { assignee: 'Carl Tanner', task: 'Review the Q3 audit evidence list again', status: 'open' },
    { assignee: 'Carl Tanner', task: 'Review the Q3 audit evidence list for Hannah', status: 'open' },
  ], decisions: [], intents: [] }, previous, 1000);
  const fresh = fm.action_items.filter(i => !i.carried);
  assert.equal(fresh.length, 2);
  assert.ok(fresh.every(i => i.id !== 'ai-1' && i.review === true && i.status === 'open'));
  assert.equal(fm.action_items.filter(i => i.carried).length, 1);
});

test('assembleFile: frontmatter block then body, Unix line endings, single trailing newline', () => {
  const out = f.assembleFile('title: "x"\r\ntype: "meeting"\r\n', '\r\n# T\r\nbody\r\n\r\n');
  assert.equal(out, '---\ntitle: "x"\ntype: "meeting"\n---\n# T\nbody\n');
});

test('newId is prefixed, time-sortable and unique', () => {
  const a = f.newId('mt', 1000), b = f.newId('mt', 2000);
  assert.match(a, /^mt-[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(a.slice(3, 13) < b.slice(3, 13));
  assert.notEqual(f.newId('x', 5), f.newId('x', 5));
});
