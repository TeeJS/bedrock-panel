'use strict';
// Enrolled voices: the on-disk format that has to match the other stacks, the name handling, and
// the matching arithmetic. No audio and no models, so it runs anywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createSpeakerProfiles, writeNpy, readNpy, normalizeName, cosine, validName,
} = require('../app/linuxSpeakerProfiles');
const clusters = require('../app/linuxSpeakerClusters');
const { DIARIZATION } = require('../app/linuxSpeechCatalog');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-profiles-')); }

test('a profile is a NumPy array, byte for byte, so other machines can read it', () => {
  const buf = writeNpy([1.5, -2.25, 3.125]);
  assert.equal(buf.toString('latin1', 0, 6), '\x93NUMPY');
  assert.equal(buf[6], 1, 'version 1.0, which is what the other stacks write');
  const headerLen = buf.readUInt16LE(8);
  assert.equal((10 + headerLen) % 64, 0, 'NumPy requires the data to start 64-byte aligned');
  assert.match(buf.toString('latin1', 10, 10 + headerLen), /'descr': '<f4'.*'shape': \(3,\)/);
  assert.deepEqual(readNpy(buf), [1.5, -2.25, 3.125]);
});

test('anything that is not a 1-D float32 array is refused rather than misread', () => {
  assert.equal(readNpy(Buffer.alloc(4)), null, 'too short');
  assert.equal(readNpy(Buffer.alloc(100)), null, 'no magic');
  const good = writeNpy([1, 2, 3]);
  const truncated = good.subarray(0, good.length - 6);
  assert.equal(readNpy(truncated), null, 'the data is shorter than the shape claims');
});

test('a name written one way matches the same name written another', () => {
  // An attendee list pasted out of a calendar says "Schmitz, T.J."; the profile says "T.J. Schmitz".
  assert.equal(normalizeName('Schmitz, T.J.'), normalizeName('T.J. Schmitz'));
  assert.equal(normalizeName('  dave  brubeck '), normalizeName('Dave Brubeck'));
  assert.notEqual(normalizeName('Dave Brubeck'), normalizeName('Dave Brubek'));
});

test('a name that would escape the profile folder is refused', () => {
  for (const bad of ['../secrets', 'a/b', '', '   ', '.', '..', 'a\\b']) {
    assert.equal(validName(bad), null, JSON.stringify(bad) + ' must not be a profile name');
  }
  assert.equal(validName('  T.J. Schmitz '), 'T.J. Schmitz', 'trimmed, and otherwise left alone');
});

