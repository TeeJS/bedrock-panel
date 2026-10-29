'use strict';
/*
 * meetingRecord.js — where a meeting's record lives, for both note styles (Settings → Meeting →
 * Advanced settings → Note style):
 *
 *   - Minutes Compatible: <base>.md carries the record as its YAML header (meetingFrontmatter.js).
 *   - Classic: <base>-analysis.md is plain markdown, exactly as 0.9.9 wrote it, and the record sits
 *     beside the meeting's sources as <base>.bedrock.json — in details\ when Use Details Folder is
 *     on, else beside the .md. The record is the SAME data object the Minutes header holds, so
 *     hand-edit detection, item ids, and the Joplin / Obsidian / task-list export state work the
 *     same way in either style.
 *
 * A Classic record is trusted only when exactly one readable, valid record names this note. A
 * missing, corrupt, invalid, or ambiguous record reads as "no record", which the analyzer treats
 * like a pre-format file: a re-analysis is saved beside the note for review, never written over it.
 *
 * Synchronous fs (records are small); the fs module is injected for tests.
 */
const path = require('path');
const { readFrontmatter, validateFrontmatter, serializeFrontmatter } = require('./meetingFrontmatter');
const { sha256, assembleFile } = require('./meetingFile');

const NOTE_STYLES = ['classic', 'minutes'];
const RECORD_SCHEMA = 1;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;

// A config without a note style predates the setting (0.9.9 or a 1.0.0 beta): its meetings keep
// the Classic shape. A new install's seed (config.default.json) carries 'minutes'.
function migrateNoteStyle(config) {
  if (!config.settings) config.settings = {};
  const me = config.settings.meeting;
  if (!me || me.noteStyle === undefined) config.settings.meeting = Object.assign({}, me, { noteStyle: 'classic' });
  return config;
}
function normalizeNoteStyle(style) { return style === 'minutes' ? 'minutes' : 'classic'; }

// The analyzer's filing options from settings.meeting. Classic honours Separate Clean Transcript
// and Use Details Folder as 0.9.9 did; Minutes Compatible always keeps the transcript in the .md
// and files the sources into details\. byDate: Organize by date (completed\YYYY\MM).
function filingOptionsFor(m) {
  const s = m || {};
  const classic = normalizeNoteStyle(s.noteStyle) === 'classic';
  return {
    separateRecurring: !!s.separateRecurring, byDate: !!s.processedByDate, noteStyle: classic ? 'classic' : 'minutes',
    separateTranscript: classic && !!s.separateTranscript, useDetailsFolder: classic ? !!s.useDetailsFolder : true,
  };
}

const classicName = base => base + '-analysis.md';
const minutesName = base => base + '.md';
function mdNameFor(style, base) { return normalizeNoteStyle(style) === 'minutes' ? minutesName(base) : classicName(base); }
function recordName(base) { return base + '.bedrock.json'; }
// The meeting name behind a note file: <base>.md, <base>-analysis.md (and the old archive's variants).
function baseOfNote(file) { return path.basename(String(file)).replace(/(?:[-_ ]+meeting)?[-_ ]+analysis\.md$/i, '').replace(/\.md$/i, ''); }
function isClassicName(file) { return /-analysis\.md$/i.test(String(file)); }

// Where a meeting's side files may be: details\ first, then the note's own folder. Lookups never
// follow the CURRENT Use Details Folder setting — a record is wherever it was written.
function sideDirs(mdPath) { const home = path.dirname(mdPath); return [path.join(home, 'details'), home]; }
// The side folder new files go to: details\ unless Classic with Use Details Folder off.
function sideDirFor(mdPath, style, useDetailsFolder) {
  return style === 'classic' && !useDetailsFolder ? path.dirname(mdPath) : path.join(path.dirname(mdPath), 'details');
}
// Every existing copy of a side file (<leaf>) for this note, details\ first.
function findSide(fsMod, mdPath, leaf) {
  return sideDirs(mdPath).map(d => path.join(d, leaf)).filter(p => { try { return fsMod.statSync(p).isFile(); } catch (e) { return false; } });
}

