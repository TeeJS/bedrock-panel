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

test('annotate: available / installed / update / edited (a missing hash counts as edited)', () => {
  const src = 'https://github.com/TeeJS/bedrock-personas/tree/main';
  const fromSrc = (id, version) => { const p = normalizePersona({ id }); p.source = { url: src, version, hash: repo.contentHash(p) }; return p; };
  const library = [
    fromSrc('rocky', '1.0'),
    fromSrc('norm', '2.0'),
    { id: 'mine' },
    { id: 'other', source: { url: 'https://github.com/x/y/tree/main', version: '1.0' } },
    { id: 'legacy', source: { url: src, version: '1.0' } },   // installed before hashes existed: never silently replaced
  ];
  const entries = repo.parsePersonaIndex([{ id: 'rocky', version: '1.1' }, { id: 'norm', version: '2.0' }, { id: 'mine', version: '1.0' }, { id: 'other', version: '9' }, { id: 'legacy', version: '2.0' }, { id: 'fresh', version: '1' }]);
  assert.deepEqual(repo.annotate(entries, library, src).map(e => e.id + ':' + e.state), ['rocky:update', 'norm:installed', 'mine:edited', 'other:edited', 'legacy:edited', 'fresh:available']);
  assert.equal(repo.annotate(entries, library, src)[0].installedVersion, '1.0');
});

test('catalog file names are bare: percent escapes, query/fragment characters and odd extensions are refused', () => {
  const e = repo.parsePersonaIndex([
    { id: 'a', file: '%2e%2e%2fsecret.persona.json' }, { id: 'b', file: 'x?ref=other.persona.json' }, { id: 'c', file: 'x#hidden.persona.json' },
    { id: 'd', file: 'D.Persona.JSON' }, { id: 'e', file: 'ok-1.persona.json' }, { id: 'f', version: '1.2.3.4' }, { id: 'g', version: 'v2' },
  ]);
  assert.deepEqual(e.map(x => x.id + ':' + x.file + ':' + x.version), ['d:D.Persona.JSON:0.0.0', 'e:ok-1.persona.json:0.0.0', 'f:f.persona.json:1.2.3.4', 'g:g.persona.json:0.0.0']);
  assert.equal(repo.personaFileUrl('https://github.com/o/r/tree/main', { file: 'a b.persona.json' }), 'https://raw.githubusercontent.com/o/r/main/a%20b.persona.json');
});

test('annotate is not fooled by prototype property names', () => {
  const e = repo.parsePersonaIndex([{ id: 'constructor' }, { id: 'tostring' }, { id: '__proto__' }]);
  assert.deepEqual(e.map(x => x.id), ['constructor', 'tostring']);   // __proto__ fails the id alphabet (leading underscore)
  assert.deepEqual(repo.annotate(e, [], 'https://github.com/o/r/tree/main').map(x => x.state), ['available', 'available']);
  const ctor = normalizePersona({ id: 'constructor' });
  ctor.source = { url: 'https://github.com/o/r/tree/main', version: '0.0.0', hash: repo.contentHash(ctor) };
  assert.deepEqual(repo.annotate(e, [ctor], 'https://github.com/o/r/tree/main').map(x => x.state), ['installed', 'available']);
});

test('a persona edited after being installed from a source counts as edited, an untouched one as installed/update', () => {
  const src = 'https://github.com/o/r/tree/main';
  const installed = normalizePersona({ id: 'p', name: 'P', prompt: 'Be brief.' });
  installed.source = { url: src, version: '1.0', hash: repo.contentHash(installed) };
  const edited = Object.assign({}, installed, { prompt: 'Be very brief.' });
  const entries = repo.parsePersonaIndex([{ id: 'p', version: '1.1' }]);
  assert.equal(repo.annotate(entries, [installed], src)[0].state, 'update');
  assert.equal(repo.annotate(entries, [edited], src)[0].state, 'edited');
  assert.equal(repo.annotate(repo.parsePersonaIndex([{ id: 'p', version: '1.0' }]), [installed], src)[0].state, 'installed');
  assert.equal(repo.contentHash(installed), repo.contentHash(Object.assign({}, installed, { source: null })), 'the hash ignores source');
  assert.equal(repo.contentHash(null), '');
});

test('a persona keeps its source through normalization, and bad sources are dropped', () => {
  const p = normalizePersona({ id: 'a', source: { url: 'https://github.com/TeeJS/bedrock-personas/tree/main', version: '1.2' } });
  assert.deepEqual(p.source, { url: 'https://github.com/TeeJS/bedrock-personas/tree/main', version: '1.2' });
  const h = 'a'.repeat(64);
  assert.equal(normalizePersona({ id: 'a', source: { url: 'https://github.com/o/r/tree/main', version: '1', hash: h } }).source.hash, h);
  assert.equal(normalizePersona({ id: 'a', source: { url: 'https://github.com/o/r/tree/main', version: '1', hash: 'nope' } }).source.hash, undefined);
  assert.equal(normalizePersona({ id: 'b' }).source, null);
  assert.equal(normalizePersona({ id: 'c', source: { url: 'ftp://x' } }).source, null);
  assert.equal(normalizePersona({ id: 'd', source: 'junk' }).source, null);
});
