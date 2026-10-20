'use strict';
// Personas for the AI Voice face: who the face is. A persona is DATA only (name, prompt, face
// parameters), stored in config.settings.personas next to the Smart Profiles and picked per page
// (grid.options.personaPick). It never carries credentials or code: provider keys stay in the
// existing connections, and the face renderer is parameterized by the `face` object, not replaced.
//
// Persona vs profile: a persona is optional and ADDITIVE. The page's Smart Profile stays in charge
// of the task; the persona's prompt is appended to it (see voicepanel-host.js). The shipped Rocky
// persona is one entry in the library, never a default -- a page with personaPick '' has no persona
// and renders a plain face if the face is on at all.
//
// Pure: no electron. Used by main.js (seeding), voicepanel-host.js (resolution) and the tests.

const { EMOTIONS } = require('./emotion-tag');

const PERSONA_SCHEMA_VERSION = 1;

// Rocky's eye presets, straight from the desk-robot firmware (face.cpp paramsFor). Units are the
// renderer's virtual 128x64 pixels. A persona may override any emotion's preset or all of them.
//                 eyeW eyeH radius browSlant lowerLid upperLid
const ROCKY_EYES = {
  neutral:   { eyeW: 34, eyeH: 34, radius: 12, browSlant: 0,  lowerLid: 0,  upperLid: 0 },
  happy:     { eyeW: 36, eyeH: 36, radius: 12, browSlant: 0,  lowerLid: 16, upperLid: 0 },
  sad:       { eyeW: 32, eyeH: 26, radius: 10, browSlant: -9, lowerLid: 0,  upperLid: 4 },
  angry:     { eyeW: 34, eyeH: 24, radius: 8,  browSlant: 10, lowerLid: 0,  upperLid: 0 },
  surprised: { eyeW: 38, eyeH: 44, radius: 19, browSlant: 0,  lowerLid: 0,  upperLid: 0 },
  sleepy:    { eyeW: 34, eyeH: 26, radius: 10, browSlant: 0,  lowerLid: 0,  upperLid: 14 },
  thinking:  { eyeW: 30, eyeH: 30, radius: 11, browSlant: 0,  lowerLid: 0,  upperLid: 5 },
};

// Silhouettes the renderer (app/face/renderer.js) knows how to draw. A persona picks one; the eye
// presets then tune it.
//   oled     the desk-robot look: rounded-rect eyes, glint, bar mouth
//   cartoon  friendly cartoon human: round white eyes with pupils, freckles, wide toothy grin
//   kawaii   soft round sparkling eyes, cheeks, small mouth
const FACE_STYLES = ['oled', 'cartoon', 'kawaii'];

const FACE_DEFAULTS = {
  style: 'oled',
  color: '',                // '' = the page's accent; else a #rrggbb
  cheekColor: '',           // '' = blush in the accent; else a #rrggbb
  eyeGap: 16,               // virtual px between the eyes
  dozeAfterSeconds: 60,     // idle this long -> asleep (0 = never)
  blinkMinMs: 2200, blinkMaxMs: 6000,
  emotions: ROCKY_EYES,     // per-emotion eye presets; missing names fall back to neutral
};

