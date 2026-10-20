'use strict';
// Persona repositories reuse the drop-in app repository model: GitHub folder URLs, an index.json
// catalog, versions compared the same way, and a `source` on each installed persona for updates.

const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../app/face/persona-repo');
const { normalizePersona } = require('../app/face/persona');

test('every app repository doubles as a persona source through its personas folder', () => {
  assert.equal(repo.personaSourceFromAppRepo('https://github.com/TeeJS/bedrock-panel/tree/main/community-apps/'), 'https://github.com/TeeJS/bedrock-panel/tree/main/community-apps/personas');
  assert.equal(repo.personaSourceFromAppRepo('https://raw.githubusercontent.com/TeeJS/x/main/apps'), 'https://raw.githubusercontent.com/TeeJS/x/main/apps/personas');
  assert.equal(repo.personaSourceFromAppRepo('https://evil.example/apps'), '');   // GitHub only, like apps
  assert.equal(repo.personaSourceFromAppRepo(''), '');
});

test('sources: explicit persona repos first, then app repos, deduplicated', () => {
  const s = { personaRepos: ['https://github.com/TeeJS/bedrock-personas/tree/main', 'https://nope.example/p'], appRepos: ['https://github.com/TeeJS/bedrock-panel/tree/main/community-apps', 'https://github.com/TeeJS/bedrock-panel/tree/main/community-apps/'] };
  assert.deepEqual(repo.personaSources(s), [
    'https://github.com/TeeJS/bedrock-personas/tree/main',
    'https://github.com/TeeJS/bedrock-panel/tree/main/community-apps/personas',
  ]);
  assert.deepEqual(repo.personaSources({ appRepo: 'https://github.com/TeeJS/open-quake/tree/main/community-apps' }), ['https://github.com/TeeJS/bedrock-panel/tree/main/community-apps/personas']);   // renamed repo mapped like apps
  assert.deepEqual(repo.personaSources({}), []);
});

test('parsePersonaIndex accepts { personas } or an array, defaults the file name, refuses paths and URLs', () => {
  const e = repo.parsePersonaIndex({ personas: [
    { id: 'Rocky', name: 'Rocky', version: '1.1', description: 'd' },
    { id: 'norm' },
    { id: 'bad/one' }, { id: 'x', file: '../up.persona.json' }, { id: 'y', file: 'https://x/y.persona.json' }, { id: 'z', file: 'z.json' }, { name: 'no id' },
  ] });
  assert.deepEqual(e, [
    { id: 'rocky', name: 'Rocky', description: 'd', version: '1.1', file: 'rocky.persona.json' },
    { id: 'norm', name: 'norm', description: '', version: '0.0.0', file: 'norm.persona.json' },
  ]);
  assert.equal(repo.parsePersonaIndex([{ id: 'a' }]).length, 1);
  assert.deepEqual(repo.parsePersonaIndex(null), []);
});

test('personaFileUrl resolves against the raw base', () => {
  assert.equal(repo.personaFileUrl('https://github.com/TeeJS/bedrock-personas/tree/main', { file: 'rocky.persona.json' }), 'https://raw.githubusercontent.com/TeeJS/bedrock-personas/main/rocky.persona.json');
});

test('annotate: available / installed / update / edited', () => {
  const src = 'https://github.com/TeeJS/bedrock-personas/tree/main';
  const library = [
    { id: 'rocky', source: { url: src, version: '1.0' } },
    { id: 'norm', source: { url: src, version: '2.0' } },
    { id: 'mine' },
    { id: 'other', source: { url: 'https://github.com/x/y/tree/main', version: '1.0' } },
  ];
  const entries = repo.parsePersonaIndex([{ id: 'rocky', version: '1.1' }, { id: 'norm', version: '2.0' }, { id: 'mine', version: '1.0' }, { id: 'other', version: '9' }, { id: 'fresh', version: '1' }]);
  assert.deepEqual(repo.annotate(entries, library, src).map(e => e.id + ':' + e.state), ['rocky:update', 'norm:installed', 'mine:edited', 'other:edited', 'fresh:available']);
  assert.equal(repo.annotate(entries, library, src)[0].installedVersion, '1.0');
});

test('a persona keeps its source through normalization, and bad sources are dropped', () => {
  const p = normalizePersona({ id: 'a', source: { url: 'https://github.com/TeeJS/bedrock-personas/tree/main', version: '1.2' } });
  assert.deepEqual(p.source, { url: 'https://github.com/TeeJS/bedrock-personas/tree/main', version: '1.2' });
  assert.equal(normalizePersona({ id: 'b' }).source, null);
  assert.equal(normalizePersona({ id: 'c', source: { url: 'ftp://x' } }).source, null);
  assert.equal(normalizePersona({ id: 'd', source: 'junk' }).source, null);
});
