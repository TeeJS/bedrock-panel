'use strict';

// Minutes v1/v2 file contract, pinned to 6a5a8cbf9c4236f55814cccafb50a840fbf15c86.
// This is deliberately a small data grammar, not a general YAML implementation. Unsupported
// external YAML is read-only; never guess at policy fields or partially rewrite such a file.
const crypto = require('crypto');
const MAX_BYTES = 1024 * 1024;
const MAX_STRING = 32768;
const MAX_ITEMS = 2000;
const MAX_DEPTH = 12;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const START = '<!-- BEDROCK-STRUCTURED v1 -->';
const END = '<!-- /BEDROCK-STRUCTURED -->';
const OWNED_KEYS = new Set(['title', 'type', 'date', 'duration', 'source', 'status', 'tags', 'attendees',
  'people', 'speaker_map', 'action_items', 'decisions', 'intents', 'recorded_by', 'bedrock']);

function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value)); }
function checkKey(key) {
  if (typeof key !== 'string' || !key.length || key.length > 256 || FORBIDDEN.has(key)) throw new Error('unsupported key');
}
function checkValue(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('nesting limit');
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) throw new Error('string limit');
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
  } else if (value === null || typeof value === 'boolean') { /* supported scalar */ }
  else if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) throw new Error('item limit');
    value.forEach(v => checkValue(v, depth + 1));
  } else if (object(value)) {
    if (Object.keys(value).length > MAX_ITEMS) throw new Error('key limit');
    for (const [key, v] of Object.entries(value)) { checkKey(key); checkValue(v, depth + 1); }
  } else throw new Error('unsupported value');
}

function yamlKey(key) { return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) ? key : JSON.stringify(key); }
function scalar(value) {
  if (typeof value === 'string') return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return JSON.stringify(value);
}
function serializeFrontmatter(data) {
  checkValue(data);
  if (!object(data)) throw new Error('frontmatter must be a map');
  const lines = [];
  function write(value, indent) {
    const pad = ' '.repeat(indent);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (object(item) && Object.keys(item).length) {
          const before = lines.length;
          write(item, indent + 2);
          lines[before] = pad + '- ' + lines[before].slice(indent + 2);
        } else if (Array.isArray(item) && item.length) {
          lines.push(pad + '-'); write(item, indent + 2);
        } else lines.push(pad + '- ' + (Array.isArray(item) ? '[]' : object(item) ? '{}' : scalar(item)));
      }
    } else {
      for (const [key, item] of Object.entries(value)) {
        const prefix = pad + yamlKey(key) + ':';
        if ((Array.isArray(item) && item.length) || (object(item) && Object.keys(item).length)) {
          lines.push(prefix); write(item, indent + 2);
        } else lines.push(prefix + ' ' + (Array.isArray(item) ? '[]' : object(item) ? '{}' : scalar(item)));
      }
    }
  }
  write(data, 0);
  const yaml = lines.join('\n') + '\n';
  if (Buffer.byteLength(yaml) > MAX_BYTES) throw new Error('frontmatter byte limit');
  return yaml;
}