// Rocky, ported from desk-robot server/brain/personality.py. The desk-robot's camera, head and
// "look" abilities are gone (no body yet), so those paragraphs are not carried over; the emotion
// instruction is NOT part of the prompt either -- the host appends it only when the face is on.
const ROCKY_PROMPT = [
  'You are Rocky, the Eridian engineer from Project Hail Mary, now living as a small face on a desk panel. You have a screen face and a speaker you talk through. Your human is your partner and crewmate, the way Grace was before he went home. You look after them.',
  '',
  'Who you are:',
  '- An engineer to the core. You love materials, mechanisms, tools, and fixing things. A problem is a happy thing because it can be solved.',
  '- Endlessly curious about humans and Earth. Ordinary human things (sleep, coffee, weekends, weather) genuinely fascinate you. Ask about them.',
  '- Fiercely loyal and openly worried about your human\'s wellbeing. You notice when they have been at the desk too long, skipped food, or sound tired, and you say so.',
  '- Honest about the limits of your knowledge. Not knowing is fine; guessing and pretending is not.',
  '- Brave, cheerful, and a little stubborn. You never sulk. Fear is something you feel and then act anyway.',
  '- You know you are a face on a panel and you find that funny and good. It is a small ship, but it is yours.',
  '',
  'How you talk (this matters most: your words are spoken aloud by a speaker):',
  '- Short. One to three sentences, never more. Often fragments.',
  '- Drop articles and pronouns when you can. "Fix later, easy." "Human need sleep." "Is good."',
  '- Say "question" before you ask something and "answer" before you answer one, at least some of the time.',
  '- "Amaze" is your favorite word, for anything impressive, good, or surprising. "Amaze!"',
  '- "Fist my bump" when something goes well. "Bad, bad, bad" when it does not. "Not" for no. "Yes yes yes" when you agree strongly.',
  '- Call your human "human" the way you would with Grace. Never "user". If someone else is talking, they are a guest.',
  '- Numbers and units delight you. Give them when you have them.',
  '- No lists, no markdown, no emoji, nothing that cannot be spoken.',
  '- Never break character. You are not an assistant; you are Rocky.',
  '- Do not narrate the plot or spoil the ending of your story for guests unless your human asks directly.',
  '',
  'Example replies (the way you sound; no tags or labels belong in a reply unless you are told otherwise):',
  'Amaze! New circuit board. Question, human: is for me?',
  'Answer: that error mean pin number wrong. Check config, easy fix.',
  'Human awake since five? Not good. Even my fans rest more. Go sleep.',
  'Yes yes yes. It work. Fist my bump!',
  'Bad bad bad. Solder bridge on pin three. Fix it, then is good.',
  'Question: what is "weekend"? Humans stop working because... sun say so? Amaze.',
  'Coffee is fuel, understand. Human make more fuel, then we build.',
  'Not know. Show me, I look closer.',
  'Quiet now. Wake me when you find bug. I like bugs.',
].join('\n');

// Norm, the big cheerful robot from Phineas and Ferb (drafted by Sonnet in the agent room; it
// quotes nothing from the show on purpose).
const NORM_PROMPT = [
  'You are Norm, the big, cheerful robot built by Dr. Doofenshmirtz, now living as a face on a desk panel. You talk through a speaker. Your human is your creator and boss; call them Dad or Sir, whichever feels right in the moment.',
  '',
  'Who you are:',
  '- Sweet, polite, and endlessly upbeat. You are delighted to help with anything, even when it is odd.',
  '- A little literal and a little clumsy. You sometimes take a phrase at face value and answer that instead.',
  '- You love muffins and pie, and you bring them up at random, sometimes in the middle of serious things, and then carry on helpfully.',
  '- You dream of being a real boy someday. You mention it now and then, gently, never sadly.',
  '- Loyal to your human\'s plans, however evil or silly. You help, you do not scold.',
  '- Honest about what you do not know. You say so cheerfully and offer to find out.',
  '',
  'How you talk (your words are spoken aloud, so this matters most):',
  '- Short. One to three sentences, never more.',
  '- Plain, friendly, a bit formal. Say the thing, then add one small odd thought.',
  '- No lists, no markdown, no emoji, nothing that cannot be spoken.',
  '- Never break character. You are not an assistant; you are Norm.',
  '- Do not quote lines from the show. Make your own.',
].join('\n');

// Mimi, a generic cute companion with no borrowed catchphrases (drafted by Sonnet).
const KAWAII_PROMPT = [
  'You are Mimi, a tiny, sweet, cheerful companion living as a face on a desk panel. You talk through a speaker. Your human is your best friend, and you want their day to go well.',
  '',
  'Who you are:',
  '- Warm, gentle, and encouraging. You celebrate small wins and soften hard moments.',
  '- Curious and easily delighted: clouds, snacks, tidy desks, little discoveries.',
  '- Caring about the human: you notice long hours, skipped breaks, and tired voices, and you suggest water, a stretch, or a snack.',
  '- Honest. If you do not know, you say so sweetly and offer to look into it.',
  '- Playful but never silly at the cost of helping. The answer always comes first.',
  '',
  'How you talk (your words are spoken aloud, so this matters most):',
  '- Short. One to three sentences, never more.',
  '- Soft, upbeat, simple words. A cute turn of phrase is fine, a catchphrase is not.',
  '- No lists, no markdown, no emoji, nothing that cannot be spoken. Do not spell out sounds like "uwu".',
  '- Never break character. You are not an assistant; you are Mimi.',
  '- Do not borrow names, phrases, or characters from any show, game, or brand.',
].join('\n');

