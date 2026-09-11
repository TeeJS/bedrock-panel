'use strict';
// Transcribing a meeting on this machine, on Linux: the WAV split, the segment parsing, and the
// speaker labelling that comes from channels rather than from voices. No engine is run here.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  createLinuxMeetingTranscriber, readHeader, extractChannel, parseSegments, parseTurns, attribute,
  overlap, monoHeader,
} = require('../app/linuxMeetingTranscribe');

// A 16 kHz stereo recording in the shape app/meetingRecorder.js writes: mic left, system right.
function stereoWav(frames, rate = 16000) {
  const data = Buffer.alloc(frames.length * 4);
  frames.forEach(([l, r], i) => { data.writeInt16LE(l, i * 4); data.writeInt16LE(r, i * 4 + 2); });
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

test('the recorder\'s stereo format is read, and anything else is refused rather than guessed', () => {
  const h = readHeader(stereoWav([[1, 2], [3, 4]]));
  assert.deepEqual({ rate: h.rate, channels: h.channels, dataStart: h.dataStart, dataSize: h.dataSize },
    { rate: 16000, channels: 2, dataStart: 44, dataSize: 8 });
  // A mono file has no second speaker to find; splitting it down the middle would invent one.
  const mono = Buffer.concat([monoHeader(16000, 4), Buffer.alloc(4)]);
  assert.equal(readHeader(mono), null);
  assert.equal(readHeader(Buffer.alloc(10)), null, 'too short to be a WAV');
  assert.equal(readHeader(Buffer.alloc(100)), null, 'not RIFF/WAVE');
});

test('a data chunk that is not at byte 44 is still found', () => {
  // A recorder that writes a LIST chunk first is writing a perfectly valid WAV.
  const base = stereoWav([[7, 8]]);
  const list = Buffer.alloc(12);
  list.write('LIST', 0); list.writeUInt32LE(4, 4); list.write('INFO', 8);
  const withList = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
  withList.writeUInt32LE(withList.length - 8, 4);
  const h = readHeader(withList);
  assert.equal(h.dataStart, 56);
  assert.equal(h.dataSize, 4);
});

test('each channel comes out as its own mono WAV, left being the microphone', () => {
  const wav = stereoWav([[100, -100], [200, -200], [300, -300]]);
  const h = readHeader(wav);
  const data = wav.subarray(h.dataStart, h.dataStart + h.dataSize);
  const left = extractChannel(data, 0, 16000);
  const right = extractChannel(data, 1, 16000);
  const samples = b => [0, 1, 2].map(i => b.readInt16LE(44 + i * 2));
  assert.deepEqual(samples(left), [100, 200, 300], 'the mic channel');
  assert.deepEqual(samples(right), [-100, -200, -300], 'the system channel');
  assert.equal(left.readUInt16LE(22), 1, 'mono');
  assert.equal(left.readUInt32LE(24), 16000, 'same rate as the recording');
  assert.equal(left.readUInt32LE(40), 6, 'the data size is the real one');
});

test('segments are read from the recognizer\'s lines and everything else is ignored', () => {
  const out = [
    'Started', 'num threads: 2',
    '0.038 -- 1.132: Let us start the meeting.',
    'Elapsed seconds: 0.149',
    '2.662 -- 4.684: I think the panel work is nearly finished.',
    '6.0 -- 6.5:    ',                       // a segment the recognizer found no words in
  ].join('\n');
  assert.deepEqual(parseSegments(out, 'T.J.'), [
    { speaker: 'T.J.', start: 0.038, end: 1.132, text: 'Let us start the meeting.' },
    { speaker: 'T.J.', start: 2.662, end: 4.684, text: 'I think the panel work is nearly finished.' },
  ]);
  assert.deepEqual(parseSegments('', 'x'), []);
  assert.deepEqual(parseSegments(null, 'x'), []);
});

// ---- the whole job, with the recognizer faked ------------------------------------------------

function transcriberWith({ onDisk = true, outputs = {}, diarize = true } = {}) {
  const written = {};
  const calls = [];
  const files = {
    '/base/speech/sherpa/bin/sherpa-onnx-vad-with-offline-asr': true,
    '/base/speech/sherpa/silero_vad.onnx': true,
    '/base/speech/stt/moonshine-tiny-en/encoder_model.ort': true,
    '/base/speech/stt/moonshine-tiny-en/decoder_model_merged.ort': true,
    '/base/speech/stt/moonshine-tiny-en/tokens.txt': true,
  };
  if (diarize) {
    files['/base/speech/sherpa/bin/sherpa-onnx-offline-speaker-diarization'] = true;
    files['/base/speech/sherpa/segmentation/model.onnx'] = true;
    files['/base/speech/sherpa/speaker-embedding.onnx'] = true;
  }
  const fs = {
    existsSync: p => (onDisk ? !!files[p] : false),
    readdirSync: () => (onDisk ? ['moonshine-tiny-en'] : []),
    readFileSync: () => stereoWav([[1, 2], [3, 4]]),
    writeFileSync: (p, b) => { written[p] = b; },
    unlinkSync: p => { delete written[p]; },
  };
  const t = createLinuxMeetingTranscriber({
    baseDir: '/base', fs, tmpDir: '/tmp/x', log: () => {},
    execFile: (bin, args, opts, cb) => {
      calls.push({ bin, args, env: opts.env });
      const wav = args[args.length - 1];
      const which = /diarization/.test(bin) ? 'turns' : (wav.includes('mic') ? 'mic' : 'sys');
      cb(null, outputs[which] || '', '');
    },
  });
  return { t, calls, written };
}

test('nothing is attempted until the whole listening install is present', () => {
  assert.equal(transcriberWith({ onDisk: false }).t.available(), false);
  assert.equal(transcriberWith().t.available(), true);
});

test('both channels are transcribed and merged onto one timeline, the far side told apart', async () => {
  const { t, calls } = transcriberWith({ outputs: {
    mic: '0.30 -- 1.50: Can everyone hear me?\n7.90 -- 9.80: I will send the notes.',
    sys: '4.00 -- 5.30: Yes we can hear you.\n11.60 -- 12.80: That sounds good.',
    turns: '4.00 -- 5.30 speaker_00\n11.60 -- 12.80 speaker_01',
  } });
  const r = await t.transcribe('/recordings/meeting.wav', { myName: 'T.J.' });
  assert.deepEqual(r.segments.map(s => s.speaker + ': ' + s.text), [
    'T.J.: Can everyone hear me?',
    'Speaker 1: Yes we can hear you.',
    'T.J.: I will send the notes.',
    'Speaker 2: That sounds good.',
  ], 'interleaved in time, and two remote people are two people');
  assert.deepEqual(r.speaker_report.speakers.map(x => [x.name, x.channel, x.segments]),
    [['T.J.', 'left', 2], ['Speaker 1', 'right', 1], ['Speaker 2', 'right', 1]]);
  assert.equal(r.speaker_report.method, 'channels+diarization');
  assert.equal(calls.length, 3, 'a recognizer run per channel, plus the diarizer on the far side');
  assert.ok(calls[0].env.LD_LIBRARY_PATH.startsWith(path.join('/base', 'speech', 'sherpa', 'lib')),
    'the engine finds its own libraries');
  assert.ok(calls[0].args.some(a => a.startsWith('--silero-vad-model=')), 'timestamps need the VAD');
});

test('an unnamed operator is still labelled, and a silent recording is not an error', async () => {
  const { t } = transcriberWith({ outputs: {} });
  const r = await t.transcribe('/recordings/meeting.wav', {});
  assert.deepEqual(r.segments, []);
  assert.equal(r.speaker_report.speakers[0].name, 'Me');
});

test('a recording that is not the recorder\'s format is refused with a reason', async () => {
  const mono = createLinuxMeetingTranscriber({
    baseDir: '/base', tmpDir: '/tmp/x', log: () => {},
    fs: { existsSync: () => true, readdirSync: () => ['moonshine-tiny-en'],
          readFileSync: () => Buffer.concat([monoHeader(16000, 4), Buffer.alloc(4)]),
          writeFileSync: () => {}, unlinkSync: () => {} },
    execFile: (b, a, o, cb) => cb(null, '', ''),
  });
  await assert.rejects(() => mono.transcribe('/x.wav', {}), /not the 16-bit stereo WAV/);
});

test('a recognizer that fails names the channel it failed on', async () => {
  const t = createLinuxMeetingTranscriber({
    baseDir: '/base', tmpDir: '/tmp/x', log: () => {},
    fs: { existsSync: () => true, readdirSync: () => ['moonshine-tiny-en'],
          readFileSync: () => stereoWav([[1, 2]]), writeFileSync: () => {}, unlinkSync: () => {} },
    execFile: (b, a, o, cb) => cb(new Error('segfault')),
  });
  await assert.rejects(() => t.transcribe('/x.wav', { myName: 'T.J.' }), /channel: segfault/);
});

// ---- telling the far side apart ---------------------------------------------------------------

test('diarized turns are read, and anything else on that stream is ignored', () => {
  const out = ['Started', 'progress 50.00%', '0.335 -- 1.600 speaker_00',
               'Duration : 10.892 s', '2.866 -- 4.520 speaker_01', 'Elapsed seconds: 0.297'].join('\n');
  assert.deepEqual(parseTurns(out), [
    { start: 0.335, end: 1.600, cluster: 'speaker_00' },
    { start: 2.866, end: 4.520, cluster: 'speaker_01' },
  ]);
  assert.deepEqual(parseTurns(''), []);
});

test('overlap is the time two spans share, and nothing when they do not touch', () => {
  assert.equal(overlap({ start: 0, end: 2 }, { start: 1, end: 3 }), 1);
  assert.equal(overlap({ start: 0, end: 2 }, { start: 5, end: 6 }), 0);
  assert.equal(overlap({ start: 0, end: 10 }, { start: 2, end: 4 }), 2, 'fully contained');
});

test('speakers are numbered in the order they first speak, so the names mean something', () => {
  const turns = parseTurns('5.0 -- 6.0 speaker_03\n1.0 -- 2.0 speaker_01');
  const segs = [{ start: 1.1, end: 1.9, text: 'first' }, { start: 5.1, end: 5.9, text: 'second' }];
  assert.deepEqual(attribute(segs, turns, 'Others').map(s => s.speaker + ':' + s.text),
    ['Speaker 1:first', 'Speaker 2:second'], 'cluster numbers are arbitrary; order of speaking is not');
});

test('a line the diarizer did not cover keeps the fallback rather than being dropped', () => {
  // The recognizer heard words there. Losing the line would be worse than under-labelling it.
  const turns = parseTurns('1.0 -- 2.0 speaker_00');
  const segs = [{ start: 1.1, end: 1.9, text: 'covered' }, { start: 30, end: 31, text: 'not covered' }];
  assert.deepEqual(attribute(segs, turns, 'Others').map(s => s.speaker),
    ['Speaker 1', 'Others']);
});

test('a line is given the speaker it shares the most time with, not merely the first that touches it', () => {
  const turns = parseTurns('0.0 -- 1.1 speaker_00\n1.0 -- 5.0 speaker_01');
  const segs = [{ start: 1.0, end: 4.0, text: 'mostly the second speaker' }];
  assert.equal(attribute(segs, turns, 'Others')[0].speaker, 'Speaker 2');
});

test('without the diarization models the far side is one Others, and the job still runs', async () => {
  const { t, calls } = transcriberWith({ diarize: false, outputs: {
    mic: '0.30 -- 1.50: Hello.',
    sys: '4.00 -- 5.30: Hello back.',
  } });
  assert.equal(t.canDiarize(), false);
  const r = await t.transcribe('/recordings/meeting.wav', { myName: 'T.J.' });
  assert.deepEqual(r.segments.map(s => s.speaker), ['T.J.', 'Others']);
  assert.equal(r.speaker_report.method, 'channels');
  assert.equal(calls.length, 2, 'the diarizer is not run when it is not installed');
});

test('a diarizer that fails loses the speakers, never the transcript', async () => {
  const t = createLinuxMeetingTranscriber({
    baseDir: '/base', tmpDir: '/tmp/x', log: () => {},
    fs: { existsSync: () => true, readdirSync: () => ['moonshine-tiny-en'],
          readFileSync: () => stereoWav([[1, 2], [3, 4]]), writeFileSync: () => {}, unlinkSync: () => {} },
    execFile: (bin, args, opts, cb) => {
      if (/diarization/.test(bin)) return cb(new Error('model load failed'));
      cb(null, args[args.length - 1].includes('mic') ? '0.1 -- 1.0: Mine.' : '2.0 -- 3.0: Theirs.', '');
    },
  });
  const r = await t.transcribe('/recordings/meeting.wav', { myName: 'T.J.' });
  assert.deepEqual(r.segments.map(s => s.speaker + ': ' + s.text), ['T.J.: Mine.', 'Others: Theirs.']);
  assert.equal(r.speaker_report.method, 'channels');
});
