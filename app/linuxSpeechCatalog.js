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

// The listening engine: sherpa-onnx's prebuilt Linux x64 release (Apache-2.0). Same reasoning as
// Piper -- prebuilt, no compiler, no pip, which is what rules out whisper.cpp and faster-whisper.
const STT_ENGINE = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2',
  bytes: 28156791,
  sha256: 'c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4',
  stripComponents: 1,
};

// Voice activity detection: what splits a long recording into utterances so each gets a timestamp.
// Downloaded with the recognition model rather than separately -- listening without it can still
// transcribe one utterance handed to it, but meeting transcription cannot work at all.
const VAD_MODEL = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  name: 'silero_vad.onnx',
  bytes: 643854,
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
  license: 'MIT',
};

// Speaker diarization: who, among the people on the far side, said each line. Channel separation
// already tells the operator apart from everyone else, but "everyone else" is not one person, so the
// system-audio channel is clustered into distinct voices. Two models: segmentation finds speech
// turns, the embedding extractor makes each turn comparable.
//
// pyannote segmentation 3.0 is MIT (CNRS); the WeSpeaker VoxCeleb embedder is Apache-2.0. Both were
// checked rather than assumed, the way the voices were.
const DIARIZATION = {
  license: 'MIT and Apache-2.0',
  // Measured: two distinct voices separate cleanly at 0.35 and a single voice is never split into
  // two, at any threshold tried down to 0.25. The tool's own default of 0.60 merged two speakers
  // into one, which is the failure that matters -- a transcript that silently attributes one
  // person's words to another.
  clusterThreshold: 0.35,
  segmentation: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
    bytes: 6958444,
    sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
    stripComponents: 1,
  },
  embedding: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_CAM++.onnx',
    name: 'speaker-embedding.onnx',
    bytes: 29292684,
    sha256: 'c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef',
  },
};

// Recognition models. Moonshine is built for short utterances on a CPU, which is exactly dictation
// and voice commands: it transcribed 3.85 s of speech in 0.086 s on an i5-10210U laptop. The English
// models are MIT. Whisper tiny is the multilingual fallback when more languages are wanted, and is
// not in this list until someone has measured it.
const STT_MODELS = [
  {
    id: 'moonshine-tiny-en',
    label: 'English — fast, for dictation and commands',
    license: 'MIT',
    languages: ['en'],
    bytes: 29858559,
    sha256: '9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2',
    stripComponents: 1,
  },
];

function voices() { return VOICES.slice(); }

function sttModels() { return STT_MODELS.slice(); }

function sttModelById(id) { return STT_MODELS.find(m => m.id === id) || null; }

function defaultSttModel() { return STT_MODELS[0]; }

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

/** The same, for listening: the recognition engine plus the model. */
function sttDownloadBytes(model, engineInstalled) {
  return (engineInstalled ? 0 : STT_ENGINE.bytes) + ((model && model.bytes) || 0) + VAD_MODEL.bytes
    + DIARIZATION.segmentation.bytes + DIARIZATION.embedding.bytes;
}

module.exports = { ENGINE, STT_ENGINE, VAD_MODEL, DIARIZATION, VOICES_BASE, voices, voiceById, defaultVoice, voiceFiles, downloadBytes,
  sttModels, sttModelById, defaultSttModel, sttDownloadBytes };
