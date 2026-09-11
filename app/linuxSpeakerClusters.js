'use strict';
/*
 * linuxSpeakerClusters.js — turning diarized turns into people.
 *
 * The diarizer says "these spans are the same voice" and hands back more clusters than there are
 * humans. This module is the arithmetic that gets from there to a list of participants: build one
 * fingerprint per cluster, merge the ones that are obviously the same person, drop the fragments,
 * and give each survivor a name.
 *
 * All of it is pure — vectors in, vectors out — so the tuning can be tested without audio, a model,
 * or a subprocess. The constants live in linuxSpeechCatalog and are ported from the Windows
 * helper's pipeline, itself a port of the Python meeting-diarizer's, so that a score means the same
 * thing on every platform. The one that matters most is the merge: sherpa's clustering over-splits
 * badly against a real meeting (the reference notes 62 clusters where the Python pipeline found 4),
 * so a merge pass afterwards is not a refinement, it is the difference between a transcript with
 * four people in it and one with sixty-two.
 */
const { DIARIZATION } = require('./linuxSpeechCatalog');

/** L2 norm of a vector. */
function norm(v) {
  let n = 0;
  for (const x of v) n += x * x;
  return Math.sqrt(n);
}

/** A copy scaled to unit length, or null when there is nothing to scale. */
function unit(v) {
  if (!v || !v.length) return null;
  const n = norm(v);
  if (!(n > 1e-8) || v.some(x => !Number.isFinite(x))) return null;
  return v.map(x => x / n);
}

/**
 * One fingerprint for a cluster, from the fingerprints of its segments.
 *
 * Each segment is normalized BEFORE averaging, so a long confident segment does not drown out the
 * rest by sheer magnitude, and the mean is normalized again so cluster fingerprints are comparable
 * to each other and to an enrolled profile. Segments shorter than the minimum are dropped and only
 * the longest are used: the tail of a meeting's 1-second interjections is noise in this space.
 */
function clusterEmbedding(segments) {
  const usable = (segments || [])
    .filter(s => s.embedding && (s.end - s.start) >= DIARIZATION.minSegmentSec)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .slice(0, DIARIZATION.maxEmbedSegments);
  let sum = null;
  const used = [];
  for (const seg of usable) {
    const u = unit(seg.embedding);
    if (!u) continue;
    if (!sum) sum = new Array(u.length).fill(0);
    for (let i = 0; i < u.length; i++) sum[i] += u[i];
    used.push([seg.start, seg.end]);
  }
  if (!sum) return { embedding: null, used: [] };
  for (let i = 0; i < sum.length; i++) sum[i] /= used.length;
  const n = norm(sum) + 1e-8;
  return { embedding: sum.map(x => x / n), used };
}

function cos(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (norm(a) * norm(b) + 1e-8);
}

/**
 * Repeatedly join the two most similar clusters until none are alike enough. Merging is weighted by
 * how long each cluster spoke, so a thirty-second cluster is not dragged off course by a
 * five-second one it absorbs.
 */
function mergeClusters(clusters, threshold) {
  const cut = threshold == null ? DIARIZATION.clusterMergeThreshold : threshold;
  const out = clusters.map(c => Object.assign({}, c, { labels: c.labels.slice(), segments: c.segments.slice() }));
  for (;;) {
    let bi = -1, bj = -1, best = cut;
    for (let i = 0; i < out.length; i++) {
      if (!out[i].embedding) continue;
      for (let j = i + 1; j < out.length; j++) {
        if (!out[j].embedding) continue;
        const c = cos(out[i].embedding, out[j].embedding);
        if (c >= best) { bi = i; bj = j; best = c; }
      }
    }
    if (bi < 0) break;
    const a = out[bi], b = out[bj];
    const merged = a.embedding.map((v, k) => v * a.duration + b.embedding[k] * b.duration);
    const n = norm(merged) + 1e-8;
    a.embedding = merged.map(v => v / n);
    a.labels = a.labels.concat(b.labels);
    a.segments = a.segments.concat(b.segments);
    a.duration += b.duration;
    out.splice(bj, 1);
  }
  return out;
}

/** Clusters too short to be a participant. Their words fall back rather than inventing a person. */
function dropFragments(clusters, minSec) {
  const cut = minSec == null ? DIARIZATION.minClusterSec : minSec;
  return clusters.filter(c => c.duration >= cut);
}

/** "Speaker A" … "Speaker Z", then "Speaker 27" onwards. */
function placeholderName(index) {
  return index < 26 ? 'Speaker ' + String.fromCharCode(65 + index) : 'Speaker ' + (index + 1);
}

/**
 * Give every cluster a display name: the enrolled speaker it matches, else a placeholder in order
 * of appearance. `identify` is the profile store's; passing one that knows no profiles is how a
 * machine with nobody enrolled still gets a readable transcript.
 */
function labelClusters(clusters, identify, settings) {
  let unnamed = 0;
  return clusters.map(c => {
    const result = c.embedding && identify ? identify(c.embedding, settings) : { matched: null, scores: [], margin: null, ambiguous: false };
    const name = result.matched || placeholderName(unnamed);
    if (!result.matched) unnamed++;
    return Object.assign({}, c, {
      name,
      identified: !!result.matched,
      scores: result.scores || [],
      margin: result.margin == null ? null : result.margin,
      ambiguous: !!result.ambiguous,
    });
  });
}

/** Unknown voices that spoke enough of the meeting to be worth a name. */
function enrollmentCandidates(labelled, totalSpeechSec) {
  if (!(totalSpeechSec > 0)) return [];
  return labelled
    .filter(c => !c.identified && (c.duration / totalSpeechSec) * 100 >= DIARIZATION.enrollCandidatePct)
    .map(c => ({ cluster: c.name, duration_sec: Math.round(c.duration * 100) / 100,
                 speech_pct: Math.round((c.duration / totalSpeechSec) * 1000) / 10 }));
}

module.exports = {
  clusterEmbedding, mergeClusters, dropFragments, labelClusters, enrollmentCandidates,
  placeholderName, cos, unit,
};
