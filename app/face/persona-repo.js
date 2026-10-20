'use strict';
// Persona repositories: the same model as drop-in app repositories (app/appRepo.js). A source is a
// GitHub folder URL that serves an index.json catalog and the <id>.persona.json files beside it.
// Every app repository doubles as a persona source through its `personas/` subfolder, and persona-
// only repositories can be listed separately. Pure: URL derivation, catalog parsing, install-state
// annotation; the network and the GitHub token live in main.js.

const appRepo = require('../appRepo');

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
// usable id are dropped; `file` defaults to <id>.persona.json and must be a bare file name inside
// the source folder (no paths, no URLs: a private repo is read file-by-file through the Contents API).
function parsePersonaIndex(json) {
  const arr = json && Array.isArray(json.personas) ? json.personas : (Array.isArray(json) ? json : []);
  const out = [];
  arr.forEach(p => {
    if (!p || typeof p.id !== 'string') return;
    const id = p.id.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return;
    let file = typeof p.file === 'string' ? p.file.trim() : '';
    if (!file) file = id + '.persona.json';
    if (/[\\/]/.test(file) || /^https?:/i.test(file) || !/\.persona\.json$/i.test(file)) return;
    out.push({
      id,
      name: (typeof p.name === 'string' && p.name.trim()) || id,
      description: typeof p.description === 'string' ? p.description : '',
      version: typeof p.version === 'string' && p.version.trim() ? p.version.trim() : '0.0.0',
      file,
    });
  });
  return out;
}

function personaFileUrl(base, entry) {
  return appRepo.repoRawBase(base) + '/' + String(entry.file).replace(/^\/+/, '');
}

// Annotate catalog entries against the library: 'available' (not in the library), 'installed'
// (in the library at this version or newer, or added by hand), 'update' (installed from a source and
// the catalog is newer), 'edited' (in the library but not from this source: installing would replace
// something the user may have written). The caller decides what to ask before an 'edited' install.
function annotate(entries, library, sourceUrl) {
  const byId = {};
  (Array.isArray(library) ? library : []).forEach(p => { if (p && p.id) byId[p.id] = p; });
  return entries.map(e => {
    const have = byId[e.id];
    let state = 'available';
    if (have) {
      const src = have.source && have.source.url ? have.source : null;
      if (src && src.url === sourceUrl) state = appRepo.cmpVersion(e.version, src.version || '0.0.0') > 0 ? 'update' : 'installed';
      else state = 'edited';
    }
    return Object.assign({}, e, { state, installedVersion: have && have.source ? (have.source.version || null) : null, source: sourceUrl });
  });
}

module.exports = { personaSourceFromAppRepo, personaSources, parsePersonaIndex, personaFileUrl, annotate };
