'use strict';
/*
 * verify-update-manifests.js — check every dist/latest*.yml against the files it describes. [build tooling, MIT]
 *
 * The app updater downloads what these manifests name and refuses a file whose sha512 or size differs,
 * so a stale manifest ships an update nobody can install. Run after a build, before uploading:
 *
 *   node tools/verify-update-manifests.js [distDir]
 *
 * Exit 0 when every entry (and the top-level path/sha512) matches its real file; 1 otherwise.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

function sha512(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

// Returns a list of problems (empty = all good) for one manifest.
function checkManifest(ymlPath) {
  const dir = path.dirname(ymlPath);
  const doc = yaml.load(fs.readFileSync(ymlPath, 'utf8')) || {};
  const problems = [];
  const files = Array.isArray(doc.files) ? doc.files : [];
  if (!files.length) problems.push('no files listed');
  const seen = new Map();
  for (const f of files) {
    const file = path.join(dir, String(f.url || ''));
    if (!f.url || !fs.existsSync(file)) { problems.push((f.url || '(no url)') + ': file missing'); continue; }
    const size = fs.statSync(file).size;
    const hash = sha512(file);
    seen.set(f.url, hash);
    if (Number(f.size) !== size) problems.push(f.url + ': size ' + f.size + ' in the manifest, ' + size + ' on disk');
    if (f.sha512 !== hash) problems.push(f.url + ': sha512 does not match the file');
  }
  if (doc.path) {
    const hash = seen.get(doc.path);
    if (!hash) problems.push('top-level path ' + doc.path + ' is not one of the listed files');
    else if (doc.sha512 !== hash) problems.push('top-level sha512 does not match ' + doc.path);
  }
  return { version: doc.version, files: files.map(f => f.url), problems };
}

if (require.main === module) {
  const dist = path.resolve(process.argv[2] || 'dist');
  const ymls = fs.existsSync(dist) ? fs.readdirSync(dist).filter(n => /^latest.*\.yml$/.test(n)) : [];
  if (!ymls.length) { console.error('no latest*.yml in ' + dist); process.exit(1); }
  let bad = 0;
  for (const n of ymls) {
    const r = checkManifest(path.join(dist, n));
    if (r.problems.length) { bad++; console.error('FAIL ' + n + ' (' + r.version + '): ' + r.problems.join('; ')); }
    else console.log('ok   ' + n + ' (' + r.version + '): ' + r.files.join(', '));
  }
  process.exit(bad ? 1 : 0);
}

module.exports = { checkManifest };
