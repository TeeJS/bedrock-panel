'use strict';
// lucidtypeDictation.js — MAIN PROCESS
//
// LucidType dictation controller. Owns a hidden, main-owned capture window (lucidtype-dictate.html)
// that runs getUserMedia + the shared energy VAD and streams each trimmed utterance (Int16 16 kHz mono
// PCM) back to main; main transcribes it via the injected `transcribe()` (Wyoming/Whisper) and appends
// it to the running transcript. The panel page (/lucidtype) displays that transcript and lets the user
// edit it; Apply pastes it at the PC cursor (handled in main). Mirrors meetingRecorder.js: a persistent
// hidden window keeps capture independent of whatever the visible panel shows.
//
// deps: {
//   createWindow()            -> a hidden BrowserWindow loading /lucidtype-dictate (session + preload set by main)
//   resolveSettings()         -> { micDevice, silenceMs, notifyBeep }
//   resolveEndpoints()        -> { sttHost, sttPort, ttsHost, ttsPort }
//   transcribe({host,port,audio}) -> Promise<string>   (already noise-filtered)
//   onState(state)            -> fires on every state change (tray/switch hooks in main)
//   log(msg)
//   ackTimeoutMs              -> optional; how long the capture window gets to confirm a start
// }
//
// Every way dictation can produce no text (mic won't open, nothing heard, capture window dead, speech
// server down) ends up in state().notice -- shown on the panel page -- and in the log, rather than
// leaving a DICTATING indicator over an empty box.