// The Classic record for mdPath, or { ok: false, reason }. `path` is where it was found.
function readClassicRecord(fsMod, mdPath) {
  const note = path.basename(mdPath);
  const found = [];
  for (const p of findSide(fsMod, mdPath, recordName(baseOfNote(mdPath)))) {
    try {
      if (fsMod.statSync(p).size > MAX_RECORD_BYTES) continue;
      const raw = fsMod.readFileSync(p);
      const rec = JSON.parse(raw.toString('utf8'));
      if (!rec || rec.schema !== RECORD_SCHEMA || rec.note !== note || !rec.data) continue;   // another note's, or not ours
      if (!validateFrontmatter(rec.data).ok) continue;
      found.push({ path: p, data: rec.data, hash: sha256(raw) });
    } catch (e) { /* corrupt: not a record */ }
  }
  if (found.length > 1) return { ok: false, reason: 'record-conflict', paths: found.map(f => f.path) };
  if (!found.length) return { ok: false, reason: 'no-record' };
  return Object.assign({ ok: true }, found[0]);
}

// The record of a note in either style: { ok, style, data, body, bytes, recordPath? } or
// { ok: false, style, reason, body?, bytes? }. `body` is the note's markdown (the header removed
// for Minutes; the whole file for Classic). Style comes from the file itself, never the setting.
function readRecord(fsMod, mdPath) {
  let bytes;
  try { bytes = fsMod.readFileSync(mdPath); } catch (e) { return { ok: false, style: null, reason: 'unreadable' }; }
  const text = bytes.toString('utf8');
  const fm = readFrontmatter(text);
  if (fm.ok) return { ok: true, style: 'minutes', data: fm.data, body: fm.body, bytes };
  if (fm.reason !== 'no-frontmatter') return { ok: false, style: 'minutes', reason: fm.reason, bytes };
  const body = text.replace(/^﻿/, '');
  const rec = readClassicRecord(fsMod, mdPath);
  if (!rec.ok) return { ok: false, style: 'classic', reason: rec.reason, body, bytes };
  return { ok: true, style: 'classic', data: rec.data, body, bytes, recordPath: rec.path, recordHash: rec.hash };
}

function writeAtomic(fsMod, p, data) {
  const tmp = p + '.tmp';
  fsMod.writeFileSync(tmp, data);
  fsMod.renameSync(tmp, p);
}
function recordText(mdPath, data) { return JSON.stringify({ schema: RECORD_SCHEMA, note: path.basename(mdPath), data }, null, 2) + '\n'; }
function writeClassicRecord(fsMod, recordPath, mdPath, data) {
  const valid = validateFrontmatter(data);
  if (!valid.ok) throw new Error('meeting record failed validation: ' + valid.errors.join('; '));
  fsMod.mkdirSync(path.dirname(recordPath), { recursive: true });
  writeAtomic(fsMod, recordPath, recordText(mdPath, data));
}

// Rewrite only the record of a published note (export state, revision bookkeeping): read, mutate,
// validate, and write via temp+rename, refusing if the note (or the Classic record) moved between
// read and write. Minutes rewrites the header with the SAME body; Classic never touches the .md.
function patchRecord(fsMod, mdPath, mutate) {
  const r = readRecord(fsMod, mdPath);
  if (!r.ok) throw new Error(r.style === 'classic' ? 'cannot patch a note without a readable record (' + r.reason + ')' : 'cannot patch a file without readable frontmatter');
  const data = r.data;
  mutate(data);
  const valid = validateFrontmatter(data);
  if (!valid.ok) throw new Error('patched ' + (r.style === 'classic' ? 'record' : 'frontmatter') + ' invalid: ' + valid.errors.join('; '));
  if (sha256(fsMod.readFileSync(mdPath)) !== sha256(r.bytes)) throw new Error('file changed while patching');
  if (r.style === 'minutes') { writeAtomic(fsMod, mdPath, assembleFile(serializeFrontmatter(data), r.body)); return; }
  if (sha256(fsMod.readFileSync(r.recordPath)) !== r.recordHash) throw new Error('record changed while patching');
  writeAtomic(fsMod, r.recordPath, recordText(mdPath, data));
}

module.exports = {
  NOTE_STYLES, migrateNoteStyle, normalizeNoteStyle, filingOptionsFor, mdNameFor, classicName, minutesName,
  recordName, baseOfNote, isClassicName, sideDirs, sideDirFor, findSide, readRecord, readClassicRecord,
  writeClassicRecord, patchRecord, writeAtomic,
};