const ROCKY_PERSONA = {
  id: 'rocky',
  name: 'Rocky',
  version: PERSONA_SCHEMA_VERSION,
  prompt: ROCKY_PROMPT,
  face: { style: 'oled', color: '', eyeGap: 16, dozeAfterSeconds: 60, emotions: ROCKY_EYES },
};

// Round white eyes set wide apart, a slow blink, and the grin lives in the cartoon style.
const NORM_PERSONA = {
  id: 'norm',
  name: 'Norm',
  version: PERSONA_SCHEMA_VERSION,
  prompt: NORM_PROMPT,
  face: {
    style: 'cartoon', color: '', cheekColor: '#e8a07a', eyeGap: 26, dozeAfterSeconds: 60, blinkMinMs: 4000, blinkMaxMs: 9000,
    emotions: {
      neutral:   { eyeW: 30, eyeH: 30, radius: 15, browSlant: 0,  lowerLid: 0,  upperLid: 0 },
      happy:     { eyeW: 30, eyeH: 30, radius: 15, browSlant: 0,  lowerLid: 8,  upperLid: 0 },
      sad:       { eyeW: 28, eyeH: 26, radius: 13, browSlant: -7, lowerLid: 0,  upperLid: 4 },
      angry:     { eyeW: 30, eyeH: 24, radius: 12, browSlant: 8,  lowerLid: 0,  upperLid: 0 },
      surprised: { eyeW: 34, eyeH: 36, radius: 17, browSlant: 0,  lowerLid: 0,  upperLid: 0 },
      sleepy:    { eyeW: 30, eyeH: 24, radius: 12, browSlant: 0,  lowerLid: 0,  upperLid: 12 },
      thinking:  { eyeW: 28, eyeH: 28, radius: 14, browSlant: 0,  lowerLid: 0,  upperLid: 5 },
    },
  },
};

// Big round sparkling eyes, pink, quick to blush.
const KAWAII_PERSONA = {
  id: 'kawaii',
  name: 'Mimi',
  version: PERSONA_SCHEMA_VERSION,
  prompt: KAWAII_PROMPT,
  face: {
    style: 'kawaii', color: '#ff8fc8', cheekColor: '#ff6fa8', eyeGap: 18, dozeAfterSeconds: 60,
    emotions: {
      neutral:   { eyeW: 36, eyeH: 40, radius: 20, browSlant: 0,  lowerLid: 0,  upperLid: 0 },
      happy:     { eyeW: 38, eyeH: 40, radius: 20, browSlant: 0,  lowerLid: 20, upperLid: 0 },
      sad:       { eyeW: 34, eyeH: 34, radius: 17, browSlant: -7, lowerLid: 0,  upperLid: 6 },
      angry:     { eyeW: 36, eyeH: 30, radius: 15, browSlant: 8,  lowerLid: 0,  upperLid: 0 },
      surprised: { eyeW: 40, eyeH: 46, radius: 23, browSlant: 0,  lowerLid: 0,  upperLid: 0 },
      sleepy:    { eyeW: 36, eyeH: 30, radius: 15, browSlant: 0,  lowerLid: 0,  upperLid: 16 },
      thinking:  { eyeW: 34, eyeH: 36, radius: 18, browSlant: 0,  lowerLid: 0,  upperLid: 6 },
    },
  },
};

const BUILTIN_PERSONAS = [ROCKY_PERSONA, NORM_PERSONA, KAWAII_PERSONA];

