'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const fs = require('node:fs');
const path = require('node:path');
const fm = require('../app/meetingFrontmatter');

const valid = () => ({ title: 'Meeting', type: 'meeting', date: '2026-10-14T15:57:16-07:00', duration: '32m',
  status: 'complete', attendees: ['Carl Tanner'], people: ['carl-tanner'], tags: ['2026'],
  action_items: [{ id: 'a1', assignee: 'Carl Tanner', task: 'Send draft', status: 'done' }],
  decisions: [{ id: 'd1', text: 'Ship', authority: 'high' }], intents: [{ kind: 'open-question', what: 'When?', status: 'open' }],
  speaker_map: [{ speaker_label: 'Speaker A', name: 'carl-tanner', confidence: 'medium', source: 'llm' }],
  bedrock: { schema: 1, revision: 1, exports: { joplin: { id: '0123', state: 'pending' } } } });
const wrap = obj => '---\n' + fm.serializeFrontmatter(obj) + '---\n\n## Summary\nNotes\n';
function tail(sections = {}) {
  return '## Summary\nKept\n\n<!-- BEDROCK-STRUCTURED v1 -->\n' + Object.entries({
    'KEY POINTS': '- Discussed rollout', 'DECISIONS': '- Ship Friday', 'ACTION ITEMS': '- @Carl Tanner: Send draft (by Friday)',
    'OPEN QUESTIONS': '- Who will review?', 'COMMITMENTS': '- @Ann: Review draft', 'PARTICIPANTS': '- Carl Tanner',
    'SPEAKER MAP': '- Speaker A → Carl Tanner (self introduction)', 'TURNS': '- 1: segments 0-3', ...sections,
  }).map(([heading, value]) => heading + ':\n' + value).join('\n\n') + '\n<!-- /BEDROCK-STRUCTURED -->\n';
}

test('writer round-trips independently and through bounded reader, including nested extension maps', () => {
  const obj = valid();
  obj.custom = { 'quoted key: #': 'colon: hash # quote " slash \\ line\nnext 😀', list: [true, false, null, 2, '2026', {}, []],
    nested: [{ first: { name: 'nested' }, other: 'ok' }] };
  const serialized = fm.serializeFrontmatter(obj);
  assert.deepEqual(yaml.load(serialized, { schema: yaml.JSON_SCHEMA }), obj);
  const parsed = fm.readFrontmatter(wrap(obj));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data, obj);
  assert.deepEqual(parsed.unknownKeys, ['custom']);
  assert.equal(parsed.body, '\n## Summary\nNotes\n');
  assert.equal(fm.validateFrontmatter(parsed.data).ok, true);
});

test('pinned Minutes schema example is accepted as documented data', () => {
  // docs/architecture/frontmatter-schema.md at 6a5a8cbf9c4236f55814cccafb50a840fbf15c86.
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'minutes-6a5a8cb-meeting.md'), 'utf8');
  const parsed = fm.readFrontmatter(text);
  assert.equal(parsed.ok, true);
  assert.equal(fm.validateFrontmatter(parsed.data).ok, true);
  assert.deepEqual(parsed.data, yaml.load(parsed.raw, { schema: yaml.JSON_SCHEMA }));
  assert.equal(parsed.data.action_items[0].assignee, 'jordan');
  assert.match(parsed.body, /\[SPEAKER_0 0:00\]/);
});

test('reader preserves body bytes including CRLF and never parses an embedded frontmatter block', () => {
  const body = '\r\n## Summary\r\nEdited\r\n';
  const parsed = fm.readFrontmatter('---\r\ntitle: "x"\r\n---\r\n' + body);
  assert.equal(parsed.body, body);
  assert.equal(fm.readFrontmatter('text\n---\ntitle: x\n---\n').reason, 'no-frontmatter');
});

