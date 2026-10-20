'use strict';
// Emotion tag protocol for the AI Voice face. A face-enabled page asks the model to start every
// reply with one short tag in square brackets, e.g. "[happy] Yes yes yes. It work." The HOST strips
// that tag before anything else sees the text -- before the speech pipeline (Piper must never read
// "bracket happy bracket") and before the transcript -- and broadcasts the emotion to the page.
//
// Streaming makes this fiddly: the tag arrives split across deltas ("[", "hap", "py] Yes"). The
// parser therefore holds back the first few characters of a message until it can tell whether a
// tag is there. The hold is bounded (MAX_PREFIX): once that many characters have arrived with no
// closing bracket, or the reply plainly does not start with "[", everything is released untouched.
// So an untagged reply, a code block, markdown, or a backend that ignores the instruction costs at
// most a MAX_PREFIX-character delay on its first delta and loses nothing.
//
// Pure: no electron, no DOM. Used by voicepanel-host.js (main process) and its tests.

const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'sleepy', 'thinking'];
const MAX_PREFIX = 24;   // "[surprised] " is 12 chars; this leaves room for stray whitespace
const TAG_RE = /^\s*\[\s*([a-z]+)\s*\]\s*/i;

function vocabOf(emotions) {
  const list = Array.isArray(emotions) && emotions.length ? emotions : EMOTIONS;
  return list.map(e => String(e).toLowerCase());
}

// Strips a leading emotion tag from a complete text. Returns { text, emotion } where emotion is
// null when there was no recognized tag. Unknown words in brackets ("[note]") are left in place:
// only the vocabulary is a tag. All whitespace between the tag and the reply is dropped.
function stripEmotionTag(text, emotions) {
  const vocab = vocabOf(emotions);
  const s = String(text == null ? '' : text);
  const m = TAG_RE.exec(s);
  if (!m) return { text: s, emotion: null };
  const name = m[1].toLowerCase();
  if (vocab.indexOf(name) === -1) return { text: s, emotion: null };
  return { text: s.slice(m[0].length), emotion: name };
}

// Streaming parser for one assistant message. push(delta) returns { text, emotion } where `text`
// is what may be released downstream now (possibly '' while the prefix is still being judged) and
// `emotion` is set exactly once, on the push that resolved a tag. flush() releases anything still
// held at the end of the message and resets the parser, so a host that misses a start() can at
// worst delay a prefix, never leak a tag into a later message.
function createTagParser(opts) {
  const vocab = vocabOf(opts && opts.emotions);
  const maxPrefix = (opts && opts.maxPrefix > 0) ? opts.maxPrefix : MAX_PREFIX;
  let held = '';        // prefix not yet released
  let decided = false;  // true once the tag question is settled for this message

  function start() { held = ''; decided = false; }

  function push(delta) {
    const d = String(delta == null ? '' : delta);
    if (decided) return { text: d, emotion: null };
    held += d;
    const lead = held.replace(/^\s+/, '');
    // Not a tag: the first visible character is not "[" -- release everything, decide once.
    if (lead && lead.charAt(0) !== '[') { decided = true; const out = held; held = ''; return { text: out, emotion: null }; }
    // A closing bracket arrived: judge the tag now.
    if (lead.indexOf(']') !== -1) {
      decided = true;
      const r = stripEmotionTag(held, vocab);
      held = '';
      return r;
    }
    // Still open. Keep holding unless the window is exhausted (then it is not a tag we understand).
    if (held.length >= maxPrefix) { decided = true; const out = held; held = ''; return { text: out, emotion: null }; }
    return { text: '', emotion: null };
  }

  function flush() {
    const out = held;
    start();
    return out;
  }

  function pending() { return held; }

  return { start, push, flush, pending };
}

// The instruction appended to the assembled prompt when the face is on. Built from the vocabulary
// so no persona's wording is baked in; the examples are here, and only here, so a persona prompt
// never carries tagged lines that could leak when the face is off.
function emotionInstruction(emotions) {
  const vocab = vocabOf(emotions);
  const a = vocab[0], b = vocab[Math.min(1, vocab.length - 1)];
  return 'Every reply MUST start with one emotion tag in square brackets, chosen from: ' + vocab.join(', ') +
    '. The tag sets your face while you speak and is never read aloud. Put nothing before it and continue the ' +
    'reply right after it, for example: "[' + b + '] Yes, that works." or "[' + a + '] Not sure, I will check."';
}

module.exports = { EMOTIONS, MAX_PREFIX, stripEmotionTag, createTagParser, emotionInstruction };
