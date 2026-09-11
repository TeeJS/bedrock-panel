'use strict';
/*
 * linuxSpeechCatalog.js — what the built-in Linux engine may download, pinned and checksummed.
 *
 * Pure data plus the few functions that read it, so the editor, the installer and the tests all
 * agree on one list without any of them reaching the network.
 *
 * Every voice here is PUBLIC DOMAIN or CC0. That is not a nicety: Piper's voices inherit their
 * training dataset's terms, and most of the good-sounding ones are CC BY-NC-SA (non-commercial) or
 * carry a bespoke research licence. Those cannot ship in a product, so the list was built by reading
 * the MODEL_CARD of every English voice and keeping only the ones with no restrictions. The licence
 * is recorded per voice so the editor can show it and nobody has to take this comment on trust.
 *
 * Sizes are the real byte counts from the upstream index, so a progress bar can be honest before the
 * first byte arrives. Digests are the upstream md5s, which is what that index publishes.
 */

const VOICES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

// The engine: Piper's own prebuilt Linux x64 release, binary and its shared libraries. No compiler,
// no package manager, nothing in the deb.
const ENGINE = {
  url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz',
  bytes: 26460462,
  sha256: 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992',
  // The tarball unpacks to a `piper/` directory holding the binary and its libraries.
  stripComponents: 1,
};

// Default first. `bytes` is the model; the .json beside it is a couple of kilobytes and ignored for
// progress. `quality` is Piper's own label and tracks size and naturalness together.
const VOICES = [
  { id: 'en_US-ljspeech-medium', label: 'English (US) — female',  quality: 'medium', bytes: 63531379, md5: '109d552e9dd78d92d1169a7edd6de38d', license: 'Public domain', path: 'en/en_US/ljspeech/medium' },
  { id: 'en_US-joe-medium',      label: 'English (US) — male',    quality: 'medium', bytes: 63201294, md5: '74fd6a4dc39e0aa9dce145d7f5acd4f6', license: 'CC0',           path: 'en/en_US/joe/medium' },
  { id: 'en_GB-cori-medium',     label: 'English (UK) — female',  quality: 'medium', bytes: 63531379, md5: 'f143307611eccea9d976235d0895f57c', license: 'Public domain', path: 'en/en_GB/cori/medium' },
  { id: 'en_US-kristin-medium',  label: 'English (US) — female 2', quality: 'medium', bytes: 63531379, md5: '5fed42d2296baca042e2bf74785db725', license: 'Public domain', path: 'en/en_US/kristin/medium' },
];

function voices() { return VOICES.slice(); }

function voiceById(id) {
  return VOICES.find(v => v.id === id) || null;
}

/** The voice a fresh install gets when nobody has chosen one. */
function defaultVoice() { return VOICES[0]; }

/** The two files a voice is made of: the model and the config Piper reads beside it. */
function voiceFiles(voice) {
  if (!voice) return [];
  return [
    { url: VOICES_BASE + '/' + voice.path + '/' + voice.id + '.onnx', name: voice.id + '.onnx', bytes: voice.bytes, md5: voice.md5 },
    { url: VOICES_BASE + '/' + voice.path + '/' + voice.id + '.onnx.json', name: voice.id + '.onnx.json', bytes: 0, md5: '' },
  ];
}

/** Bytes to fetch for a first-time install of this voice, engine included. Drives the progress bar. */
function downloadBytes(voice, engineInstalled) {
  return (engineInstalled ? 0 : ENGINE.bytes) + ((voice && voice.bytes) || 0);
}

module.exports = { ENGINE, VOICES_BASE, voices, voiceById, defaultVoice, voiceFiles, downloadBytes };