test('reader refuses unsupported/malicious YAML instead of losing unknown policy data', () => {
  for (const raw of ['title: |\n  multiline', 'title: &a "name"\ncopy: *a', 'title: "one"\ntitle: "two"',
    '__proto__: "bad"', 'nested:\n  constructor: "bad"', 'title: { nested: map }', "title: 'single quotes'",
    'title:\n   bad: "indent"', 'title:\n\tbad: "tab"', 'title: "unterminated']) {
    assert.equal(fm.readFrontmatter('---\n' + raw + '\n---\nbody').reason, 'unreadable-frontmatter', raw);
  }
  assert.equal({}.bad, undefined);
  assert.equal(fm.readFrontmatter('---\ntitle: "' + 'x'.repeat(32769) + '"\n---\n').ok, false);
  assert.throws(() => fm.serializeFrontmatter({ s: 'x'.repeat(32769) }), /string limit/);
  assert.throws(() => fm.serializeFrontmatter({ n: Infinity }), /non-finite/);
  assert.throws(() => fm.serializeFrontmatter({ date: new Date() }), /unsupported/);
});

test('validator rejects missing required values, wrong types/enums and fabricated LLM high confidence', () => {
  for (const [key, value] of [['date', '2026-10-15'], ['date', '2026-02-30T12:00:00Z'], ['type', 'arbitrary'], ['duration', null], ['status', 'done'], ['title', '']]) {
    const obj = valid(); obj[key] = value;
    assert.equal(fm.validateFrontmatter(obj).ok, false, key);
  }
  const obj = valid(); delete obj.action_items[0].assignee;
  assert.equal(fm.validateFrontmatter(obj).ok, false);
  obj.action_items = []; obj.speaker_map[0].confidence = 'high';
  assert.equal(fm.validateFrontmatter(obj).ok, false);
  obj.speaker_map[0].confidence = 'medium'; obj.sensitivity = 'restricted';
  assert.equal(fm.validateFrontmatter(obj).ok, true);
});

test('structured parser extracts labelled lists, free-text due date, speaker provenance and turn ranges', () => {
  const parsed = fm.parseStructuredTail(tail());
  assert.equal(parsed.malformed, false, parsed.errors.join('; '));
  assert.equal(parsed.bodyWithoutTail, '## Summary\nKept\n');
  assert.deepEqual(parsed.structured.action_items, [{ assignee: 'Carl Tanner', task: 'Send draft', due: 'Friday', status: 'open' }]);
  assert.deepEqual(parsed.structured.turns, [{ turn: 1, segmentStart: 0, segmentEnd: 3 }]);
  assert.equal(parsed.structured.speaker_map[0].confidence, 'medium');
  assert.equal(parsed.structured.speaker_map[0].source, 'llm');
  assert.deepEqual(parsed.structured.intents.map(i => i.kind), ['open-question', 'commitment']);
});

test('unassigned action stays in intents and explicit none remains valid empty extraction', () => {
  const parsed = fm.parseStructuredTail(tail({ 'ACTION ITEMS': '- Confirm version', 'SPEAKER MAP': '(none)', 'TURNS': '(none)' }));
  assert.equal(parsed.malformed, false);
  assert.deepEqual(parsed.structured.action_items, []);
  assert.deepEqual(parsed.structured.intents[0], { kind: 'action-item', what: 'Confirm version', status: 'open' });
  const unnamed = fm.parseStructuredTail(tail({ 'ACTION ITEMS': '- @Speaker A: Check it' }));
  assert.equal(unnamed.structured.action_items.length, 0);
  assert.equal(unnamed.structured.intents[0].who, undefined);
});

test('missing/ambiguous/malformed tail stays visibly preserved rather than becoming verified empty', () => {
  for (const text of ['Notes only', tail().replace('PARTICIPANTS:', 'UNKNOWN:'), tail() + tail(), tail({ TURNS: '- 1: segments 3-0' }),
    tail({ TURNS: '- 1: segments 0-1\n- 1: segments 2-3' }), tail({ 'ACTION ITEMS': 'not a bullet' })]) {
    const parsed = fm.parseStructuredTail(text);
    assert.equal(parsed.malformed, true);
    assert.equal(parsed.bodyWithoutTail, text);
    assert.ok(parsed.errors.length);
  }
});

