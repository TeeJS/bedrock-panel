'use strict';
// Wake word for AI Voice pages, phase 1: the transcript gate. Pure: no electron, no DOM, no clock
// of its own (the state machine takes `now`). The host (voicepanel-host.js) runs the matcher on
// the STT text of each utterance and the state machine decides what becomes a turn.
//
// Vocabulary: the PHRASE is what the user must say ("hey jarvis"); ALIASES are alternative spellings
// of the same phrase as STT tends to produce them ("hey jarvus"); both are matched the same way.
// Matching normalizes a COPY of the text (case, punctuation, spacing); the command returned to the
// caller is the STT's original text with only the phrase and its trailing punctuation removed, so
// code and dictation keep their case and punctuation.

const MAX_PHRASE_LEN = 60;

// Lowercase, punctuation -> space, collapse spaces. Keeps letters, digits and apostrophes.
function normalizeForMatch(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// A spoken name worth auto-filling: one clean pronounceable word (letters only, 3-16 chars). Display
// names like "CRT Terminal", "Startup Intern", "J.A.R.V.I.S." or an imported "Dr. X" get no auto-fill:
// the editor asks for a spoken alias and shows the exact resolved phrase.
function autoWakeName(displayName) {
  const s = String(displayName == null ? '' : displayName).trim();
  return /^\p{L}{3,16}$/u.test(s) ? s.toLowerCase() : '';
}

// The phrase a page listens for, and whether it can: page override > persona wakeName > nothing.
// Returns { ready, phrase, aliases, reason }. `reason` explains a not-ready result for the UI.
function resolvePhrase({ persona, pageOverride, pageDefault }) {
  const override = normalizeForMatch(pageOverride);
  if (override) return finish(override, []);
  const p = persona || null;
  const wakeName = p && typeof p.wakeName === 'string' ? normalizeForMatch(p.wakeName) : '';
  if (wakeName) return finish('hey ' + wakeName, Array.isArray(p.aliases) ? p.aliases : []);
  if (p) return { ready: false, phrase: '', aliases: [], reason: 'The persona "' + (p.name || p.id) + '" has no spoken name yet. Set its Wake name in Settings → Personas, or give this page its own wake phrase.' };
  const dflt = normalizeForMatch(pageDefault);
  if (dflt) return finish(dflt, []);
  return { ready: false, phrase: '', aliases: [], reason: 'No wake phrase: pick a persona with a spoken name or set a wake phrase for this page.' };
  function finish(phrase, aliases) {
    if (phrase.length > MAX_PHRASE_LEN) return { ready: false, phrase: '', aliases: [], reason: 'The wake phrase is too long (max ' + MAX_PHRASE_LEN + ' characters).' };
    if (!/\s/.test(phrase)) return { ready: false, phrase: '', aliases: [], reason: 'Use at least two words ("hey ' + phrase + '"): a single word wakes the page on everyday speech.' };
    const al = aliases.map(normalizeForMatch).filter(a => a && a !== phrase && a.length <= MAX_PHRASE_LEN);
    return { ready: true, phrase, aliases: Array.from(new Set(al)), reason: '' };
  }
}

// Builds the matcher for one resolved phrase. match(text) -> { wake:false } or
// { wake:true, phrase, commandText } where commandText keeps the STT's original text after the
// phrase (and its trailing punctuation), '' when the phrase stood alone. Anchored: the phrase must be
// the first words of the utterance and end on a word boundary ("hey norm" never matches "hey normal").
function createWakeMatcher({ phrase, aliases }) {
  const forms = [phrase].concat(Array.isArray(aliases) ? aliases : []).map(normalizeForMatch).filter(Boolean);
  const res = forms.map(f => new RegExp('^\\s*' + f.split(' ').map(escapeRe).join('[\\s\\p{P}]+') + '(?![\\p{L}\\p{N}\'])', 'iu'));
  function match(text) {
    const raw = String(text == null ? '' : text);
    for (let i = 0; i < res.length; i++) {
      const m = res[i].exec(raw);
      if (!m) continue;
      let rest = raw.slice(m[0].length);
      rest = rest.replace(/^[\s\p{P}]+/u, '');   // the comma/period after the name, then the command as spoken
      return { wake: true, phrase: forms[i], commandText: rest };
    }
    return { wake: false };
  }
  return { match, forms };
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// The page's wake state machine. States:
//   off        wake word disabled for this page, or mic closed: everything passes as today
//   waiting    mic open, only the phrase counts
//   listening  phrase heard alone: the human has `windowMs` to START a request
//   active     a request is with the model / being spoken: unaddressed speech is dropped
//   followup   the reply is done and `followUpMs` > 0: the human may speak without the phrase
//   cooldown   just after playback ended: nothing counts for `cooldownMs` (echo guard)
// `now` is injected (ms). Decisions come back from the event methods; the host acts on them.
function createWakeState(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const windowMs = o.windowMs != null ? o.windowMs : 8000;
  const cooldownMs = o.cooldownMs != null ? o.cooldownMs : 1200;
  let followUpMs = o.followUpMs != null ? o.followUpMs : 0;
  let matcher = o.matcher || null;
  let state = 'off';
  let until = 0;            // when listening / followup / cooldown ends
  let gen = 0;              // bumped on arm/disarm/phrase change: stale utterances are dropped
  let pendingAfterActive = null;   // where to go when the reply is over (set when the turn starts)
  let lastWindow = null;           // {state, until} of the listening/follow-up window that last expired: a
                                   // request begun inside it still counts when its STT lands after the expiry

  function snapshot() {
    tick();
    return { state, until: (state === 'listening' || state === 'followup' || state === 'cooldown') ? until : 0, gen, followUpMs, windowMs };
  }
  function set(next, ms) { state = next; until = ms ? now() + ms : 0; }
  // Expire timed states. Called before every decision and by the host's timer.
  function tick() {
    const t = now();
    if ((state === 'listening' || state === 'followup') && until && t >= until) { lastWindow = { state, until }; set('waiting', 0); }
    else if (state === 'cooldown' && until && t >= until) {
      // Timed from the cooldown's END, not from this (possibly late) tick: a lazy tick must never
      // stretch a follow-up window.
      const end = until, next = pendingAfterActive || 'waiting';
      pendingAfterActive = null;
      state = next; until = next === 'followup' ? end + followUpMs : 0;
      if (next === 'followup' && t >= until) set('waiting', 0);
    }
    return state;
  }
  function arm(m) { if (m) matcher = m; gen++; lastWindow = null; set(matcher ? 'waiting' : 'off', 0); return gen; }
  function disarm() { gen++; set('off', 0); pendingAfterActive = null; lastWindow = null; return gen; }
  function setMatcher(m) { matcher = m; lastWindow = null; if (state !== 'off') { gen++; set('waiting', 0); } return gen; }
  function setFollowUpMs(ms) { followUpMs = Math.max(0, Number(ms) || 0); }

  // An utterance's STT text arrived. Returns { action: 'pass' | 'drop' | 'turn' | 'listen', commandText?, reason }.
  //   pass   wake is off: the host treats the text exactly as today
  //   turn   addressed: send commandText as the turn
  //   listen the phrase alone: the listening window is open
  //   drop   unaddressed, stale, or arrived while active/cooldown
  // `startedAt` (ms) is when the human started this utterance: a request begun inside a listening or
  // follow-up window counts even when STT hands it back after the window has closed.
  function onUtterance(text, utteranceGen, startedAt) {
    tick();
    if (startedAt != null) {
      // Begun inside a window that has since expired (the host's timer already ticked it to waiting,
      // or this tick did): bring that window back for this one decision.
      if (state === 'waiting' && lastWindow && startedAt < lastWindow.until && (utteranceGen === undefined || utteranceGen === gen)) { state = lastWindow.state; until = now() + 1; }
      lastWindow = null;
    }
    if (state === 'off') return { action: 'pass', commandText: String(text == null ? '' : text) };
    if (utteranceGen !== undefined && utteranceGen !== gen) return { action: 'drop', reason: 'stale' };
    if (state === 'active' || state === 'cooldown') return { action: 'drop', reason: state };
    const raw = String(text == null ? '' : text);
    if (!raw.trim()) return { action: 'drop', reason: 'empty' };
    if (state === 'listening' || state === 'followup') {
      // The human is expected to speak without the phrase; if they say it anyway, strip it.
      const m = matcher ? matcher.match(raw) : { wake: false };
      const cmd = m.wake ? m.commandText : raw;
      if (!cmd.trim()) { set('listening', windowMs); return { action: 'listen', reason: 'phrase-again' }; }
      return { action: 'turn', commandText: cmd, reason: state };   // onTurnStart follows; a late-window state expires on its next tick
    }
    // waiting
    const m = matcher ? matcher.match(raw) : { wake: false };
    if (!m.wake) return { action: 'drop', reason: 'unaddressed' };
    if (!m.commandText.trim()) { set('listening', windowMs); return { action: 'listen', reason: 'phrase-alone' }; }
    return { action: 'turn', commandText: m.commandText, reason: 'addressed' };
  }
  // The host sent a turn (ours or a typed one): the page is active until the reply is over.
  function onTurnStart() { if (state === 'off') return; lastWindow = null; set('active', 0); pendingAfterActive = followUpMs > 0 ? 'followup' : 'waiting'; }
  // The reply is over: when the speaker was on this is the real playback end, otherwise turn-complete.
  // `completed` false = cancelled or failed: no follow-up window for that (back to waiting after the
  // cooldown); only a completed reply earns the configured window.
  function onReplyEnd(completed) {
    if (state === 'off') return;
    if (state !== 'active') return;
    if (completed === false) pendingAfterActive = 'waiting';
    set('cooldown', cooldownMs);
  }
  // Something the human did (a tap, a typed message) counts as presence: extend a follow-up window.
  function onHumanActivity() { if (state === 'followup') set('followup', followUpMs); }
  function current() { return tick(); }

  return { snapshot, tick, arm, disarm, setMatcher, setFollowUpMs, onUtterance, onTurnStart, onReplyEnd, onHumanActivity, current, get gen() { return gen; } };
}

module.exports = { MAX_PHRASE_LEN, normalizeForMatch, autoWakeName, resolvePhrase, createWakeMatcher, createWakeState };
