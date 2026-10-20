#!/usr/bin/env node
'use strict';
// Validates Bedrock Panel persona packs: node validate-pack.js <file.persona.json | folder> [...]
// A folder is checked as a pack repository: every *.persona.json in it, plus index.json (if present) against
// the files. Reuses the app's own schema code (app/face/persona.js), so what passes here is what the
// editor's Import accepts, then adds the lint that bites in practice. Dependency-free, read-only.
// Exit code 1 when any ERROR is found (warnings do not fail).

const fs = require('fs');
const path = require('path');

function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'app', 'face', 'persona.js'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
const root = findRepoRoot(__dirname) || findRepoRoot(process.cwd());
if (!root) { console.error('Run this inside the Bedrock Panel repository (app/face/persona.js not found).'); process.exit(2); }
const persona = require(path.join(root, 'app', 'face', 'persona.js'));

let errors = 0, warnings = 0;
const out = (level, where, msg) => { if (level === 'ERROR') errors++; if (level === 'WARN') warnings++; console.log(level.padEnd(5) + ' ' + where + ': ' + msg); };

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const TAG_LINE = new RegExp('^\\s*\\[(' + persona.EMOTIONS.join('|') + ')\\]', 'im');   // only the real tag names; a prose heading like [note] is fine
const VOICE_RE = /^[a-z]{2,3}_[A-Z]{2}-[A-Za-z0-9_]+-(x_low|low|medium|high)$/;
const KNOWN_TOP = ['id', 'name', 'version', 'prompt', 'voice', 'face'];

