'use strict';
/*
 * linuxMeetingTranscribe.js — transcribing a meeting recording on this machine, on Linux.
 *
 * This is the Linux half of the "local" transcription engine main.js already offers on macOS, and it
 * produces the same { segments, speaker_report } shape the diarizer server returns, so everything
 * downstream (meetingAnalyze, the library, the panel) is unchanged.
 *
 * Two mechanisms, because a meeting has two different problems in it.
 *
 * The operator is separated by CHANNEL. app/meetingRecorder.js writes a 16 kHz stereo WAV with the
 * microphone on the left and system audio on the right, so "you versus the call" is known rather
 * than inferred, and cannot be got wrong.
 *
 * The far side is separated by DIARIZATION, because "everyone else" is not one person. The system
 * channel is clustered into distinct voices and each line is attributed to the one speaking at that
 * moment. They come out as Speaker 1, Speaker 2 and so on, in the order they first talk -- real
 * names still need the diarizer server, which matches enrolled voices. Without the diarization
 * models installed this falls back to one "Others", which is the old behaviour and is stated rather
 * than hidden.
 *
 * Each channel is split into utterances by Silero VAD and recognized by sherpa-onnx, which is where
 * the timestamps come from: the recognizer alone returns one string for whatever it is handed, with
 * no idea when anything was said. Measured on an i5-10210U laptop with no GPU: 9.3 s of speech in
 * 0.15 s, about sixty times real time, so an hour-long meeting is about a minute of CPU.
 */
const path = require('path');
const fsDefault = require('fs');
const os = require('os');
const { execFile: execFileDefault } = require('child_process');
const { layout } = require('./linuxSpeech');
const catalog = require('./linuxSpeechCatalog');

// The recorder's format. Anything else is refused rather than guessed at.
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
// The diarization models are trained at this rate and the tool refuses anything else. The recorder
// writes exactly this, so it only matters for a recording that came from somewhere else.
const DIARIZATION_RATE = 16000;

/**
 * Read a canonical WAV header. Returns null when this is not the 16-bit stereo PCM the recorder
 * writes -- a mono file, or a compressed one, is not something to split down the middle.
 */
function readHeader(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (channels !== CHANNELS || bits !== BYTES_PER_SAMPLE * 8) return null;
  // Walk the chunks rather than assuming data starts at 44: a recorder that writes LIST or fact
  // chunks first is still a valid WAV.
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'data') return { rate, channels, dataStart: at + 8, dataSize: Math.min(size, buf.length - at - 8) };
    at += 8 + size + (size % 2);
  }
  return null;
}

function monoHeader(rate, dataBytes) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * BYTES_PER_SAMPLE, 28);
  buf.writeUInt16LE(BYTES_PER_SAMPLE, 32); buf.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

/** One channel of an interleaved 16-bit stereo buffer, as a mono WAV. */
function extractChannel(data, channel, rate) {
  const frames = Math.floor(data.length / (CHANNELS * BYTES_PER_SAMPLE));
  const pcm = Buffer.alloc(frames * BYTES_PER_SAMPLE);
  for (let i = 0; i < frames; i++) {
    pcm.writeInt16LE(data.readInt16LE((i * CHANNELS + channel) * BYTES_PER_SAMPLE), i * BYTES_PER_SAMPLE);
  }
  return Buffer.concat([monoHeader(rate, pcm.length), pcm]);
}

/**
 * The tool prints one line per utterance: "0.038 -- 1.132: Let us start the meeting." Everything
 * else on that stream is configuration and progress, and is ignored rather than parsed.
 */
function parseSegments(stdout, speaker) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*--\s*(\d+(?:\.\d+)?)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = m[3].trim();
    if (!text) continue;
    out.push({ speaker, start: Number(m[1]), end: Number(m[2]), text });
  }
  return out;
}

/**
 * The diarizer prints "0.335 -- 1.600 speaker_00" per turn. Returns turns in time order with the
 * raw cluster label; naming happens afterwards, in first-spoken order.
 */