function createLucidDictation(deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  const ACK_TIMEOUT_MS = d.ackTimeoutMs || 6000;
  let win = null;
  let dictating = false;
  let transcript = '';
  let seq = 0;
  let pending = 0;   // in-flight transcriptions — lets us hold "stop" as busy until the tail settles
  // Cleanup/Rewrite review (Phase 2): the AI's proposed text awaiting the user's Apply/Cancel/Refine.
  let review = { active: false, kind: '', original: '', proposed: '', status: '', error: '', mode: '' };   // status: working|ready|error
  // Why dictation isn't producing text. kind says what clears it: 'hearing' clears when a clip
  // arrives, 'stt' on the next successful transcript, the rest on the next start.
  let notice = { text: '', level: '', kind: '' };   // level: 'error' | 'warn'
  let micNotice = null;   // this session's mic warning, shown again once a passing notice clears
  let startMsg = null, ackTimer = null, retried = false;   // start-confirmation watchdog

  function state() { return { dictating, transcript, seq, pending, review: Object.assign({}, review), notice: notice.text, noticeLevel: notice.level }; }
  function notify() { try { if (d.onState) d.onState(state()); } catch (e) {} }
  function bump() { seq = (seq + 1) % 2147483647; notify(); }
  function setNotice(kind, level, text) {
    notice = { text, level, kind };
    if (kind === 'mic') micNotice = notice;
    bump();
  }
  function clearNotice(kind) {
    if (!notice.text || (kind && notice.kind !== kind)) return;
    notice = micNotice && kind !== 'mic' ? micNotice : { text: '', level: '', kind: '' };
    bump();
  }

  // Throw the capture window away so the next command builds a fresh one: it crashed, its page never
  // loaded, or it stopped answering. Sending to a dead renderer drops the message without an error.
  function discardWindow() {
    const w = win; win = null;
    try { if (w && !w.isDestroyed()) w.destroy(); } catch (e) {}
  }
  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    let w;
    try { w = d.createWindow(); } catch (e) { log('createWindow failed: ' + e.message); win = null; return null; }
    win = w;
    if (!w) return null;
    w.on('closed', () => { if (win === w) win = null; });
    const wc = w.webContents;
    if (wc && typeof wc.on === 'function') {
      wc.on('render-process-gone', (_e, details) => {
        log('capture window crashed (' + ((details && details.reason) || 'unknown') + ') — rebuilding it');
        if (win !== w) return;
        discardWindow();
        if (dictating && startMsg) { sendCmd(startMsg); armWatchdog(); }
      });
      wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
        if (isMainFrame === false || win !== w) return;
        log('capture page failed to load (' + code + ' ' + (desc || '') + ') — it will be rebuilt');
        discardWindow();
      });
    }
    return w;
  }
  // Main's IPC handlers only service the current capture window.
  function ownsSender(sender) {
    if (!win || win.isDestroyed() || !sender || !win.webContents) return false;
    return win.webContents === sender || (sender.id != null && win.webContents.id === sender.id);
  }
  function sendCmd(msg) {
    const w = ensureWindow();
    if (!w || w.isDestroyed()) return;
    const post = () => { try { w.webContents.send('lucid-cmd', msg); } catch (e) { log('sendCmd error: ' + e.message); } };
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', post); else post();
  }

  // The window has a few seconds to confirm a start ('started' or 'error' status). No answer means
  // its renderer is gone or wedged: rebuild it once and resend; a second silence is reported.
  function armWatchdog() {
    clearTimeout(ackTimer);
    ackTimer = setTimeout(() => {
      ackTimer = null;
      if (!dictating || !startMsg) return;
      if (!retried) {
        retried = true;
        log('capture window did not confirm the start within ' + ACK_TIMEOUT_MS + ' ms — rebuilding it and retrying');
        discardWindow();
        sendCmd(startMsg);
        armWatchdog();
        return;
      }
      log('capture window still not responding after a rebuild — giving up');
      dictating = false; startMsg = null;
      discardWindow();   // a renderer that was only slow must not keep the mic open; next start builds fresh
      setNotice('capture', 'error', 'The microphone capture isn\'t responding. Restart Bedrock Panel; if it keeps happening, send main.log.');
    }, ACK_TIMEOUT_MS);
  }

  // Capture-health report from the hidden window (lucidtype-dictate.js). Stale reports (after a stop)
  // are dropped.
  function onCaptureStatus(st) {
    if (!st || typeof st !== 'object' || !dictating) return;
    const mic = String(st.mic || '') || 'the system default microphone';
    if (st.type === 'started') {
      clearTimeout(ackTimer); ackTimer = null; retried = false;
      const wanted = String(st.wanted || '');
      log('capturing from "' + mic + '"' + (wanted && !st.matched ? ' (saved mic "' + wanted + '" not found)' : '') +
        ', audio ' + String(st.context || '?') + ' at ' + Number(st.rate || 0) + ' Hz');
      if (st.context && st.context !== 'running') setNotice('mic', 'error', 'Audio from ' + mic + ' is ' + st.context + ', so nothing can be heard. Stop and start dictation again.');
      else if (wanted && !st.matched) setNotice('mic', 'warn', 'Couldn\'t find "' + wanted + '" — listening on ' + mic + ' instead.');
    } else if (st.type === 'error') {
      clearTimeout(ackTimer); ackTimer = null;
      const msg = String(st.message || 'unknown error');
      log('microphone failed to open: ' + msg);
      dictating = false; startMsg = null;
      setNotice('mic', 'error', 'The microphone failed to open: ' + msg);
    } else if (st.type === 'no-audio') {
      log('no audio arriving from "' + mic + '" (audio ' + String(st.context || '?') + ')');
      setNotice('hearing', 'error', 'No audio is arriving from ' + mic + '. Stop and start dictation again.');
    } else if (st.type === 'silent') {
      log('nothing above the speech level from "' + mic + '" yet (loudest ' + Number(st.peak || 0).toFixed(3) + ')');
      setNotice('hearing', 'warn', 'Nothing heard from ' + mic + ' yet. If you\'re talking, check it\'s the right mic and not muted.');
    }
  }

  // Called by main when the hidden window streams one utterance (a Node Buffer of Int16 PCM).
  async function onUtterance(pcmBuf) {
    if (!dictating || !pcmBuf || !pcmBuf.length) return;
    clearNotice('hearing');
    const ms = Math.round(pcmBuf.length / 32);   // 16 kHz x 2 bytes = 32 bytes per ms
    const ep = d.resolveEndpoints ? d.resolveEndpoints() : {};
    if (!ep.sttHost || !ep.sttPort) {
      log('utterance dropped: no STT endpoint configured');
      setNotice('stt', 'error', 'No speech server is set. Add one in Settings → TTS/STT.');
      return;
    }
    pending += 1;
    try {
      const text = await d.transcribe({ host: ep.sttHost, port: ep.sttPort, audio: pcmBuf });
      log('clip ' + ms + ' ms -> ' + (text ? text.length + ' chars' : 'no words (empty or a noise phrase)'));
      clearNotice('stt');
      if (text) { transcript = transcript ? (transcript + ' ' + text) : text; bump(); }
    } catch (e) {
      log('transcribe error: ' + e.message);
      setNotice('stt', 'error', 'The speech server at ' + ep.sttHost + ':' + ep.sttPort + ' failed: ' + e.message);
    } finally {
      pending = Math.max(0, pending - 1);
    }
  }

  function start(modeOverride) {
    if (dictating) return { ok: true, dictating: true };
    const s = d.resolveSettings ? d.resolveSettings() : {};
    const mode = modeOverride || s.startMode;            // buttons pass 'clear'/'append' explicitly; the hotkey uses the setting
    if (mode !== 'append') transcript = '';              // 'clear' (default): fresh box; 'append': keep + add to existing text
    dictating = true;
    notice = { text: '', level: '', kind: '' };
    micNotice = null;
    retried = false;
    startMsg = { type: 'start', micDevice: s.micDevice || '', silenceMs: s.silenceMs || 400, beep: !!s.notifyBeep };
    sendCmd(startMsg);
    armWatchdog();
    bump();
    log('dictation start');
    return { ok: true, dictating: true };
  }
  function stop() {
    if (!dictating) return { ok: true, dictating: false };
    dictating = false;
    startMsg = null;
    clearTimeout(ackTimer); ackTimer = null;
    const s = d.resolveSettings ? d.resolveSettings() : {};
    sendCmd({ type: 'stop', beep: !!s.notifyBeep });
    bump();
    log('dictation stop');
    return { ok: true, dictating: false };
  }
  function toggle() { return dictating ? stop() : start(); }

  // The editor (panel textarea) is the source of truth after a stop; keep main's copy in sync so the
  // global Apply hotkey pastes exactly what the user sees. No seq bump — don't echo it back and clobber.
  function setTranscript(text) { transcript = String(text == null ? '' : text); return { ok: true }; }
  function currentText() { return transcript; }

  // ---- Cleanup / Rewrite (Phase 2) ----
  // Source is the box text; if the box is empty, pull the clipboard (if it holds text) into the box and
  // use that. Sends to the AI (deps.transform) and opens a review with the proposed result.
  async function runTransform(kind) {
    if (review.active) return { ok: false, error: 'a review is already open' };
    let src = transcript;
    if (!src.trim() && d.readClipboard) {
      const clip = String((await d.readClipboard()) || '');   // Electron 44+: clipboard reads are Promises; await is harmless on the old sync string
      if (clip.trim()) { transcript = clip; src = clip; bump(); }   // adopt clipboard text into the box
    }
    if (!src.trim()) return { ok: false, error: 'nothing to ' + kind + ' — the box and clipboard are empty' };
    const mode = kind === 'rewrite' ? ((d.resolveSettings ? d.resolveSettings().rewriteMode : '') || 'professional') : '';
    review = { active: true, kind, original: src, proposed: '', status: 'working', error: '', mode };
    bump();
    try {
      const out = await d.transform({ kind, mode, text: src });
      if (!review.active) return { ok: false };                     // cancelled while the AI ran
      review.proposed = String(out || ''); review.status = 'ready'; bump();
      return { ok: true };
    } catch (e) {
      review.status = 'error'; review.error = e.message || String(e); bump();
      return { ok: false, error: review.error };
    }
  }
  function runCleanup() { return runTransform('cleanup'); }
  function runRewrite() { return runTransform('rewrite'); }
  // Re-run the transform on the user's edited proposal (the "Refine" button).
  async function refineReview(editedProposed) {
    if (!review.active) return { ok: false, error: 'no review open' };
    const text = String(editedProposed != null ? editedProposed : review.proposed);
    review.proposed = text; review.status = 'working'; bump();
    try {
      const out = await d.transform({ kind: review.kind, mode: review.mode, text });
      if (!review.active) return { ok: false };
      review.proposed = String(out || ''); review.status = 'ready'; bump();
      return { ok: true };
    } catch (e) { review.status = 'error'; review.error = e.message || String(e); bump(); return { ok: false, error: review.error }; }
  }
  // Accept the (possibly edited) proposal into the box, then the Apply-text hotkey pastes it as usual.
  function applyReview(editedProposed) {
    if (!review.active) return { ok: false, error: 'no review open' };
    transcript = String(editedProposed != null ? editedProposed : review.proposed);
    review = { active: false, kind: '', original: '', proposed: '', status: '', error: '', mode: '' };
    bump();
    return { ok: true };
  }
  function cancelReview() {
    review = { active: false, kind: '', original: '', proposed: '', status: '', error: '', mode: '' };
    bump();
    return { ok: true };
  }

  return { ensureWindow, ownsSender, onUtterance, onCaptureStatus, start, stop, toggle, state, setTranscript, currentText, isDictating: () => dictating,
    runCleanup, runRewrite, refineReview, applyReview, cancelReview };
}

module.exports = { createLucidDictation };
