'use strict';
/*
 * slideCapture.js — main-process controller for Meeting Slide Capture. [MIT]
 *
 * Owns a hidden, main-owned BrowserWindow (the "capture window", show:false) that runs
 * getDisplayMedia on a window the user picked and ships downsampled thumbnails back. THIS module
 * runs the settle-detection engine (app/slideCaptureEngine.js) on those thumbnails — so all the
 * diff/settle logic stays in the unit-tested engine — and, when a new slide settles, asks the page
 * for one full-resolution PNG and writes it beside the active recording.
 *
 * Slides file into "<wav-basename>-screenshots\" next to the recording, so the folder travels and
 * renames exactly like the .json sidecar (see meetingTranscribe/meetingAnalyze filing). Capture is
 * only allowed while a recording is live, so every slide has a home folder — a hotkey pressed with
 * no recording is refused, not silently dropped somewhere.
 *
 * DI (deps): resolveSettings() -> slide settings block; resolveActiveRecording() -> { folder, base }
 * of the live recording or null; getSources() -> desktopCapturer window list; notify(title, body);
 * onState(state) fired on any change so the panel poller reflects it; log(msg).
 */
const path = require('path');
const fs = require('fs');
const engine = require('./slideCaptureEngine');

// 'ms-teams, chrome' -> Set { 'ms-teams', 'chrome' }. Comma/semicolon only — never whitespace —
// because macOS process names carry spaces ("Microsoft Teams"). A pre-list single value parses
// as a one-app set, so existing configs need no migration.
function parseAppFilter(csv) {
  const out = new Set();
  String(csv == null ? '' : csv).split(/[,;]+/).forEach(part => {
    const name = part.trim().toLowerCase();
    if (name) out.add(name);
  });
  return out;
}

