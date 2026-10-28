'use strict';

// Obsidian export for finished meeting files: a plain copy of the published <base>.md into an
// Obsidian vault, at the same path under the vault root as the file has under Completed Meetings
// (YYYY\<Meeting-Name>\ for recurring meetings, YYYY\MM\ for the rest, the root otherwise), so
// the vault mirrors Completed one-to-one. Nothing here runs git: the vault's own sync (the
// Obsidian Git plugin on the PC, a git client on a phone) commits and pushes; Bedrock only
// writes the file. Deps are injected for tests: fs, log.
//
// Edits made in the vault (speaker names fixed on a phone, say) are never overwritten. The
// meeting file remembers the hash of the bytes Bedrock last wrote to the vault
// (`bedrock.exports.obsidian.hash`); a vault copy that no longer hashes to that was edited there,
// so a re-analysis lands BESIDE it as <base>.conflict.md for the user to merge, and the meeting
// file records `state: conflict`. The caller writes `pending` to the meeting file before the copy
// and `succeeded` / `conflict` after, so a crash in between is settled on the next analysis by
// re-hashing the vault copy (verifyExport).

const path = require('path');
const { sha256 } = require('./meetingFile');

// The vault root as a usable directory, or an Error naming what is wrong (not set, missing).
// Checked BEFORE anything is recorded in the meeting file: a missing vault writes nothing anywhere.
function resolveVault(fsMod, vaultRoot) {
  const root = String(vaultRoot || '').trim();
  if (!root) throw new Error('Obsidian vault folder is not set — configure it in Settings › Meeting');
  let st = null;
  try { st = fsMod.statSync(root); } catch (e) { st = null; }
  if (!st || !st.isDirectory()) throw new Error('Obsidian vault folder not found: ' + root + ' — nothing written');
  return path.resolve(root);
}

// Vault-relative posix path → absolute path inside the vault; refuses anything that escapes it.
function vaultPathFor(root, relPath) {
  const rel = String(relPath || '').split('/').filter(Boolean);
  if (!rel.length || rel.some(p => p === '.' || p === '..')) throw new Error('bad vault path: ' + relPath);
  const abs = path.join(root, ...rel);
  const back = path.relative(root, abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new Error('vault path escapes the vault: ' + relPath);
  return abs;
}

async function writeAtomic(fsp, dest, bytes) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp';
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, dest);
}

async function hashOf(fsMod, p) {
  try { return sha256(await fsMod.promises.readFile(p)); } catch (e) { return null; }
}

// Copy `bytes` to <vault>/<relPath>. `prior` is the meeting file's previous exports.obsidian
// record (or null). Resolves { state, path, hash, conflict?, left? }: `state` is 'succeeded' when
// the vault copy is now these bytes, 'conflict' when the vault copy was edited there and the bytes
// went to `conflict` (<base>.conflict.md) instead. An earlier copy at a different path (the
// meeting moved to its recurring folder) is removed when it is still what Bedrock wrote, or left
// in place and named in `left` when it was edited.
async function exportMeetingFile({ fs: fsMod, vaultRoot, relPath, bytes, prior, log }) {
  const fsp = fsMod.promises;
  const say = log || (() => {});
  const root = resolveVault(fsMod, vaultRoot);
  const dest = vaultPathFor(root, relPath);
  const hash = sha256(bytes);
  // Bytes Bedrock is known to have written at this path: the last record's hash, plus the one
  // before it when that record is a pending write that may never have landed.
  const ours = new Set();
  if (prior && prior.hash) ours.add(String(prior.hash));
  if (prior && prior.prior_hash) ours.add(String(prior.prior_hash));
  const existing = await hashOf(fsMod, dest);
  const record = { state: 'succeeded', path: relPath, hash };
  if (existing === null || ours.has(existing)) {
    await writeAtomic(fsp, dest, bytes);
  } else {
    // The vault copy is not what Bedrock last wrote: someone edited it (or it was never ours).
    // Their file stays; the new analysis lands beside it for a manual merge.
    record.state = 'conflict';
    record.conflict = relPath.replace(/\.md$/i, '') + '.conflict.md';
    await writeAtomic(fsp, vaultPathFor(root, record.conflict), bytes);
  }
  // The meeting moved (recurring folder, year): the copy at the old path goes when it is still
  // ours, and stays when it was edited there — a vault edit is never deleted.
  if (prior && prior.path && prior.path !== relPath) {
    let old = null;
    try { old = vaultPathFor(root, prior.path); } catch (e) { old = null; }
    const oldHash = old ? await hashOf(fsMod, old) : null;
    if (oldHash !== null) {
      if (ours.has(oldHash)) { await fsp.unlink(old); say('obsidian export: earlier vault copy removed: ' + prior.path); }
      else { record.left = prior.path; say('obsidian export: earlier vault copy was edited there and was left in place: ' + prior.path); }
    }
  }
  return record;
}

// A `pending` record from an interrupted run: true when the vault copy at its path is exactly the
// bytes the record names (the write landed; the state can flip to succeeded), false otherwise.
async function verifyExport({ fs: fsMod, vaultRoot, record }) {
  if (!record || !record.path || !record.hash) return false;
  let root;
  try { root = resolveVault(fsMod, vaultRoot); } catch (e) { return false; }
  let dest;
  try { dest = vaultPathFor(root, record.path); } catch (e) { return false; }
  return (await hashOf(fsMod, dest)) === String(record.hash);
}

module.exports = { exportMeetingFile, verifyExport, resolveVault, vaultPathFor };
