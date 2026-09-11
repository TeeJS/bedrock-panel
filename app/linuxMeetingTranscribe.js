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
 * channel is clustered into distinct voices, the clusters are merged and pruned, and each line is
 * attributed to whoever was speaking during it. A cluster whose voice matches an ENROLLED speaker
 * gets that person's name; the rest are Speaker A, Speaker B and so on in order of appearance.
 *
 * Enrollment, the constants and the profile format are all deliberately the Windows helper's, so a
 * folder of voice profiles works identically on either platform and a threshold tuned on one is
 * still right on the other. Without the diarization models installed this falls back to one
 * "Others", which is stated rather than hidden.
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
const clusters = require('./linuxSpeakerClusters');
const { createSpeakerProfiles } = require('./linuxSpeakerProfiles');

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
 * most time with. Each turn already carries its speaker's display name, whether that is an enrolled
 * person or a placeholder, so this only decides WHICH turn a line belongs to.
 *
 * A line overlapping no turn keeps `fallback`: the recognizer heard words there and the diarizer
 * did not, and dropping the line would be worse than under-labelling it.
 */
function attribute(segments, turns, fallback) {
  return segments.map(seg => {
    let best = null, bestShare = 0;
    for (const t of turns) {
      const share = overlap(seg, t);
      if (share > bestShare) { bestShare = share; best = t; }
    }
    return Object.assign({}, seg, { speaker: best ? best.cluster : fallback });
  });
}

