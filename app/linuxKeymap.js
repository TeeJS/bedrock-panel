'use strict';
/*
 * linuxKeymap.js — robotjs key names and literal text to Linux evdev key codes. Pure, so it
 * unit-tests without a device.
 *
 * The Linux input backend sends KEY CODES, not characters: the compositor applies the user's
 * keyboard layout on the way out, exactly as it would for a real keyboard. That is the right
 * behaviour for a macro pad — Ctrl+C stays Ctrl+C on every layout — but it means typed TEXT is
 * layout-dependent. The character table below is US QWERTY, so on another layout a typed string
 * produces whatever those physical keys mean there. Key combos are unaffected.
 *
 * Codes are from linux/input-event-codes.h. Names on the left are robotjs's, because that is the
 * vocabulary app/main.js and the macro editor already speak.
 */

// ---- modifiers ----------------------------------------------------------------------------
// robotjs calls the Super/Windows key 'command'; app/mediaKeys.js already aliases win/cmd/meta/super
// onto it, so this table only has to know the four names that reach us.
const MODIFIERS = {
  control: 29,   // KEY_LEFTCTRL
  shift: 42,     // KEY_LEFTSHIFT
  alt: 56,       // KEY_LEFTALT
  command: 125,  // KEY_LEFTMETA
};

// ---- named keys ---------------------------------------------------------------------------
const NAMED = {
  escape: 1, backspace: 14, tab: 15, enter: 28, space: 57, capslock: 58,
  minus: 12, equal: 13, '-': 12, '=': 13,
  home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108, pagedown: 109,
  insert: 110, delete: 111, pause: 119, printscreen: 99, menu: 127,
  numlock: 69, scrolllock: 70,
  // Media keys — what transport() and volume() need.
  audio_mute: 113, audio_vol_down: 114, audio_vol_up: 115,
  audio_next: 163, audio_play: 164, audio_prev: 165, audio_stop: 166,
};
for (let i = 1; i <= 10; i++) NAMED['f' + i] = 58 + i;          // F1..F10 = 59..68
NAMED.f11 = 87; NAMED.f12 = 88;

// Letters and digits sit on fixed scancodes; the layout decides what they print.
const LETTERS = { q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
                  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
                  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50 };
const DIGITS = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11 };

// ---- punctuation, for typed text (US QWERTY) -----------------------------------------------
const PUNCT = {
  '[': 26, ']': 27, ';': 39, "'": 40, '`': 41, '\\': 43, ',': 51, '.': 52, '/': 53,
};
// Characters that are the shifted form of another key.
const SHIFTED = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: '-', '+': '=', '{': '[', '}': ']', ':': ';', '"': "'", '~': '`', '|': '\\', '<': ',', '>': '.', '?': '/',
};

/** Key code for a robotjs key name, or null when this backend has no code for it. */
function codeFor(name) {
  const n = String(name == null ? '' : name).toLowerCase();
  if (MODIFIERS[n] !== undefined) return MODIFIERS[n];
  if (NAMED[n] !== undefined) return NAMED[n];
  if (LETTERS[n] !== undefined) return LETTERS[n];
  if (DIGITS[n] !== undefined) return DIGITS[n];
  if (PUNCT[n] !== undefined) return PUNCT[n];
  return null;
}

/** True when `name` is one of the four modifier names. */
function isModifier(name) {
  return MODIFIERS[String(name == null ? '' : name).toLowerCase()] !== undefined;
}

/**
 * One character -> { code, shift } on a US layout, or null when it cannot be typed.
 * Newline and tab are included because a macro's text may contain them.
 */
function charToKey(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return null;
  if (ch === '\n' || ch === '\r') return { code: NAMED.enter, shift: false };
  if (ch === '\t') return { code: NAMED.tab, shift: false };
  if (ch === ' ') return { code: NAMED.space, shift: false };
  if (ch >= 'A' && ch <= 'Z') return { code: LETTERS[ch.toLowerCase()], shift: true };
  if (LETTERS[ch] !== undefined) return { code: LETTERS[ch], shift: false };
  if (DIGITS[ch] !== undefined) return { code: DIGITS[ch], shift: false };
  if (PUNCT[ch] !== undefined) return { code: PUNCT[ch], shift: false };
  const base = SHIFTED[ch];
  if (base !== undefined) {
    const code = DIGITS[base] !== undefined ? DIGITS[base] : (PUNCT[base] !== undefined ? PUNCT[base] : NAMED[base]);
    if (code !== undefined) return { code, shift: true };
  }
  return null;
}

/**
 * A string -> the taps needed to type it, plus the characters that could not be mapped.
 * Unmappable characters are skipped rather than aborting the whole macro: dropping one accented
 * letter is better than typing nothing at all.
 */
function textToTaps(text) {
  const taps = [];
  const skipped = [];
  for (const ch of String(text == null ? '' : text)) {
    const k = charToKey(ch);
    if (!k) { skipped.push(ch); continue; }
    taps.push({ code: k.code, mods: k.shift ? [MODIFIERS.shift] : [] });
  }
  return { taps, skipped };
}

/**
 * Every key code this backend can ever send. The uinput device has to declare its full key set
 * before it is created, so this is what the helper is handed at startup.
 */
function allCodes() {
  const set = new Set();
  for (const table of [MODIFIERS, NAMED, LETTERS, DIGITS, PUNCT]) {
    for (const code of Object.values(table)) set.add(code);
  }
  return Array.from(set).sort((a, b) => a - b);
}

module.exports = { codeFor, isModifier, charToKey, textToTaps, allCodes, MODIFIERS };
