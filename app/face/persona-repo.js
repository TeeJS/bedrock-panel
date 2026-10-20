'use strict';
// Persona repositories: the same model as drop-in app repositories (app/appRepo.js). A source is a
// GitHub folder URL that serves an index.json catalog and the <id>.persona.json files beside it.
// Every app repository doubles as a persona source through its `personas/` subfolder, and persona-
// only repositories can be listed separately. Pure: URL derivation, catalog parsing, install-state
// annotation, content hashing; the network and the GitHub token live in main.js.

const crypto = require('crypto');
const appRepo = require('../appRepo');
const { normalizePersona } = require('./persona');

// Catalog file names are bare: one path segment, the persona id's alphabet, ending in
// .persona.json. Anything else (slashes, percent escapes, query/fragment characters, URLs) is
// refused so a catalog cannot point the Contents API or the raw host anywhere else.
const FILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}\.persona\.json$/i;

// `<app repo folder>` -> `<app repo folder>/personas` (a github.com tree URL or a raw base). '' for junk.
function personaSourceFromAppRepo(appRepoUrl) {
  const u = appRepo.canonicalRepoUrl(String(appRepoUrl || '').trim()).replace(/\/+$/, '');
  if (!u || !appRepo.isAllowedRepoUrl(u)) return '';
  return u + '/personas';
}

// The full ordered list of sources: explicit persona repos first, then each app repo's personas
// folder; duplicates dropped, order kept.
function personaSources(settings) {
  const s = settings || {};
  const explicit = Array.isArray(s.personaRepos) ? s.personaRepos : [];
  const appRepos = (Array.isArray(s.appRepos) && s.appRepos.length) ? s.appRepos : (s.appRepo ? [s.appRepo] : []);
  const out = [];
  explicit.map(u => appRepo.canonicalRepoUrl(String(u || '').trim()).replace(/\/+$/, '')).filter(u => u && appRepo.isAllowedRepoUrl(u)).forEach(u => { if (out.indexOf(u) === -1) out.push(u); });
  appRepos.map(personaSourceFromAppRepo).filter(Boolean).forEach(u => { if (out.indexOf(u) === -1) out.push(u); });
  return out;
}

// Normalize a catalog ({ personas: [...] } or a bare array) into clean entries. Entries without a
// usable id or an acceptable file name are dropped; `file` defaults to <id>.persona.json.
function parsePersonaIndex(json) {
  const arr = json && Array.isArray(json.personas) ? json.personas : (Array.isArray(json) ? json : []);
  const out = [];
  arr.forEach(p => {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string') return;
    const id = p.id.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return;
    let file = typeof p.file === 'string' ? p.file.trim() : '';
    if (!file) file = id + '.persona.json';
    if (!FILE_RE.test(file)) return;
    out.push({
      id,
      name: (typeof p.name === 'string' && p.name.trim()) || id,
      description: typeof p.description === 'string' ? p.description.slice(0, 500) : '',
      version: typeof p.version === 'string' && /^[0-9][0-9.]{0,31}$/.test(p.version.trim()) ? p.version.trim() : '0.0.0',
      file,
    });
  });
  return out;
}

function personaFileUrl(base, entry) {
  return appRepo.repoRawBase(base) + '/' + encodeURIComponent(String(entry.file));
}

// A stable fingerprint of a persona's content (everything but `source`), so a locally edited
// install can be told from an untouched one before an update replaces it.
function contentHash(persona) {
  const n = normalizePersona(persona);
  if (!n) return '';
  const copy = Object.assign({}, n, { source: null });
  return crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

// Annotate catalog entries against the library: 'available' (not in the library), 'installed'
// (from this source, unchanged, at this version or newer), 'update' (from this source, unchanged,
// catalog is newer), 'edited' (in the library but hand-made, from another source, or changed since
// it was installed: installing replaces something the user may have written, so the caller asks).
function annotate(entries, library, sourceUrl) {
  const byId = Object.create(null);   // ids like "constructor" must not find Object.prototype
  (Array.isArray(library) ? library : []).forEach(p => { if (p && typeof p.id === 'string') byId[p.id] = p; });
  return entries.map(e => {
    const have = byId[e.id];
    let state = 'available';
    if (have) {
      const src = have.source && have.source.url ? have.source : null;
      // No recorded hash (installed before hashes existed) counts as edited: the user is asked once.
      const untouched = !!src && src.url === sourceUrl && !!src.hash && src.hash === contentHash(have);
      if (untouched) state = appRepo.cmpVersion(e.version, src.version || '0.0.0') > 0 ? 'update' : 'installed';
      else state = 'edited';
    }
    return Object.assign({}, e, { state, installedVersion: have && have.source ? (have.source.version || null) : null, source: sourceUrl });
  });
}

module.exports = { FILE_RE, personaSourceFromAppRepo, personaSources, parsePersonaIndex, personaFileUrl, contentHash, annotate };
