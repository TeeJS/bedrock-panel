'use strict';
// Personas are data: seeded once with Rocky, normalized and clamped so the renderer can trust the
// numbers, never carrying credentials, and never a default (a page with no pick has no persona).

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensurePersonas, resolvePersona, normalizePersona, validatePersona, personaForPage, KAWAII_PERSONA, EMOTIONS } = require('../app/face/persona');

// Only characters that are nobody's property ship in the app; third-party characters are packs.
const BUILTIN_IDS = ['kawaii', 'jarvis', 'crt', 'intern', 'sprite'];

test('ensurePersonas seeds the built-ins once and never touches an existing list', () => {
  const c = {};
  ensurePersonas(c);
  assert.deepEqual(c.settings.personas.map(p => p.id), BUILTIN_IDS);
  assert.deepEqual(c.settings.personas.map(p => p.face.style), ['kawaii', 'oled', 'crt', 'kawaii', 'sprite']);
  assert.deepEqual(c.settings.personasSeeded, BUILTIN_IDS);
  c.settings.personas[0].name = 'Mimi (mine)';
  c.settings.personas.push({ id: 'dot', name: 'Dot', prompt: '' });
  ensurePersonas(c);
  assert.equal(c.settings.personas[0].name, 'Mimi (mine)');
  assert.equal(c.settings.personas.length, BUILTIN_IDS.length + 1);
});

test('a library from the first release gains the newer built-ins once; a deleted one stays deleted', () => {
  // The first release seeded rocky/norm/kawaii; this user kept an imported rocky and deleted norm.
  // Later built-ins are appended once; nothing deleted is resurrected and nothing is removed.
  const c = { settings: { personas: [{ id: 'rocky', name: 'Rocky' }, { id: 'kawaii', name: 'Mimi' }] } };
  ensurePersonas(c);
  assert.deepEqual(c.settings.personas.map(p => p.id), ['rocky', 'kawaii', 'jarvis', 'crt', 'intern', 'sprite']);
  c.settings.personas = c.settings.personas.filter(p => p.id !== 'crt');
  ensurePersonas(c);
  assert.equal(c.settings.personas.some(p => p.id === 'crt'), false);
});

test('no built-in persona is a third-party character', () => {
  const { BUILTIN_PERSONAS } = require('../app/face/persona');
  BUILTIN_PERSONAS.forEach(p => {
    assert.doesNotMatch(p.name + ' ' + p.prompt, /Rocky|Eridian|Hail Mary|Norm\b|Doofenshmirtz|Phineas/i, p.id);
  });
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
  const settings = { personas: [KAWAII_PERSONA] };
  assert.equal(resolvePersona(settings, ''), null);
  assert.equal(resolvePersona(settings, 'nope'), null);
  assert.equal(resolvePersona(settings, 'kawaii').name, 'Mimi');
  assert.equal(resolvePersona(undefined, 'kawaii'), null);
});

test('normalizePersona fills every emotion preset and clamps out-of-range numbers', () => {
  const p = normalizePersona({ id: 'Dot', face: { eyeGap: 999, dozeAfterSeconds: -5, emotions: { happy: { eyeW: 1000 } } } });
  assert.equal(p.id, 'dot');
  assert.equal(p.name, 'dot');
  EMOTIONS.forEach(e => assert.ok(p.face.emotions[e], e));
  assert.equal(p.face.eyeGap, 60);
  assert.equal(p.face.dozeAfterSeconds, 0);
  assert.equal(p.face.emotions.happy.eyeW, 60);
  assert.equal(p.face.emotions.happy.lowerLid, 16);   // the rest of the preset comes from the OLED happy default
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
  const v = personaForPage(normalizePersona(KAWAII_PERSONA));
  assert.equal(v.id, 'kawaii');
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
  assert.match(KAWAII_PERSONA.prompt, /Mimi/);
});
