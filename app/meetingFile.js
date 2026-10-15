'use strict';
/*
 * meetingFile.js — the pieces of the one-file meeting record that are the ANALYZER's business
 * rather than the schema's (meetingFrontmatter.js owns the YAML subset, the structured-tail
 * parser, the builder and the validator):
 *
 *   - ids: stable, time-sortable ids for the meeting and for every extracted item;
 *   - turn times: the transcript's "[Name m:ss]" times come from the diarizer segments the model
 *     cited (TURNS: ranges), derived here in code; a turn the code can't verify gets NO time;
 *   - ownership: which body sections the AI regenerates and which are the user's, plus the
 *     baseline hash that tells a user edit inside an AI section from the app's own output;
 *   - item matching across re-analyses: an item keeps its id only on unique compatible
 *     evidence, and a "done" status never crosses an uncertain match;
 *   - assembling the file: frontmatter block + body, Unix line endings.
 *
 * Pure functions, no I/O — every rule here is unit-tested in test/meetingFile.test.js.
 */
const crypto = require('crypto');

const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford base32, like ULID
function newId(prefix, nowMs) {
  let t = Math.max(0, Math.floor(nowMs === undefined ? Date.now() : nowMs));
  let time = '';
  for (let i = 0; i < 10; i++) { time = ID_ALPHABET[t % 32] + time; t = Math.floor(t / 32); }
  const rnd = crypto.randomBytes(10);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ID_ALPHABET[(rnd[i % 10] + i * 7) % 32];
  return (prefix ? prefix + '-' : '') + time + rand;
}

function sha256(data) { return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex'); }

function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = n => (n < 10 ? '0' : '') + n;
  return h ? h + ':' + two(m) + ':' + two(r) : m + ':' + two(r);
}

// ---- text similarity (shared by turn verification and item matching) ----
// Unicode-aware: letters and digits in any script count; a CJK sentence tokenizes into its
// characters' runs rather than vanishing (an empty token set must never "match" anything).
function tokens(text) {
  const t = String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const words = t.match(/[\p{L}\p{N}]+/gu) || [];
  const out = [];
  for (const w of words) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(w)) {
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));   // character bigrams for unspaced scripts
      if (w.length === 1) out.push(w);
    } else if (w.length > 1) out.push(w);
  }
  return out;
}
function dice(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;   // nothing recognizable on either side is never evidence of a match
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return (2 * both) / (A.size + B.size);
}
function normalizedText(text) { return tokens(text).join(' '); }

// ---- transcript turn times ----
const TURN_LINE = /^\[([^\]\n]+?)(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?\]\s(.*)$/;
const MIN_TURN_OVERLAP = 0.3;

// Rewrites the "## Transcript" section so each turn's time is the start of the first diarizer
// segment in the range the model cited for it, when that citation checks out: the range exists,
// starts no earlier than the previous verified turn, and the turn's words overlap the cited
// segments' words. Otherwise the time is removed ("[Name] text") — never guessed or snapped.
function applyTurnTimes(body, turns, segments) {
  const text = String(body || '');
  const segs = Array.isArray(segments) ? segments : [];
  const ranges = new Map((Array.isArray(turns) ? turns : []).map(t => [t.turn, t]));
  const lines = text.split('\n');
  let inTranscript = false, turnNo = 0, verified = 0, unverified = 0, lastStart = -1;
  const out = lines.map(line => {
    if (/^##\s/.test(line)) { inTranscript = /^##\s*Transcript\s*$/i.test(line); return line; }
    if (!inTranscript) return line;
    const m = TURN_LINE.exec(line);
    if (!m) return line;
    turnNo++;
    const name = m[1].trim(), rest = m[3];
    const r = ranges.get(turnNo);
    let time = null;
    if (r && Number.isInteger(r.segmentStart) && Number.isInteger(r.segmentEnd)
        && r.segmentStart >= 0 && r.segmentEnd >= r.segmentStart && r.segmentEnd < segs.length) {
      const first = segs[r.segmentStart];
      const start = Number(first && first.start);
      const cited = segs.slice(r.segmentStart, r.segmentEnd + 1).map(s => s && s.text).join(' ');
      if (Number.isFinite(start) && start >= lastStart && dice(rest, cited) >= MIN_TURN_OVERLAP) {
        time = start; lastStart = start;
      }
    }
    if (time === null) { unverified++; return '[' + name + '] ' + rest; }
    verified++;
    return '[' + name + ' ' + formatTime(time) + '] ' + rest;
  });
  // No transcript section, or no turn lines in it, is not "fully evidenced" — it is nothing to
  // verify, and the file must say so.
  return { body: out.join('\n'), evidence: unverified || !verified ? 'limited' : 'full', verified, unverified, turns: turnNo };
}

// ---- body sections and ownership ----
// Splits a body into [{ heading, text }] on "## " lines; the preamble (title line, anything
// before the first section) has heading ''. `text` includes the heading line itself.
function splitSections(body) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let cur = { heading: '', lines: [] };
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { sections.push(cur); cur = { heading: h[1], lines: [line] }; }
    else cur.lines.push(line);
  }
  sections.push(cur);
  return sections.filter((s, i) => i > 0 || s.lines.some(l => l.trim()) ).map(s => ({ heading: s.heading, text: s.lines.join('\n') }));
}
function aiHeadingsOf(body) { return splitSections(body).map(s => s.heading).filter(Boolean); }
function baselineHash(body, aiHeadings) {
  const set = new Set(aiHeadings || []);
  const parts = splitSections(body).filter(s => !s.heading || set.has(s.heading)).map(s => s.text.trim());
  return sha256(parts.join('\n\n'));
}
// User-owned sections (headings outside the AI set) from the previous body are appended, in
// their original order, after the new AI-generated body. Nothing in them is touched.
function mergeOwnership(previousBody, newBody, aiHeadings) {
  const set = new Set(aiHeadings || []);
  const keep = splitSections(previousBody).filter(s => s.heading && !set.has(s.heading));
  if (!keep.length) return String(newBody || '');
  return String(newBody || '').replace(/\s+$/, '') + '\n\n' + keep.map(s => s.text.trim()).join('\n\n') + '\n';
}

