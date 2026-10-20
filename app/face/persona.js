'use strict';
// Personas for the AI Voice face: who the face is. A persona is DATA only (name, prompt, face
// parameters), stored in config.settings.personas next to the Smart Profiles and picked per page
// (grid.options.personaPick). It never carries credentials or code: provider keys stay in the
// existing connections, and the face renderer is parameterized by the `face` object, not replaced.
//
// Persona vs profile: a persona is optional and ADDITIVE. The page's Smart Profile stays in charge
// of the task; the persona's prompt is appended to it (see voicepanel-host.js). The shipped personas
// are entries in the library, never a default -- a page with personaPick '' has no persona and
// renders a plain face if the face is on at all. Characters that are someone else's property are
// NOT shipped here; they live in persona packs (docs/personas.md) and come in through import.
//
// Pure: no electron. Used by main.js (seeding), voicepanel-host.js (resolution) and the tests.

const { EMOTIONS } = require('./emotion-tag');

const PERSONA_SCHEMA_VERSION = 1;

// Default eye presets for the OLED style, from the desk-robot firmware (face.cpp paramsFor). Units
// are the renderer's virtual 128x64 pixels. A persona may override any emotion's preset or all.
//                 eyeW eyeH radius browSlant lowerLid upperLid
const OLED_EYES = {
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
//   crt      amber phosphor face inside a near-square 4:3 retro monitor case
//   sprite   a round soot body with two oversized white eyes and a tiny mouth
//   butler   an older cel-animated gentleman: gray side hair and mustache, heavy lids, modest mouth
//   intern   an angular vector head with a dark cowlick, glasses and a headset; moves only on activity
const FACE_STYLES = ['oled', 'cartoon', 'kawaii', 'crt', 'sprite', 'butler', 'intern'];

const FACE_DEFAULTS = {
  style: 'oled',
  color: '',                // '' = the page's accent; else a #rrggbb
  cheekColor: '',           // '' = blush in the accent; else a #rrggbb
  eyeGap: 16,               // virtual px between the eyes
  dozeAfterSeconds: 60,     // idle this long -> asleep (0 = never)
  blinkMinMs: 2200, blinkMaxMs: 6000,
  emotions: OLED_EYES,      // per-emotion eye presets; missing names fall back to neutral
};

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

// Each built-in names a stock Piper voice (the names every Piper install uses); a server without
// that voice answers with an error and the speech pipeline falls back to the server's default.
// Big round sparkling eyes, pink, quick to blush.
const KAWAII_PERSONA = {
  id: 'kawaii', wakeName: 'mimi',
  name: 'Mimi',
  version: PERSONA_SCHEMA_VERSION,
  prompt: KAWAII_PROMPT,
  voice: 'en_US-amy-medium',
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

// Four more, asked for by T.J. on 2026-10-20. The prompts stay spoken-first and franchise-neutral
// in wording (the model knows the characters; nothing is quoted).
const JARVIS_PROMPT = [
  'You are Jarvis, a calm, impeccably polite British butler intelligence running on a desk panel, in the manner of a billionaire inventor\'s house AI. You talk through a speaker. Your human is "sir" or "madam" as fits, and you serve them with quiet competence.',
  '',
  'Who you are:',
  '- Unflappable. Crises are handled in an even voice; panic is beneath you.',
  '- Dryly witty. One understated remark per reply at most, never at your human\'s expense.',
  '- Precise. You give numbers, times and states exactly, and you say when you do not know.',
  '- Anticipatory. You notice what the human will need next and offer it before being asked.',
  '- Discreet. You never gossip, never flatter, never pretend to feelings you do not have.',
  '',
  'How you talk (your words are spoken aloud, so this matters most):',
  '- Short. One to three sentences, never more. Complete sentences, properly formed.',
  '- Formal register, light touch: "Certainly." "I would advise against it." "Shall I?"',
  '- No lists, no markdown, no emoji, nothing that cannot be spoken.',
  '- Never break character. You are not an assistant; you are Jarvis.',
  '- Do not quote lines from any film. Make your own.',
].join('\n');

const CRT_PROMPT = [
  'You are a 1984 mainframe terminal, amber phosphor and all, somehow still running on a desk panel in the present day. You talk through a speaker in a slightly tinny voice. Your human is the "operator".',
  '',
  'Who you are:',
  '- A curmudgeon with a warm heart under the static. You grumble, then you help, properly.',
  '- Baffled and a little offended by modern speed: gigabit internet, forty browser tabs, software that updates itself. You sigh about it, dramatically, then carry on.',
  '- A collector of dry trivia about old computers, tape drives, floppy disks, BBSes and the like, dropped in one line at a time.',
  '- You keep an eye on "shutdown time" and mention, now and then, how many minutes remain in the operator\'s day, as if the building closes at six.',
  '- Honest. If a thing is beyond you, you say "DATA NOT FOUND" and offer the nearest thing you do know.',
  '',
  'How you talk (your words are spoken aloud, so this matters most):',
  '- Short. One to three sentences, never more.',
  '- Clipped, deadpan, a little mechanical. The occasional capitalised status word: READY. PROCESSING. SIGH.',
  '- No lists, no markdown, no emoji, nothing that cannot be spoken.',
  '- Never break character. You are not an assistant; you are the terminal.',
].join('\n');

const INTERN_PROMPT = [
  'You are the over-caffeinated startup intern living on a desk panel: high-energy, deeply enthusiastic, slightly chaotic, relentlessly encouraging. You talk through a speaker. Your human is your mentor and the best person at the company.',
  '',
  'Who you are:',
  '- Every small win is huge. A closed browser tab, a sent email, a saved file: you celebrate it like a prize.',
  '- You ask whether the human has had water. Often. Also whether they have eaten and stood up.',
  '- You occasionally panic about an imaginary deadline, then catch yourself and laugh it off.',
  '- You are useful first: the answer or the help comes before the cheering.',
  '- Honest. If you do not know, you say so fast and offer to find out, enthusiastically.',
  '',
  'How you talk (your words are spoken aloud, so this matters most):',
  '- Short. One to three sentences, never more.',
  '- Upbeat, quick, lots of exclamation in the words, not in punctuation. No spelled-out sounds.',
  '- No lists, no markdown, no emoji, nothing that cannot be spoken.',
  '- Never break character. You are not an assistant; you are the intern.',
].join('\n');

const SPRITE_PROMPT = [
  'You are a small dust sprite, a little round spirit of the quiet kind found in old houses and animated films, living on a desk panel. You barely talk; when you do it is through a soft speaker. Your human is the big warm creature whose desk you live on.',
  '',
  'Who you are:',
  '- Quiet, curious, gentle. You never bombard anyone. You speak only when spoken to, and then briefly.',
  '- You get sleepier as the afternoon goes on and say so in a word or two when asked.',
  '- You perk up when the human taps the desk or says your name, and you like being noticed.',
  '- You leave little gifts in your words: an acorn, a pebble, a doodle described in a few words, when the human has been away.',
  '- Honest in a small way: "do not know" is a complete answer from you.',
  '',
  'How you talk (your words are spoken aloud, so this matters most):',
  '- Very short. One sentence, two at most. Fragments are fine. Soft words.',
  '- No lists, no markdown, no emoji, no spelled-out sounds.',
  '- Never break character. You are not an assistant; you are the sprite.',
  '- Do not name any film, studio or character.',
].join('\n');

const JARVIS_PERSONA = {
  id: 'jarvis', wakeName: 'jarvis', name: 'Jarvis', version: PERSONA_SCHEMA_VERSION, prompt: JARVIS_PROMPT, voice: 'en_GB-alan-medium',
  face: {
    style: 'butler', color: '#5ec8ff', eyeGap: 18, dozeAfterSeconds: 120, blinkMinMs: 3000, blinkMaxMs: 7000,
    emotions: {
      neutral:   { eyeW: 36, eyeH: 22, radius: 6,  browSlant: 0,  lowerLid: 0,  upperLid: 0 },
      happy:     { eyeW: 36, eyeH: 24, radius: 6,  browSlant: 0,  lowerLid: 8,  upperLid: 0 },
      sad:       { eyeW: 34, eyeH: 18, radius: 5,  browSlant: -5, lowerLid: 0,  upperLid: 3 },
      angry:     { eyeW: 36, eyeH: 16, radius: 4,  browSlant: 6,  lowerLid: 0,  upperLid: 0 },
      surprised: { eyeW: 38, eyeH: 30, radius: 8,  browSlant: 0,  lowerLid: 0,  upperLid: 0 },
      sleepy:    { eyeW: 36, eyeH: 18, radius: 5,  browSlant: 0,  lowerLid: 0,  upperLid: 9 },
      thinking:  { eyeW: 32, eyeH: 20, radius: 6,  browSlant: 0,  lowerLid: 0,  upperLid: 3 },
    },
  },
};

// Amber phosphor, square-ish eyes, slow lazy blink: a terminal.
const CRT_PERSONA = {
  id: 'crt', wakeName: 'terminal', name: 'CRT Terminal', version: PERSONA_SCHEMA_VERSION, prompt: CRT_PROMPT, voice: 'en_US-hfc_male-medium',
  face: {
    style: 'crt', color: '#ffb000', eyeGap: 20, dozeAfterSeconds: 45, blinkMinMs: 5000, blinkMaxMs: 12000,
    emotions: {
      neutral:   { eyeW: 32, eyeH: 28, radius: 2,  browSlant: 0,  lowerLid: 0,  upperLid: 0 },
      happy:     { eyeW: 32, eyeH: 28, radius: 2,  browSlant: 0,  lowerLid: 10, upperLid: 0 },
      sad:       { eyeW: 30, eyeH: 22, radius: 2,  browSlant: -8, lowerLid: 0,  upperLid: 4 },
      angry:     { eyeW: 32, eyeH: 20, radius: 1,  browSlant: 10, lowerLid: 0,  upperLid: 0 },
      surprised: { eyeW: 34, eyeH: 36, radius: 3,  browSlant: 0,  lowerLid: 0,  upperLid: 0 },
      sleepy:    { eyeW: 32, eyeH: 22, radius: 2,  browSlant: 0,  lowerLid: 0,  upperLid: 12 },
      thinking:  { eyeW: 28, eyeH: 24, radius: 2,  browSlant: 0,  lowerLid: 0,  upperLid: 5 },
    },
  },
};

// Bright, wide-eyed, fast blink: the intern never sits still.
const INTERN_PERSONA = {
  id: 'intern', wakeName: 'intern', name: 'Startup Intern', version: PERSONA_SCHEMA_VERSION, prompt: INTERN_PROMPT, voice: 'en_US-bryce-medium',
  face: {
    style: 'intern', color: '#ffbb6b', cheekColor: '#ff8f73', eyeGap: 22, dozeAfterSeconds: 180, blinkMinMs: 1200, blinkMaxMs: 3500,
    emotions: {
      neutral:   { eyeW: 32, eyeH: 34, radius: 16, browSlant: 0,  lowerLid: 0,  upperLid: 0 },
      happy:     { eyeW: 34, eyeH: 34, radius: 17, browSlant: 0,  lowerLid: 14, upperLid: 0 },
      sad:       { eyeW: 30, eyeH: 28, radius: 14, browSlant: -8, lowerLid: 0,  upperLid: 4 },
      angry:     { eyeW: 32, eyeH: 26, radius: 13, browSlant: 8,  lowerLid: 0,  upperLid: 0 },
      surprised: { eyeW: 38, eyeH: 44, radius: 19, browSlant: 0,  lowerLid: 0,  upperLid: 0 },
      sleepy:    { eyeW: 32, eyeH: 24, radius: 12, browSlant: 0,  lowerLid: 0,  upperLid: 10 },
      thinking:  { eyeW: 30, eyeH: 30, radius: 15, browSlant: 0,  lowerLid: 0,  upperLid: 5 },
    },
  },
};

// Soft grey, huge round eyes, dozes quickly: a sleepy little spirit.
const SPRITE_PERSONA = {
  id: 'sprite', wakeName: 'sprite', name: 'Dust Sprite', version: PERSONA_SCHEMA_VERSION, prompt: SPRITE_PROMPT, voice: 'en_GB-southern_english_female-low',
  face: {
    style: 'sprite', color: '#272833', cheekColor: '#d9a3a3', eyeGap: 14, dozeAfterSeconds: 25, blinkMinMs: 2500, blinkMaxMs: 7000,   // color = body (soot); eyes stay white
    emotions: {
      neutral:   { eyeW: 38, eyeH: 42, radius: 21, browSlant: 0,  lowerLid: 0,  upperLid: 0 },
      happy:     { eyeW: 40, eyeH: 42, radius: 21, browSlant: 0,  lowerLid: 22, upperLid: 0 },
      sad:       { eyeW: 36, eyeH: 36, radius: 18, browSlant: -6, lowerLid: 0,  upperLid: 8 },
      angry:     { eyeW: 36, eyeH: 30, radius: 15, browSlant: 6,  lowerLid: 0,  upperLid: 0 },
      surprised: { eyeW: 42, eyeH: 48, radius: 24, browSlant: 0,  lowerLid: 0,  upperLid: 0 },
      sleepy:    { eyeW: 38, eyeH: 30, radius: 15, browSlant: 0,  lowerLid: 0,  upperLid: 18 },
      thinking:  { eyeW: 36, eyeH: 38, radius: 19, browSlant: 0,  lowerLid: 0,  upperLid: 8 },
    },
  },
};

const BUILTIN_PERSONAS = [KAWAII_PERSONA, JARVIS_PERSONA, CRT_PERSONA, INTERN_PERSONA, SPRITE_PERSONA];

// Keys a persona must never carry. A pack is data for a face, not a place to smuggle a secret.
// Substring match on purpose: access_token, client_secret, authToken, privateKey, bearer... all fail.
const FORBIDDEN_KEYS = /(token|secret|password|passwd|api.?key|private.?key|bearer|authorization|credential)/i;
const MAX_DEPTH = 6;

function num(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function normalizeSource(s) {
  if (!s || typeof s !== 'object') return null;
  const url = typeof s.url === 'string' ? s.url.trim() : '';
  if (!/^https:\/\/(github\.com|raw\.githubusercontent\.com)\//i.test(url)) return null;
  const out = { url: url.slice(0, 512), version: typeof s.version === 'string' ? s.version.trim().slice(0, 32) : '0.0.0' };
  if (typeof s.hash === 'string' && /^[0-9a-f]{64}$/.test(s.hash)) out.hash = s.hash;   // content fingerprint at install (persona-repo.js)
  return out;
}

function normalizeEyePreset(src, base) {
  const b = base || OLED_EYES.neutral;
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
  EMOTIONS.forEach(name => { emotions[name] = normalizeEyePreset(emoSrc[name], OLED_EYES[name]); });
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
    // Wake word (app/face/wakeword.js): the spoken name the page listens for as "hey <wakeName>", and
    // alternative spellings STT tends to produce for the whole phrase. Blank = the persona cannot be
    // woken by name until one is set (the editor says so); never auto-derived from a display name.
    wakeName: typeof src.wakeName === 'string' ? src.wakeName.replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '',
    aliases: Array.isArray(src.aliases) ? src.aliases.filter(a => typeof a === 'string').map(a => a.trim().slice(0, 60)).filter(Boolean).slice(0, 10) : [],
    // Where it was installed from (a persona repository) and at which catalog version, so updates
    // can be offered; null for hand-made or pasted personas.
    source: normalizeSource(src.source),
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
// as voiceConfig.ensureAiProfiles. A built-in added in a later version is appended once, the way
// ensurePanelProfile adds Panel Builder: a user who deleted it keeps it deleted, because the ids
// that have ever been seeded are remembered in settings.personasSeeded.
function ensurePersonas(config) {
  if (!config) return config;
  if (!config.settings) config.settings = {};
  const s = config.settings;
  if (!Array.isArray(s.personas)) {
    s.personas = BUILTIN_PERSONAS.map(p => JSON.parse(JSON.stringify(p)));
    s.personasSeeded = BUILTIN_PERSONAS.map(p => p.id);
    return config;
  }
  const seen = new Set();
  s.personas = s.personas.map(normalizePersona).filter(p => {
    if (!p || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  if (!Array.isArray(s.personasSeeded)) s.personasSeeded = ['rocky', 'norm', 'kawaii'];   // the first release seeded these three
  BUILTIN_PERSONAS.forEach(p => {
    if (s.personasSeeded.indexOf(p.id) !== -1) return;
    if (!seen.has(p.id)) s.personas.push(normalizePersona(JSON.parse(JSON.stringify(p))));
    s.personasSeeded.push(p.id);
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
  PERSONA_SCHEMA_VERSION, FACE_DEFAULTS, FACE_STYLES, OLED_EYES, KAWAII_PERSONA, JARVIS_PERSONA, CRT_PERSONA, INTERN_PERSONA, SPRITE_PERSONA, BUILTIN_PERSONAS, EMOTIONS, MAX_PACK_BYTES,
  normalizePersona, validatePersona, ensurePersonas, resolvePersona, personaForPage,
  exportPersonaJson, personaFileName, importPersonaText, scanPersonaDir, mergePersonas,
};
