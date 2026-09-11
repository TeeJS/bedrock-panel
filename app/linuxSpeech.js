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
const STT_PORT = 10300;
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
    // Listening is a different engine from speaking, so it gets its own tree: one can be installed
    // without the other, and removing one must not disturb the other.
    sherpaDir: path.join(root, 'sherpa'),
    sttBinary: path.join(root, 'sherpa', 'bin', 'sherpa-onnx-offline'),
    sttLibDir: path.join(root, 'sherpa', 'lib'),
    sttDir: path.join(root, 'stt'),
    vadModel: path.join(root, 'sherpa', 'silero_vad.onnx'),
    // The VAD+ASR binary is what turns a whole recording into timestamped utterances; the plain
    // offline one handles a single utterance handed to it over Wyoming.
    sttVadBinary: path.join(root, 'sherpa', 'bin', 'sherpa-onnx-vad-with-offline-asr'),
    // Diarization: which of the people on the far side is speaking.
    diarizeBinary: path.join(root, 'sherpa', 'bin', 'sherpa-onnx-offline-speaker-diarization'),
    segmentationModel: path.join(root, 'sherpa', 'segmentation', 'model.onnx'),
    embeddingModel: path.join(root, 'sherpa', 'speaker-embedding.onnx'),
  };
}

// A model directory is complete when its token list is there. The two families name that file
// differently, which is a packaging detail rather than a difference worth configuring.
const TOKEN_FILES = ['tokens.txt', 'tiny-tokens.txt', 'base-tokens.txt'];

/** The directory of the named recognition model, or of the only one installed. */
function sttModelDir(baseDir, name, readdir = fs.readdirSync, exists = fs.existsSync) {
  const { sttDir } = layout(baseDir);
  let names;
  try { names = readdir(sttDir); } catch (e) { return null; }
  const wanted = name && names.includes(name) ? [name] : names;
  for (const dir of wanted) {
    const full = path.join(sttDir, dir);
    if (TOKEN_FILES.some(f => exists(path.join(full, f)))) return full;
  }
  return null;
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
  const sttPort = opts.sttPort || STT_PORT;

  let child = null;
  let ready = false;      // at least one half is being served by us
  let serving = [];       // which halves: 'tts', 'stt'
  let deferred = false;   // something else already serves the port, and it wins
  let failed = null;

  const paths = layout(baseDir);

  /** Is there an engine and a voice on disk to speak with? Asked before anything else. */
  function installed(voice) {
    return !!(exists(paths.piperBinary) && voiceModel(baseDir, voice, readdir, exists));
  }

  /** The same question for listening, which is a separate download. */
  function sttInstalled(model) {
    return !!(exists(paths.sttBinary) && sttModelDir(baseDir, model, readdir, exists));
  }

  function stop() {
    if (!child) return;
    try { child.stdin.end(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    child = null; ready = false; serving = [];
  }

  /**
   * Serve whichever halves are installed and asked for. `speak` and `hear` default to true, so a
   * caller that just wants everything available says nothing; main.js turns one off when the user
   * has pointed that half at their own server.
   */
  function start(options) {
    if (child || failed) return;
    const o = options || {};
    const speak = o.speak !== false;
    const hear = o.hear !== false;
    const model = speak ? voiceModel(baseDir, o.voice, readdir, exists) : null;
    const speaks = !!(speak && exists(paths.piperBinary) && model);
    const sttPath = (hear && exists(paths.sttBinary)) ? sttModelDir(baseDir, o.sttModel, readdir, exists) : null;
    if (!speaks && !sttPath) { log('built-in speech is not installed yet'); return; }
    let proc = null;
    // Whichever halves are installed; the helper serves what it is given and says what it served.
    const args = [script, '--host', HOST, '--port', String(port), '--stt-port', String(sttPort)];
    if (speaks) args.push('--piper', paths.piperBinary, '--model', model, '--config', model + '.json', '--lib-dir', paths.piperDir);
    if (sttPath) args.push('--stt-binary', paths.sttBinary, '--stt-lib-dir', paths.sttLibDir, '--stt-model-dir', sttPath);
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
        // 'ready tts stt' — the helper reports which halves it actually got, since a port it could
        // not take is skipped rather than fatal.
        if (line === 'ready' || line.startsWith('ready ')) {
          ready = true;
          serving = line.split(/\s+/).slice(1);
          log('built-in speech ready on ' + HOST + ' (' + (serving.join(', ') || 'tts') + ')');
        }
      }
    });
    if (proc.stderr) proc.stderr.on('data', buf => log('speech: ' + String(buf).trim()));
    proc.on('error', e => { failed = String(e && e.message); log('built-in speech unavailable — ' + failed); child = null; ready = false; serving = []; });
    proc.on('exit', code => {
      child = null; ready = false; serving = [];
      // 3 is the helper finding the port already served. That is someone's own Wyoming server and it
      // wins — the app points at the same host and port regardless, so speech still works.
      if (code === 3) {
        deferred = true;
        log('another Wyoming server already serves these ports on ' + HOST + ' — using it instead of starting ours');
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
    sttInstalled,
    start,
    stop,
    /** Where a Wyoming client should dial for the built-in engine. */
    endpoint() { return { host: HOST, port }; },
    sttEndpoint() { return { host: HOST, port: sttPort }; },
    /** Which halves we are actually serving right now. */
    servingHalves() { return serving.slice(); },
    /** Serving now, either because we started it or because someone else's server already was. */
    available() { return (ready || deferred) && !failed; },
    isReady() { return ready; },
    deferredToExisting() { return deferred; },
    failure() { return failed; },
  };
}

module.exports = { createLinuxSpeech, helperScript, layout, voiceModel, sttModelDir, TOKEN_FILES, TTS_PORT, STT_PORT, HOST };
