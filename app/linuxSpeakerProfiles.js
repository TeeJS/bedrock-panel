'use strict';
/*
 * linuxSpeakerProfiles.js — enrolled voices, and matching a voice against them.
 *
 * A meeting transcript is far more useful with names in it than with "Speaker A", and a name can
 * only come from having been introduced: someone enrolls a clip of a person talking, and every
 * later meeting compares voices against that.
 *
 * The storage format is deliberately not ours. Profiles are one NumPy .npy file per speaker, the
 * filename being the identity, which is exactly what the Windows helper and the Python
 * meeting-diarizer write. A folder of profiles can be copied between all three, so enrolling on one
 * machine is not work thrown away when the person moves to another. That portability also dictates
 * the embedding model, which is pinned in linuxSpeechCatalog for the same reason: the same voice
 * fingerprinted by a different model is a different number, and profiles would silently stop
 * matching.
 *
 * The matching constants are ported, not re-derived — see the catalogue for why.
 */
const path = require('path');
const fsDefault = require('fs');
const { DIARIZATION } = require('./linuxSpeechCatalog');

// The six bytes NumPy puts at the head of every .npy file.
const NPY_MAGIC = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);

/** A 1-D float32 array as NumPy writes it: magic, version, header, then little-endian data. */
function writeNpy(vector) {
  let header = "{'descr': '<f4', 'fortran_order': False, 'shape': (" + vector.length + ",), }";
  const pad = (10 + header.length + 1) % 64;
  if (pad !== 0) header += ' '.repeat(64 - pad);
  header += '\n';
  const head = Buffer.alloc(10 + header.length);
  NPY_MAGIC.copy(head, 0);
  head[6] = 1; head[7] = 0;
  head.writeUInt16LE(header.length, 8);
  head.write(header, 10, 'latin1');
  const body = Buffer.alloc(vector.length * 4);
  vector.forEach((v, i) => body.writeFloatLE(v, i * 4));
  return Buffer.concat([head, body]);
}

/** The inverse. Returns null for anything that is not a 1-D little-endian float32 array. */
function readNpy(buf) {
  if (!buf || buf.length < 12 || !buf.subarray(0, 6).equals(NPY_MAGIC)) return null;
  const major = buf[6];
  const headerLen = major >= 2 ? buf.readUInt32LE(8) : buf.readUInt16LE(8);
  const start = (major >= 2 ? 12 : 10) + headerLen;
  const header = buf.toString('latin1', major >= 2 ? 12 : 10, start);
  if (!/'descr':\s*'<f4'/.test(header) || /'fortran_order':\s*True/.test(header)) return null;
  const shape = /'shape':\s*\((\d+)\s*,?\s*\)/.exec(header);
  if (!shape) return null;
  const n = Number(shape[1]);
  if (buf.length < start + n * 4) return null;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(start + i * 4);
  return out;
}

/**
 * "Schmitz, T.J." and "T.J. Schmitz" are the same person. Comparing the squashed form means an
 * attendee list pasted out of a calendar still lines up with how someone was enrolled.
 */
function normalizeName(name) {
  let n = String(name == null ? '' : name).trim();
  const comma = n.indexOf(',');
  if (comma >= 0) n = (n.slice(comma + 1).trim() + ' ' + n.slice(0, comma).trim()).trim();
  return n.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Cosine similarity, with the same epsilon the other implementations use. */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

const round4 = v => Math.round(v * 10000) / 10000;

/** A name that is safe as a filename and is not a traversal attempt. */
function validName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n || n === '.' || n === '..') return null;
  if (n.includes('/') || n.includes('\\') || n.includes('\0')) return null;
  return n;
}

function createSpeakerProfiles(options) {
  const opts = options || {};
  const fs = opts.fs || fsDefault;
  const dir = opts.dir || '';

  function fileFor(name) {
    const n = validName(name);
    return n ? path.join(dir, n + '.npy') : null;
  }

  function list() {
    try {
      return fs.readdirSync(dir).filter(f => f.endsWith('.npy')).map(f => f.slice(0, -4)).sort();
    } catch (e) { return []; }
  }

  function all() {
    const out = {};
    for (const name of list()) {
      try {
        const v = readNpy(fs.readFileSync(path.join(dir, name + '.npy')));
        if (v) out[name] = v;
      } catch (e) { /* a profile we cannot read is one we do not match against */ }
    }
    return out;
  }

  function save(name, vector) {
    const file = fileFor(name);
    if (!file || !Array.isArray(vector) || !vector.length) return false;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, writeNpy(vector));
    return true;
  }

  function remove(name) {
    const file = fileFor(name);
    if (!file) return false;
    try { fs.unlinkSync(file); return true; } catch (e) { return false; }
  }

  function rename(from, to) {
    const src = fileFor(from), dst = fileFor(to);
    if (!src || !dst) return false;
    if (fs.existsSync(dst)) return false;          // never silently overwrite someone else
    try { fs.renameSync(src, dst); return true; } catch (e) { return false; }
  }

  /**
   * Which enrolled speaker this voice is, if any. `attendees` is an optional list of who was
   * supposed to be in the meeting; anyone enrolled but not invited is penalised rather than
   * excluded, because meetings have gatecrashers and calendars have mistakes.
   *
   * Returns { matched, scores, margin, ambiguous } — scores best-first, always, so a report can
   * show why a name was or was not given.
   */
  function identify(embedding, settings) {
    const s = settings || {};
    const threshold = s.threshold == null ? DIARIZATION.similarityThreshold : Number(s.threshold);
    const profiles = all();
    const names = Object.keys(profiles).sort();
    if (!embedding || !names.length || embedding.some(v => !Number.isFinite(v))) {
      return { matched: null, scores: [], margin: null, ambiguous: false };
    }
    let invited = null;
    if (Array.isArray(s.attendees) && s.attendees.length) {
      const byNorm = new Map(names.map(n => [normalizeName(n), n]));
      invited = new Set();
      for (const who of s.attendees) {
        const hit = byNorm.get(normalizeName(who));
        if (hit) invited.add(hit);
      }
    }
    const scores = names.map(name => {
      const raw = cosine(embedding, profiles[name]);
      const isAttendee = !invited || invited.has(name);
      const entry = { name, raw: round4(raw), score: round4(isAttendee ? raw : raw - DIARIZATION.attendeeOffset) };
      if (invited) entry.attendee = isAttendee;
      return entry;
    }).sort((a, b) => b.score - a.score);
    const margin = scores.length > 1 ? round4(scores[0].score - scores[1].score) : null;
    return {
      matched: scores.length && scores[0].score >= threshold ? scores[0].name : null,
      scores,
      margin,
      ambiguous: margin !== null && margin < DIARIZATION.ambiguousMargin,
    };
  }

  /** The enrolled spelling of a name, when one matches. Used to label the operator's own channel. */
  function resolveName(name) {
    const norm = normalizeName(name);
    return list().find(n => normalizeName(n) === norm) || String(name || '').trim();
  }

  return { dir, list, all, save, remove, rename, identify, resolveName };
}

module.exports = { createSpeakerProfiles, writeNpy, readNpy, normalizeName, cosine, validName };