function createSlideCapture(deps) {
  const log = deps.log || (() => {});
  let win = null, ready = false, pendingStart = null;

  let targetId = null, targetName = '';         // the picked window
  let capturing = false;
  let stopAfterManual = false;                   // a standalone Manual grab spun the stream up just for one frame
  let pendingGrab = false;                       // Manual grab queued behind pendingStart (capture window still loading)
  let slideCount = 0;
  let saveFolder = null, saveBase = null;        // resolved once per capture start; where slides land
  let prevThumb = null, lastSavedThumb = null;   // Uint8ClampedArray thumbnails
  let detector = null;
  let awaitingFrame = false, frameIsManual = false, pendingThumb = null;
  let idleTimer = null, warnedBlank = false, pickerRequested = false;

  function settings() { try { return deps.resolveSettings() || {}; } catch (e) { return {}; } }
  function enabled() { return !!settings().slideCaptureEnabled; }
  function fireState() { try { if (deps.onState) deps.onState(getState()); } catch (e) {} }

  function getState() {
    const openPicker = pickerRequested; pickerRequested = false;   // one-shot: the select hotkey asks the panel to open its picker
    return {
      enabled: enabled(),
      target: targetName || '',
      // A standalone Manual one-shot briefly has the stream up; don't show it as "capturing" —
      // the panel toggle would flash "Stop capture" as if Manual had started auto-capture.
      capturing: capturing && !stopAfterManual,
      slides: slideCount,
      // the panel greys Start/Manual unless a recording is live
      canCapture: !!activeRecording(),
      openPicker: openPicker,
    };
  }
  // The "select window" hotkey can't draw the touch picker itself; it flags the panel (which polls
  // getState) to open it. Only meaningful while the meeting page is on screen — a harmless no-op otherwise.
  function requestPicker() { pickerRequested = true; }

  function activeRecording() {
    try { const r = deps.resolveActiveRecording(); return (r && r.folder && r.base) ? r : null; }
    catch (e) { return null; }
  }

  // ---- hidden capture window ----
  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = deps.createWindow();      // main wires the session + display-media handler; see main.js
    ready = false;
    win.on('closed', () => { win = null; ready = false; capturing = false; pendingStart = null; pendingGrab = false; stopAfterManual = false; });
    return win;
  }
  function sendCmd(msg) {
    if (win && !win.isDestroyed() && ready) { try { win.webContents.send('slide-cmd', msg); return true; } catch (e) {} }
    return false;
  }
  function isSender(wc) { return win && !win.isDestroyed() && wc === win.webContents; }
  function onReady() {
    ready = true;
    if (pendingStart) { const s = pendingStart; pendingStart = null; beginCapture(s); }
    // A Manual grab that was waiting on the window load rides right behind the start; the page
    // parks it until the stream is live, so ordering is safe.
    if (pendingGrab) { pendingGrab = false; sendCmd({ type: 'grab' }); }
  }

  // main hands the capture window the source id it should capture (set right before 'start')
  function currentSourceId() { return targetId; }

  // ---- window picker ----
  async function listWindows() {
    if (!enabled()) return [];
    // The helper's EnumWindows list is the source of truth — desktopCapturer.getSources EXCLUDES
    // minimized windows and can't name owning processes, so a multi-window app (four Chrome
    // windows, three Teams windows) would come back incomplete. Electron accepts a source id
    // fabricated from the HWND ("window:<hwnd>:0") in the display-media handler (verified), so we
    // don't need getSources at all.
    let wins = [];
    try { wins = (deps.listApps ? await deps.listApps() : []) || []; } catch (e) { log('window enumeration failed: ' + e.message); return []; }
    const filter = parseAppFilter(settings().slideAppFilter);
    const out = [];
    for (const w of wins) {
      if (!w || !w.hwnd || !w.title) continue;
      // The filter is the APP(s) picked in Settings (exact process names) — the panel lists every
      // window those apps own and nothing else. Blank filter = every window.
      if (filter.size && !filter.has(String(w.processName || '').toLowerCase())) continue;
      out.push({ id: 'window:' + w.hwnd + ':0', name: w.title, proc: w.processName || '', min: !!w.minimized });
    }
    return out;
  }

  function selectWindow(id, name) {
    targetId = id || null;
    targetName = name || '';
    warnedBlank = false;
    fireState();
    if (targetId && settings().slideAutoStartOnSelect && activeRecording()) start();
    return getState();
  }

  // ---- capture lifecycle ----
  function start() {
    if (!enabled()) return { ok: false, error: 'Slide capture is disabled' };
    if (!targetId) return { ok: false, error: 'No window selected' };
    const rec = activeRecording();
    if (!rec) return { ok: false, error: 'Start a recording first — slides file into it' };
    if (capturing) return { ok: true, state: getState() };
    saveFolder = path.join(rec.folder, engine.screenshotsFolderName(rec.base));
    saveBase = rec.base;
    detector = new engine.SettleDetector();
    prevThumb = null; lastSavedThumb = null; awaitingFrame = false; warnedBlank = false;
    stopAfterManual = false; pendingGrab = false; frameIsManual = false;   // no stale one-shot state from an aborted Manual
    ensureWindow();
    const cmd = { type: 'start', sourceId: targetId };
    if (!sendCmd(cmd)) { pendingStart = cmd; }   // window still loading; beginCapture on ready
    else beginCapture(cmd);
    return { ok: true, state: getState() };
  }
  function beginCapture(cmd) { sendCmd(cmd); capturing = true; resetIdle(); fireState(); log('slide capture started -> ' + targetName); }

  function stop(reason) {
    // Always kill queued work — a leftover pendingStart would ghost-start capture when the
    // window finishes loading (the original "Manual started auto-capture" bug).
    pendingStart = null; pendingGrab = false; stopAfterManual = false;
    if (!capturing) { sendCmd({ type: 'stop' }); return { ok: true, state: getState() }; }
    capturing = false;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    sendCmd({ type: 'stop' });
    fireState();
    log('slide capture stopped' + (reason ? ' (' + reason + ')' : ''));
    return { ok: true, state: getState() };
  }

  // Manual capture is a SINGLE shot: grab one frame and leave nothing running. If auto-capture is
  // already live we just piggyback a grab on it; otherwise we spin the stream up ONLY for this frame
  // and tear it down again in onFrame — Manual must never start the continuous auto-capture process.
  function manual() {
    if (!enabled()) return { ok: false, error: 'Slide capture is disabled' };
    if (!targetId) return { ok: false, error: 'No window selected' };
    if (!activeRecording()) return { ok: false, error: 'Start a recording first — slides file into it' };
    if (!capturing) {
      const r = start();
      if (!r.ok) return r;
      stopAfterManual = true;   // spun up just for this one grab (set AFTER start(), which clears it)
    }
    frameIsManual = true; awaitingFrame = true;
    if (!sendCmd({ type: 'grab' })) {
      // Capture window still loading (start() parked pendingStart): queue the grab to ride
      // behind it in onReady. Any other send failure is a real error — undo the one-shot state.
      if (win && !win.isDestroyed() && !ready) { pendingGrab = true; return { ok: true, state: getState() }; }
      awaitingFrame = false; frameIsManual = false;
      if (stopAfterManual) stop('manual');
      return { ok: false, error: 'Capture window not ready' };
    }
    return { ok: true, state: getState() };
  }

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    const mins = Math.max(0, parseInt(settings().slideIdleStopMin, 10) || 0);
    if (!mins) { idleTimer = null; return; }
    idleTimer = setTimeout(() => { if (capturing) { stop('idle'); notify('Slide capture stopped', 'No new slides for ' + mins + ' min.'); } }, mins * 60000);
  }

  function notify(title, body) { try { if (deps.notify && settings().slideNotifications) deps.notify(title, body); } catch (e) {} }

  // ---- IPC from the capture page ----
  function onThumb(buf, meta) {
    if (!capturing || awaitingFrame) return;   // ignore polls while we're waiting on a full-res PNG (incl. a standalone Manual grab)
    const thumb = new Uint8ClampedArray(buf);
    // Minimized/blank target: getDisplayMedia hands back an all-black surface for iconic windows.
    if (engine.looksBlank(meta && meta.meanLuma, meta && meta.nonBlack)) {
      if (!warnedBlank) { warnedBlank = true; notify('Slide capture', 'The window looks minimized — restore it to capture slides.'); if (deps.onBlank) try { deps.onBlank(); } catch (e) {} }
      prevThumb = thumb; return;
    }
    warnedBlank = false;
    const f2f = prevThumb ? engine.frameDiff(thumb, prevThumb) : 1;
    const vsSaved = lastSavedThumb ? engine.frameDiff(thumb, lastSavedThumb) : 1;
    prevThumb = thumb;
    if (detector.evaluate(f2f, vsSaved)) {   // settled on a new slide -> pull a full-res frame
      pendingThumb = thumb; awaitingFrame = true; frameIsManual = false;
      sendCmd({ type: 'grab' });
    }
  }

  function onFrame(buf) {
    const manualSave = frameIsManual;
    const teardown = stopAfterManual; stopAfterManual = false;
    awaitingFrame = false; frameIsManual = false;
    if (teardown) stop('manual');   // Manual spun the stream up for this one frame — don't leave capture running
    if (!buf) { pendingThumb = null; return; }
    const rec = activeRecording();
    if (!rec) { pendingThumb = null; return; }   // recording ended mid-grab — drop it, nowhere to file
    try {
      fs.mkdirSync(saveFolder, { recursive: true });
      slideCount++;
      const file = path.join(saveFolder, engine.slideFileName(new Date(), slideCount));
      fs.writeFileSync(file, Buffer.from(buf));
      if (manualSave) { detector.noteManualSave(); } else if (pendingThumb) { lastSavedThumb = pendingThumb; }
      if (manualSave && prevThumb) lastSavedThumb = prevThumb;
      pendingThumb = null;
      if (capturing) resetIdle();   // a one-shot Manual already tore down — don't re-arm the idle timer
      notify('Slide captured', 'Slide ' + slideCount + (targetName ? ' — ' + targetName : ''));
      fireState();
    } catch (e) { log('slide save failed: ' + e.message); if (deps.onError) try { deps.onError(e.message); } catch (e2) {} }
  }

  function onStatus(state, detail) {
    if (state === 'error') { log('slide capture error: ' + detail); notify('Slide capture failed', detail || 'Capture error'); stop('error'); }
    else if (state === 'source-ended') { log('slide capture: shared window closed'); stop('window closed'); notify('Slide capture stopped', 'The captured window was closed.'); }
  }

  // Recording stopped: end capture too (its home folder is finalized by the recorder).
  function onRecordingStopped() { if (capturing) stop('recording ended'); slideCount = 0; fireState(); }

  function dispose() {
    if (idleTimer) clearTimeout(idleTimer);
    if (win && !win.isDestroyed()) { try { win.destroy(); } catch (e) {} }
    win = null;
  }

  return {
    getState, listWindows, selectWindow, start, stop, manual, requestPicker,
    onReady, isSender, onThumb, onFrame, onStatus, onRecordingStopped, currentSourceId,
    ensureWindow, dispose,
  };
}

module.exports = { createSlideCapture, parseAppFilter };