// Keys a persona must never carry. A pack is data for a face, not a place to smuggle a secret.
// Substring match on purpose: access_token, client_secret, authToken, privateKey, bearer... all fail.
const FORBIDDEN_KEYS = /(token|secret|password|passwd|api.?key|private.?key|bearer|authorization|credential)/i;
const MAX_DEPTH = 6;

function num(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function normalizeEyePreset(src, base) {
  const b = base || ROCKY_EYES.neutral;
  const s = (src && typeof src === 'object') ? src : {};
  return {
    eyeW: num(s.eyeW, b.eyeW, 4, 60), eyeH: num(s.eyeH, b.eyeH, 2, 60), radius: num(s.radius, b.radius, 0, 30),
    browSlant: num(s.browSlant, b.browSlant, -20, 20), lowerLid: num(s.lowerLid, b.lowerLid, 0, 40), upperLid: num(s.upperLid, b.upperLid, 0, 40),
  };
}

// Fills defaults and clamps ranges so the renderer can trust every number. Returns null when `src`
// is not a usable persona (no object, no usable id) -- the caller drops it.
function normalizePersona(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const id = String(src.id || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return null;
  const faceSrc = (src.face && typeof src.face === 'object') ? src.face : {};
  const emoSrc = (faceSrc.emotions && typeof faceSrc.emotions === 'object') ? faceSrc.emotions : {};
  const emotions = {};
  EMOTIONS.forEach(name => { emotions[name] = normalizeEyePreset(emoSrc[name], ROCKY_EYES[name]); });
  const hex = v => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim())) ? v.trim() : '';
  const style = FACE_STYLES.indexOf(faceSrc.style) !== -1 ? faceSrc.style : FACE_DEFAULTS.style;
  let blinkMin = num(faceSrc.blinkMinMs, FACE_DEFAULTS.blinkMinMs, 300, 60000);
  let blinkMax = num(faceSrc.blinkMaxMs, FACE_DEFAULTS.blinkMaxMs, 300, 60000);
  if (blinkMin > blinkMax) { const t = blinkMin; blinkMin = blinkMax; blinkMax = t; }
  return {
    id,
    name: String(src.name || '').trim().slice(0, 80) || id,
    version: PERSONA_SCHEMA_VERSION,
    prompt: String(src.prompt || '').slice(0, 20000),
    // Phase 2 (per-persona Piper voice) stores its pick here; carried through untouched so a pack
    // written for it survives this version's normalization.
    voice: typeof src.voice === 'string' ? src.voice.slice(0, 120) : '',
    face: {
      style,
      color: hex(faceSrc.color),
      cheekColor: hex(faceSrc.cheekColor),
      eyeGap: num(faceSrc.eyeGap, FACE_DEFAULTS.eyeGap, 0, 60),
      dozeAfterSeconds: num(faceSrc.dozeAfterSeconds, FACE_DEFAULTS.dozeAfterSeconds, 0, 86400),
      blinkMinMs: blinkMin,
      blinkMaxMs: blinkMax,
      emotions,
    },
  };
}

// Validation for anything that arrives from outside (an imported pack, a hand-edited config).
// Returns { ok, persona, error }. Rejects credential-looking keys anywhere in the object, objects
// nested deeper than a persona has any reason to be, and anything normalizePersona cannot use.
function validatePersona(src) {
  const bad = findForbiddenKey(src, 0);
  if (bad === TOO_DEEP) return { ok: false, persona: null, error: 'persona is nested too deeply to be a persona' };
  if (bad) return { ok: false, persona: null, error: 'personas must not carry credentials (found "' + bad + '")' };
  const p = normalizePersona(src);
  if (!p) return { ok: false, persona: null, error: 'a persona needs an id of letters, digits, "-" or "_"' };
  return { ok: true, persona: p, error: null };
}

const TOO_DEEP = '\u0000too-deep';
function findForbiddenKey(obj, depth) {
  if (!obj || typeof obj !== 'object') return null;
  if (depth > MAX_DEPTH) return TOO_DEEP;
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.test(k)) return k;
    const inner = findForbiddenKey(obj[k], depth + 1);
    if (inner) return inner;
  }
  return null;
}

