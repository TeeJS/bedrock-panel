'use strict';
/*
 * linuxShortcuts.js — a stand-in for Electron's `globalShortcut` on Linux.
 *
 * Electron's own one is unusable here: `register()` returns true under XWayland and the shortcut
 * never fires, even when the key is pressed by a real kernel-level keyboard. Registration succeeding
 * is not evidence of anything, which is the worst kind of failure. This routes through the XDG
 * GlobalShortcuts portal instead (app/linux/portal-shortcuts.py).
 *
 * The shape of the feature changes, and callers should not pretend otherwise. On Windows and macOS
 * the app takes the key combination the user typed. Here the app registers a NAMED ACTION and
 * proposes a trigger; the desktop decides. KDE Plasma 6.6 shows one dialog listing the actions with
 * the proposed keys already filled in, and a click on OK binds them -- the keys the user typed do
 * become live, after one consent step, measured by pressing them with this project's own uinput
 * keyboard. Nobody has to visit System Settings.
 *
 * The dialog is modal to nothing: BindShortcuts does not answer until it is dealt with, and ignoring
 * or cancelling it leaves the actions registered with NO key. That is indistinguishable, from here,
 * from a desktop that binds nothing -- so `triggers()` reporting an empty string means "not bound
 * yet", not "this desktop cannot". The editor shows what was actually granted either way.
 *
 * Registrations are batched: the portal binds a whole set in one call, so register() collects and
 * apply() performs the handshake. main.js already rebuilds its whole shortcut set at once.
 */
const path = require('path');
const childProcess = require('child_process');

function helperScript(dir = __dirname) {
  return path.join(dir, 'linux', 'portal-shortcuts.py').replace('app.asar', 'app.asar.unpacked');
}

/**
 * Electron accelerator -> the portal's trigger syntax, or null when it cannot be expressed.
 * "Ctrl+Alt+S" -> "CTRL+ALT+s". The portal wants modifiers upper-cased and the key as an XKB name.
 */
function toPortalTrigger(accelerator) {
  const parts = String(accelerator || '').split('+').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const MODS = { ctrl: 'CTRL', control: 'CTRL', cmdorctrl: 'CTRL', commandorcontrol: 'CTRL',
                 alt: 'ALT', option: 'ALT', shift: 'SHIFT', super: 'SUPER', meta: 'SUPER',
                 cmd: 'SUPER', command: 'SUPER' };
  const mods = [];
  let key = null;
  for (const p of parts) {
    const m = MODS[p.toLowerCase()];
    if (m) { if (!mods.includes(m)) mods.push(m); continue; }
    key = p;
  }
  if (!key) return null;
  // Single characters go through lower-cased; named keys (F5, Space) keep their spelling.
  const xkb = key.length === 1 ? key.toLowerCase() : key;
  return mods.concat(xkb).join('+');
}

/** A stable, readable id for a shortcut, derived from the accelerator it was asked for. */
function idFor(accelerator, index) {
  const slug = String(accelerator || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (slug || 'shortcut') + '-' + index;
}

function createLinuxShortcuts(options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const spawn = opts.spawn || childProcess.spawn;
  const python = opts.python || 'python3';
  const script = opts.script || helperScript();

  let child = null;
  let pending = [];          // [{ id, accelerator, description, trigger, callback }]
  let granted = {};          // id -> trigger description the desktop actually bound
  let failed = null;

  function stop() {
    if (!child) return;
    try { child.stdin.end(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    child = null;
  }

  function onLine(line) {
    if (line.startsWith('ready ') || line.startsWith('changed ')) {
      try { granted = JSON.parse(line.slice(line.indexOf(' ') + 1)); } catch (e) { granted = {}; }
      const unbound = pending.filter(s => !granted[s.id]).length;
      log('portal bound ' + (pending.length - unbound) + ' of ' + pending.length + ' shortcut(s)'
        + (unbound ? ' — the rest have no key until they are assigned in the desktop\'s shortcut settings' : ''));
      return;
    }
    if (line.startsWith('activated ')) {
      const id = line.slice('activated '.length).trim();
      const hit = pending.find(s => s.id === id);
      if (hit && typeof hit.callback === 'function') { try { hit.callback(); } catch (e) { log('shortcut handler threw: ' + (e && e.message)); } }
      return;
    }
    if (line.startsWith('err ')) { failed = line.slice(4); log('global shortcuts unavailable — ' + failed); }
  }

  return {
    /** Collect a shortcut. Nothing reaches the portal until apply(). Mirrors globalShortcut.register's return. */
    register(accelerator, callback) {
      const trigger = toPortalTrigger(accelerator);
      if (!trigger) { log('cannot express "' + accelerator + '" as a portal trigger'); return false; }
      const id = idFor(accelerator, pending.length);
      pending.push({ id, accelerator, description: opts.describe ? opts.describe(accelerator) : accelerator, trigger, callback });
      return true;
    },
    /** Hand the whole set to the portal. Replaces any previous session. */
    apply() {
      stop();
      granted = {};
      if (failed || !pending.length) return false;
      const payload = JSON.stringify(pending.map(s => ({ id: s.id, description: s.description, trigger: s.trigger })));
      let proc = null;
      try { proc = spawn(python, [script, payload], { stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (e) { failed = 'cannot start python3: ' + (e && e.message); log('global shortcuts unavailable — ' + failed); return false; }
      child = proc;
      let buf = '';
      if (proc.stdout) proc.stdout.on('data', b => {
        buf += String(b);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); }
      });
      if (proc.stderr) proc.stderr.on('data', b => log('portal helper stderr: ' + String(b).trim()));
      proc.on('error', e => { failed = String(e && e.message); child = null; log('global shortcuts unavailable — ' + failed); });
      proc.on('exit', code => {
        child = null;
        // 2 = bad arguments, 3 = no portal, 4 = no PyGObject. None of those get better by retrying.
        if (code === 2 || code === 3 || code === 4) { failed = 'portal helper exited with code ' + code; log('global shortcuts unavailable — ' + failed); }
      });
      return true;
    },
    unregisterAll() { stop(); pending = []; granted = {}; },
    /** accelerator -> what the desktop actually bound ('' when it bound nothing). For the editor. */
    triggers() {
      const out = {};
      for (const s of pending) out[s.accelerator] = granted[s.id] || '';
      return out;
    },
    available() { return !failed; },
    failure() { return failed; },
    stop,
  };
}

module.exports = { createLinuxShortcuts, toPortalTrigger, idFor, helperScript };