function lintPersona(file, raw, text) {
  const where = path.basename(file);
  if (Buffer.byteLength(text, 'utf8') > persona.MAX_PACK_BYTES) { out('ERROR', where, 'larger than ' + persona.MAX_PACK_BYTES + ' bytes (the importer refuses it)'); return null; }
  let src;
  try { src = JSON.parse(text); } catch (e) { out('ERROR', where, 'not valid JSON: ' + e.message); return null; }
  const v = persona.validatePersona(src);
  if (!v.ok) { out('ERROR', where, v.error); return null; }
  const p = v.persona;
  if (path.basename(file).toLowerCase() !== p.id + '.persona.json') out('WARN', where, 'file name should be "' + p.id + '.persona.json" (the id is "' + p.id + '")');
  if (src.source !== undefined && src.source !== null) out('ERROR', where, 'remove "source": the app records source and a content hash itself on install; an authored one can expose a private repository URL');
  Object.keys(src).filter(k => k !== 'source' && KNOWN_TOP.indexOf(k) === -1).forEach(k => out('WARN', where, 'unknown top-level field "' + k + '" is ignored'));
  const face = src.face || {};
  if (face.style !== undefined && persona.FACE_STYLES.indexOf(face.style) === -1) out('WARN', where, 'face.style "' + face.style + '" is unknown and becomes "oled" (known: ' + persona.FACE_STYLES.join(', ') + ')');
  ['color', 'cheekColor'].forEach(k => { if (face[k] && !/^#[0-9a-fA-F]{6}$/.test(String(face[k]).trim())) out('WARN', where, 'face.' + k + ' "' + face[k] + '" is not #rrggbb and is dropped'); });
  [['eyeGap', 0, 60], ['dozeAfterSeconds', 0, 86400], ['blinkMinMs', 300, 60000], ['blinkMaxMs', 300, 60000]].forEach(a => {
    if (face[a[0]] !== undefined && (Number(face[a[0]]) < a[1] || Number(face[a[0]]) > a[2])) out('WARN', where, 'face.' + a[0] + ' ' + face[a[0]] + ' is outside ' + a[1] + '..' + a[2] + ' and is clamped');
  });
  if (src.voice && !VOICE_RE.test(src.voice)) out('WARN', where, 'voice "' + src.voice + '" does not look like a Piper voice name (xx_XX-name-quality); a wrong name makes the server refuse and the app falls back to the page default');
  if (src.version !== undefined && src.version !== persona.PERSONA_SCHEMA_VERSION) out('WARN', where, '"version" is the schema version (' + persona.PERSONA_SCHEMA_VERSION + '); the pack version belongs in index.json');

  const prompt = String(src.prompt || '');
  if (!prompt.trim()) out('WARN', where, 'empty prompt: the persona changes the face only');
  if (prompt.length > 6000) out('WARN', where, 'prompt is ' + prompt.length + ' characters; long prompts dilute the character and cost tokens every turn (hard limit ' + 20000 + ')');
  if (TAG_LINE.test(prompt)) out('ERROR', where, 'prompt has a line starting with an emotion tag like "[happy]": the app adds the tag instruction itself; example lines with tags can be spoken aloud when the face is off');
  if (EMOJI.test(prompt)) out('WARN', where, 'prompt contains emoji; replies are spoken aloud, so the prompt should not model them');
  if (!/spoken|speak|aloud|talk/i.test(prompt) && prompt.trim()) out('WARN', where, 'the prompt never says replies are spoken aloud; add "your words are spoken aloud: short, no lists, markdown or emoji"');
  if (!/(one to three|1-3|1 to 3|short)/i.test(prompt) && prompt.trim()) out('WARN', where, 'no length guidance (e.g. "one to three sentences"); spoken replies run long without it');
  if (/never break character|stay in character/i.test(prompt) === false && prompt.trim()) out('WARN', where, 'no "never break character" line; models drift back to a generic assistant');
  if (/\b(api[ _-]?key|password|token|secret)\b/i.test(prompt)) out('WARN', where, 'prompt mentions a key/password/token; a pack must never carry credentials (check it is only prose)');
  return p;
}

function lintIndex(dir, packs) {
  const file = path.join(dir, 'index.json');
  let idx;
  try { idx = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { out('ERROR', 'index.json', 'not valid JSON: ' + e.message); return; }
  const list = Array.isArray(idx) ? idx : idx && idx.personas;
  if (!Array.isArray(list)) { out('ERROR', 'index.json', 'needs { "personas": [ ... ] }'); return; }
  const seen = Object.create(null);   // an id like "constructor" must not look like a duplicate
  list.forEach((e, i) => {
    const where = 'index.json[' + i + ']';
    if (!e || typeof e.id !== 'string') { out('ERROR', where, 'entry without an id'); return; }
    if (seen[e.id]) out('ERROR', where, 'duplicate id "' + e.id + '"');
    seen[e.id] = true;
    const file2 = e.file || e.id + '.persona.json';
    if (!/^[a-z0-9][a-z0-9_-]{0,63}\.persona\.json$/.test(file2)) out('ERROR', where, 'file "' + file2 + '" must be a bare lowercase file name ending .persona.json');
    else if (!fs.existsSync(path.join(dir, file2))) out('ERROR', where, 'file "' + file2 + '" does not exist');
    else if (packs[file2] && packs[file2].id !== e.id) out('ERROR', where, 'id "' + e.id + '" does not match the id inside ' + file2 + ' ("' + packs[file2].id + '")');
    if (typeof e.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(e.version)) out('WARN', where, 'version should be dotted digits like "1.0.0" (it is how updates are detected); missing means 0.0.0');
    if (!e.name) out('WARN', where, 'no name: the id is shown instead');
    if (!e.description) out('WARN', where, 'no description: the catalog row will be empty');
  });
  Object.keys(packs).forEach(f => { if (packs[f] && !list.some(e => (e.file || e.id + '.persona.json') === f)) out('WARN', 'index.json', f + ' is not listed in the catalog, so it cannot be installed from this repository'); });
}

const args = process.argv.slice(2);
if (!args.length) { console.log('usage: node validate-pack.js <file.persona.json | pack folder> [...]'); process.exit(2); }
args.forEach(a => {
  if (!fs.existsSync(a)) { out('ERROR', a, 'not found'); return; }
  if (fs.statSync(a).isDirectory()) {
    const files = fs.readdirSync(a).filter(f => /\.persona\.json$/i.test(f)).sort();
    const packs = {};
    files.forEach(f => { packs[f] = lintPersona(path.join(a, f), null, fs.readFileSync(path.join(a, f), 'utf8')); });
    if (fs.existsSync(path.join(a, 'index.json'))) lintIndex(a, packs);
    else out('WARN', a, 'no index.json: files can be imported one by one but not browsed/installed as a repository');
    console.log(files.length + ' persona file' + (files.length === 1 ? '' : 's') + ' in ' + a);
  } else lintPersona(a, null, fs.readFileSync(a, 'utf8'));
});
console.log(errors + ' error' + (errors === 1 ? '' : 's') + ', ' + warnings + ' warning' + (warnings === 1 ? '' : 's'));
process.exit(errors ? 1 : 0);