test('legacy migration parser keeps completed table actions, unowned actions and decisions', () => {
  const parsed = fm.parseLegacyAnalysis('## Key Decisions\n- Ship\n## Action Items\n| S | Owner | Task |\n|---|---|---|\n| ☑ | Ann | Send draft |\n| ☐ | TBD | Verify |\n## Transcript\n- not a task');
  assert.deepEqual(parsed.action_items, [{ assignee: 'Ann', task: 'Send draft', status: 'done' }]);
  assert.equal(parsed.intents[0].what, 'Verify');
  assert.deepEqual(parsed.decisions, [{ text: 'Ship' }]);
});

test('builder uses capture time, measured/estimated/unknown duration and never calendar time as capture', () => {
  const inputs = { base: '2026-10-14-15-57-16-Review', sources: { capture: { started_at: '2026-10-14T15:57:16-07:00' },
    meta: { subject: 'Review', start: '2026-10-14T12:00:00Z', required_attendees: ['Ann'] },
    transcriptJson: { segments: [{ speaker: 'Ann', start: 0, end: 62, text: 'hi' }], speaker_report: { speakers: [{ label: 'Ann', identified: true }] } }, wavDurationMs: 64000 } };
  let result = fm.buildFrontmatter(inputs);
  assert.equal(result.frontmatter.date, inputs.sources.capture.started_at);
  assert.equal(result.frontmatter.duration, '1m 4s');
  assert.equal(result.frontmatter.bedrock.duration_source, 'wav');
  assert.equal(result.frontmatter.captured_at, undefined); assert.equal(result.frontmatter.calendar_event, undefined);
  assert.equal(result.frontmatter.speaker_map[0].source, 'enrollment');
  assert.equal(fm.validateFrontmatter(result.frontmatter).ok, true);
  inputs.sources.wavDurationMs = null;
  result = fm.buildFrontmatter(inputs);
  assert.equal(result.frontmatter.bedrock.duration_source, 'diarizer');
  inputs.sources.transcriptJson.segments = [];
  result = fm.buildFrontmatter(inputs);
  assert.equal(result.frontmatter.duration, 'unknown');
  assert.ok(result.warnings.some(w => /unknown/i.test(w)));
});

test('builder LA historical policy uses date-specific DST and rejects ambiguous stamps', () => {
  const build = base => fm.buildFrontmatter({ base, settings: { tzPolicy: 'assumed-los-angeles' } }).frontmatter;
  assert.equal(build('2026-10-14-15-57-16-Review').date, '2026-10-14T15:57:16-07:00');
  assert.equal(build('2026-01-14-15-57-16-Review').date, '2026-01-14T15:57:16-08:00');
  assert.equal(fm.validateFrontmatter(build('2026-11-01-01-30-00-Review')).ok, false);
  const previous = fm.buildFrontmatter({ base: 'imported', now: 123000 }).frontmatter;
  assert.equal(fm.buildFrontmatter({ base: 'imported', now: 456000, previous }).frontmatter.date, previous.date);
});

test('merge preserves unknown policy fields and matched item extensions without overriding fresh status', () => {
  const previous = valid(); previous.sensitivity = 'restricted'; previous.action_items[0].custom = { evidence: 'original' };
  const next = valid(); next.action_items[0].task = 'New words'; next.bedrock.revision = 2;
  const merged = fm.mergeUnknown(previous, next);
  assert.equal(merged.sensitivity, 'restricted');
  assert.deepEqual(merged.action_items[0].custom, { evidence: 'original' });
  assert.equal(merged.action_items[0].task, 'New words');
  assert.equal(merged.bedrock.revision, 2);
});
