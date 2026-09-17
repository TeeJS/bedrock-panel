'use strict';

// IO edge (tiny): last-seen-version store, a flat JSON map keyed by "owner/repo".

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

function defaultStatePath() {
  return path.join(paths.configDir(), 'state.json');
}

function load(statePath) {
  const p = statePath || defaultStatePath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {}; // corrupt -> start fresh (everything re-updates)
  }
}

// Atomic write: a crash mid-write can't leave a truncated/corrupt state file.
function save(state, statePath) {
  const p = statePath || defaultStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours
  }
}

// Serialize update runs so two processes (tabs, CLI, server) can't interleave writes
// to state.json. Returns a token to pass to releaseLock. A stale lock from a dead
// process is stolen. Throws (err.locked) if another live run holds it.
function acquireLock(statePath) {
  const p = statePath || defaultStatePath();
  const lock = `${p}.lock`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return lock;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = parseInt(fs.readFileSync(lock, 'utf8').trim(), 10);
      if (owner && pidAlive(owner)) {
        const err = new Error('another update is already in progress');
        err.locked = true;
        throw err;
      }
      try {
        fs.rmSync(lock, { force: true }); // stale lock from a dead process -> steal it
      } catch {}
    }
  }
  const err = new Error('could not acquire the update lock');
  err.locked = true;
  throw err;
}

function releaseLock(lock) {
  if (lock) {
    try {
      fs.rmSync(lock, { force: true });
    } catch {}
  }
}

module.exports = { load, save, defaultStatePath, acquireLock, releaseLock, pidAlive };
