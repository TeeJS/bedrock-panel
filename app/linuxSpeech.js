'use strict';
/*
 * linuxSpeech.js — the built-in speech engine on Linux, as main.js sees it.
 *
 * Owns one long-lived python3 helper (app/linux/speech-server.py) that holds a resident Piper voice
 * and serves Wyoming on 127.0.0.1:10200, the same loopback convention the macOS engine and the
 * Windows helper already use. Nothing downstream changes: app/claudevoice-wyoming.js dials the same
 * host and port it would dial for any other server.
 *
 * Nothing ships in the package. The engine and the voices are downloaded on first use into
 * <userData>/speech, so the deb and the AppImage stay their current size and behave identically, and
 * the voice a person picks decides what is fetched. `installed()` is therefore the question every
 * caller asks first, and it is answered from the filesystem, not from config.
 *
 * The port rule, which is the whole reason this is polite to the rest of the machine: if something
 * ALREADY answers on 10200, that is someone's own wyoming-piper and it wins. The helper exits 3
 * rather than fighting for the port, and this module reports that as `deferred` — not as a failure,
 * because the user ends up with working speech either way.
 *
 * Dependency-injected (spawn, base directory) so it unit-tests with a fake spawn and no engine
 * installed, the way test/linuxInput.test.js tests the uinput helper.
 */
const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');

// The loopback ports every Wyoming consumer already expects. Piper is TTS; STT is phase two.
const TTS_PORT = 10200;
const HOST = '127.0.0.1';

function helperScript(dir = __dirname) {
  return path.join(dir, 'linux', 'speech-server.py').replace('app.asar', 'app.asar.unpacked');
}

/** Where a downloaded engine and its voices live. Outside the app, so an upgrade never touches them. */
function layout(baseDir) {
  const root = path.join(baseDir, 'speech');
  return {
    root,
    piperDir: path.join(root, 'piper'),
    piperBinary: path.join(root, 'piper', 'piper'),
    voicesDir: path.join(root, 'voices'),
  };
}

/** The .onnx of the named voice, or of the only installed voice when no name is given. */
function voiceModel(baseDir, name, readdir = fs.readdirSync, exists = fs.existsSync) {
  const { voicesDir } = layout(baseDir);
  let names;
  try { names = readdir(voicesDir); } catch (e) { return null; }
  const wanted = name && names.includes(name) ? [name] : names;
  for (const dir of wanted) {
    const model = path.join(voicesDir, dir, dir + '.onnx');
    if (exists(model)) return model;
  }
  return null;
}

function createLinuxSpeech(options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const spawn = opts.spawn || childProcess.spawn;
  const python = opts.python || 'python3';
  const script = opts.script || helperScript();
  const baseDir = opts.baseDir || '';
  const exists = opts.exists || fs.existsSync;
  const readdir = opts.readdir || fs.readdirSync;
  const port = opts.port || TTS_PORT;

  let child = null;
  let ready = false;
  let deferred = false;   // something else already serves the port, and it wins
  let failed = null;

  const paths = layout(baseDir);

  /** Is there an engine and a voice on disk to run? Asked before anything else. */
  function installed(voice) {
    return !!(exists(paths.piperBinary) && voiceModel(baseDir, voice, readdir, exists));
  }

  function stop() {
    if (!child) return;
    try { child.stdin.end(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    child = null; ready = false;
  }

  function start(voice) {
    if (child || failed) return;
    const model = voiceModel(baseDir, voice, readdir, exists);
    if (!exists(paths.piperBinary) || !model) { log('built-in speech is not installed yet'); return; }
    let proc = null;
    const args = [script, '--piper', paths.piperBinary, '--model', model,
                  '--config', model + '.json', '--lib-dir', paths.piperDir,
                  '--host', HOST, '--port', String(port)];
    try {
      proc = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      failed = 'cannot start python3: ' + (e && e.message);
      log('built-in speech unavailable — ' + failed);
      return;
    }
    child = proc;
    deferred = false;

    let out = '';
    if (proc.stdout) proc.stdout.on('data', buf => {
      out += String(buf);
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        if (line === 'ready') { ready = true; log('built-in speech ready on ' + HOST + ':' + port); }
      }
    });
    if (proc.stderr) proc.stderr.on('data', buf => log('speech: ' + String(buf).trim()));
    proc.on('error', e => { failed = String(e && e.message); log('built-in speech unavailable — ' + failed); child = null; ready = false; });
    proc.on('exit', code => {
      child = null; ready = false;
      // 3 is the helper finding the port already served. That is someone's own Wyoming server and it
      // wins — the app points at the same host and port regardless, so speech still works.
      if (code === 3) {
        deferred = true;
        log('another Wyoming server already serves ' + HOST + ':' + port + ' — using it instead of starting ours');
      } else if (code === 2) {
        failed = 'the speech helper refused to start (exit 2)';
        log('built-in speech unavailable — ' + failed);
      } else if (code !== 0 && code !== null) {
        log('speech helper exited (' + code + ')');
      }
    });
  }

  return {
    paths,
    installed,
    start,
    stop,
    /** Where a Wyoming client should dial for the built-in engine. */
    endpoint() { return { host: HOST, port }; },
    /** Serving now, either because we started it or because someone else's server already was. */
    available() { return (ready || deferred) && !failed; },
    isReady() { return ready; },
    deferredToExisting() { return deferred; },
    failure() { return failed; },
  };
}

module.exports = { createLinuxSpeech, helperScript, layout, voiceModel, TTS_PORT, HOST };