// ---- item identity across re-analyses ----
const HIGH_SIMILARITY = 0.8;
const ITEM_PREFIX = { action_items: 'ai', decisions: 'dc', intents: 'in' };
function itemText(key, it) { return key === 'action_items' ? it.task : key === 'decisions' ? it.text : it.what; }
function itemOwner(key, it) { return key === 'action_items' ? it.assignee : key === 'intents' ? it.who : undefined; }

// Returns the previous item that is the UNIQUE compatible match for `item` (and for which `item`
// is the unique match back), or null. Equal normalized text always matches; otherwise the owner
// must be the same and the text similarity high, with exactly one such candidate on each side.
function compatible(key, a, b) {
  // Same owner (a reassigned task is a different commitment) and, for intents, the same kind.
  if (normalizedText(itemOwner(key, a) || '') !== normalizedText(itemOwner(key, b) || '')) return false;
  if (key === 'intents' && String(a.kind || '') !== String(b.kind || '')) return false;
  return true;
}
function matchPrevious(key, item, prevItems, newItems) {
  const text = normalizedText(itemText(key, item));
  const exact = prevItems.filter(p => compatible(key, p, item) && normalizedText(itemText(key, p)) === text);
  if (exact.length > 1) return null;
  if (exact.length === 1) {
    // unique the other way too: two identical new extractions must not both claim one identity
    const twins = newItems.filter(n => compatible(key, n, item) && normalizedText(itemText(key, n)) === text);
    return twins.length === 1 ? exact[0] : null;
  }
  const near = prevItems.filter(p => compatible(key, p, item) && dice(itemText(key, p), itemText(key, item)) >= HIGH_SIMILARITY);
  if (near.length !== 1) return null;
  const back = newItems.filter(n => compatible(key, n, item) && dice(itemText(key, near[0]), itemText(key, n)) >= HIGH_SIMILARITY);
  return back.length === 1 ? near[0] : null;
}

// Gives every extracted item an id. With a previous frontmatter: a matched item keeps its id and
// its previous "done" status (the user's completion survives a reworded re-extraction); a
// previous done item with no confident successor is carried over, marked carried; an uncertain
// match is a NEW item with review: true, never a transfer of done-ness.
function assignItemIds(frontmatter, previous, nowMs) {
  const fm = frontmatter;
  const prev = previous || {};
  for (const key of Object.keys(ITEM_PREFIX)) {
    const items = Array.isArray(fm[key]) ? fm[key] : [];
    const prevItems = Array.isArray(prev[key]) ? prev[key] : [];
    const used = new Set();
    const out = items.map(item => {
      const match = matchPrevious(key, item, prevItems.filter(p => !used.has(p)), items);
      if (match) {
        used.add(match);
        const merged = Object.assign({}, match, item, { id: match.id || newId(ITEM_PREFIX[key], nowMs) });
        if (match.status === 'done' && item.status !== 'done') merged.status = 'done';
        return merged;
      }
      const fresh = Object.assign({}, item, { id: newId(ITEM_PREFIX[key], nowMs) });
      const owner = normalizedText(itemOwner(key, item) || '');
      const lookalikes = prevItems.filter(p => normalizedText(itemOwner(key, p) || '') === owner && dice(itemText(key, p), itemText(key, item)) >= 0.5);
      if (lookalikes.length) fresh.review = true;   // similar to something that was there; a human decides
      return fresh;
    });
    for (const p of prevItems) {
      if (used.has(p) || p.status !== 'done') continue;
      out.push(Object.assign({}, p, { id: p.id || newId(ITEM_PREFIX[key], nowMs), carried: true }));
    }
    fm[key] = out;
  }
  return fm;
}

// ---- the file ----
function assembleFile(frontmatterYaml, body) {
  const yaml = String(frontmatterYaml || '').replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
  const text = String(body || '').replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
  return '---\n' + yaml + '---\n' + text;
}

module.exports = { newId, sha256, formatTime, dice, normalizedText, applyTurnTimes, splitSections, aiHeadingsOf, baselineHash, mergeOwnership, assignItemIds, matchPrevious, assembleFile };