test('profiles round-trip through the folder, and the filename is the identity', () => {
  const dir = tempDir();
  try {
    const store = createSpeakerProfiles({ dir });
    assert.deepEqual(store.list(), []);
    assert.equal(store.save('Dave Brubeck', [1, 0, 0]), true);
    assert.equal(store.save('Paul Desmond', [0, 1, 0]), true);
    assert.deepEqual(store.list(), ['Dave Brubeck', 'Paul Desmond']);
    assert.ok(fs.existsSync(path.join(dir, 'Dave Brubeck.npy')), 'the file is named after the person');
    assert.deepEqual(store.all()['Dave Brubeck'], [1, 0, 0]);
    assert.equal(store.save('../escape', [1]), false, 'a bad name saves nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('renaming keeps the profile, and never silently overwrites somebody else', () => {
  const dir = tempDir();
  try {
    const store = createSpeakerProfiles({ dir });
    store.save('Dave', [1, 0, 0]);
    store.save('Paul', [0, 1, 0]);
    assert.equal(store.rename('Dave', 'Dave Brubeck'), true);
    assert.deepEqual(store.list(), ['Dave Brubeck', 'Paul']);
    assert.equal(store.rename('Dave Brubeck', 'Paul'), false, 'Paul already exists');
    assert.deepEqual(store.all()['Paul'], [0, 1, 0], 'and Paul is untouched');
    assert.equal(store.remove('Paul'), true);
    assert.deepEqual(store.list(), ['Dave Brubeck']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a voice is identified only when it clears the threshold', () => {
  const dir = tempDir();
  try {
    const store = createSpeakerProfiles({ dir });
    store.save('Dave', [1, 0, 0]);
    store.save('Paul', [0, 1, 0]);
    const asDave = store.identify([0.99, 0.14, 0]);
    assert.equal(asDave.matched, 'Dave');
    assert.ok(asDave.scores[0].score > DIARIZATION.similarityThreshold);
    assert.equal(asDave.scores.length, 2, 'every profile is scored, so a report can show the near misses');
    const stranger = store.identify([0.6, 0.6, 0.53]);
    assert.equal(stranger.matched, null, 'close to both is nobody');
    assert.equal(store.identify([1, 0, 0], { threshold: 0.99 }).matched, 'Dave', 'an exact match still passes');
    assert.equal(store.identify(null).matched, null);
    assert.equal(store.identify([Number.NaN, 0, 0]).matched, null, 'a broken fingerprint names nobody');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('somebody not on the attendee list is penalised, not excluded', () => {
  // Meetings have gatecrashers and calendars have mistakes, so the list is a hint, not a gate.
  const dir = tempDir();
  try {
    const store = createSpeakerProfiles({ dir });
    store.save('Dave Brubeck', [1, 0, 0]);
    const invited = store.identify([1, 0, 0], { attendees: ['Brubeck, Dave'] });
    assert.equal(invited.matched, 'Dave Brubeck', 'the comma form still resolves to the enrolled name');
    assert.equal(invited.scores[0].attendee, true);
    const uninvited = store.identify([1, 0, 0], { attendees: ['Someone Else'] });
    assert.equal(uninvited.scores[0].attendee, false);
    assert.ok(Math.abs(uninvited.scores[0].raw - uninvited.scores[0].score - DIARIZATION.attendeeOffset) < 1e-6,
      'the penalty is exactly the offset');
    assert.equal(uninvited.matched, 'Dave Brubeck', 'still a match: 1.0 minus 0.15 clears 0.70');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('two profiles that are nearly as close as each other are flagged ambiguous', () => {
  const dir = tempDir();
  try {
    const store = createSpeakerProfiles({ dir });
    store.save('Twin One', [1, 0.02, 0]);
    store.save('Twin Two', [1, 0, 0.02]);
    const r = store.identify([1, 0.01, 0.01]);
    assert.ok(r.margin < DIARIZATION.ambiguousMargin);
    assert.equal(r.ambiguous, true, 'a coin toss must be visible rather than presented as a fact');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the operator is labelled with their enrolled spelling when there is one', () => {
  const dir = tempDir();
  try {
    const store = createSpeakerProfiles({ dir });
    store.save('T.J. Schmitz', [1, 0, 0]);
    assert.equal(store.resolveName('tj schmitz'), 'T.J. Schmitz');
    assert.equal(store.resolveName('Schmitz, T.J.'), 'T.J. Schmitz');
    assert.equal(store.resolveName('Somebody Else'), 'Somebody Else', 'not enrolled, used verbatim');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the clustering arithmetic ----------------------------------------------------------------

test('a cluster fingerprint normalizes each segment before averaging them', () => {
  // Otherwise one loud segment's magnitude decides the cluster's identity on its own.
  const out = clusters.clusterEmbedding([
    { start: 0, end: 3, embedding: [300, 0, 0] },
    { start: 5, end: 7, embedding: [0, 2, 0] },
  ]);
  const rounded = out.embedding.map(v => Math.round(v * 1000) / 1000);
  assert.deepEqual(rounded, [0.707, 0.707, 0], 'equal weight despite a 150x magnitude difference');
  assert.deepEqual(out.used, [[0, 3], [5, 7]]);
});

test('segments too short to be a voice do not contribute to a fingerprint', () => {
  const out = clusters.clusterEmbedding([
    { start: 0, end: 3, embedding: [1, 0, 0] },
    { start: 9, end: 9.2, embedding: [0, 0, 1] },
  ]);
  assert.deepEqual(out.used, [[0, 3]]);
  assert.equal(clusters.clusterEmbedding([]).embedding, null);
});

test('only the longest segments are used, because the tail is noise', () => {
  const many = [];
  for (let i = 0; i < DIARIZATION.maxEmbedSegments + 10; i++) many.push({ start: i * 10, end: i * 10 + 1 + i, embedding: [1, 0, 0] });
  assert.equal(clusters.clusterEmbedding(many).used.length, DIARIZATION.maxEmbedSegments);
});

test('clusters of one person are merged, and merging is weighted by how long they spoke', () => {
  const merged = clusters.mergeClusters([
    { labels: [0], duration: 30, embedding: [1, 0, 0], segments: [] },
    { labels: [1], duration: 5, embedding: [0.98, 0.2, 0], segments: [] },
    { labels: [2], duration: 20, embedding: [0, 1, 0], segments: [] },
  ]);
  assert.equal(merged.length, 2, 'the two alike clusters are one person');
  assert.equal(merged[0].duration, 35);
  assert.deepEqual(merged[0].labels, [0, 1]);
  assert.ok(merged[0].embedding[0] > 0.99, 'the 30-second cluster dominates the 5-second one');
});

test('nothing is merged when nobody is alike enough', () => {
  const apart = [
    { labels: [0], duration: 30, embedding: [1, 0, 0], segments: [] },
    { labels: [1], duration: 30, embedding: [0, 1, 0], segments: [] },
  ];
  assert.equal(clusters.mergeClusters(apart).length, 2);
});

test('placeholder names run A to Z and then keep counting', () => {
  assert.equal(clusters.placeholderName(0), 'Speaker A');
  assert.equal(clusters.placeholderName(25), 'Speaker Z');
  assert.equal(clusters.placeholderName(26), 'Speaker 27');
});

test('an unknown voice that talked a lot is suggested for enrollment', () => {
  const labelled = [
    { name: 'Dave', identified: true, duration: 300 },
    { name: 'Speaker A', identified: false, duration: 200 },
    { name: 'Speaker B', identified: false, duration: 5 },
  ];
  const candidates = clusters.enrollmentCandidates(labelled, 505);
  assert.deepEqual(candidates.map(c => c.cluster), ['Speaker A'], 'the 1% voice is not worth a prompt');
  assert.equal(candidates[0].duration_sec, 200);
});
