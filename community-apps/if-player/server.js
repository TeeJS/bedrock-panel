'use strict';
// App-local server for the Interactive Fiction player. Reached from the page as GET/POST
// /app-api/<action>. Runs inside Bedrock Panel's main process, so it can read the host's own config.json
// (for the system Wyoming TTS/STT servers) and read story files from any folder on the PC the user
// pointed the app at -- the local static server only serves files under the app root, so stories that
// live elsewhere are read here and handed to the page as bytes.
//
// Actions:
//   config     -> { stories:[names], folder, tts, stt }   (what the picker needs)
//   storyfile  -> { name, b64 }                            (one story's bytes, base64)
//   speak      -> { wav }   (base64 WAV of a passage, via Wyoming TTS)
//   listen     -> { text }  (transcript of POSTed PCM, via Wyoming STT)
//   save-write -> { ok }              (raw save bytes in the POST body -> saves/<game>/<slot>, slot verbatim)
//   save-read  -> { b64 } | { ok:false, error }   (one save's bytes, base64)
//   save-list  -> { slots:[{slot,size,mtime}] }   (a game's saves, newest first)
//   save-delete-> { ok }              (remove one save; idempotent)

const fs = require('fs');
const path = require('path');
const wyoming = require('./wyoming');

const STORY_EXT = new Set(['.z1', '.z2', '.z3', '.z4', '.z5', '.z6', '.z7', '.z8', '.zlb', '.zblorb',
  '.ulx', '.blb', '.blorb', '.glb', '.gblorb', '.dat']);
const MAX_AUDIO = 8 * 1024 * 1024;    // ~4 minutes of 16kHz mono PCM; an utterance is far smaller
const MAX_SPEAK = 4000;               // characters per synthesize call
const MAX_STORY = 64 * 1024 * 1024;   // generous: large Glulx blorbs can be tens of MB
const MAX_SAVE = 32 * 1024 * 1024;    // full-VM autosave snapshots (esp. Glulx) can run to several MB
// Save files are written to the user-chosen "Saves folder" (the savesDir option), a real folder on
// the PC -- kept OUTSIDE this app directory so they survive app updates/reinstalls (which replace the
// app folder). Layout: <savesDir>/<game>/<slot>, where <slot> is the interpreter's full Glk filename,
// stored VERBATIM (it already carries its own extension, e.g. name.glksave / name.glkdata).

// The host config's settings.* block, read fresh each call so changes apply without a restart.
// Never throws -- a missing/unreadable config yields {}.
function hostSettings() {
  try {
    const electron = require('electron');
    const userDir = electron && electron.app && electron.app.getPath('userData');
    if (!userDir) return {};
    const cfg = JSON.parse(fs.readFileSync(path.join(userDir, 'config.json'), 'utf8'));
    return (cfg && cfg.settings && typeof cfg.settings === 'object') ? cfg.settings : {};
  } catch (e) { return {}; }
}

// System TTS/STT (Settings -> TTS/STT), with optional per-app advanced overrides from the settings
// block (config.settings.ifPlayer). The app "just uses" the system servers unless a developer sets
// an override in the page editor's Advanced / developer overrides section.
function endpoints() {
  const s = hostSettings();
  const g = (s.voice && typeof s.voice === 'object') ? s.voice : {};
  const o = (s.ifPlayer && typeof s.ifPlayer === 'object') ? s.ifPlayer : {};
  const pick = (a, b, fallback) => String(a || b || fallback || '').trim();
  return {
    tts: { host: pick(o.ttsHost, g.ttsHost), port: pick(o.ttsPort, g.ttsPort, '10200') },
    stt: { host: pick(o.sttHost, g.sttHost), port: pick(o.sttPort, g.sttPort, '10300') },
  };
}

