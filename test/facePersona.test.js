'use strict';
// Personas are data: seeded once with Rocky, normalized and clamped so the renderer can trust the
// numbers, never carrying credentials, and never a default (a page with no pick has no persona).

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensurePersonas, resolvePersona, normalizePersona, validatePersona, personaForPage, ROCKY_PERSONA, EMOTIONS } = require('../app/face/persona');

const BUILTIN_IDS = ['rocky', 'norm', 'kawaii', 'jarvis', 'crt', 'intern', 'sprite'];

test('ensurePersonas seeds the built-ins once and never touches an existing list', () => {
  const c = {};
  ensurePersonas(c);
  assert.deepEqual(c.settings.personas.map(p => p.id), BUILTIN_IDS);
  assert.deepEqual(c.settings.personas.slice(0, 3).map(p => p.face.style), ['oled', 'cartoon', 'kawaii']);
  assert.deepEqual(c.settings.personasSeeded, BUILTIN_IDS);
  c.settings.personas[0].name = 'Rocky (mine)';
  c.settings.personas.push({ id: 'dot', name: 'Dot', prompt: '' });
  ensurePersonas(c);
  assert.equal(c.settings.personas[0].name, 'Rocky (mine)');
  assert.equal(c.settings.personas.length, BUILTIN_IDS.length + 1);
});

test('a library from the first release gains the newer built-ins once; a deleted one stays deleted', () => {
  // Shipped with three; the user deleted Norm. Later built-ins are appended, Norm is not resurrected.
  const c = { settings: { personas: [{ id: 'rocky', name: 'Rocky' }, { id: 'kawaii', name: 'Mimi' }] } };
  ensurePersonas(c);
  assert.deepEqual(c.settings.personas.map(p => p.id), ['rocky', 'kawaii', 'jarvis', 'crt', 'intern', 'sprite']);
  c.settings.personas = c.settings.personas.filter(p => p.id !== 'crt');
  ensurePersonas(c);
  assert.equal(c.settings.personas.some(p => p.id === 'crt'), false);
});

test('ensurePersonas drops unusable entries and duplicate ids instead of keeping junk', () => {
  const c = { settings: { personas: [null, { name: 'no id' }, { id: 'ok', name: 'Ok' }, { id: 'OK', name: 'dupe' }], personasSeeded: BUILTIN_IDS } };
  ensurePersonas(c);
  assert.deepEqual(c.settings.personas.map(p => p.id), ['ok']);
  assert.equal(c.settings.personas[0].name, 'Ok');
});

test('normalizePersona keeps style, cheekColor and the phase-2 voice field, and reconciles blink bounds', () => {
  const p = normalizePersona({ id: 'x', voice: 'en_US-amy', face: { style: 'cartoon', cheekColor: '#ABCDEF', color: 'red', blinkMinMs: 9000, blinkMaxMs: 500 } });
  assert.equal(p.face.style, 'cartoon');
  assert.equal(p.face.cheekColor, '#ABCDEF');
  assert.equal(p.face.color, '');          // not a hex: dropped, renderer uses the accent
  assert.equal(p.voice, 'en_US-amy');
  assert.equal(p.face.blinkMinMs, 500);
  assert.equal(p.face.blinkMaxMs, 9000);
  assert.equal(normalizePersona({ id: 'y', face: { style: 'metal' } }).face.style, 'oled');
});

test('resolvePersona: blank or unknown id is no persona, not the first entry', () => {
  const settings = { personas: [ROCKY_PERSONA] };
  assert.equal(resolvePersona(settings, ''), null);
  assert.equal(resolvePersona(settings, 'nope'), null);
  assert.equal(resolvePersona(settings, 'rocky').name, 'Rocky');
  assert.equal(resolvePersona(undefined, 'rocky'), null);
});

test('normalizePersona fills every emotion preset and clamps out-of-range numbers', () => {
  const p = normalizePersona({ id: 'Dot', face: { eyeGap: 999, dozeAfterSeconds: -5, emotions: { happy: { eyeW: 1000 } } } });
  assert.equal(p.id, 'dot');
  assert.equal(p.name, 'dot');
  EMOTIONS.forEach(e => assert.ok(p.face.emotions[e], e));
  assert.equal(p.face.eyeGap, 60);
  assert.equal(p.face.dozeAfterSeconds, 0);
  assert.equal(p.face.emotions.happy.eyeW, 60);
  assert.equal(p.face.emotions.happy.lowerLid, 16);   // the rest of the preset comes from Rocky's happy
  assert.equal(p.face.color, '');
});

test('normalizePersona rejects a bad id and a non-object', () => {
  assert.equal(normalizePersona({ id: 'has space' }), null);
  assert.equal(normalizePersona('rocky'), null);
  assert.equal(normalizePersona(null), null);
});

test('validatePersona refuses credentials anywhere in the pack, by substring and at any depth', () => {
  ['apiKey', 'api_key', 'access_token', 'client_secret', 'authToken', 'privateKey', 'bearer', 'password'].forEach(k => {
    const o = { id: 'x' }; o[k] = 'v';
    assert.equal(validatePersona(o).ok, false, k);
  });
  assert.equal(validatePersona({ id: 'x', face: { token: 'abc' } }).ok, false);
  assert.match(validatePersona({ id: 'x', face: { token: 'abc' } }).error, /credentials/);
  let deep = { id: 'x' }; let cur = deep;
  for (let i = 0; i < 9; i++) { cur.n = {}; cur = cur.n; }
  cur.apiKey = 'hidden';
  assert.equal(validatePersona(deep).ok, false);   // too deep is refused, not ignored
  assert.equal(validatePersona({ id: 'x', name: 'X' }).ok, true);
});

test('personaForPage carries the face and name, never the prompt', () => {
  const v = personaForPage(normalizePersona(ROCKY_PERSONA));
  assert.equal(v.id, 'rocky');
  assert.ok(v.face.emotions.neutral);
  assert.equal(v.prompt, undefined);
  assert.equal(personaForPage(null), null);
});

test('built-in prompts are spoken-first, carry no body abilities and no tagged examples', () => {
  const { BUILTIN_PERSONAS } = require('../app/face/persona');
  assert.equal(BUILTIN_PERSONAS.length, BUILTIN_IDS.length);
  BUILTIN_PERSONAS.forEach(p => {
    assert.doesNotMatch(p.prompt, /track_face|`look`|camera/, p.id);
    assert.doesNotMatch(p.prompt, /MUST start with/, p.id);        // the emotion instruction is the host's, added only when the face is on
    assert.doesNotMatch(p.prompt, /^\[[a-z]+\]/m, p.id);            // a tagged example would leak when the face is off
    assert.match(p.prompt, /Never break character/, p.id);
  });
  assert.match(ROCKY_PERSONA.prompt, /Rocky/);
});
