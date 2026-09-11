'use strict';
/*
 * linuxInput.js — the Linux keystroke backend behind app/mediaKeys.js.
 *
 * Owns one long-lived python3 helper (app/linux/uinput-helper.py) that holds a uinput virtual
 * keyboard, and translates robotjs key names into the evdev codes it speaks. Dependency-injected so
 * it unit-tests with a fake spawn, the way test/reservedDisplay.test.js tests its helper.
 *
 * Commands are fire-and-forget: a tile tap must not wait on a round trip, and the helper's replies
 * are only read to notice failures. The helper exits on stdin EOF, so it dies with the app.
 */
const path = require('path');
const childProcess = require('child_process');
const keymap = require('./linuxKeymap');

// Matches the other helpers: resolve next to this file, and reach outside the asar, since a python
// script inside app.asar is not a real file that python3 can open.
function helperScript(dir = __dirname) {
  return path.join(dir, 'linux', 'uinput-helper.py').replace('app.asar', 'app.asar.unpacked');
}

function createLinuxInput(options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const spawn = opts.spawn || childProcess.spawn;
  const python = opts.python || 'python3';
  const script = opts.script || helperScript();

  let child = null;
  let ready = false;
  let failed = null;     // a permanent failure: no python3, no /dev/uinput, helper rejected the setup
  let starting = false;

  function stop() {
    if (!child) return;
    try { child.stdin.end(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    child = null; ready = false;
  }

  function start() {
    if (child || starting || failed) return;
    starting = true;
    let proc = null;
    try {
      proc = spawn(python, [script, keymap.allCodes().join(',')], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      failed = 'cannot start python3: ' + (e && e.message);
      starting = false;
      log('keystrokes unavailable — ' + failed);
      return;
    }
    child = proc;
    starting = false;

    let out = '';
    if (proc.stdout) proc.stdout.on('data', buf => {
      out += String(buf);
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        if (line === 'ready') { ready = true; log('virtual keyboard ready'); }
        else if (line.startsWith('err')) log('helper: ' + line);
      }
    });
    if (proc.stderr) proc.stderr.on('data', buf => log('helper stderr: ' + String(buf).trim()));
    proc.on('error', e => { failed = String(e && e.message); log('keystrokes unavailable — ' + failed); child = null; ready = false; });
    proc.on('exit', code => {
      child = null; ready = false;
      // Exit 2 or 3 is the helper refusing the job (no codes, no permission, no device). Retrying
      // that forever would spawn a process per keystroke, so treat it as permanent.
      if (code === 2 || code === 3) {
        failed = 'helper exited with code ' + code;
        log('keystrokes unavailable — ' + failed + (code === 3
          ? '. /dev/uinput is not writable by you. Install the udev rule (Settings → Hardware → Device access), '
            + 'and if it still fails add yourself to the input group: sudo usermod -aG input $USER, then log out and back in.'
          : '.'));
      }
      else log('virtual keyboard helper exited (' + code + ')');
    });
  }

  function send(line) {
    if (failed) return false;
    if (!child) start();
    if (!child || !child.stdin || child.stdin.destroyed) return false;
    try { child.stdin.write(line + '\n'); return true; }
    catch (e) { log('write failed: ' + (e && e.message)); return false; }
  }

  function tap(name, mods) {
    const code = keymap.codeFor(name);
    if (code === null) { log('no Linux key code for "' + name + '"'); return false; }
    const modCodes = (mods || []).map(keymap.codeFor).filter(c => c !== null);
    return send(['tap', code].concat(modCodes).join(' '));
  }

  return {
    /** Start the helper eagerly, so the first macro is not delayed by device settle time. */
    warmUp() { start(); },
    /** Usable as far as we know. False only after a permanent failure. */
    available() { return !failed; },
    /** The device exists and the compositor has had time to see it. */
    isReady() { return ready; },
    failure() { return failed; },
    tap,
    keyDown(name) { const c = keymap.codeFor(name); return c === null ? false : send('key ' + c + ' 1'); },
    keyUp(name) { const c = keymap.codeFor(name); return c === null ? false : send('key ' + c + ' 0'); },
    /** Type literal text. Characters with no code on a US layout are skipped, not fatal. */
    typeString(text) {
      const { taps, skipped } = keymap.textToTaps(text);
      if (skipped.length) log('skipped ' + skipped.length + ' character(s) with no key on this layout: ' + skipped.join(''));
      if (!taps.length) return false;
      let ok = true;
      for (const t of taps) ok = send(['tap', t.code].concat(t.mods).join(' ')) && ok;
      return ok;
    },
    stop,
  };
}

module.exports = { createLinuxInput, helperScript };
