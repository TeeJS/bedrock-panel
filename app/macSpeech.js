'use strict';

// Controller for native/mac/speech-server — macOS's built-in speech recognition and voices served as
// a local Wyoming server (127.0.0.1:10300 STT / :10200 TTS, the same loopback convention as the
// tts-stt-windows helper), so the AI Voice pages, LucidType dictation, and everything else that
// already speaks Wyoming works on a Mac with nothing to install. Started when the voice settings
// want the macOS engine (voiceConfig.macSpeechWanted), restarted with a short backoff if it dies,
// stopped at quit. The helper's stdout lines (ready / auth / error) become `status()`, which the
// editor's TTS/STT tab shows. Injectable for tests; a no-op where the helper does not exist.

const readline = require('readline');
const childProcess = require('child_process');
const nativeHelpers = require('./nativeHelpers');

function createMacSpeech(options) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  const log = opts.log || (() => {});
  const spawn = opts.spawn || childProcess.spawn;
  const helperPath = opts.helperPath !== undefined ? opts.helperPath : nativeHelpers.helperPath('speechServer', platform);
  const restartDelay = opts.restartDelay == null ? 2000 : opts.restartDelay;
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;

  let child = null, wanted = false, stopping = false, restartTimer = null, restarts = 0;
  let config = { host: '127.0.0.1', sttPort: 10300, ttsPort: 10200, language: '', voice: '' };
  let status = { running: false, ready: false, speechAuth: null, onDevice: null, voices: [], error: null, host: config.host, sttPort: config.sttPort, ttsPort: config.ttsPort, language: '' };

  function publish(patch) {
    status = Object.assign({}, status, patch);
    if (onStatus) { try { onStatus(status); } catch (e) { log('status handler error: ' + (e && e.message)); } }
  }

  function args() {
    const a = ['--host', config.host, '--stt-port', String(config.sttPort), '--tts-port', String(config.ttsPort)];
    if (config.language) a.push('--language', config.language);
    if (config.voice) a.push('--voice', config.voice);
    return a;
  }

  function launch() {
    if (!helperPath || !wanted || child || stopping) return;
    let proc;
    try { proc = spawn(helperPath, args(), { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { log('start failed: ' + (e && e.message)); publish({ running: false, error: 'start failed: ' + (e && e.message) }); scheduleRestart(); return; }
    child = proc;
    publish({ running: true, ready: false, error: null, host: config.host, sttPort: config.sttPort, ttsPort: config.ttsPort });
    if (proc.stdout) {
      readline.createInterface({ input: proc.stdout }).on('line', line => {
        let ev; try { ev = JSON.parse(line); } catch (e) { log('helper: ' + line); return; }
        if (ev.event === 'ready') {
          restarts = 0;
          publish({ ready: true, engine: ev.engine || 'sfspeech', speechAuth: ev.speechAuth || null, onDevice: !!ev.onDevice, recognizerAvailable: !!ev.recognizerAvailable, voices: Array.isArray(ev.voices) ? ev.voices : [], language: ev.language || '', voice: ev.voice || '' });
          log('ready on ' + ev.host + ':' + ev.sttPort + ' (STT) / :' + ev.ttsPort + ' (TTS), ' + (ev.engine || 'sfspeech') + ', speech recognition ' + ev.speechAuth + (ev.onDevice ? ', on-device' : '') + ', ' + (ev.voices || []).length + ' voices');
        } else if (ev.event === 'auth') {
          publish({ speechAuth: ev.speechAuth || null });
          log('speech recognition ' + ev.speechAuth);
        } else if (ev.event === 'stt-error') {
          // 'dictation-off': on-device recognition needs System Settings → Keyboard → Dictation; the helper
          // falls back to Apple's servers meanwhile. The editor's Status line shows this.
          publish({ sttError: { code: ev.code || 'failed', message: ev.message || 'speech recognition failed' } });
          log('speech recognition: ' + (ev.message || ev.code));
        } else if (ev.event === 'error') {
          publish({ error: ev.message || 'error' });
          log('error: ' + ev.message);
        }
      });
    }
    if (proc.stderr) proc.stderr.on('data', b => { const t = String(b).trim(); if (t) log(t); });
    if (proc.stdin) proc.stdin.on('error', () => {});
    proc.on('error', e => { log('helper error: ' + (e && e.message)); });
    proc.on('exit', (code, signal) => {
      if (child !== proc) return;
      child = null;
      publish({ running: false, ready: false });
      if (stopping || !wanted) return;
      log('helper exited (' + (signal || code) + ')');
      scheduleRestart();
    });
  }

  function scheduleRestart() {
    if (restartTimer || stopping || !wanted) return;
    const delay = Math.min(30000, restartDelay * Math.pow(2, Math.min(4, restarts++)));
    restartTimer = setTimeout(() => { restartTimer = null; launch(); }, delay);
  }

  function terminate() {
    const proc = child;
    if (!proc) return;
    child = null;
    try { if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end(); } catch (e) {}   // the helper exits on stdin EOF
    const killer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 1500);
    proc.once('exit', () => clearTimeout(killer));
    publish({ running: false, ready: false });
  }

  // Bring the helper in line with what the settings want; a changed language/voice restarts it.
  function apply(want, cfg) {
    const next = Object.assign({}, config, cfg || {});
    const changed = JSON.stringify(next) !== JSON.stringify(config);
    config = next;
    wanted = !!want && !!helperPath;
    if (!wanted) { clearTimeout(restartTimer); restartTimer = null; terminate(); return; }
    if (child && changed) { terminate(); }
    if (!child) launch();
  }

  function stop() { stopping = true; wanted = false; clearTimeout(restartTimer); restartTimer = null; terminate(); }

  // Restart the helper so its voice list is read again: a voice downloaded under Spoken Content after
  // the helper started is invisible to that process. The new one launches once the old has exited
  // (the ports must be free). Returns whether a restart was started.
  function rescan() {
    const proc = child;
    if (!proc) { if (wanted && !stopping) launch(); return false; }
    terminate();
    proc.once('exit', () => { if (wanted && !child && !stopping) { clearTimeout(restartTimer); restartTimer = null; launch(); } });
    return true;
  }

  return {
    available: !!helperPath,
    apply, stop, rescan,
    status: () => Object.assign({ available: !!helperPath, wanted }, status),
  };
}

module.exports = { createMacSpeech };