// The folder to read stories from: the per-page "Stories folder" option (any path on the PC) if it
// is set and usable, otherwise the app's bundled stories/ folder. Returns an absolute path.
function storiesDir(options) {
  const chosen = String((options && options.storiesDir) || '').trim();
  if (chosen) {
    try { if (fs.statSync(chosen).isDirectory()) return path.resolve(chosen); } catch (e) {}
  }
  return path.join(__dirname, 'stories');
}
// The folder to write save files to: the per-page "Saves folder" option (any path on the PC) if set,
// otherwise a sensible default that is NEVER inside this app dir (an update would wipe it) -- next to
// the user's stories folder, or the host's per-user data dir when the bundled stories are in use.
function savesDir(options) {
  const chosen = String((options && options.savesDir) || '').trim();
  if (chosen) return path.resolve(chosen);                 // created on first write if it doesn't exist yet
  const stories = storiesDir(options);
  if (path.resolve(stories) !== path.resolve(path.join(__dirname, 'stories'))) {
    return path.join(stories, 'saves');                    // next to the user's own stories
  }
  try {
    const electron = require('electron');
    const userDir = electron && electron.app && electron.app.getPath('userData');
    if (userDir) return path.join(userDir, 'if-player-saves');
  } catch (e) {}
  return path.join(__dirname, 'saves');                    // last resort (non-electron/test only)
}
function listStories(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names
    .filter(n => STORY_EXT.has(path.extname(n).toLowerCase()))
    .filter(n => { try { return fs.statSync(path.join(dir, n)).isFile(); } catch (e) { return false; } })
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
// Resolve a requested story name to a real file inside `dir`, rejecting anything that tries to escape
// it (path separators, "..", absolute paths) or that isn't an allowed story file.
function resolveStory(dir, name) {
  const base = String(name || '');
  if (!base || base !== path.basename(base)) return null;         // no separators / traversal
  if (!STORY_EXT.has(path.extname(base).toLowerCase())) return null;
  const full = path.resolve(dir, base);
  if (full !== path.join(path.resolve(dir), base)) return null;   // belt and suspenders
  try { if (!fs.statSync(full).isFile()) return null; } catch (e) { return null; }
  return full;
}

// Save files live under saves/<game>/<slot>.glksave. Both the game and the slot come from the
// interpreter / the player, so each is guarded exactly like a story name: one path component with no
// separators, no "." / ".." traversal, and none of the characters that are illegal in a Windows
// filename. Returns the cleaned component, or null if it is unsafe.
function safeComponent(name) {
  const base = String(name == null ? '' : name);
  if (!base || base === '.' || base === '..') return null;
  if (base !== path.basename(base)) return null;                // no separators / traversal
  if (/[\\/:*?"<>|\x00-\x1f]/.test(base)) return null;          // reject path seps + control chars + Windows-illegal chars
  return base;
}
// Resolve a (game, slot) pair to an absolute .glksave path inside the saves folder, plus the game's own
// directory (for listing). Returns null if either component is unsafe.
function resolveSave(options, game, slot) {
  const g = safeComponent(game);
  const s = safeComponent(slot);
  if (!g || !s) return null;
  const dir = path.join(savesDir(options), g);
  const full = path.resolve(dir, s);                                     // slot stored verbatim (carries its own extension)
  if (full !== path.join(path.resolve(dir), s)) return null;             // belt and suspenders
  return { dir, full };
}

async function handle(action, context) {
  const options = context && context.options || {};
  const query = context && context.query || {};
  const ends = endpoints();
  const dir = storiesDir(options);

  // What the picker needs: available stories + the folder they came from + whether voice is usable.
  if (action === 'config') {
    return { ok: true, stories: listStories(dir), folder: dir, tts: !!ends.tts.host, stt: !!ends.stt.host };
  }

  // One story's bytes, base64. The page turns these into a File and hands them to the interpreter --
  // the only way to play a story that lives outside the app's own (served) folder.
  if (action === 'storyfile') {
    const full = resolveStory(dir, query.name);
    if (!full) return { ok: false, error: 'story not found' };
    let buf;
    try { buf = fs.readFileSync(full); } catch (e) { return { ok: false, error: 'could not read story' }; }
    if (buf.length > MAX_STORY) return { ok: false, error: 'story file too large' };
    return { ok: true, name: path.basename(full), b64: buf.toString('base64') };
  }

  // Speak one passage. Audio comes back as a base64 WAV: /app-api/ is a JSON channel, and an
  // utterance-sized clip is small enough that base64 over loopback costs nothing meaningful.
  if (action === 'speak') {
    const text = String((context.body ? context.body.toString('utf8') : query.text) || '').slice(0, MAX_SPEAK).trim();
    if (!text) return { ok: false, error: 'nothing to speak' };
    if (!ends.tts.host) return { ok: false, error: 'No TTS server configured (Settings → TTS/STT).' };
    const chunks = [];
    let format = null;
    try {
      await wyoming.synthesize({
        host: ends.tts.host, port: ends.tts.port, text,
        onFormat: f => { format = f; },
        onChunk: b => chunks.push(b),
      });
    } catch (e) {
      return { ok: false, error: 'TTS failed: ' + (e.message || 'unknown error') };
    }
    const pcm = Buffer.concat(chunks);
    if (!pcm.length) return { ok: false, error: 'TTS returned no audio' };
    // Real length is known here, so write a correct WAV header rather than the streaming sentinel.
    const header = wyoming.wavHeader(format || {});
    header.writeUInt32LE(36 + pcm.length, 4);
    header.writeUInt32LE(pcm.length, 40);
    return { ok: true, wav: Buffer.concat([header, pcm]).toString('base64') };
  }

  // Transcribe one captured utterance (raw 16kHz mono Int16 PCM in the POST body).
  if (action === 'listen') {
    const audio = context && context.body;
    if (!audio || !audio.length) return { ok: false, error: 'no audio' };
    if (audio.length > MAX_AUDIO) return { ok: false, error: 'audio too long' };
    if (!ends.stt.host) return { ok: false, error: 'No STT server configured (Settings → TTS/STT).' };
    try {
      const text = await wyoming.transcribe({ host: ends.stt.host, port: ends.stt.port, audio });
      return { ok: true, text: String(text || '').trim() };
    } catch (e) {
      return { ok: false, error: 'STT failed: ' + (e.message || 'unknown error') };
    }
  }

  // --- Save byte store -------------------------------------------------------------------------
  // A format-agnostic store for interpreter save bytes at saves/<game>/<slot>.glksave. Both manual
  // SAVE/RESTORE and the autosave timer flow through these four verbs via the asyncglk storage
  // provider (its only caller). Raw bytes go in on write (the POST body); base64-in-JSON comes back
  // on read, because this /app-api/ channel only ever emits JSON (see sysserver.js serveAppApi).
  // The autosave uses a fixed slot; manual saves use the player-chosen name.

  if (action === 'save-write') {
    const loc = resolveSave(options, query.game, query.slot);
    if (!loc) return { ok: false, error: 'bad save name' };
    const data = context && context.body;
    if (!data || !data.length) return { ok: false, error: 'no save data' };
    if (data.length > MAX_SAVE) return { ok: false, error: 'save too large' };
    try {
      fs.mkdirSync(loc.dir, { recursive: true });
      fs.writeFileSync(loc.full, data);
    } catch (e) { return { ok: false, error: 'could not write save' }; }
    return { ok: true };
  }

  if (action === 'save-read') {
    const loc = resolveSave(options, query.game, query.slot);
    if (!loc) return { ok: false, error: 'bad save name' };
    let buf;
    try { buf = fs.readFileSync(loc.full); } catch (e) { return { ok: false, error: 'not found' }; }
    return { ok: true, b64: buf.toString('base64') };
  }

  if (action === 'save-list') {
    const g = safeComponent(query.game);
    if (!g) return { ok: false, error: 'bad save name' };
    const base = savesDir(options);
    let names = [];
    try { names = fs.readdirSync(path.join(base, g)); } catch (e) { return { ok: true, slots: [] }; }
    const slots = [];
    for (const n of names) {
      let st;
      try { st = fs.statSync(path.join(base, g, n)); } catch (e) { continue; }
      if (!st.isFile()) continue;
      slots.push({ slot: n, size: st.size, mtime: Math.round(st.mtimeMs) });   // verbatim filename, incl. its extension
    }
    slots.sort((a, b) => b.mtime - a.mtime);          // most-recent first: powers the Resume prompt + RESTORE picker
    return { ok: true, slots };
  }

  if (action === 'save-delete') {
    const loc = resolveSave(options, query.game, query.slot);
    if (!loc) return { ok: false, error: 'bad save name' };
    try { fs.unlinkSync(loc.full); } catch (e) { /* idempotent: already-gone counts as deleted */ }
    return { ok: true };
  }

  return { ok: false, error: 'unknown action' };
}

module.exports = { handle };