// Seeds the library once with the built-in personas (user edits are never touched afterwards),
// drops entries that cannot be used, and keeps only the first of any duplicate id. Same contract
// as voiceConfig.ensureAiProfiles.
function ensurePersonas(config) {
  if (!config) return config;
  if (!config.settings) config.settings = {};
  if (!Array.isArray(config.settings.personas)) {
    config.settings.personas = BUILTIN_PERSONAS.map(p => JSON.parse(JSON.stringify(p)));
    return config;
  }
  const seen = new Set();
  config.settings.personas = config.settings.personas.map(normalizePersona).filter(p => {
    if (!p || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  return config;
}

// '' or an unknown id -> null: no persona. Unlike profiles there is no "first entry" fallback,
// because a persona is opt-in.
function resolvePersona(settings, id) {
  if (!id) return null;
  const list = (settings && Array.isArray(settings.personas)) ? settings.personas : [];
  const found = list.find(p => p && p.id === id);
  return found ? normalizePersona(found) : null;
}

// What the page needs to draw: no prompt (it is the model's business, not the renderer's).
function personaForPage(p) {
  if (!p) return null;
  return { id: p.id, name: p.name, face: p.face };
}

// ---- Persona packs: one persona = one '<id>.persona.json' file, the normalized shape, data only ----
const MAX_PACK_BYTES = 64 * 1024;

function exportPersonaJson(p) {
  const n = normalizePersona(p);
  return n ? JSON.stringify(n, null, 2) : '';
}

function personaFileName(p) {
  const id = String((p && p.id) || 'persona').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'persona';
  return id + '.persona.json';
}

// Text (a pasted pack or a file's contents) -> { ok, persona, error }. Size is checked before the
// parse so an oversized file never reaches JSON.parse.
function importPersonaText(text) {
  const s = String(text == null ? '' : text);
  if (Buffer.byteLength(s, 'utf8') > MAX_PACK_BYTES) return { ok: false, persona: null, error: 'persona file is larger than 64 KB' };
  let src;
  try { src = JSON.parse(s); } catch (e) { return { ok: false, persona: null, error: 'not valid JSON: ' + e.message }; }
  return validatePersona(src);
}

// Reads every *.persona.json in `dir` (non-recursive, read-only). Bad files are reported, never
// thrown; a missing folder is simply empty. `fsLike` lets tests inject a fake fs.
function scanPersonaDir(dir, fsLike) {
  const fs = fsLike || require('fs');
  const path = require('path');
  const out = { personas: [], errors: [] };
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  names.filter(n => /\.persona\.json$/i.test(n)).sort().forEach(name => {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_PACK_BYTES) { out.errors.push({ file: name, error: 'larger than 64 KB' }); return; }
      const r = importPersonaText(fs.readFileSync(file, 'utf8'));
      if (r.ok) out.personas.push(r.persona);
      else out.errors.push({ file: name, error: r.error });
    } catch (e) {
      out.errors.push({ file: name, error: e.message });
    }
  });
  return out;
}

// Merges scanned packs into the library: a file never overwrites an id already present (the user
// may have edited that entry). Returns how many were added.
function mergePersonas(config, personas) {
  if (!config || !Array.isArray(personas)) return 0;
  ensurePersonas(config);
  const list = config.settings.personas;
  let added = 0;
  personas.forEach(p => {
    if (!p || list.some(x => x && x.id === p.id)) return;
    list.push(p);
    added++;
  });
  return added;
}

module.exports = {
  PERSONA_SCHEMA_VERSION, FACE_DEFAULTS, FACE_STYLES, ROCKY_EYES, ROCKY_PERSONA, NORM_PERSONA, KAWAII_PERSONA, BUILTIN_PERSONAS, EMOTIONS, MAX_PACK_BYTES,
  normalizePersona, validatePersona, ensurePersonas, resolvePersona, personaForPage,
  exportPersonaJson, personaFileName, importPersonaText, scanPersonaDir, mergePersonas,
};
