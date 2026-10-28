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
// What Whisper tends to write for a spoken "hey" in front of a name (measured on the live panel:
// "Hey Norm" came back as "A norm." and "pain norm." as often as "Hey Norm."). Every "hey <name>"
// phrase also accepts these in front of the same name; the name itself is matched exactly here (near
// spellings of it are accepted only after a clear "hey", below).
const HEY_FUSED = ['e', 'he', 'hey', 'ey', 'ay', 'a'];   // glued straight onto the name, no space
const HEY_VARIANTS = ['a', 'hay', 'hate', 'pain', 'ay', 'eh', 'hi', 'he', 'say'];
function createWakeMatcher({ phrase, aliases }) {
  const base = [phrase].concat(Array.isArray(aliases) ? aliases : []).map(normalizeForMatch).filter(Boolean);
  const forms = [];
  const names = [];   // the bare names of "hey <name>" phrases: the whole utterance being just the name wakes too
  for (const f of base) {
    forms.push(f);
    if (/^hey\s+\S/.test(f)) {
      const name = f.slice(4).trim();
      names.push(name);
      for (const v of HEY_VARIANTS) forms.push(v + ' ' + name);
      for (const v of HEY_FUSED) forms.push(v + name);   // a fast "Hey Norm" comes back as one word: "Enorm."
    }
  }
  const res = forms.map(f => new RegExp('^\\s*' + f.split(' ').map(escapeRe).join('[\\s\\p{P}]+') + '(?![\\p{L}\\p{N}\'])', 'iu'));
  // The utterance is only the name (Whisper drops a quick "hey": "Jarvis.", "terminal."), said once or
  // repeated. It opens the listening window like the full phrase alone; it can never carry a command.
  const aloneRes = names.map(n => new RegExp('^[\\s\\p{P}]*(?:' + n.split(' ').map(escapeRe).join('[\\s\\p{P}]+') + '[\\s\\p{P}]*)+$', 'iu'));
  // Near spellings of the name ("Hey Nord", "Hey Norma", "Hey Kimmy"): one letter off after doubled
  // letters are collapsed, same first letter. Only for one-word names of 4+ letters and only after a
  // clear "hey"/"hay", never after the weak variants ("a nord" stays unaddressed) and never for the
  // name alone.
  const nearNames = Array.from(new Set(names.filter(n => /^\p{L}{4,}$/u.test(n))));
  function match(text) {
    const raw = String(text == null ? '' : text);
    for (let i = 0; i < res.length; i++) {
      const m = res[i].exec(raw);
      if (!m) continue;
      let rest = raw.slice(m[0].length).replace(/^[\s\p{P}]+/u, '');   // the comma/period after the name, then the command as spoken
      // "Hey Mimi. Hey Mimi. Hey Mimi." is the phrase said three times, not a request: drop the repeats.
      for (let guard = 0; guard < 6; guard++) {
        const again = res.map(r => r.exec(rest)).find(Boolean);
        if (!again) break;
        rest = rest.slice(again[0].length).replace(/^[\s\p{P}]+/u, '');
      }
      return { wake: true, phrase: forms[i], commandText: rest };
    }
    for (let i = 0; i < aloneRes.length; i++) if (aloneRes[i].test(raw)) return { wake: true, phrase: 'hey ' + names[i], commandText: '' };
    if (nearNames.length) {
      const nm = NEAR_RE.exec(raw);
      const heard = nm ? squeeze(nm[1].toLowerCase()) : '';
      // Same first letter: a different first letter is usually a different real word or name ("Hey
      // Travis" is someone else, "Hey Mimi" is another persona, "hey form" is not Norm).
      const name = heard && nearNames.find(n => n[0] === heard[0] && editDistance(squeeze(n), heard) <= 1);
      if (name) return { wake: true, phrase: 'hey ' + name, near: true, commandText: raw.slice(nm[0].length).replace(/^[\s\p{P}]+/u, '') };
    }
    return { wake: false };
  }
  return { match, forms };
}
const NEAR_RE = /^[\s\p{P}]*h(?:ey|ay)[\s\p{P}]+([\p{L}']+)(?![\p{L}\p{N}'])/iu;   // "hey <word>" / "hay <word>"
function squeeze(s) { return s.replace(/(\p{L})\1+/gu, '$1'); }   // "kimmy" -> "kimy": doubled letters are spelling, not sound
// Levenshtein distance, stopping early once it passes 1 (all the caller needs).
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...cur) > 1) return 2;
    prev = cur;
  }
  return prev[b.length];
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Does a finished reply invite an answer? Used to decide whether the follow-up window opens at all
// (option "only after a question"): "It's 3:15." closes at once, "Want the lights on too?" opens it.
// A question mark ending the reply, or a closing offer in its last sentence ("let me know", "would you
// like", "do you want", "want me to", "shall I", "should I", "which one").
const INVITES = /\b(let me know|would you like|do you want|want me to|shall i|should i|which (one|would|do)|tell me (which|what|if)|anything else)\b/i;
function replyInvitesAnswer(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return false;
  if (/\?[\s"'”’)\]*_~`]*$/u.test(t)) return true;
  const last = t.split(/(?<=[.!?])\s+/).pop() || '';
  return INVITES.test(last);
}

// Said on its own, these end the conversation: no turn is sent, nothing is spoken back, and an open
// listening or follow-up window closes at once. Matched against the WHOLE utterance (after the wake
// phrase, if any), so "thanks for the update on the build" still goes through as a request.
const CLOSERS = [
  'thanks', 'thank you', 'thanks a lot', 'thank you very much', 'thanks so much', 'cheers', 'ok thanks', 'okay thanks', 'ok thank you', 'okay thank you',
  "that's all", 'that is all', "that's it", 'that is it', "that'll be all", 'that will be all', "that's everything",
  'never mind', 'nevermind', 'forget it', 'cancel that', 'no thanks', 'no thank you', 'nothing', 'nope',
  'go to sleep', 'stop listening', 'goodbye', 'good bye', 'bye', 'bye bye', 'good night', 'goodnight',
  "i'm done", 'i am done', "we're done", 'we are done', 'all done', 'all set', "i'm good", 'i am good', "we're good",
];
function isClosePhrase(text, names) {
  let t = normalizeForMatch(String(text == null ? '' : text).replace(/[’‘]/g, "'"));   // Whisper sometimes writes a curly apostrophe
  if (!t) return false;
  for (const n of (names || [])) if (n && t.endsWith(' ' + n)) { t = t.slice(0, -(n.length + 1)); break; }   // "thanks Jarvis"
  return CLOSERS.indexOf(t) !== -1;
}

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
  const closeNamesNow = () => (Array.isArray(o.closeNames) ? o.closeNames : []);   // read at call time: the host's phrase can change
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const windowMs = o.windowMs != null ? o.windowMs : 8000;
  const cooldownMs = o.cooldownMs != null ? o.cooldownMs : 1200;
  let followUpMs = o.followUpMs != null ? o.followUpMs : 0;
  let matcher = o.matcher || null;
  let state = 'off';
  let until = 0;            // when listening / followup / cooldown ends
  let gen = 0;              // bumped on arm/disarm/phrase change: stale utterances are dropped
  let pendingAfterActive = null;   // where to go when the reply is over (set when the turn starts)
  let openedAt = 0;                // when the current listening/follow-up window opened (speech begun before it is not for us)
  let lastWindow = null;           // {state, openedAt, until} of the window that last expired: a request begun
                                   // inside it still counts when its STT lands after the expiry
  const SLACK_MS = 500;            // lower-bound tolerance ONLY for an estimated start (no VAD onset from the page)

  function snapshot() {
    tick();
    return { state, until: (state === 'listening' || state === 'followup' || state === 'cooldown') ? until : 0, gen, followUpMs, windowMs };
  }
  function set(next, ms) { state = next; until = ms ? now() + ms : 0; if (ms) openedAt = now(); }
  // A listening window opens at the moment the phrase utterance was RECEIVED (its speech had ended),
  // not when STT returned: a human who goes on talking before the transcript is back is inside it.
  function openListening(receivedAt) { state = 'listening'; until = now() + windowMs; openedAt = receivedAt != null ? receivedAt : now(); }
  // Expire timed states. Called before every decision and by the host's timer.
  function tick() {
    const t = now();
    if ((state === 'listening' || state === 'followup') && until && t >= until) { lastWindow = { state, openedAt, until }; set('waiting', 0); }
    else if (state === 'cooldown' && until && t >= until) {
      // Timed from the cooldown's END, not from this (possibly late) tick: a lazy tick must never
      // stretch a follow-up window.
      const end = until, next = pendingAfterActive || 'waiting';
      pendingAfterActive = null;
      state = next; until = next === 'followup' ? end + followUpMs : 0; openedAt = end;   // the follow-up opens when the cooldown ends
      if (next === 'followup' && t >= until) { lastWindow = { state, openedAt, until }; set('waiting', 0); }
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
  // `startedAt` (ms) is when the human started this utterance and `receivedAt` when its audio arrived
  // (its speech had ended). A request counts for a window when it BEGAN inside it (openedAt <= start
  // < until): begun inside a window that has since closed still counts when STT is slow; begun before
  // the window opened (ambient speech that straddled the phrase, the speaker's tail in the cooldown)
  // does not. `startedEstimated` true = the start was derived from the audio length, not the page's
  // VAD onset: only then is the lower bound SLACK_MS lenient.
  function onUtterance(text, utteranceGen, startedAt, receivedAt, startedEstimated) {
    tick();
    const genOk = utteranceGen === undefined || utteranceGen === gen;
    const slack = startedEstimated ? SLACK_MS : 0;
    if (startedAt != null) {
      if (state === 'waiting' && lastWindow && genOk && startedAt >= lastWindow.openedAt - slack && startedAt < lastWindow.until) {
        state = lastWindow.state; until = now() + 1; openedAt = lastWindow.openedAt;   // the window, back for this one decision
      }
      lastWindow = null;
    }
    if (state === 'off') return { action: 'pass', commandText: String(text == null ? '' : text) };
    if (!genOk) return { action: 'drop', reason: 'stale' };
    if (state === 'active' || state === 'cooldown') return { action: 'drop', reason: state };
    if ((state === 'listening' || state === 'followup') && startedAt != null && startedAt < openedAt - slack) return { action: 'drop', reason: 'early' };
    const raw = String(text == null ? '' : text);
    if (!raw.trim()) return { action: 'drop', reason: 'empty' };
    if (state === 'listening' || state === 'followup') {
      // The human is expected to speak without the phrase; if they say it anyway, strip it.
      const m = matcher ? matcher.match(raw) : { wake: false };
      const cmd = m.wake ? m.commandText : raw;
      if (!cmd.trim()) { openListening(receivedAt); return { action: 'listen', reason: 'phrase-again' }; }
      // "thanks", "that's all", "never mind": the conversation is over; close the window, send nothing.
      if (isClosePhrase(cmd, closeNamesNow())) { set('waiting', 0); lastWindow = null; return { action: 'drop', reason: 'closed' }; }
      return { action: 'turn', commandText: cmd, reason: state };   // onTurnStart follows; a late-window state expires on its next tick
    }
    // waiting
    const m = matcher ? matcher.match(raw) : { wake: false };
    if (!m.wake) return { action: 'drop', reason: 'unaddressed' };
    if (!m.commandText.trim()) { openListening(receivedAt); return { action: 'listen', reason: 'phrase-alone' }; }
    if (isClosePhrase(m.commandText, closeNamesNow())) return { action: 'drop', reason: 'closed' };   // "Hey Jarvis, thanks": nothing to answer
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

module.exports = { MAX_PHRASE_LEN, normalizeForMatch, autoWakeName, resolvePhrase, createWakeMatcher, createWakeState, replyInvitesAnswer, isClosePhrase };