function parseTurns(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*--\s*(\d+(?:\.\d+)?)\s+(speaker_\d+)\s*$/.exec(line);
    if (m) out.push({ start: Number(m[1]), end: Number(m[2]), cluster: m[3] });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** How much two spans share, in seconds. Zero when they do not touch. */
function overlap(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * Give each recognized line the speaker who was talking during it — the diarized turn it shares the
 * most time with. Speakers are numbered in the order they first speak, so the names are stable and
 * mean something to a reader. A line overlapping no turn keeps `fallback`: the recognizer heard
 * words there and the diarizer did not, and dropping the line would be worse than under-labelling it.
 */
function attribute(segments, turns, fallback) {
  const naming = new Map();
  for (const t of turns) if (!naming.has(t.cluster)) naming.set(t.cluster, 'Speaker ' + (naming.size + 1));
  return segments.map(seg => {
    let best = null, bestShare = 0;
    for (const t of turns) {
      const share = overlap(seg, t);
      if (share > bestShare) { bestShare = share; best = t; }
    }
    return Object.assign({}, seg, { speaker: best ? naming.get(best.cluster) : fallback });
  });
}

function createLinuxMeetingTranscriber(options) {
  const opts = options || {};
  const baseDir = opts.baseDir || '';
  const fs = opts.fs || fsDefault;
  const execFile = opts.execFile || execFileDefault;
  const log = opts.log || (() => {});
  const tmpDir = opts.tmpDir || os.tmpdir();
  const paths = layout(baseDir);

  /** Everything needed to transcribe a whole recording, which is more than Wyoming listening needs. */
  function available() {
    return !!(fs.existsSync(paths.sttVadBinary) && fs.existsSync(paths.vadModel) && modelArgs());
  }

  /** Can the far side be told apart, or is it one "Others"? A separate question from available(). */
  function canDiarize() {
    return !!(fs.existsSync(paths.diarizeBinary) && fs.existsSync(paths.segmentationModel)
      && fs.existsSync(paths.embeddingModel));
  }

  function modelArgs() {
    let dirs;
    try { dirs = fs.readdirSync(paths.sttDir); } catch (e) { return null; }
    for (const id of dirs) {
      const dir = path.join(paths.sttDir, id);
      const enc = path.join(dir, 'encoder_model.ort');
      const merged = path.join(dir, 'decoder_model_merged.ort');
      const tokens = path.join(dir, 'tokens.txt');
      if (fs.existsSync(enc) && fs.existsSync(merged) && fs.existsSync(tokens)) {
        return ['--moonshine-encoder=' + enc, '--moonshine-merged-decoder=' + merged, '--tokens=' + tokens];
      }
    }
    return null;
  }

  function env() {
    return Object.assign({}, process.env, {
      LD_LIBRARY_PATH: paths.sttLibDir + path.delimiter + (process.env.LD_LIBRARY_PATH || ''),
    });
  }

  function diarize(wavPath) {
    return new Promise(resolve => {
      const args = ['--clustering.cluster-threshold=' + catalog.DIARIZATION.clusterThreshold,
                    '--segmentation.pyannote-model=' + paths.segmentationModel,
                    '--embedding.model=' + paths.embeddingModel, wavPath];
      execFile(paths.diarizeBinary, args, { env: env(), maxBuffer: 64 * 1024 * 1024, timeout: 3600000 }, (err, stdout) => {
        // A diarizer that fails must not lose the transcript: the words are already recognized, and
        // one "Others" is worse than nothing but far better than no meeting notes.
        if (err) { log('could not tell the far side apart, labelling it all as one: ' + (err.message || err)); resolve([]); return; }
        resolve(parseTurns(stdout));
      });
    });
  }

  function runOn(wavPath, speaker) {
    return new Promise((resolve, reject) => {
      const args = ['--silero-vad-model=' + paths.vadModel].concat(modelArgs(), [wavPath]);
      execFile(paths.sttVadBinary, args, { env: env(), maxBuffer: 64 * 1024 * 1024, timeout: 3600000 }, (err, stdout) => {
        if (err) { reject(new Error('recognition failed on the ' + speaker + ' channel: ' + (err.message || err))); return; }
        resolve(parseSegments(stdout, speaker));
      });
    });
  }

  /**
   * A stereo recording in, the diarizer's shape out. `myName` labels the microphone channel; the
   * system channel is everyone else, which is as fine-grained as channels can be.
   */
  async function transcribe(wavPath, settings) {
    const myName = String((settings && settings.myName) || '').trim() || 'Me';
    const others = 'Others';
    if (!available()) throw new Error('built-in transcription is not installed');
    const buf = fs.readFileSync(wavPath);
    const header = readHeader(buf);
    if (!header) throw new Error('this recording is not the 16-bit stereo WAV the recorder writes');
    const data = buf.subarray(header.dataStart, header.dataStart + header.dataSize);

    const stamp = Date.now() + '-' + process.pid;
    const left = path.join(tmpDir, 'bedrock-mic-' + stamp + '.wav');
    const right = path.join(tmpDir, 'bedrock-sys-' + stamp + '.wav');
    try {
      fs.writeFileSync(left, extractChannel(data, 0, header.rate));
      fs.writeFileSync(right, extractChannel(data, 1, header.rate));
      log('transcribing both channels of ' + path.basename(wavPath));
      // The far side is diarized while it is being recognized: two passes over the same audio that
      // do not depend on each other.
      const diarizing = canDiarize() && header.rate === DIARIZATION_RATE;
      if (canDiarize() && !diarizing) log('the far side cannot be split: diarization needs ' + DIARIZATION_RATE + ' Hz, this is ' + header.rate);
      const [mine, heard, turns] = await Promise.all([
        runOn(left, myName),
        runOn(right, others),
        diarizing ? diarize(right) : Promise.resolve([]),
      ]);
      const theirs = turns.length ? attribute(heard, turns, others) : heard;
      const segments = mine.concat(theirs).sort((a, b) => a.start - b.start || a.end - b.end);
      if (!segments.length) log('no speech was found in either channel');
      const farSide = [...new Set(theirs.map(s => s.speaker))];
      if (turns.length) log('the far side was ' + farSide.length + ' voice(s)');
      return {
        segments,
        speaker_report: {
          engine: 'bedrock-panel-linux',
          method: turns.length ? 'channels+diarization' : 'channels',
          speakers: [{ name: myName, channel: 'left', segments: mine.length }].concat(
            farSide.map(name => ({ name, channel: 'right', segments: theirs.filter(s => s.speaker === name).length }))),
        },
      };
    } finally {
      for (const f of [left, right]) { try { fs.unlinkSync(f); } catch (e) {} }
    }
  }

  return { available, canDiarize, transcribe, paths };
}

module.exports = { createLinuxMeetingTranscriber, readHeader, extractChannel, parseSegments, parseTurns, attribute, overlap, monoHeader };