function createLinuxMeetingTranscriber(options) {
  const opts = options || {};
  const baseDir = opts.baseDir || '';
  const fs = opts.fs || fsDefault;
  const execFile = opts.execFile || execFileDefault;
  const spawn = opts.spawn || require('child_process').spawn;
  const python = opts.python || 'python3';
  const log = opts.log || (() => {});
  const tmpDir = opts.tmpDir || os.tmpdir();
  const paths = layout(baseDir);
  const embedScript = opts.embedScript || path.join(__dirname, 'linux', 'speaker-embed.py').replace('app.asar', 'app.asar.unpacked');
  const profilesDir = opts.profilesDir || path.join(baseDir, 'speech', 'speakers');
  let profileStore = null;
  const profiles = () => (profileStore || (profileStore = createSpeakerProfiles({ dir: profilesDir, fs })));

  /** Everything needed to transcribe a whole recording, which is more than Wyoming listening needs. */
  function available() {
    return !!(fs.existsSync(paths.sttVadBinary) && fs.existsSync(paths.vadModel) && modelArgs());
  }

  /** Can the far side be told apart, or is it one "Others"? A separate question from available(). */
  function canDiarize() {
    return !!(fs.existsSync(paths.diarizeBinary) && fs.existsSync(paths.segmentationModel)
      && fs.existsSync(paths.embeddingModel));
  }

  /**
   * Arguments for whichever recognition model is installed. Two families, told apart by the files
   * present: Moonshine is English and fastest, Whisper is multilingual. A meeting in another
   * language needs the second one, the same as Live Translate does.
   */
  function modelArgs() {
    let dirs;
    try { dirs = fs.readdirSync(paths.sttDir); } catch (e) { return null; }
    const at = (dir, name) => { const p = path.join(dir, name); return fs.existsSync(p) ? p : null; };
    for (const id of dirs) {
      const dir = path.join(paths.sttDir, id);
      const wEnc = at(dir, 'tiny-encoder.int8.onnx') || at(dir, 'tiny-encoder.onnx');
      const wDec = at(dir, 'tiny-decoder.int8.onnx') || at(dir, 'tiny-decoder.onnx');
      const wTok = at(dir, 'tiny-tokens.txt');
      if (wEnc && wDec && wTok) {
        return ['--whisper-encoder=' + wEnc, '--whisper-decoder=' + wDec, '--tokens=' + wTok,
                '--model-type=whisper', '--num-threads=4'];
      }
      const enc = at(dir, 'encoder_model.ort');
      const merged = at(dir, 'decoder_model_merged.ort');
      const tokens = at(dir, 'tokens.txt');
      if (enc && merged && tokens) {
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

  /**
   * A voice fingerprint per span, from the resident helper. One request per span rather than one
   * for the whole cluster, because each has to be normalized BEFORE they are averaged -- see
   * linuxSpeakerClusters.
   */
  function embedSpans(wavPath, spans) {
    return new Promise(resolve => {
      if (!spans.length || !fs.existsSync(paths.embeddingModel)) { resolve([]); return; }
      const args = [embedScript, path.join(paths.sttLibDir, 'libsherpa-onnx-c-api.so'), paths.embeddingModel];
      let proc;
      try {
        proc = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env() });
      } catch (exc) {
        log('could not start the voice fingerprinter: ' + (exc && exc.message));
        resolve([]);
        return;
      }
      const out = [];
      let buffer = '';
      let ready = false;
      proc.stdout.on('data', chunk => {
        buffer += String(chunk);
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (!line) continue;
          let msg = null;
          try { msg = JSON.parse(line); } catch (e) { continue; }
          if (!ready) {
            ready = true;
            if (msg.error) { log('voice fingerprinting unavailable: ' + msg.error); try { proc.kill(); } catch (e) {} resolve([]); return; }
            // A span of null means the whole file, which is what enrolling a clip wants.
            for (const span of spans) {
              const request = span ? { wav: wavPath, spans: [[span.start, span.end]] } : { wav: wavPath };
              proc.stdin.write(JSON.stringify(request) + '\n');
            }
            continue;
          }
          out.push(msg.embedding || null);
          if (out.length === spans.length) { try { proc.stdin.end(); } catch (e) {} }
        }
      });
      proc.on('error', e => { log('voice fingerprinter failed: ' + e.message); resolve([]); });
      proc.on('exit', () => resolve(out));
    });
  }

  /** Diarized turns into named participants: fingerprint, merge, prune, identify. */
  async function participants(wavPath, turns, settings) {
    const byCluster = new Map();
    for (const t of turns) {
      if (!byCluster.has(t.cluster)) byCluster.set(t.cluster, []);
      byCluster.get(t.cluster).push(t);
    }
    // Only the spans that will actually be used are fingerprinted -- the rest is wasted model time.
    const wanted = [];
    for (const [, segs] of byCluster) {
      segs.filter(s => (s.end - s.start) >= catalog.DIARIZATION.minSegmentSec)
        .sort((a, b) => (b.end - b.start) - (a.end - a.start))
        .slice(0, catalog.DIARIZATION.maxEmbedSegments)
        .forEach(s => wanted.push(s));
    }
    const vectors = await embedSpans(wavPath, wanted);
    const embedded = new Map(wanted.map((s, i) => [s, vectors[i] || null]));

    let built = [];
    for (const [cluster, segs] of byCluster) {
      const withEmb = segs.map(s => Object.assign({}, s, { embedding: embedded.get(s) || null }));
      const { embedding, used } = clusters.clusterEmbedding(withEmb);
      built.push({ labels: [cluster], segments: segs, duration: segs.reduce((n, s) => n + (s.end - s.start), 0), embedding, used });
    }
    built = clusters.dropFragments(clusters.mergeClusters(built));
    return clusters.labelClusters(built, (emb, opts) => profiles().identify(emb, opts), settings);
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
    const myName = profiles().resolveName(String((settings && settings.myName) || '').trim() || 'Me');
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

      // Name the far side: fingerprint each cluster, merge, prune, and match against enrolled
      // voices. Every turn then carries the display name of the person it belongs to.
      let people = [];
      let theirs = heard;
      if (turns.length) {
        people = await participants(right, turns, { attendees: settings && settings.attendees, threshold: settings && settings.threshold });
        const nameFor = new Map();
        for (const p of people) for (const label of p.labels) nameFor.set(label, p.name);
        const named = turns.map(t => Object.assign({}, t, { cluster: nameFor.get(t.cluster) || null }))
          .filter(t => t.cluster);
        theirs = attribute(heard, named, others);
        log('the far side was ' + people.length + ' voice(s): ' + people.map(p => p.name).join(', '));
      }

      const segments = mine.concat(theirs).sort((a, b) => a.start - b.start || a.end - b.end);
      if (!segments.length) log('no speech was found in either channel');
      const mineSec = mine.reduce((n, s) => n + (s.end - s.start), 0);
      const farSec = people.reduce((n, p) => n + p.duration, 0);
      const round2 = v => Math.round(v * 100) / 100;
      return {
        segments,
        speaker_report: {
          engine: 'bedrock-panel-linux',
          method: people.length ? 'channels+diarization' : 'channels',
          threshold_used: (settings && settings.threshold) || catalog.DIARIZATION.similarityThreshold,
          speaker_count: people.length + 1,
          total_speech_sec: round2(mineSec + farSec),
          speakers: [{
            label: myName, identified: true, channel_matched: true, channel: 'left',
            duration_sec: round2(mineSec), segments: mine.length,
          }].concat(people.map(p => ({
            label: p.name, identified: p.identified, channel: 'right',
            duration_sec: round2(p.duration), segments: p.segments.length,
            clusters: p.labels.length,
            best_score: p.scores.length ? p.scores[0].score : null,
            nearest: p.scores.length ? p.scores[0].name : null,
            margin: p.margin, ambiguous: p.ambiguous,
          }))),
          enrollment_candidates: clusters.enrollmentCandidates(people, mineSec + farSec),
        },
      };
    } finally {
      for (const f of [left, right]) { try { fs.unlinkSync(f); } catch (e) {} }
    }
  }

  /** Fingerprint a clip of one person talking and keep it under `name`. */
  async function enroll(name, wavPath) {
    if (!fs.existsSync(paths.embeddingModel)) throw new Error('the voice models are not installed');
    // The whole clip, mono or stereo: an enrollment recording is one person talking, start to end.
    const [vector] = await embedSpans(wavPath, [null]);
    if (!vector) throw new Error('there was not enough clear speech in that clip to enroll a voice');
    if (!profiles().save(name, vector)) throw new Error('that name cannot be used for a voice profile');
    log('enrolled ' + name + ' from ' + path.basename(wavPath));
    return { name, dimensions: vector.length };
  }

  return { available, canDiarize, transcribe, enroll, profiles, paths };
}

module.exports = { createLinuxMeetingTranscriber, readHeader, extractChannel, parseSegments, parseTurns, attribute, overlap, monoHeader };