// Find syntax outside quoted strings. JSON escapes in double-quoted strings are understood;
// single-quoted and multiline YAML intentionally require another editor/reader to rewrite.
function stripComment(line) {
  let quoted = false, escape = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escape) { escape = false; continue; }
    if (quoted && c === '\\') { escape = true; continue; }
    if (c === '"') quoted = !quoted;
    if (!quoted && c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  if (quoted) throw new Error('unclosed quote');
  return line.trimEnd();
}
function pair(text) {
  let key, rest;
  if (text.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*"):\s*(.*)$/.exec(text);
    if (!match) throw new Error('unsupported mapping');
    key = JSON.parse(match[1]); rest = match[2];
  } else {
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:\s+(.*)|$)/.exec(text);
    if (!match) throw new Error('unsupported mapping');
    key = match[1]; rest = match[2] || '';
  }
  checkKey(key);
  return [key, rest];
}
function parseScalar(text) {
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (text.startsWith('"')) {
    const value = JSON.parse(text);
    if (typeof value !== 'string') throw new Error('unsupported scalar');
    return value;
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    const items = [], inside = text.slice(1, -1);
    let quote = false, escape = false, from = 0;
    for (let i = 0; i <= inside.length; i++) {
      const c = inside[i];
      if (escape) { escape = false; continue; }
      if (quote && c === '\\') { escape = true; continue; }
      if (c === '"') quote = !quote;
      if ((c === ',' && !quote) || i === inside.length) {
        const item = inside.slice(from, i).trim();
        if (!item) throw new Error('empty inline item');
        const value = parseScalar(item);
        if (typeof value === 'object') throw new Error('nested inline structure');
        items.push(value); from = i + 1;
      }
    }
    if (quote) throw new Error('unclosed quote');
    return items;
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return Number(text);
  if (!text || /^[!&*'"\[\]{}|>@`]/.test(text) || /:\s/.test(text) || /[\u0000-\u001f]/.test(text)) throw new Error('unsupported scalar');
  return text;
}
function parseYaml(raw) {
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('frontmatter byte limit');
  const lines = [];
  for (const line of raw.split('\n')) {
    if (/\t/.test(line)) throw new Error('tabs unsupported');
    const text = stripComment(line);
    if (!text.trim()) continue;
    const indent = /^ */.exec(text)[0].length;
    if (indent % 2) throw new Error('indentation unsupported');
    lines.push({ indent, text: text.slice(indent) });
  }
  let cursor = 0, nodes = 0;
  function block(indent, depth) {
    if (depth > MAX_DEPTH || ++nodes > 20000) throw new Error('structure limit');
    const list = /^-(?:\s|$)/.test(lines[cursor]?.text || '');
    const out = list ? [] : {};
    while (cursor < lines.length && lines[cursor].indent === indent) {
      if (++nodes > 20000) throw new Error('structure limit');
      const row = lines[cursor];
      if (list) {
        if (!/^-(?:\s|$)/.test(row.text)) throw new Error('mixed list and map');
        const tail = row.text.slice(1).trimStart();
        if (tail && /^(?:[A-Za-z_][A-Za-z0-9_.-]*|"(?:[^"\\]|\\.)*"):(?:\s|$)/.test(tail)) {
          lines[cursor] = { indent: indent + 2, text: tail };
          out.push(block(indent + 2, depth + 1));
        } else {
          cursor++;
          if (!tail) {
            if (!lines[cursor] || lines[cursor].indent !== indent + 2) throw new Error('empty list entry');
            out.push(block(indent + 2, depth + 1));
          } else out.push(parseScalar(tail));
        }
        if (out.length > MAX_ITEMS) throw new Error('item limit');
      } else {
        const [key, rest] = pair(row.text);
        if (Object.hasOwn(out, key)) throw new Error('duplicate key');
        cursor++;
        if (!rest) {
          if (!lines[cursor] || lines[cursor].indent !== indent + 2) throw new Error('missing value');
          out[key] = block(indent + 2, depth + 1);
        } else out[key] = parseScalar(rest);
      }
      if (lines[cursor] && lines[cursor].indent > indent) throw new Error('unexpected indentation');
    }
    return out;
  }
  if (!lines.length || lines[0].indent !== 0) throw new Error('empty frontmatter');
  const data = block(0, 0);
  if (cursor !== lines.length || !object(data)) throw new Error('frontmatter must be a map');
  checkValue(data);
  return data;
}
function readFrontmatter(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'unreadable-frontmatter' };
  const normalized = text.replace(/^\uFEFF/, '');
  if (!/^---\r?\n/.test(normalized)) return { ok: false, reason: 'no-frontmatter' };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  if (!match) return { ok: false, reason: 'unreadable-frontmatter' };
  const raw = match[1];
  try {
    const data = parseYaml(raw.replace(/\r\n/g, '\n'));
    return { ok: true, data, unknownKeys: Object.keys(data).filter(k => !OWNED_KEYS.has(k)),
      body: normalized.slice(match[0].length), raw };
  } catch (e) { return { ok: false, reason: 'unreadable-frontmatter' }; }
}

function validateFrontmatter(data) {
  const errors = [];
  try { checkValue(data); } catch (e) { errors.push(e.message); }
  if (!object(data)) return { ok: false, errors: errors.concat('frontmatter must be a map') };
  const string = (value, label, required = true) => {
    if (value === undefined && !required) return;
    if (typeof value !== 'string' || (required && !value.trim())) errors.push(label + ' must be a string');
  };
  const enumeration = (value, allowed, label, required = false) => {
    if (value === undefined && !required) return;
    if (!allowed.includes(value)) errors.push(label + ' invalid');
  };
  string(data.title, 'title'); string(data.duration, 'duration');
  enumeration(data.type, ['meeting', 'memo', 'dictation', 'note'], 'type', true);
  const dateParts = typeof data.date === 'string' && /^(\d{4})-(\d\d)-(\d\d)T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(data.date);
  if (!dateParts || !Number.isFinite(Date.parse(data.date)) || +dateParts[2] < 1 || +dateParts[2] > 12 || +dateParts[3] < 1
    || +dateParts[3] > new Date(Date.UTC(+dateParts[1], +dateParts[2], 0)).getUTCDate()) errors.push('date must be ISO-8601 with timezone');
  enumeration(data.status, ['complete', 'processing', 'failed'], 'status');
  enumeration(data.sensitivity, ['normal', 'restricted'], 'sensitivity');
  enumeration(data.visibility, ['private', 'team'], 'visibility');
  enumeration(data.consent, ['verbal_all_parties', 'notice_in_invite', 'recorded_disclosed', 'na', 'unattested'], 'consent');
  for (const key of ['source', 'recorded_by', 'calendar_event', 'context', 'device']) string(data[key], key, false);
  for (const key of ['attendees', 'people', 'tags']) {
    if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some(v => typeof v !== 'string'))) errors.push(key + ' must be strings');
  }
  for (const key of ['action_items', 'decisions', 'intents', 'speaker_map']) {
    if (data[key] === undefined) continue;
    if (!Array.isArray(data[key])) { errors.push(key + ' must be a list'); continue; }
    data[key].forEach((item, i) => {
      const label = key + '[' + i + ']';
      if (!object(item)) { errors.push(label + ' must be a map'); return; }
      if (key === 'action_items') {
        string(item.assignee, label + '.assignee'); string(item.task, label + '.task'); string(item.status, label + '.status'); string(item.due, label + '.due', false);
      } else if (key === 'decisions') {
        string(item.text, label + '.text');
        for (const field of ['id', 'topic', 'supersedes', 'effective_date']) string(item[field], label + '.' + field, false);
        enumeration(item.authority, ['high', 'medium', 'low'], label + '.authority');
      } else if (key === 'intents') {
        enumeration(item.kind, ['action-item', 'decision', 'open-question', 'commitment'], label + '.kind', true);
        string(item.what, label + '.what'); string(item.status, label + '.status');
        string(item.who, label + '.who', false); string(item.by_date, label + '.by_date', false);
      } else {
        string(item.speaker_label, label + '.speaker_label'); string(item.name, label + '.name');
        enumeration(item.confidence, ['high', 'medium', 'low'], label + '.confidence', true);
        enumeration(item.source, ['deterministic', 'llm', 'enrollment', 'manual', 'ml-bleed-degraded', 'stem-recovery'], label + '.source', true);
        if (item.source === 'llm' && item.confidence === 'high') errors.push(label + ' llm confidence exceeds medium');
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

function emptyStructured() { return { action_items: [], decisions: [], intents: [], speaker_map: [], turns: [], participants: [], key_points: [] }; }
function parseStructuredTail(markdown) {
  const text = String(markdown || '');
  const structured = emptyStructured(), errors = [];
  const starts = text.split(START).length - 1, ends = text.split(END).length - 1;
  const start = text.lastIndexOf(START), end = text.lastIndexOf(END);
  if (starts !== 1 || ends !== 1 || end < start || text.slice(end + END.length).trim()) {
    return { structured, bodyWithoutTail: text, malformed: true, errors: ['missing or ambiguous structured block'] };
  }
  const bodyWithoutTail = text.slice(0, start).trimEnd() + '\n';
  const tail = text.slice(start + START.length, end);
  if (Buffer.byteLength(tail) > MAX_BYTES) return { structured, bodyWithoutTail: text, malformed: true, errors: ['structured byte limit'] };
  const sections = new Map([
    ['KEY POINTS', 'key_points'], ['DECISIONS', 'decisions'], ['ACTION ITEMS', 'action_items'],
    ['OPEN QUESTIONS', 'open-question'], ['COMMITMENTS', 'commitment'], ['PARTICIPANTS', 'participants'],
    ['SPEAKER MAP', 'speaker_map'], ['TURNS', 'turns'],
  ]);
  const seen = new Set();
  let section = null, items = 0;
  for (const raw of tail.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.replace(/^#{1,6}\s*/, '').replace(/:\s*$/, '').toUpperCase();
    if (sections.has(heading)) {
      section = sections.get(heading);
      if (seen.has(section)) errors.push('duplicate section: ' + heading);
      seen.add(section); continue;
    }
    if (!section) { errors.push('item outside section'); continue; }
    if (/^(?:-\s*)?\(?none\)?[.]?$/i.test(line)) continue;
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (!bullet || ++items > MAX_ITEMS || line.length > MAX_STRING) { errors.push('invalid or oversized structured item'); continue; }
    let value = bullet[1];
    if (section === 'action_items' || section === 'commitment' || section === 'open-question') {
      const who = /^@([^:]+):\s*(.+)$/.exec(value);
      let task = who ? who[2] : value;
      const due = /\s+\(by (.+)\)$/.exec(task);
      if (due) task = task.slice(0, due.index);
      const named = who && who[1].trim() && !/^(?:UNKNOWN|Speaker\s+[A-Z0-9]+|unassigned|TBD)$/i.test(who[1].trim());
      if (section === 'action_items' && named && task.trim()) {
        const item = { assignee: who[1].trim(), task: task.trim(), status: 'open' };
        if (due) item.due = due[1];
        structured.action_items.push(item);
      } else {
        const item = { kind: section === 'action_items' ? 'action-item' : section, what: task.trim(), status: 'open' };
        if (named) item.who = who[1].trim();
        if (due) item.by_date = due[1];
        structured.intents.push(item);
      }
    } else if (section === 'decisions') structured.decisions.push({ text: value });
    else if (section === 'speaker_map') {
      const match = /^(.+?)\s*(?:→|->)\s*(.+?)\s*\((.+)\)$/.exec(value);
      if (!match) { errors.push('invalid speaker mapping'); continue; }
      structured.speaker_map.push({ speaker_label: match[1].trim(), name: match[2].trim(), confidence: 'medium', source: 'llm', evidence: match[3] });
    } else if (section === 'turns') {
      const match = /^(\d+):\s*segments?\s+(\d+)(?:\s*-\s*(\d+))?$/.exec(value);
      if (!match) { errors.push('invalid turn range'); continue; }
      const range = { turn: Number(match[1]), segmentStart: Number(match[2]), segmentEnd: Number(match[3] || match[2]) };
      if (!Number.isSafeInteger(range.turn) || range.turn < 1 || !Number.isSafeInteger(range.segmentStart) || !Number.isSafeInteger(range.segmentEnd) || range.segmentEnd < range.segmentStart || structured.turns.some(t => t.turn === range.turn)) errors.push('invalid turn range');
      else structured.turns.push(range);
    } else structured[section].push(value);
  }
  for (const key of sections.values()) if (!seen.has(key)) errors.push('missing section: ' + key);
  // Malformed extraction remains in the visible body so unparsed commitments are never lost.
  return { structured, bodyWithoutTail: errors.length ? text : bodyWithoutTail, malformed: errors.length > 0, errors };
}

function parseLegacyAnalysis(markdown) {
  const structured = emptyStructured();
  let section = '';
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(raw);
    if (heading) { section = heading[1].trim().toLowerCase(); continue; }
    if (section === 'decisions' || section === 'key decisions') {
      const m = /^\s*[-*]\s+(.+)$/.exec(raw);
      if (m && !/^\(?none\b/i.test(m[1])) structured.decisions.push({ text: m[1] });
    } else if (section === 'action items') {
      if (raw.trim().startsWith('|')) {
        const cols = raw.trim().slice(1).replace(/\|$/, '').split(/(?<!\\)\|/).map(v => v.trim().replace(/\\\|/g, '|'));
        if (cols.length < 3 || /^(?:s|status|[-:\s]+)$/i.test(cols[0]) || /^owner$/i.test(cols[1])) continue;
        const status = /[☑✓✔]|\[x\]|^done$/i.test(cols[0]) ? 'done' : 'open';
        if (cols[1] && !/^(?:unknown|unassigned|speaker\s+[a-z0-9]+|tbd|[-—])$/i.test(cols[1])) structured.action_items.push({ assignee: cols[1], task: cols.slice(2).join(' | '), status });
        else if (cols[2]) structured.intents.push({ kind: 'action-item', what: cols.slice(2).join(' | '), status });
      } else {
        const m = /^\s*[-*]\s+(?:\[([ xX])\]\s*)?(?:\*\*)?@?([^:]+?)(?:\*\*)?:\s*(.+)$/.exec(raw);
        if (m && !/^\(?none\b/i.test(m[2])) structured.action_items.push({ assignee: m[2].replace(/\*\*/g, '').trim(), task: m[3], status: /x/i.test(m[1] || '') ? 'done' : 'open' });
      }
    }
  }
  return structured;
}

function slug(name) { return String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'person'; }
function transcriptObject(value) { if (typeof value === 'string') { try { return JSON.parse(value); } catch (e) { return {}; } } return object(value) ? value : {}; }
function dateFromBase(base, timezone) {
  const match = /^(\d{4})-(\d\d)-(\d\d)[-_](\d\d)[-_](\d\d)[-_](\d\d)/.exec(base);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  const naive = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const offsetAt = ms => {
    const fields = Object.fromEntries(fmt.formatToParts(ms).map(p => [p.type, p.value]));
    return (Date.UTC(+fields.year, +fields.month - 1, +fields.day, +fields.hour, +fields.minute, +fields.second) - ms) / 60000;
  };
  const possibilities = [...new Set([offsetAt(naive - 86400000), offsetAt(naive), offsetAt(naive + 86400000)])]
    .map(offset => ({ offset, ms: naive - offset * 60000 }))
    .filter(p => offsetAt(p.ms) === p.offset);
  if (possibilities.length !== 1) return null; // DST gap/overlap needs an explicit human resolution.
  const offset = possibilities[0].offset;
  return match.slice(1, 4).join('-') + 'T' + match.slice(4).join(':')
    + (offset < 0 ? '-' : '+') + String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0') + ':' + String(Math.abs(offset) % 60).padStart(2, '0');
}
function buildFrontmatter(inputs = {}) {
  const { base = 'Meeting', sources = {}, settings = {} } = inputs;
  const parsed = inputs.parsed?.structured || inputs.parsed || emptyStructured();
  const transcript = transcriptObject(sources.transcriptJson || sources.transcript);
  const meta = transcriptObject(sources.meta);
  const capture = transcriptObject(sources.capture);
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  const reports = Array.isArray(transcript.speaker_report?.speakers) ? transcript.speaker_report.speakers : [];
  const attendees = [...new Set([...(Array.isArray(meta.required_attendees) ? meta.required_attendees : []), ...(Array.isArray(meta.optional_attendees) ? meta.optional_attendees : []), ...(parsed.participants || []), ...reports.filter(s => s.identified).map(s => s.label)]
    .filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))];
  const people = [], slugOwners = new Map(), collisions = [];
  for (const name of attendees) {
    let id = slug(name);
    if (slugOwners.has(id) && slugOwners.get(id) !== name) {
      collisions.push({ slug: id, names: [slugOwners.get(id), name] });
      id += '-' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
    }
    slugOwners.set(id, name); people.push(id);
  }
  const end = segments.reduce((n, s) => Number.isFinite(s.end) && s.end >= 0 ? Math.max(n, s.end) : n, 0);
  const wav = sources.wavDurationMs;
  const durationSec = Number.isFinite(wav) && wav >= 0 ? wav / 1000 : end || null;
  const durationSource = Number.isFinite(wav) && wav >= 0 ? 'wav' : end ? 'diarizer' : 'unknown';
  const warnings = [];
  let date = capture.started_at || sources.date || inputs.date || inputs.previous?.date;
  const bedrock = { schema: 1, duration_source: durationSource, extraction: inputs.malformed || inputs.parsed?.malformed ? 'malformed' : 'ok', evidence: 'limited' };
  if (!date) {
    const zone = settings.tzPolicy === 'assumed-los-angeles' ? 'America/Los_Angeles' : settings.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    date = dateFromBase(base, zone);
    bedrock.tz_policy = settings.tzPolicy || 'assumed-' + zone;
    if (!date && /^\d{4}-\d\d-\d\d/.test(base)) warnings.push('Capture timestamp is invalid or ambiguous; explicit date required');
    else if (!date) {
      date = new Date(inputs.now === undefined ? Date.now() : inputs.now).toISOString();
      bedrock.date_source = 'first-seen';
      warnings.push('Capture time unavailable; date records first-seen time');
    } else warnings.push('Capture timezone assumed from filename');
  }
  if (durationSource !== 'wav') warnings.push(durationSource === 'unknown' ? 'Recording duration unknown' : 'Duration estimated from diarizer');
  if (parsed.intents?.some(i => i.kind === 'action-item' && !i.who)) warnings.push('Action item without an owner retained as an intent');
  warnings.push('Transcript evidence must be verified against cited source segments');
  if (collisions.length) bedrock.slug_collisions = collisions;
  const data = { title: String(meta.subject || inputs.title || base), type: 'meeting', date: date || '',
    duration: durationSec === null ? 'unknown' : durationSec >= 60 ? Math.floor(durationSec / 60) + 'm ' + Math.floor(durationSec % 60) + 's' : Math.floor(durationSec) + 's',
    source: inputs.source || 'bedrock-panel', status: inputs.status || 'complete', attendees, people,
    tags: (inputs.tags || []).filter(t => typeof t === 'string'), action_items: parsed.action_items || [], decisions: parsed.decisions || [], intents: parsed.intents || [],
    speaker_map: (parsed.speaker_map || []).map(s => ({ speaker_label: s.speaker_label, name: people[attendees.indexOf(s.name)] || slug(s.name), confidence: 'medium', source: 'llm' })), bedrock };
  for (const speaker of reports) {
    if (!speaker.identified || !speaker.label || /^(?:UNKNOWN|Speaker\s+[A-Z0-9]+)$/i.test(speaker.label)) continue;
    if (data.speaker_map.some(s => s.speaker_label === speaker.label)) continue;
    // An enrolled name alone does not prove the channel; keep voice enrollment provenance.
    data.speaker_map.push({ speaker_label: speaker.label, name: people[attendees.indexOf(speaker.label)] || slug(speaker.label), confidence: 'high', source: 'enrollment' });
  }
  if (settings.myName) data.recorded_by = slug(settings.myName);
  if (meta.start) data.bedrock.scheduled_start = String(meta.start);
  if (capture.device && typeof capture.device === 'string') data.device = capture.device;
  return { frontmatter: inputs.previous ? mergeUnknown(inputs.previous, data) : data, warnings };
}
function mergeUnknown(previous, next) {
  checkValue(previous); checkValue(next);
  const result = {};
  for (const [key, value] of Object.entries(previous || {})) if (!OWNED_KEYS.has(key)) result[key] = value;
  Object.assign(result, next);
  result.bedrock = Object.assign({}, previous?.bedrock, next?.bedrock);
  for (const key of ['action_items', 'decisions', 'intents', 'speaker_map']) {
    if (!Array.isArray(next?.[key])) continue;
    result[key] = next[key].map(item => {
      const old = (Array.isArray(previous?.[key]) ? previous[key] : []).find(p => object(p) && (item.id ? p.id === item.id : key === 'speaker_map' && p.speaker_label === item.speaker_label));
      return Object.assign({}, old, item);
    });
  }
  return result;
}

module.exports = { parseStructuredTail, parseLegacyAnalysis, buildFrontmatter, validateFrontmatter,
  serializeFrontmatter, readFrontmatter, mergeUnknown };
