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

// The voice list lives in linuxVoices.json, generated from Piper's published index plus a reading of
// every voice's MODEL_CARD: 82 voices across 30 languages, and every one of them CC0, public domain,
// CC BY or MIT. The non-commercial and share-alike voices are excluded on purpose -- they sound just
// as good and cannot ship in a product, which is the whole reason this file is curated rather than
// mirrored. `bytes` is the model; the .json beside it is a couple of kilobytes and ignored for
// progress. `quality` is Piper's own label and tracks size and naturalness together.
const VOICES = require('./linuxVoices.json');

// Where someone can browse every Piper voice, ours and the ones we cannot ship.
const VOICE_SAMPLES_URL = 'https://rhasspy.github.io/piper-samples/';

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
  // These are the tuning constants from the Windows helper's pipeline, which are themselves a port
  // of the Python meeting-diarizer's, with the empirical history behind each recorded there. They
  // are copied rather than re-derived on purpose: the same numbers against the same model are what
  // make a score mean the same thing on every platform, and what makes a threshold someone tuned on
  // Windows still correct here.
  clusterThreshold: 0.35,        // what sherpa's own clustering is given, before the merge pass
  clusterMergeThreshold: 0.60,   // sherpa over-splits; clusters this alike are one person
  similarityThreshold: 0.70,     // a profile matches its own voice at 0.76-0.99; impostors under 0.46
  attendeeOffset: 0.15,          // a speaker not on the attendee list is penalised this much
  ambiguousMargin: 0.05,         // top two scores closer than this is a coin toss, and is flagged
  minSegmentSec: 0.5,            // shorter than this is a noise, not a voice
  maxEmbedSegments: 30,          // longest-first, and this many is plenty
  minClusterSec: 5.0,            // a cluster under this is crosstalk, not a participant
  enrollCandidatePct: 5.0,       // an unknown voice holding this much of the meeting is worth a name
  segmentation: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
    bytes: 6958444,
    sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
    stripComponents: 1,
  },
  // ERes2Net, and specifically this one, because a voice profile is only portable if both ends
  // fingerprint with the same model: this is the embedder the Windows helper and the Python
  // meeting-diarizer use, so a folder of enrolled speakers can be copied between the three.
  // Changing it silently invalidates every profile anyone has ever enrolled.
  embedding: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx',
    name: 'speaker-embedding.onnx',
    bytes: 26485263,
    sha256: 'c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5',
  },
};

// Recognition models. Moonshine is built for short utterances on a CPU, which is exactly dictation
// and voice commands: it transcribed 3.85 s of speech in 0.086 s on an i5-10210U laptop. The English
// models are MIT. Whisper tiny is the multilingual fallback when more languages are wanted, and is
// not in this list until someone has measured it.
const STT_MODELS = [
  {
    id: 'moonshine-tiny-en',
    label: 'English only — fastest',
    family: 'moonshine',
    license: 'MIT',
    languages: ['en'],
    bytes: 29858559,
    sha256: '9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2',
    stripComponents: 1,
  },
  {
    // Needed by anything that listens to a language other than English -- Live Translate above all,
    // which is unusable without it: an English-only model does not fail on German, it INVENTS
    // English. "Guten Morgen, wir beginnen die Besprechung" came back as "Good morning, we begin the
    // vascation with incorrect answer", and a translator downstream faithfully translates that.
    id: 'whisper-tiny-multilingual',
    label: 'Many languages — fastest, roughest',
    family: 'whisper',
    license: 'MIT',
    languages: ['multilingual'],
    bytes: 116204861,
    sha256: 'c46116994e539aa165266d96b325252728429c12535eb9d8b6a2b10f129e66b1',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2',
    stripComponents: 1,
  },
  {
    id: 'whisper-base-multilingual',
    label: 'Many languages — a step up',
    family: 'whisper',
    license: 'MIT',
    languages: ['multilingual'],
    bytes: 207557382,
    sha256: '911b2083efd7c0dca2ac3b358b75222660dc09fb716d64fbfc417ba6c99ff3de',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.tar.bz2',
    stripComponents: 1,
  },
  {
    // The accuracy answer. On the reference laptop (i5-10210U, no GPU) a 13-second German passage
    // came back word-perfect where tiny lost a word and mangled every compound, at roughly 0.7x real
    // time -- fine for meetings and for dictation, noticeably behind for live captions.
    id: 'whisper-small-multilingual',
    label: 'Many languages — most accurate, slower',
    family: 'whisper',
    license: 'MIT',
    languages: ['multilingual'],
    bytes: 639387718,
    sha256: '486a46afbb7ba798507190ffe02fea2dd726049af212e774537efac6afb210a6',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.tar.bz2',
    stripComponents: 1,
  },
  // Whisper turbo and the large models are deliberately absent. Turbo matched small's accuracy
  // exactly on the same audio while being larger and SLOWER on a CPU (11.2 s against 9.4 s) -- it
  // pays off on a GPU, which this port does not assume anyone has. Anyone who wants one can run it
  // on their own Wyoming server, which still takes precedence over the built-in engine.
];

function voices() { return VOICES.slice(); }

/** The languages on offer, each with its voices, for a picker that is not one flat list of 82. */
function voiceLanguages() {
  const byLang = new Map();
  for (const v of VOICES) {
    if (!byLang.has(v.lang)) byLang.set(v.lang, { code: v.lang, name: v.langName, country: v.country, voices: [] });
    byLang.get(v.lang).voices.push(v);
  }
  return [...byLang.values()].sort((a, b) => a.name.localeCompare(b.name) || a.country.localeCompare(b.country));
}

/** A voice's label in a list: who they are and how big they are, not a filename. */
function voiceLabel(voice) {
  if (!voice) return '';
  const quality = voice.quality === 'x_low' ? 'smallest' : voice.quality;
  return voice.name + ' — ' + quality + ', ' + voice.license;
}

function sttModels() { return STT_MODELS.slice(); }

function sttModelById(id) { return STT_MODELS.find(m => m.id === id) || null; }

function defaultSttModel() { return STT_MODELS[0]; }

function voiceById(id) {
  return VOICES.find(v => v.id === id) || null;
}

/** The voice a fresh install gets when nobody has chosen one: US English, the app's own language. */
function defaultVoice() {
  return VOICES.find(v => v.id === 'en_US-ljspeech-medium')
    || VOICES.find(v => v.lang === 'en_US' && v.quality === 'medium')
    || VOICES.find(v => v.lang === 'en_US') || VOICES[0];
}

/**
 * A recording of this voice, published beside the model. This is what makes "hear it before you
 * download 60 MB of it" possible at all: a voice cannot be spoken locally until it is installed, and
 * being told to install four voices to choose one is not a choice.
 */
function voiceSampleUrl(voice) {
  return voice ? VOICES_BASE + '/' + voice.path + '/samples/speaker_0.mp3' : '';
}

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

module.exports = { ENGINE, STT_ENGINE, VAD_MODEL, DIARIZATION, VOICES_BASE, VOICE_SAMPLES_URL,
  voices, voiceLanguages, voiceLabel, voiceById, defaultVoice, voiceFiles, voiceSampleUrl, downloadBytes,
  sttModels, sttModelById, defaultSttModel, sttDownloadBytes };
