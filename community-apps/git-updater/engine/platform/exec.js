'use strict';

// Shared subprocess helper for the platform modules. Everything is ASYNC on purpose:
// these inventory commands take seconds, and a spawnSync would freeze the Electron
// main process (window paint, IPC) for that whole time.
//
// No shell is ever used — the command and its arguments are passed as an argv array,
// so nothing is parsed or expanded by an intermediate shell.

const { spawn } = require('child_process');

// Run a command and report how it went: { code, out, err, timedOut }.
//   code     the exit status, or null when the process never ran or was killed
//   out      stdout, '' on any failure
//   err      stderr — where tools like codesign put the REASON, which is the difference
//            between telling a user "a sealed resource is missing or invalid" and "exit 1"
//   timedOut true when the watchdog killed it
//
// Use this whenever SUCCESS MATTERS. run() below cannot express it: a tool that
// succeeds silently and a tool that fails both produce '', and copying tools like
// ditto are exactly that shape — silence on success is the normal case.
function runStatus(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve({ code: null, out: '', err: '', timedOut: false });
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    // A hung command must not hang the whole operation. Callers that copy large files
    // MUST raise this; the default suits an inventory query, not a 300MB bundle copy.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ code: null, out: '', err, timedOut: true });
    }, opts.timeout || 60_000);
    child.stdout.on('data', (d) => (out += d));
    // stderr must be drained even when unused: a full pipe blocks the child.
    child.stderr.on('data', (d) => (err += d));
    child.on('error', () => {
      clearTimeout(timer);
      finish({ code: null, out: '', err, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, out, err, timedOut: false });
    });
  });
}

// Resolve a command's stdout, or '' on any failure including the command not existing.
// Callers treat '' as "this source has nothing to contribute", which is right for the
// inventory queries and wrong for anything whose failure must be noticed — use
// runStatus for those.
async function run(cmd, args, opts = {}) {
  const r = await runStatus(cmd, args, opts);
  // Some inventory tools exit nonzero with partial-but-usable output; callers that care
  // pass acceptAnyExit. The default stays strict, as the registry reader was.
  return r.code === 0 || (opts.acceptAnyExit && r.code !== null) ? r.out : '';
}

module.exports = { run, runStatus };
