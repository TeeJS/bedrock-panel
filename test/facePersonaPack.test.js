'use strict';
// A persona pack is a plain JSON file: the shipped template must validate, a pack must survive an
// export/import round trip unchanged, and bad packs must be refused with a reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validatePersona, normalizePersona, ensurePersonas } = require('../app/face/persona');

const TEMPLATE = path.join(__dirname, '..', 'docs', 'personas', 'template.persona.json');
const tagLine = /^\s*\[[a-z]+\]/m;

test('the shipped template validates and keeps its fields', () => {
  const src = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const r = validatePersona(src);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.persona.id, 'my-persona');
  assert.equal(r.persona.face.style, 'kawaii');
  assert.equal(r.persona.face.emotions.happy.eyeW, 36);
  assert.doesNotMatch(r.persona.prompt, tagLine);
});

test('export then import is identical after normalize', () => {
  const first = validatePersona(JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'))).persona;
  const exported = JSON.stringify(first, null, 2);
  const second = validatePersona(JSON.parse(exported));
  assert.equal(second.ok, true);
  assert.deepEqual(second.persona, first);
});

// The seeded entries are raw copies until something normalizes them (Rocky has no blink fields yet),
// so export must write normalizePersona(p), not the stored object.
test('every built-in persona round-trips through export and import', () => {
  ensurePersonas({}).settings.personas.forEach(p => {
    const exported = normalizePersona(p);
    const again = validatePersona(JSON.parse(JSON.stringify(exported)));
    assert.equal(again.ok, true, p.id);
    assert.deepEqual(again.persona, exported);
  });
});

test('no shipped persona prompt contains a tagged example line', () => {
  ensurePersonas({}).settings.personas.forEach(p => assert.doesNotMatch(p.prompt, tagLine, p.id));
});

test('a pack with a credential-looking key is refused with a reason', () => {
  const src = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  src.face.api_key = 'sk-123';
  const r = validatePersona(src);
  assert.equal(r.ok, false);
  assert.match(r.error, /credential/);
});

test('a pack without a usable id is refused', () => {
  assert.equal(validatePersona({ name: 'No id' }).ok, false);
  assert.equal(validatePersona({ id: '../evil' }).ok, false);
  assert.equal(validatePersona([]).ok, false);
});

test('unknown fields and an unknown style do not break an import', () => {
  const r = validatePersona({ id: 'odd', hook: 'x', face: { style: 'hologram', extra: 1 } });
  assert.equal(r.ok, true);
  assert.equal(r.persona.face.style, 'oled');
  assert.equal(r.persona.hook, undefined);
});

// ---- the pack API agreed in the room: persona.js exports importPersonaText, exportPersonaJson and
// personaFileName. These fail until those land.
const persona = require('../app/face/persona');

test('exportPersonaJson writes the normalized shape and importPersonaText reads it back identically', () => {
  const p = ensurePersonas({}).settings.personas[0];
  const text = persona.exportPersonaJson(p);
  assert.equal(typeof text, 'string');
  const r = persona.importPersonaText(text);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.persona, normalizePersona(p));
});

test('personaFileName is <id>.persona.json', () => {
  assert.equal(persona.personaFileName({ id: 'rocky' }), 'rocky.persona.json');
});

test('importPersonaText refuses malformed JSON, credentials and oversize text with a reason', () => {
  const bad = persona.importPersonaText('{not json');
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
  const cred = persona.importPersonaText(JSON.stringify({ id: 'x', token: 'abc' }));
  assert.equal(cred.ok, false);
  assert.match(cred.error, /credential/);
  const big = persona.importPersonaText(JSON.stringify({ id: 'x', prompt: 'a'.repeat(70 * 1024) }));
  assert.equal(big.ok, false);
});

// ---- drop-in folder: <userData>/personas/*.persona.json
const os = require('node:os');

test('scanPersonaDir returns valid packs and reports bad ones without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personas-'));
  try {
    fs.writeFileSync(path.join(dir, 'good.persona.json'), JSON.stringify({ id: 'good', name: 'Good', prompt: 'Be brief.' }));
    fs.writeFileSync(path.join(dir, 'broken.persona.json'), '{nope');
    fs.writeFileSync(path.join(dir, 'secret.persona.json'), JSON.stringify({ id: 's', apiKey: 'k' }));
    fs.writeFileSync(path.join(dir, 'huge.persona.json'), JSON.stringify({ id: 'huge', prompt: 'a'.repeat(70 * 1024) }));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const r = persona.scanPersonaDir(dir);
    assert.deepEqual(r.personas.map(p => p.id), ['good']);
    assert.deepEqual(r.errors.map(e => e.file).sort(), ['broken.persona.json', 'huge.persona.json', 'secret.persona.json']);
    r.errors.forEach(e => assert.ok(e.error));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanPersonaDir on a missing folder is empty, not an error', () => {
  const r = persona.scanPersonaDir(path.join(os.tmpdir(), 'personas-does-not-exist-' + Date.now()));
  assert.deepEqual(r.personas, []);
  assert.deepEqual(r.errors, []);
});

test('mergePersonas adds new ids and never overwrites an existing (possibly edited) one', () => {
  const c = ensurePersonas({});
  c.settings.personas[0].name = 'Rocky (mine)';
  const added = persona.mergePersonas(c, [
    { id: 'kawaii', name: 'Imposter', prompt: 'x', face: {} },
    normalizePersona({ id: 'fresh', name: 'Fresh', prompt: 'Be brief.' }),
  ]);
  assert.equal(added, 1);
  assert.equal(c.settings.personas.find(p => p.id === 'kawaii').name, 'Rocky (mine)');
  assert.ok(c.settings.personas.find(p => p.id === 'fresh'));
});
