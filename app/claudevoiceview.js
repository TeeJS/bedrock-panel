function $(id) { return document.getElementById(id); }

// Theme — read directly from the served query (musicview.js's pattern). No options here are secret
// (confirmed in apps.json), so there's no /app-config fetch needed at all for config.
var Q = new URLSearchParams(location.search);
// This one page serves EVERY AI Voice backend: the page itself is served at /ai-voice, and every
// server route carries the page's backend as a sub-prefix (/ai-voice/<backend>/turn, ...), so
// requests bind to the right backend host no matter which page is on screen. Backend-specific
// strings (title, modes, models, approval wording) arrive as `meta` on the /state snapshot -- see
// applyMeta() -- so nothing backend-specific is hardcoded here beyond the claude-shaped fallbacks.
var BACKEND = Q.get('backend') || 'claude';
var BASE = '/' + (location.pathname.split('/')[1] || 'ai-voice') + '/' + BACKEND;
(function () {
  document.body.classList.toggle('light', Q.get('_dark') === '0');
  var a = Q.get('_accent') || '';
  var validAccent = /^#[0-9a-fA-F]{6}$/.test(a);
  if (validAccent) document.documentElement.style.setProperty('--accent', a);
  // Contrast-safe foreground for text/icons sitting on the accent (user bubble, buttons, the
  // current-row highlights) -- runtime accents vary, and a dark one made the user's own message
  // unreadable against the fixed near-black text those rules used to hardcode. Same luminance
  // formula as meetingview.js's --accent-fg.
  var hex = validAccent ? a : '#7CFFB2';
  var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  document.documentElement.style.setProperty('--accent-fg', lum > 0.45 ? '#04120b' : '#f2f7fc');
})();

var projectDir = Q.get('projectDir') || '';
setProjectHeader(projectDir);   // rail label + the Settings overlay's Folder row value

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// POST a JSON body to this app's backend (BASE prefix), returning the fetch promise so each caller
// keeps its own .then/.catch. The two non-JSON POSTs (/audio binary, /panel-cancel no-body) stay inline.
function postJSON(p, body) {
  return fetch(BASE + p, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
// The shared "server unreachable" status — the catch for most backend POSTs. Callers with extra
// cleanup (or a different message) keep their own catch.
function reachErr() { setStatus('error', 'Could not reach the panel server.'); }

// Markdown rendering: claudevoice-markdown.js carries the same parser + sanitizer the Open WebUI
// chat app uses, so headings, lists, tables, links, and images render instead of showing raw. The
// hard requirement survives -- fenced code is exact text in <pre><code> with a Copy button -- by
// wrapping every <pre> the parser emits in the same .codeblock markup renderPlain() produced (the
// copy handler reads the <code> next to its button). renderPlain() is the fallback if the vendored
// script failed to load, so a reply is never lost to a missing renderer.
function renderContent(text) {
  var md = window.aiVoiceMarkdown;
  if (!md) return renderPlain(text);
  var tpl = document.createElement('template');
  try { tpl.innerHTML = md.render(text); } catch (e) { return renderPlain(text); }
  tpl.content.querySelectorAll('pre').forEach(function (pre) {
    var code = pre.querySelector('code');
    if (code) code.textContent = code.textContent.replace(/\n$/, '');   // parser keeps the fence's closing newline; Copy must not
    var wrap = document.createElement('div');
    wrap.className = 'codeblock';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    var btn = document.createElement('button');
    btn.className = 'copybtn'; btn.type = 'button'; btn.textContent = 'Copy';
    wrap.appendChild(btn);
  });
  return tpl.innerHTML || esc(text);
}
// Plain fallback: escape everything, recognize ```fenced code blocks``` as copyable <pre><code>,
// everything else as paragraphs.
function renderPlain(text) {
  var parts = String(text || '').split(/```([\s\S]*?)```/);
  var html = '';
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // fenced block — parts[i] may start with a language tag on its own first line; strip it for display
      var body = parts[i].replace(/^[ \t]*[A-Za-z0-9_+-]*\n/, '');
      html += '<div class="codeblock"><pre><code>' + esc(body.replace(/\n$/, '')) + '</code></pre>' +
        '<button class="copybtn" type="button">Copy</button></div>';
    } else if (parts[i].trim()) {
      html += '<div>' + esc(parts[i]).replace(/\n/g, '<br>') + '</div>';
    }
  }
  return html || esc(text);
}

function wireCopyButtons(container) {
  container.querySelectorAll('.copybtn').forEach(function (btn) {
    btn.onclick = function () {
      var code = btn.previousElementSibling.querySelector('code');
      var text = code ? code.textContent : '';
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'Copied'; btn.classList.add('copied');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      }).catch(function () {});
    };
  });
}

var transcript = [];   // [{role:'user'|'assistant', text}]
function renderTranscript() {
  var list = $('list'), empty = $('empty');
  empty.style.display = transcript.length ? 'none' : '';
  // The still-streaming entry keeps its data-live marker across full re-renders -- without this, a
  // message typed mid-reply destroyed the marker and the old reply's text froze on screen while
  // its generation quietly finished.
  list.innerHTML = transcript.map(function (m) {
    // User bars stay raw text (mostly STT output; a stray '*' or '#' must not restyle it) -- only
    // the assistant's replies go through the markdown renderer.
    var body = m.role === 'user' ? renderPlain(m.text) : renderContent(m.text);
    return '<div class="msg ' + m.role + '"' + (m === liveMsg ? ' data-live="1"' : '') + '><div class="bubble">' + body + '</div></div>';
  }).join('');
  wireCopyButtons(list);
  $('card').scrollTop = $('card').scrollHeight;
}

// Ring states the host (main.js) knows how to render — anything else (idle, error, ...) clears the
// override back to the user's normal theme-driven ring. Keep in sync with RING_STATES in main.js.
var RING_SIGNAL_STATES = { listening: 1, thinking: 1, speaking: 1, approval: 1 };
// Speech-only failure notice (TTS service down/off). Sticky: status changes don't wipe it -- it
// clears only when speech actually plays again or a new session starts. Without this, a dead TTS
// port was indistinguishable from "nothing to say".
var speechErrText = '';
function setStatus(status, errorText) {
  var el = $('status');
  el.textContent = (status || 'idle').toUpperCase();
  el.className = status === 'thinking' ? 'thinking' : status === 'listening' ? 'listening' :
    status === 'error' ? 'error' : status === 'approval' ? 'approval' : '';
  $('err').textContent = errorText || speechErrText || '';
  console.log('OQX_RING::' + (RING_SIGNAL_STATES[status] ? status : 'idle'));
  faceOnStatus(status || 'idle', errorText || speechErrText || '');
  if (typeof renderWakeLabel === 'function') renderWakeLabel();
}

// ---- Face (app/face/renderer.js) ----
// The page's `face` option: off (nothing here runs, no canvas, no timers), side (face column beside
// the chat) or creature (face only, controls on a reveal bar). The renderer is created lazily when
// the mode is not off and stopped whenever the page is hidden; the host sends the persona's face
// parameters on /state (meta.persona) and the emotion of each reply as an SSE 'emotion' event.
// The mouth follows the audio actually playing: a WebAudio analyser on the turn's <audio> element.
var FACE_MODES = { off: 1, side: 1, creature: 1 };
var faceMode = FACE_MODES[Q.get('face')] ? Q.get('face') : 'off';
var face = null;                 // the OqxFace instance, or null while off
var facePersona = null;          // {id, name, face} from the host, or null = plain face
var PERSONAS = [];               // [{id, name}] library, from meta
var currentPersonaId = Q.get('personaPick') || '';
var faceStatusName = 'idle';
var faceBarTimer = null;
var faceCssVar = function (name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); };
var reducedMotionMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
function faceEnabled() { return faceMode !== 'off'; }
function applyFaceMode(mode) {
  faceMode = FACE_MODES[mode] ? mode : 'off';
  document.body.classList.toggle('face-side', faceMode === 'side');
  document.body.classList.toggle('face-creature', faceMode === 'creature');
  setPersonaPending(personaPending);   // the creature badge follows the layout
  if (faceMode === 'off') { destroyFace(); hideFaceBar(); return; }
  createFace();
  syncFaceBarUI();
  if (face) face.resize();
}
function createFace() {
  if (face || !window.OqxFace || !faceEnabled()) return;
  try {
    face = window.OqxFace.create($('faceCanvas'), {
      persona: facePersona,
      accent: faceCssVar('--accent') || undefined,
      background: faceCssVar('--bg') || undefined,
      reducedMotion: !!(reducedMotionMq && reducedMotionMq.matches),
    });
  } catch (e) { console.log('face: renderer unavailable: ' + (e && e.message ? e.message : e)); face = null; return; }
  face.setState(faceStatusName);
  if (!document.hidden) face.start();
  // Face turned on mid-reply: route (or re-join) the playing element so the mouth moves now.
  if (turnAudio) faceAttachAnalyser(turnAudio);
}
function destroyFace() {
  if (!face) return;
  faceStopLevel();
  try { face.destroy(); } catch (e) {}
  face = null;
}
// Status -> renderer state, plus the creature bar's own status/error line (the main status row is
// hidden in creature mode, and an error or approval must stay visible and actionable there).
function faceOnStatus(status, errText) {
  var wasHeld = faceStatusName === 'error' || faceStatusName === 'approval';
  faceStatusName = status;
  if (face) face.setState(status);
  // The bar that an error/approval held open goes back to the normal 6 s auto-hide once resolved.
  if (wasHeld && status !== 'error' && status !== 'approval' && faceMode === 'creature' && $('faceBar').classList.contains('show')) showFaceBar(false);
  var fs = $('faceStatus');
  if (fs) {
    fs.textContent = status.toUpperCase();
    fs.className = status === 'thinking' ? 'thinking' : status === 'listening' ? 'listening' : status === 'error' ? 'error' : status === 'approval' ? 'approval' : '';
  }
  var fe = $('faceErr');
  if (fe) { fe.textContent = errText; fe.classList.remove('ok'); }
  var a11y = $('faceA11y');
  if (a11y && faceEnabled()) a11y.textContent = (facePersona ? facePersona.name + ' is ' : 'Face: ') + status + (errText ? '. ' + errText : '');
  // An error or a pending approval reveals the controls and keeps them until acted on.
  if (faceMode === 'creature' && (status === 'error' || status === 'approval')) showFaceBar(true);
}
function faceSetPersona(p) {
  facePersona = p || null;
  currentPersonaId = p ? p.id : '';
  if (face) face.setPersona(facePersona);
  syncPersonaUI();
}
// A persona switch made during a reply is applied after it (the session restarts, new
// conversation). Say so until the host confirms, on the status line and, in creature mode, as a
// quiet badge that never displaces the approval or error controls.
var personaPending = null;
function setPersonaPending(p) {
  personaPending = p && p.id !== undefined ? p : null;
  var text = personaPending ? ('Switching to ' + (personaPending.name || 'no persona') + ' after this reply') : '';
  var el = $('personaPendingNote');
  if (el) { el.textContent = text; el.classList.toggle('show', !!text); }
  var badge = $('facePendingBadge');
  if (badge) { badge.textContent = text; badge.classList.toggle('show', !!text && faceMode === 'creature'); }
}
// Reveal bar (creature mode). `hold` = opened by an error/approval or by keyboard: never auto-hides.
function showFaceBar(hold) {
  var bar = $('faceBar');
  bar.classList.add('show');
  $('faceCtl').setAttribute('aria-expanded', 'true');
  syncFaceBarUI();
  clearTimeout(faceBarTimer);
  if (!hold) faceBarTimer = setTimeout(maybeHideFaceBar, 6000);
}
function hideFaceBar() {
  clearTimeout(faceBarTimer);
  $('faceBar').classList.remove('show');
  $('faceCtl').setAttribute('aria-expanded', 'false');
}
function maybeHideFaceBar() {
  var bar = $('faceBar');
  if (bar.contains(document.activeElement)) { faceBarTimer = setTimeout(maybeHideFaceBar, 6000); return; }
  if (faceStatusName === 'error' || faceStatusName === 'approval') return;
  hideFaceBar();
}
function toggleFaceBar(fromKeyboard) {
  if ($('faceBar').classList.contains('show')) { hideFaceBar(); $('faceCtl').focus(); }
  else { showFaceBar(!!fromKeyboard); if (fromKeyboard) $('faceMic').focus(); }
}
function syncFaceBarUI() {
  $('faceMic').classList.toggle('on', conversationOpen);
  $('faceMic').classList.toggle('off', !conversationOpen);
  $('faceSpk').classList.toggle('on', speakEnabled);
  $('faceSpk').classList.toggle('off', !speakEnabled);
  $('faceMuted').classList.toggle('show', faceMode === 'creature' && !conversationOpen);
}
$('faceCol').addEventListener('click', function () { if (face) face.wake(); if (faceMode === 'creature') toggleFaceBar(false); });
$('faceCtl').onclick = function () { toggleFaceBar(false); };
$('faceCtl').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFaceBar(true); } });
$('faceBarClose').onclick = function () { hideFaceBar(); $('faceCtl').focus(); };
$('faceMic').onclick = function () { window.oqxToggleConversation(); syncFaceBarUI(); showFaceBar(false); };
$('faceSpk').onclick = function () { $('spkBtn').onclick(); syncFaceBarUI(); showFaceBar(false); };
$('faceStop').onclick = function () { stopTurnAudio(); showFaceBar(false); };
$('faceSettings').onclick = function () { $('vpSettings').onclick(); };
// Escape closes the TOPMOST layer only: a picker over Settings, then Settings, then (creature
// mode) the reveal bar. Focus returns to what opened the layer.
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  if (!$('devOverlay').classList.contains('hidden')) { $('devCancel').onclick(); var back = { audioinput: 'micPickBtn', audiooutput: 'spkPickBtn', model: 'modelPickBtn', persona: 'personaPickBtn', face: 'facePickBtn', wake: 'wakePickBtn', chime: 'chimePickBtn', followup: 'followPickBtn' }[devOverlayKindLast] || 'settingsClose'; var el = $(back); if (el) el.focus(); return; }
  if (!$('settingsOverlay').classList.contains('hidden')) { $('settingsOverlay').classList.add('hidden'); (faceMode === 'creature' ? $('faceCtl') : $('vpSettings')).focus(); return; }
  if (faceMode !== 'creature') return;
  if ($('faceBar').classList.contains('show') && faceStatusName !== 'error' && faceStatusName !== 'approval') { hideFaceBar(); $('faceCtl').focus(); }
});
var devOverlayKindLast = '';   // which picker was open last, for Escape's focus return
var wakeHiddenPaused = false;   // the wake-word mic was released because the page was hidden; re-arm on return
document.addEventListener('visibilitychange', function () {
  // Wake word on: a hidden page must not listen. Release capture and disarm; a page that comes back
  // re-arms to waiting (never to an old listening window).
  if (document.hidden && wakeOn() && conversationOpen && vad) { wakeHiddenPaused = true; vad.stop(); wakeArm(false); }
  else if (!document.hidden && wakeHiddenPaused) {
    wakeHiddenPaused = false;
    if (conversationOpen && vad) {
      var p = wakeArm(true), epoch = captureEpoch;
      p.then(function () { if (conversationOpen && !document.hidden && epoch === captureEpoch) vad.start(onVADSpeechStart, onVADSpeechEnd, onVADLevel); }).catch(function () {});
    }
  }
  if (!document.hidden && !wakeHiddenPaused) wakeAutoOpen();
  if (!face) return;
  if (document.hidden) { face.stop(); faceStopLevel(); }
  else { face.start(); face.resize(); faceResumeLevel(); }
});
window.addEventListener('resize', function () { if (face) face.resize(); });
if (reducedMotionMq && reducedMotionMq.addEventListener) reducedMotionMq.addEventListener('change', function () { if (face) face.setReducedMotion(reducedMotionMq.matches); });

// Mouth level from the audio that is actually playing. The <audio> element is routed through an
// AudioContext analyser (and on to the context's destination); the picked speaker is applied to
// the CONTEXT, since a routed element's own setSinkId no longer decides where the sound goes.
// If any of that fails the reply still plays normally and the face just stops animating its mouth
// (logged once): an honest still mouth beats a fake one.
// One MediaElementSource per <audio> (it can only ever be created once per element), cached on the
// element itself; the level loop is separate from the routing so it can stop while the page is
// hidden or the face is off, and resume when the face comes back mid-reply.
var faceAudioCtx = null, faceAnalyser = null, faceAnalysedEl = null, faceLevelRaf = null, faceAnalyserWarned = false, faceLevelBuf = null;
function faceAttachAnalyser(audio) {
  if (!face || !audio) return;
  try {
    if (!faceAudioCtx) faceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (!audio._oqxSource) {
      audio._oqxSource = faceAudioCtx.createMediaElementSource(audio);
      audio._oqxAnalyser = faceAudioCtx.createAnalyser();
      audio._oqxAnalyser.fftSize = 512;
      audio._oqxAnalyser.smoothingTimeConstant = 0.5;
      audio._oqxSource.connect(audio._oqxAnalyser);
      audio._oqxAnalyser.connect(faceAudioCtx.destination);
      audio.addEventListener('playing', function () { if (faceAnalysedEl === audio) faceResumeLevel(); });
    }
    faceAnalyser = audio._oqxAnalyser;
    faceAnalysedEl = audio;
    faceApplyCtxSink();
    if (faceAudioCtx.state === 'suspended') faceAudioCtx.resume().catch(function () {});
    faceResumeLevel();
  } catch (e) {
    if (!faceAnalyserWarned) { faceAnalyserWarned = true; console.log('face: playback analyser unavailable, mouth stays still: ' + (e && e.message ? e.message : e)); }
    faceAnalyser = null; faceAnalysedEl = null;
  }
}
function faceLevelTick() {
  faceLevelRaf = null;
  var audio = faceAnalysedEl, an = faceAnalyser;
  if (!audio || !an || !face) return;
  if (document.hidden) { face.setLevel(0); return; }   // resumed by visibilitychange
  if (!faceLevelBuf || faceLevelBuf.length !== an.fftSize) faceLevelBuf = new Uint8Array(an.fftSize);
  an.getByteTimeDomainData(faceLevelBuf);
  var sum = 0;
  for (var i = 0; i < faceLevelBuf.length; i++) { var v = (faceLevelBuf[i] - 128) / 128; sum += v * v; }
  face.setLevel(Math.min(1, Math.sqrt(sum / faceLevelBuf.length) * 5));
  if (!audio.paused && !audio.ended) faceLevelRaf = requestAnimationFrame(faceLevelTick);
  else face.setLevel(0);   // paused or ended: the mouth closes, honestly
}
function faceResumeLevel() {
  if (faceLevelRaf === null && faceAnalysedEl && face && !document.hidden) faceLevelRaf = requestAnimationFrame(faceLevelTick);
}
function faceStopLevel() {
  if (faceLevelRaf !== null) { cancelAnimationFrame(faceLevelRaf); faceLevelRaf = null; }
  if (face) face.setLevel(0);
}
// Called when the element is finished with (ended, error, stopped): tear its graph down so no
// source/analyser pair is retained per reply. A hide or layout change uses faceStopLevel instead
// and keeps the graph, since the element is still playing.
function faceDetachAnalyser(audio) {
  if (faceAnalysedEl !== audio) return;
  faceStopLevel();
  faceAnalysedEl = null;
  faceAnalyser = null;
  try { if (audio._oqxAnalyser) audio._oqxAnalyser.disconnect(); } catch (e) {}
  try { if (audio._oqxSource) audio._oqxSource.disconnect(); } catch (e) {}
  audio._oqxAnalyser = null;
  audio._oqxSource = null;
}
function faceApplyCtxSink() {
  if (faceAudioCtx && faceAudioCtx.setSinkId) faceAudioCtx.setSinkId(spkDeviceId || '').catch(function () {});
}

// Real streaming: EventSource stays open for the life of the page, pushed by main.js as
// content_block_delta events arrive from the live claude process (see claudevoice-session.js).
// `liveMsg` is the in-progress assistant transcript entry -- created on 'assistant-start', appended
// to on every 'assistant-delta', finalized (and re-rendered once more with the authoritative text)
// on 'turn-complete'.
var liveMsg = null;
// Repaint a live row's bubble from liveMsg + rewire its copy buttons. Callers keep their own guards.
function paintBubble(row) {
  row.querySelector('.bubble').innerHTML = renderContent(liveMsg.text);
  wireCopyButtons(row);
}
function updateLiveBubble() {
  var list = $('list');
  var row = list.querySelector('[data-live="1"]');
  if (!row) return;
  paintBubble(row);
  $('card').scrollTop = $('card').scrollHeight;
}
function connectEvents() {
  var es = new EventSource(BASE + '/events');
  es.onmessage = function (e) {
    var msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.type === 'assistant-start') {
      // Just a status change -- do NOT create a bubble yet. A turn emits message_start for every
      // internal message (tool calls, thinking), most of which never produce any text; creating a
      // bubble here left a trail of empty bars. The bubble appears on the first real text delta.
      setStatus('thinking');
    } else if (msg.type === 'assistant-delta') {
      if (!msg.text) return;
      if (!liveMsg) {
        liveMsg = { role: 'assistant', text: '' };
        transcript.push(liveMsg);
        $('empty').style.display = 'none';
        var row = document.createElement('div');
        row.className = 'msg assistant'; row.setAttribute('data-live', '1');
        row.innerHTML = '<div class="bubble"></div>';
        $('list').appendChild(row);
      }
      liveMsg.text += msg.text;
      updateLiveBubble();
      // Speech is NOT handled here anymore: the main process cuts sentences out of this same delta
      // stream itself and streams one continuous WAV per turn (see claudevoice-speech.js).
    } else if (msg.type === 'turn-complete') {
      var finalText = msg.text;
      if (liveMsg) {
        liveMsg.text = finalText || liveMsg.text;   // authoritative final text wins over accumulated deltas
        var row = $('list').querySelector('[data-live="1"]');
        if (row) row.removeAttribute('data-live');
        updateLiveBubbleFinal(row);
      } else if (finalText) {
        // No live bubble exists -- this turn never streamed (slash commands like /model or /context
        // come back only in the final result event), or the page loaded mid-turn. Render the result
        // as its own assistant message now instead of silently dropping it.
        transcript.push({ role: 'assistant', text: finalText });
        renderTranscript();
      }
      liveMsg = null;
      turnInProgress = false;
      // Speech: the server's per-turn stream keeps playing past turn-complete; when the audio is
      // still active its 'ended' event owns the status handoff back to listening/idle.
      if (msg.error) { stopTurnAudio(); setStatus('error', msg.error); }
      else if (!turnAudio) setStatus(conversationOpen ? 'listening' : 'idle');
    } else if (msg.type === 'error') {
      turnInProgress = false;
      stopTurnAudio();
      setStatus('error', msg.error);
    } else if (msg.type === 'approval-request') {
      showApprovalOverlay(msg.requestId, msg.toolName, msg.toolInput);
    } else if (msg.type === 'approval-decision' || msg.type === 'approval-timeout') {
      if (msg.requestId === pendingApprovalRequestId) hideApprovalOverlay();
    } else if (msg.type === 'panel-review') {
      showPanelReview(msg.panel);
    } else if (msg.type === 'panel-accepted') {
      setStatus(conversationOpen ? 'listening' : 'idle', 'Added "' + (msg.name || 'panel') + '".');
    } else if (msg.type === 'profile') {
      currentProfileId = msg.id || '';
      syncProfileUI();
    } else if (msg.type === 'emotion') {
      if (face) face.setEmotion(msg.name);
    } else if (msg.type === 'persona') {
      faceSetPersona(msg.persona);
      setPersonaPending(null);   // applied (startSession broadcasts this after the restart)
    } else if (msg.type === 'persona-pending') {
      setPersonaPending(msg.persona);
    } else if (msg.type === 'face') {
      applyFaceMode(msg.mode);
      syncPickButtons();
    } else if (msg.type === 'wake-state') {
      applyWakeState(msg.wake);
      syncPickButtons();
      // Turned on from the editor while the mic is open: the gate is shut until this page arms it.
      if (msg.wake && msg.wake.enabled && msg.wake.state === 'off' && conversationOpen) wakeArm(true);
      else if (msg.wake && msg.wake.enabled && !conversationOpen) wakeAutoOpen();   // wake word just turned on: open the mic
    } else if (msg.type === 'permission-mode') {
      currentMode = msg.mode || currentMode;
      syncModeUI();
    } else if (msg.type === 'model') {
      liveModel = msg.model || '';   // what's ACTUALLY running, per the session/adapter
      syncPickButtons();
    } else if (msg.type === 'meta') {
      applyMeta(msg.meta);   // live refresh (e.g. codex model discovery finished after page load)
    } else if (msg.type === 'notice') {
      speechErrText = msg.text || '';   // same sticky status-line slot: plain-language guidance
      setStatus($('status').textContent.toLowerCase(), '');
    } else if (msg.type === 'speech-error') {
      speechErrText = msg.error || 'Speech failed.';
      setStatus($('status').textContent.toLowerCase(), '');   // repaint the status line with the sticky notice
    } else if (msg.type === 'turn-speech') {
      // A queued turn just started generating: its speech stream id arrives here rather than on
      // the POST /turn response (that turn was parked behind the previous one -- CLI semantics).
      // speakEnabled is re-checked HERE, not just at send time: a turn can be dispatched by a
      // routine tile (from main, which can't see this page's toggle) or queued behind another and
      // muted in between. The toggle wins in both cases.
      if (msg.speech && speakEnabled) startTurnAudio(msg.speech);
    } else if (msg.type === 'user-turn') {
      // A lazily-started session's session-started broadcast just wiped this page's transcript,
      // taking the freshly-drawn user bubble with it -- the host echoes the turn text back so the
      // first spoken instruction of a session stays visible.
      transcript.push({ role: 'user', text: msg.text });
      renderTranscript();
    } else if (msg.type === 'session-started') {
      // New session (folder switch or fresh start): new conversation, new header, silence.
      // The mode rides along -- the page-load snapshot predates a lazily-started session, so
      // without this the Mode button shows a stale default until the first manual switch.
      if (msg.permissionMode) { currentMode = msg.permissionMode; syncModeUI(); }
      speechErrText = '';
      stopTurnAudio();
      turnInProgress = false;
      transcript = [];
      liveMsg = null;
      renderTranscript();
      setProjectHeader(msg.projectDir);
      if (face) face.setEmotion('neutral');   // a fresh conversation starts with a clean face
      setPersonaPending(null);                // the restart is the applied switch
      setStatus('idle');
    }
  };
  es.onerror = function () { /* EventSource auto-reconnects; nothing to do */ };
}

// ---- Touch approval overlay (Phase 7) ----
// Driven entirely by SSE: main.js's PreToolUse hook holds the tool call open and emits
// 'approval-request'; a tap here POSTs the decision, which resolves that same held-open hook
// response server-side. A reload while a request is in flight won't re-show this overlay (the
// current /claude-voice/state snapshot doesn't carry pending-request detail, only the status text) --
// same acknowledged limitation as the SSE transcript-replay gap noted above.
var pendingApprovalRequestId = null;
function renderApprovalDetail(toolInput) {
  toolInput = toolInput || {};
  var parts = [];
  var code = typeof toolInput.command === 'string' ? toolInput.command :
    typeof toolInput.content === 'string' ? toolInput.content :
    typeof toolInput.new_string === 'string' ? toolInput.new_string : null;
  if (code != null) parts.push('<pre class="approvalCode">' + esc(code) + '</pre>');
  var where = typeof toolInput.file_path === 'string' ? toolInput.file_path : typeof toolInput.path === 'string' ? toolInput.path : null;
  if (where) parts.push('<div class="approvalPath">in ' + esc(where) + '</div>');
  if (!parts.length) parts.push('<pre class="approvalCode">' + esc(JSON.stringify(toolInput, null, 2)) + '</pre>');
  return parts.join('');
}
function showApprovalOverlay(requestId, toolName, toolInput) {
  pendingApprovalRequestId = requestId;
  $('approvalTool').textContent = toolName || 'a tool';
  $('approvalDetail').innerHTML = renderApprovalDetail(toolInput);
  $('approvalOverlay').classList.remove('hidden');
  setStatus('approval');
}
function hideApprovalOverlay() {
  pendingApprovalRequestId = null;
  $('approvalOverlay').classList.add('hidden');
  setStatus('thinking');   // control is back with Claude -- it'll either keep working or ask again
}
function decideApproval(decision) {
  var requestId = pendingApprovalRequestId;
  if (!requestId) return;
  hideApprovalOverlay();
  postJSON('/approval-decision', { requestId: requestId, decision: decision })
    .catch(function () { setStatus('error', 'Could not send the approval decision.'); });
}
$('approvalApprove').onclick = function () { decideApproval('allow'); };
$('approvalDeny').onclick = function () { decideApproval('deny'); };
$('approvalAlways').onclick = function () { decideApproval('always'); };   // approve + stop asking this session (meta-gated)
function updateLiveBubbleFinal(row) {
  if (!row || !liveMsg) return;
  paintBubble(row);
}
// Agent-specific strings and pick lists, delivered by the host on /state. The markup ships with
// claude-shaped fallbacks so the page still renders sensibly if the fetch fails; meta replaces
// them wholesale. Mode options are rebuilt as DOM (labels + descriptions differ per agent).
function applyMeta(meta) {
  if (!meta) return;
  if (meta.title) { $('title').textContent = meta.title; document.title = meta.title; }
  if (meta.approvalTitle) $('approvalTitle').textContent = meta.approvalTitle;
  if (meta.turnFailedText) turnFailedText = meta.turnFailedText;
  $('approvalAlways').classList.toggle('hidden', !meta.approvalAlways);   // only agents whose protocol supports session-wide approval
  // Chat-only backends (owui/api) have no working directory and no permission modes: hide the folder
  // controls (the rail's folder-name line and the Settings overlay's Folder row) and the permission-mode
  // buttons instead of leaving dead claude-shaped controls on screen.
  $('project').classList.toggle('hidden', meta.hasProject === false);
  $('folderPickBtn').style.display = meta.hasProject === false ? 'none' : '';
  $('vpMode').classList.toggle('hidden', !(meta.modes && meta.modes.length));
  if (meta.modes && meta.modes.length) {
    MODE_LABELS = {};
    var wrap = $('modeOpts');
    wrap.innerHTML = '';
    meta.modes.forEach(function (m) {
      MODE_LABELS[m.id] = m.label;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'modeOpt';
      b.setAttribute('data-mode', m.id);
      b.textContent = m.label;
      if (m.desc) {
        var s = document.createElement('small');
        s.textContent = m.desc;
        b.appendChild(s);
      }
      wireModeOpt(b);
      wrap.appendChild(b);
    });
    syncModeUI();
  }
  if (meta.models && meta.models.length) {
    MODEL_PICKS = meta.models.map(function (m) { return [m.id, m.label]; });
    syncPickButtons();
  }
  if (meta.profiles) {
    PROFILES = meta.profiles;
    if (typeof meta.profile === 'string') currentProfileId = meta.profile;
    syncProfileUI();
  }
  // Face: the library for the picker, this page's persona (face parameters) and layout.
  if (meta.personas) PERSONAS = meta.personas;
  if ('persona' in meta) faceSetPersona(meta.persona);
  if (meta.face) applyFaceMode(meta.face);
  syncPickButtons();
}
fetch(BASE + '/state', { cache: 'no-store' }).then(function (r) { return r.json(); })
  .then(function (s) {
    applyMeta(s.meta);
    // Replay the session's transcript (kept by main.js) -- the webview reloads this page on every
    // page switch, so without this a rotate-away-and-back would blank the whole conversation.
    if (s.transcript && s.transcript.length) { transcript = s.transcript.slice(); renderTranscript(); }
    if (s.permissionMode) { currentMode = s.permissionMode; syncModeUI(); }
    if (s.model) { liveModel = s.model; syncPickButtons(); }
    if (s.projectDir) setProjectHeader(s.projectDir);   // live truth beats the (possibly stale) page-load query param
    if (s.panel && s.panel.active) showPanelReview(s.panel);   // rotating away mid-review must not lose the proposal
    if (s.emotion && face) face.setEmotion(s.emotion);
    setPersonaPending(s.personaPending || null);
    if (s.wake) applyWakeState(s.wake);
    // A reload mid-approval (page switch, creature toggle) restores the actionable overlay; the
    // decision route checks the requestId, so a stale one is refused server-side, never misapplied.
    if (s.pendingApproval && s.pendingApproval.requestId && !pendingApprovalRequestId) {
      showApprovalOverlay(s.pendingApproval.requestId, s.pendingApproval.toolName, s.pendingApproval.toolInput);
    } else setStatus(s.status, s.error);
  }).catch(function () {});
connectEvents();
applyFaceMode(faceMode);   // from the page query; /state's meta corrects it if the editor changed it since

function autoGrow() {
  var ta = $('textInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
}
$('textInput').addEventListener('input', autoGrow);

// Transient line under the transcript. Shares #err with real errors but drops the danger color for
// a confirmation, and clears itself -- the next setStatus would clear it anyway.
var routineNoticeT = null;
function routineNotice(text, ok) {
  var el = $('err');
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
  clearTimeout(routineNoticeT);
  routineNoticeT = setTimeout(function () { el.classList.remove('ok'); el.textContent = speechErrText || ''; }, 4000);
}

// "+ Routine": keep this request for a tile. Sends the message field if there's anything in it,
// otherwise the host falls back to the last request that was actually sent -- so "speak it, watch
// it work, keep it" is one tap. Naming happens on the host (no keyboard here); the generated name
// comes back for the confirmation.
$('routineBtn').onclick = function () {
  var btn = $('routineBtn');
  btn.disabled = true;
  postJSON('/routine-save', { text: $('textInput').value.trim() })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      if (r && r.ok) routineNotice('Saved routine: ' + r.name, true);
      else routineNotice((r && r.error) || 'Could not save that routine.', false);
    })
    .catch(function () { routineNotice('Could not reach the panel server.', false); })
    .finally(function () { btn.disabled = false; });
};

var turnInProgress = false;   // a sent turn hasn't seen its turn-complete yet (drives status after audio ends early)
var turnFailedText = 'Turn failed to send — no project set, or claude CLI not found.';   // meta can override per agent
function sendText(text) {
  if (!text) return;
  transcript.push({ role: 'user', text: text });
  renderTranscript();
  turnInProgress = true;
  $('sendBtn').disabled = true;
  // `speak` is decided HERE, per turn, by the SPEAKER toggle alone -- mic and speaker are fully
  // independent (mic off + speaker on = type questions, hear the answers; explicitly required).
  // Tying it to the turn server-side means one turn finishing can never silence a queued next
  // turn's speech (the old lastTurnWasVoice-clobber bug).
  postJSON('/turn', { text: text, speak: !!speakEnabled })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      if (!r || !r.ok) { turnInProgress = false; setStatus('error', turnFailedText); return; }
      if (r.speech) startTurnAudio(r.speech);
    })
    .catch(function () { turnInProgress = false; reachErr(); })
    .finally(function () { $('sendBtn').disabled = false; });
}
function send() {
  var ta = $('textInput');
  var text = ta.value.trim();
  if (!text) return;
  ta.value = ''; autoGrow();
  sendText(text);
}
$('sendBtn').onclick = send;
$('textInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

// Speaks `text` via the configured wyoming-piper. Test-speech button ONLY now -- real replies
// stream through the per-turn pipeline below. The server sanitizes the text for speech itself.
// `suppressVAD` is held true for the duration of playback so the mic doesn't hear Claude's own
// voice through the speakers and mistake it for the next user utterance (a real feedback-loop risk
// in a fully hands-free loop -- there's no headset here, just the panel's own mic and speaker).
var suppressVAD = false;
// Capture epoch: bumped synchronously on every mic/arm boundary (mic tap, hide/show, arm/disarm). An
// utterance whose STT round trip began under an older epoch never sends, even when the host's own
// generation has not caught up yet (the /wake-arm response is still in flight).
var captureEpoch = 0;
function speak(text, onDone) {
  if (!text) { if (onDone) onDone(); return; }
  stopTurnAudio();   // the Test button supersedes any in-flight turn speech -- never two streams
  suppressVAD = true;
  setStatus('speaking');
  $('spkBtn').classList.add('pulsing');
  var finish = function (errMsg) {
    suppressVAD = false;
    $('spkBtn').classList.remove('pulsing');
    setStatus(conversationOpen ? 'listening' : 'idle', errMsg || '');
    if (onDone) onDone();
  };
  // POST the text first and play by id: reply text can be many KB, far beyond what a GET query
  // string survives (oversized request lines got rejected server-side before any handler ran --
  // the "sometimes replies just aren't spoken" bug). Failures surface in the status line now
  // instead of dying silently.
  postJSON('/tts', { text: text })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      if (!r || !r.ok || !r.id) { finish('Speech failed to start.'); return; }
      var audio = new Audio(BASE + '/tts-audio?id=' + encodeURIComponent(r.id));
      audio.addEventListener('ended', function () { faceDetachAnalyser(audio); finish(); });
      audio.addEventListener('error', function () { faceDetachAnalyser(audio); finish('Speech playback failed.'); });
      applySinkId(audio);
      faceAttachAnalyser(audio);
      audio.play().catch(function () { faceDetachAnalyser(audio); finish('Speech playback failed.'); });
    })
    .catch(function () { finish('Speech failed to start.'); });
}
$('ttsTestBtn').onclick = function () {
  var last = transcript.slice().reverse().find(function (m) { return m.role === 'assistant'; });
  // Match the saved speaker label first (may not have happened yet if no conversation was opened
  // this page load) so the test actually plays on the picked device.
  ensureDeviceIds().then(function () { speak(last ? last.text : 'No reply yet to test with.'); });
};

// ---- Turn speech (v2 -- the user's own architecture, task #26) ----
// ALL speech logic lives in the MAIN process now (claudevoice-speech.js): it cuts sentences out of
// the same delta stream this page renders, sanitizes them for the speaker, synthesizes serially,
// and streams ONE continuous WAV per turn. This page just plays a single <audio> element per voice
// turn -- overlap is structurally impossible, and there are no page-side queues or watchdogs left
// to orphan. Dropping the element's stream (mute, folder switch, page unload) is itself the abort
// signal the server acts on; no separate stop request exists or is needed.
var turnAudio = null;   // the current voice turn's <audio>, or null
function endSpeechUI(errMsg) {
  suppressVAD = false;
  if (vad && vad.reset) vad.reset();   // an utterance that began as the speaker's tail is dropped, not shipped
  $('spkBtn').classList.remove('pulsing');
  setStatus(turnInProgress ? 'thinking' : conversationOpen ? 'listening' : 'idle', errMsg || '');
}
function stopTurnAudio() {
  if (!turnAudio) return;
  var a = turnAudio;
  turnAudio = null;
  faceDetachAnalyser(a);
  try { a.pause(); } catch (e) {}
  try { a.removeAttribute('src'); a.load(); } catch (e) {}   // closes the HTTP stream -> server aborts synthesis
  endSpeechUI();
  wakeReplyEnded(false);   // stopped early: the end of the sound, but no follow-up window for it
}
function startTurnAudio(turnId) {
  stopTurnAudio();
  var a = turnAudio = new Audio(BASE + '/turn-audio?turn=' + encodeURIComponent(turnId));
  var done = function (completed) {   // ended and error land in the same place: release the mic, settle status
    if (turnAudio !== a) return;
    turnAudio = null;
    faceDetachAnalyser(a);
    endSpeechUI();
    wakeReplyEnded(completed === true);   // the end of the sound: the wake gate starts its echo cooldown now;
  };                                       // only a natural end earns a follow-up window (error / rejected play do not)
  faceAttachAnalyser(a);   // before play(): the element must be routed before its first sample
  a.addEventListener('playing', function () {
    if (turnAudio !== a) return;
    speechErrText = '';   // speech audibly works again -- retire the sticky TTS-failure notice
    suppressVAD = true;   // the mic must never hear Claude's own voice through the speaker
    setStatus('speaking');
    $('spkBtn').classList.add('pulsing');
  });
  a.addEventListener('ended', function () { done(true); });
  a.addEventListener('error', function () { done(false); });
  applySinkId(a);   // route to the picked speaker (no-op on system default)
  a.play().catch(function () { done(false); });
}

// ---- Audio device pickers (Settings overlay) ----
// Picks persist server-side as LABELS ('' = system default) because Chromium salts deviceIds per
// origin and this page's origin (port) changes every app launch -- an id would never match twice.
// Labels only become visible after a getUserMedia grant in this session, so enumeration runs
// lazily (conversation open, settings open, Test speech) via a momentary mic grab that is closed
// again immediately.
var savedMicLabel = Q.get('micDevice') || '';   // this page's own pick; '' = inherit the app-wide default
var savedSpkLabel = Q.get('spkDevice') || '';
// The software-wide defaults (Settings > General > Audio), passed in by main.js. '' here = OS system
// default. Effective device = this page's own pick if set, else the app-wide default.
var globalMicLabel = Q.get('micDef') || '';
var globalSpkLabel = Q.get('spkDef') || '';
function effMicLabel() { return savedMicLabel || globalMicLabel; }
function effSpkLabel() { return savedSpkLabel || globalSpkLabel; }
var micDeviceId = '', spkDeviceId = '';
var allDevices = [];
var devicesReady = false;
function matchDevices() {
  var spk = allDevices.find(function (d) { return d.kind === 'audiooutput' && d.label === effSpkLabel(); });
  micDeviceId = window.matchMicLabel(allDevices, effMicLabel());   // missing device -> '' = system default (never a hard fail)
  spkDeviceId = spk ? spk.deviceId : '';
}
function ensureDeviceIds(force) {
  if (devicesReady && !force) return Promise.resolve();
  return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (tmp) {
    return navigator.mediaDevices.enumerateDevices().then(function (devs) {
      tmp.getTracks().forEach(function (t) { t.stop(); });
      allDevices = devs || [];
      matchDevices();
      devicesReady = true;
    });
  }).catch(function () {
    // No mic permission/hardware: carry on with system defaults. A real mic failure still
    // surfaces where it matters -- vad.start() reports it on the status line.
    allDevices = [];
    matchDevices();
    devicesReady = true;
  });
}
function applySinkId(audio) {
  if (spkDeviceId && audio.setSinkId) audio.setSinkId(spkDeviceId).catch(function () {});
  faceApplyCtxSink();   // a routed element plays through the face's AudioContext instead
}
// Model picker state: the pick is an alias ('' = account default) persisted like the device
// labels; `liveModel` is the model ACTUALLY running, reported by the session's init event.
var MODEL_PICKS = [['', 'Default (account setting)'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
var savedModelPick = Q.get('modelPick') || '';
var liveModel = '';
function modelPrettyName(id) {   // 'claude-sonnet-5' -> 'Sonnet' (best-effort; falls back to the raw id)
  var m = MODEL_PICKS.find(function (p) { return p[0] && String(id || '').indexOf(p[0]) >= 0; });
  return m ? m[1] : (id || '');
}
// Settings shows only the CURRENT pick per row (big row, tap to change); the actual list lives
// in its own full-size overlay -- never an always-visible scrolling list inside a dialog.
var FACE_PICKS = [['off', 'Off — plain chat page'], ['side', 'Side — face beside the chat'], ['creature', 'Creature — face only']];
var WAKE_PICKS = [['off', 'Off — the open mic hears everything'], ['on', 'On — wait for the persona\'s name']];
var CHIME_PICKS = [['0', 'Off'], ['1', 'On — a short two-note chime']];
var FOLLOWUP_PICKS = [['0', 'Off — one wake, one request'], ['5', '5 seconds'], ['10', '10 seconds'], ['20', '20 seconds'], ['30', '30 seconds'], ['60', '1 minute'], ['120', '2 minutes']];
var wakeFollowUpSeconds = Q.get('wakeFollowUpSeconds') || '0';
function syncPickButtons() {
  $('micPickVal').textContent = savedMicLabel || ('Default — ' + (globalMicLabel || 'System default'));
  $('spkPickVal').textContent = savedSpkLabel || ('Default — ' + (globalSpkLabel || 'System default'));
  var pick = MODEL_PICKS.find(function (p) { return p[0] === savedModelPick; });
  var label = savedModelPick ? (pick ? pick[1] : savedModelPick) : 'Default';
  if (!savedModelPick && liveModel) label = 'Default — ' + modelPrettyName(liveModel);
  $('modelPickVal').textContent = label;
  var fp = FACE_PICKS.find(function (p) { return p[0] === faceMode; });
  $('facePickVal').textContent = fp ? fp[1] : faceMode;
  var wp = WAKE_PICKS.find(function (p) { return p[0] === (wakeOn() ? 'on' : 'off'); });
  $('wakePickVal').textContent = (wp ? wp[1] : 'Off') + (wakeOn() && wakeState.phrase ? ' ("' + wakeState.phrase + '")' : '');
  var cp = CHIME_PICKS.find(function (p) { return p[0] === (wakeChimeOn ? '1' : '0'); });
  $('chimePickVal').textContent = cp ? cp[1] : 'Off';
  var fu = FOLLOWUP_PICKS.find(function (p) { return p[0] === String(wakeFollowUpSeconds); });
  $('followPickVal').textContent = fu ? fu[1] : (wakeFollowUpSeconds + ' seconds');
  syncPersonaUI();
}
function syncPersonaUI() {
  var cur = PERSONAS.find(function (p) { return p.id === currentPersonaId; });
  $('personaPickVal').textContent = cur ? cur.name : (facePersona ? facePersona.name : 'None');
}
var devOverlayKind = '';   // 'audioinput' | 'audiooutput' | 'model' | 'persona' | 'face' while the picker overlay is open
function renderDevOverlay() {
  var kind = devOverlayKind;
  var el = $('devList');
  el.innerHTML = '';
  function addRow(label, value, current) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'devRow' + (current ? ' current' : '');
    b.textContent = label;
    b.title = label;
    b.onclick = function () { pickDevice(kind, value); };
    el.appendChild(b);
  }
  if (kind === 'model') {
    MODEL_PICKS.forEach(function (p) { addRow(p[1], p[0], p[0] === savedModelPick); });
    return;
  }
  if (kind === 'persona') {
    addRow('None — plain face', '', !currentPersonaId);
    PERSONAS.forEach(function (p) { addRow(p.name, p.id, p.id === currentPersonaId); });
    return;
  }
  if (kind === 'face') {
    FACE_PICKS.forEach(function (p) { addRow(p[1], p[0], p[0] === faceMode); });
    return;
  }
  if (kind === 'wake') { WAKE_PICKS.forEach(function (p) { addRow(p[1], p[0], p[0] === (wakeOn() ? 'on' : 'off')); }); return; }
  if (kind === 'chime') { CHIME_PICKS.forEach(function (p) { addRow(p[1], p[0], p[0] === (wakeChimeOn ? '1' : '0')); }); return; }
  if (kind === 'followup') { FOLLOWUP_PICKS.forEach(function (p) { addRow(p[1], p[0], p[0] === String(wakeFollowUpSeconds)); }); return; }
  var savedLabel = kind === 'audioinput' ? savedMicLabel : savedSpkLabel;
  var globalLabel = kind === 'audioinput' ? globalMicLabel : globalSpkLabel;
  var devs = allDevices.filter(function (d) { return d.kind === kind && d.label; });
  var matched = !!savedLabel && devs.some(function (d) { return d.label === savedLabel; });
  // Top entry inherits the app-wide default (Settings > General > Audio); shown with the resolved
  // device name so the user sees what it currently points at. Selecting it clears this page's override.
  addRow('App-wide default — ' + (globalLabel || 'System default'), '', !matched);
  devs.forEach(function (d) { addRow(d.label, d.label, matched && d.label === savedLabel); });
}
function openDevOverlay(kind) {
  devOverlayKind = kind;
  devOverlayKindLast = kind;
  $('devTitle').textContent = { audioinput: 'Microphone', audiooutput: 'Speaker', persona: 'Persona', face: 'Face', wake: 'Wake word', chime: 'Chime when the name is heard', followup: 'Follow-up window after a reply' }[kind] || 'Model';
  renderDevOverlay();                                  // cached entries paint instantly...
  if (kind === 'audioinput' || kind === 'audiooutput') {   // (the other lists are static -- no mic grab)
    ensureDeviceIds(true).then(function () {           // ...then a fresh enumeration replaces them
      if (devOverlayKind === kind) renderDevOverlay();
    });
  }
  $('devOverlay').classList.remove('hidden');
}
// Announce device changes to assistive tech via a lazily-created visually-hidden aria-live region, so a
// swap (including a live one done from the panel) is not silent to non-visual users. The message states
// whether the choice is an override for this page or the inherited app-wide default.
function announce(msg) {
  var el = $('a11yLive');
  if (!el) {
    el = document.createElement('div');
    el.id = 'a11yLive';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0';
    document.body.appendChild(el);
  }
  el.textContent = '';
  setTimeout(function () { el.textContent = msg; }, 30);   // clear-then-set so repeated same-text swaps still speak
}
function deviceAnnounce(what, label, globalLabel) {
  announce(label ? (what + ' set to ' + label + ' for this page')
                 : (what + ' now using the app-wide default (' + (globalLabel || 'system default') + ')'));
}
function pickDevice(kind, label) {
  $('devOverlay').classList.add('hidden');
  devOverlayKind = '';
  if (kind === 'persona') {
    // The host persists the pick, restarts the backend's session with the new prompt once the
    // live turn ends, and broadcasts 'persona' with the face to draw.
    postJSON('/persona', { id: label })
      .then(function (r) { return r.json(); })
      .then(function (r) { if (!r || !r.ok) setStatus(conversationOpen ? 'listening' : 'idle', 'Persona switch failed.'); })
      .catch(reachErr);
    return;
  }
  if (kind === 'face') {
    postOption('face', label);   // the host re-issues the prompt (tags on/off) and broadcasts 'face'
    applyFaceMode(label);
    syncPickButtons();
    return;
  }
  if (kind === 'wake') {
    postOption('wakeWord', label);   // the host re-resolves and broadcasts wake-state
    wakeState.enabled = label === 'on';
    if (conversationOpen) wakeArm(label === 'on'); else renderWakeLabel();
    syncPickButtons();
    return;
  }
  if (kind === 'chime') { wakeChimeOn = label === '1'; postOption('wakeChime', wakeChimeOn ? 'true' : 'false'); syncPickButtons(); return; }
  if (kind === 'followup') { wakeFollowUpSeconds = label; postOption('wakeFollowUpSeconds', label); syncPickButtons(); return; }
  if (kind === 'model') {
    savedModelPick = label;
    postOption('modelPick', label);   // persists; also what a fresh session start reads
    // Live session: resume-restart onto the new model (same trick as the Mode button, ~2s pause).
    postJSON('/model', { model: label })
      .then(function (r) { return r.json(); })
      .then(function (r) { if (!r || !r.ok) setStatus(conversationOpen ? 'listening' : 'idle', 'Model switch failed.'); })
      .catch(reachErr);
    syncPickButtons();
    return;
  }
  if (kind === 'audioinput') {
    savedMicLabel = label;
    postOption('micDevice', label);
    matchDevices();
    if (conversationOpen && vad) {   // live conversation: reopen the mic on the new device now
      vad.stop();
      vad.setInputDevice(micDeviceId);
      vad.start(onVADSpeechStart, onVADSpeechEnd, onVADLevel).catch(function (e) {
        setStatus('error', 'Microphone switch failed: ' + (e && e.message ? e.message : e));
      });
    }
    deviceAnnounce('Microphone', label, globalMicLabel);
  } else {
    savedSpkLabel = label;
    postOption('spkDevice', label);
    matchDevices();
    if (turnAudio) applySinkId(turnAudio);   // mid-reply switch moves the voice immediately
    deviceAnnounce('Speaker', label, globalSpkLabel);
  }
  syncPickButtons();
}
$('micPickBtn').onclick = function () { openDevOverlay('audioinput'); };
$('spkPickBtn').onclick = function () { openDevOverlay('audiooutput'); };
$('modelPickBtn').onclick = function () { openDevOverlay('model'); };
$('personaPickBtn').onclick = function () { openDevOverlay('persona'); };
$('facePickBtn').onclick = function () { openDevOverlay('face'); };
$('wakePickBtn').onclick = function () { openDevOverlay('wake'); };
$('chimePickBtn').onclick = function () { openDevOverlay('chime'); };
$('followPickBtn').onclick = function () { openDevOverlay('followup'); };
$('devCancel').onclick = function () { $('devOverlay').classList.add('hidden'); devOverlayKind = ''; };

// ---- Tap-to-toggle voice conversation (Phase 5) ----
// Explicitly NOT push-to-talk: one tap opens a continuous conversation (VAD detects each utterance's
// start/end on its own, no holding anything down), a second tap closes it. See the plan's hard
// constraint #4 -- push-to-talk was explicitly rejected.
var conversationOpen = false;
var vadHangoverMs = parseInt(Q.get('vadHangoverMs'), 10) || 400;   // 0.4s default — snappier out of the box (matches LucidType)
var vad = window.createClaudeVoiceVAD ? window.createClaudeVoiceVAD({ hangoverMs: vadHangoverMs }) : null;
// With the wake word on, speech before the phrase is nobody's business: no status change, no face,
// no ripple until the human is expected to be talking to the persona (listening / follow-up).
function wakeExpectsSpeech() { return !wakeOn() || wakeState.state === 'listening' || wakeState.state === 'followup'; }
var vadSpeechStartedAt = 0;   // when the VAD saw the current utterance begin; sent with its audio (the host dates it by this)
var wakeHold = false;         // speech began inside a window: hold the label (no countdown, no "Waiting") until STT answers
function onVADSpeechStart() {
  vadSpeechStartedAt = Date.now();
  if (suppressVAD) return;
  if (!wakeExpectsSpeech()) return;
  if (wakeOn()) wakeHold = true;
  setStatus('listening');
  renderWakeLabel();
}
function onVADSpeechEnd(pcm16) {
  if (suppressVAD || !conversationOpen) return;
  // With the wake word on, an utterance is just "something was said": no status change until the
  // host says it was addressed to the persona. Nothing about it is ever shown on the panel.
  if (!wakeOn()) setStatus('thinking');
  var sentGen = wakeGen, epoch = captureEpoch;
  var startAgo = vadSpeechStartedAt ? Math.max(0, Date.now() - vadSpeechStartedAt) : 0;
  var q = wakeOn() ? '?gen=' + encodeURIComponent(sentGen) + '&start=' + startAgo : '';
  var release = function () { if (wakeHold) { wakeHold = false; renderWakeLabel(); } };
  fetch(BASE + '/audio' + q, { method: 'POST', cache: 'no-store', body: pcm16.buffer })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      release();
      // Re-check AFTER the async STT round trip: if speech started playing while this was in
      // flight, the utterance may have caught the speaker's first words -- drop it, never
      // ghost-send it as a turn.
      if (suppressVAD || !conversationOpen || epoch !== captureEpoch) return;   // mic closed / re-armed meanwhile: stale
      if (wakeOn() && sentGen !== wakeGen) return;   // persona switched or host re-armed meanwhile: stale
      if (r && r.ok && r.text && r.text.trim()) {
        if (r.wake === 'addressed') wakeChime();
        sendText(r.text.trim());
      } else {
        if (r && r.wake === 'listening') wakeChime();   // the name alone: now listening for the request
        if (!wakeOn()) setStatus(conversationOpen ? 'listening' : 'idle', r && r.error);
        else if (r && r.error) setStatus(conversationOpen ? 'listening' : 'idle', r.error);
      }
    })
    .catch(function () { release(); setStatus('error', 'Transcription request failed.'); });
}

// ---- Wake word (phase 1, transcript gate; the host decides, this page shows the state) ----
// Query options come from the page's saved options; the host's wake-state events and /state carry
// the live state (waiting / listening / active / followup / cooldown / not-ready) and the phrase.
var wakeGen = 0;
var wakeState = { enabled: Q.get('wakeWord') === 'on', state: 'off', phrase: '', until: 0, ready: true, reason: '' };
var wakeChimeOn = Q.get('wakeChime') === '1';
var wakeTick = null;
function wakeOn() { return !!(wakeState && wakeState.enabled); }
function wakeArm(on) {
  captureEpoch++;   // synchronous: anything captured before this boundary is stale, whatever the host says later
  wakeHold = false;
  if (!wakeOn() && on) return Promise.resolve();
  var epoch = captureEpoch;
  return postJSON('/wake-arm', { on: !!on }).then(function (r) { return r.json(); })
    .then(function (r) { if (r && r.ok && epoch === captureEpoch) { wakeGen = r.gen || 0; applyWakeState(r.wake); } })
    .catch(function () {});
}
function applyWakeState(w) {
  if (!w) return;
  wakeState = w;
  if (typeof w.gen === 'number') wakeGen = w.gen;
  renderWakeLabel();
  clearInterval(wakeTick); wakeTick = null;
  if (w.until) wakeTick = setInterval(renderWakeLabel, 500);   // the countdown on screen, so the end is visible
}
// What the status line (and the creature badge) says while the wake word is in charge.
function wakeLabelText() {
  if (!wakeOn() || !conversationOpen) return '';
  var w = wakeState, phrase = w.phrase ? w.phrase.replace(/^\w/, function (c) { return c.toUpperCase(); }) : '';
  var left = w.until ? Math.max(0, Math.ceil((w.until - Date.now()) / 1000)) : 0;
  if (w.state === 'not-ready') return 'Wake word not ready: ' + (w.reason || 'no phrase');
  if (wakeHold) return w.state === 'followup' ? 'Follow-up…' : 'Listening…';   // a request began inside the window: no countdown while it is transcribed
  if (w.state === 'waiting') return 'Waiting for "' + phrase + '"';
  if (w.state === 'listening') return 'Listening (' + left + ' s to start)';
  if (w.state === 'followup') return 'Follow-up window (' + left + ' s)';
  if (w.state === 'cooldown') return 'One moment';
  return '';
}
var wakeSrLast = '';
function renderWakeLabel() {
  var text = wakeLabelText();
  var el = $('wakeNote');
  if (el) { el.textContent = text; el.classList.toggle('show', !!text); el.classList.toggle('error', wakeState.state === 'not-ready'); }
  var badge = $('faceWakeBadge');
  if (badge) { badge.textContent = text; badge.classList.toggle('show', !!text && faceMode === 'creature'); }
  // Screen readers hear state changes, not every second of the countdown.
  var sr = text.replace(/\s*\(\d+ s[^)]*\)/, ''), srEl = $('wakeSr');
  if (srEl && sr !== wakeSrLast) { wakeSrLast = sr; srEl.textContent = sr; }
  if (face && wakeOn() && conversationOpen && wakeState.state === 'waiting' && $('status').textContent === 'LISTENING') face.setState('idle');   // waiting looks idle (the face may doze); the label says why
}
// A short two-note chime through the picked speaker when the name is heard. Off by default.
var chimeCtx = null;
function wakeChime() {
  if (!wakeChimeOn || !speakEnabled) return;   // the speaker button mutes the chime too
  try {
    if (!chimeCtx) chimeCtx = new (window.AudioContext || window.webkitAudioContext)();
    var routed = (chimeCtx.setSinkId && spkDeviceId) ? chimeCtx.setSinkId(spkDeviceId).catch(function () {}) : Promise.resolve();
    routed.then(function () {   // the picked speaker is in place before the first note
      var t = chimeCtx.currentTime, g = chimeCtx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      g.connect(chimeCtx.destination);
      [[880, 0], [1320, 0.12]].forEach(function (n) { var o = chimeCtx.createOscillator(); o.type = 'sine'; o.frequency.value = n[0]; o.connect(g); o.start(t + n[1]); o.stop(t + 0.36); });
    });
  } catch (e) {}
}
function wakeReplyEnded(completed) {
  if (!wakeOn()) return;
  postJSON('/wake-reply-end', { completed: completed !== false }).catch(function () {});
}
// Wake word on: the mic opens by itself (the page is already waiting for the name). The mic button is
// then a mute, and a deliberate mute sticks across page switches and reloads until it is tapped again.
function wakeMuted() { try { return localStorage.getItem('cvWakeMuted') === '1'; } catch (e) { return false; } }
function setWakeMuted(on) { try { localStorage.setItem('cvWakeMuted', on ? '1' : '0'); } catch (e) {} }
function wakeAutoOpen() {
  if (wakeOn() && !conversationOpen && !wakeMuted() && vad && !document.hidden && wakeState.state !== 'not-ready') window.oqxToggleConversation(true);
}
window.oqxToggleConversation = function (auto) {
  if (!vad) { $('textInput').focus(); return; }   // VAD script failed to load -- fall back to at least focusing input
  if (auto !== true) setWakeMuted(conversationOpen);   // a human tap: closing it is a mute that sticks; opening clears it
  if (conversationOpen) {
    conversationOpen = false;
    captureEpoch++;   // hard off, at once: in-flight STT results from this capture never send
    vad.stop();
    wakeArm(false);
    setStatus('idle');
  } else {
    conversationOpen = true;
    captureEpoch++;
    var epoch = captureEpoch;
    setStatus('listening');
    ensureDeviceIds().then(function () {
      if (!conversationOpen || epoch !== captureEpoch) return;   // toggled back off while devices were enumerating
      vad.setInputDevice(micDeviceId);
      return wakeArm(true).then(function () {
        if (!conversationOpen || epoch + 1 !== captureEpoch) return;   // muted during arming: capture must not reopen
        return vad.start(onVADSpeechStart, onVADSpeechEnd, onVADLevel);
      });
    }).catch(function (e) {
      conversationOpen = false;
      syncMicUI();
      setStatus('error', 'Microphone access failed: ' + (e && e.message ? e.message : e));
    });
  }
  syncMicUI();
};

// ---- Voice panel (right side): mic + speaker icon toggles, ripples, Project/Settings ----
// The mic icon IS the listening toggle (same action as the knob tap) -- crossed out when off,
// rippling outward when it hears sound. The speaker icon gates the spoken read-back of replies
// (text always renders either way) -- crossed out when off, pulsing while actually speaking.
function syncMicUI() {
  $('micBtn').classList.toggle('on', conversationOpen);
  $('micBtn').classList.toggle('off', !conversationOpen);
  syncFaceBarUI();
}
var speakEnabled = localStorage.getItem('cvSpeakEnabled') !== '0';   // persists across page switches/reloads
function syncSpkUI() {
  $('spkBtn').classList.toggle('on', speakEnabled);
  $('spkBtn').classList.toggle('off', !speakEnabled);
  syncFaceBarUI();
}
$('micBtn').onclick = function () { window.oqxToggleConversation(); };
$('spkBtn').onclick = function () {
  speakEnabled = !speakEnabled;
  localStorage.setItem('cvSpeakEnabled', speakEnabled ? '1' : '0');
  if (!speakEnabled) stopTurnAudio();   // muting mid-reply drops the stream; the server aborts synthesis on the socket close
  syncSpkUI();
};
// Ripples: spawn one expanding ring per level sample above the ripple floor, throttled so a
// sustained voice reads as a steady outward pulse rather than a solid blob.
var lastRippleAt = 0;
function onVADLevel(level) {
  if (!conversationOpen || suppressVAD || !wakeExpectsSpeech()) return;
  var now = Date.now();
  if (level < 0.012 || now - lastRippleAt < 180) return;
  lastRippleAt = now;
  if (face) face.wake();   // someone is talking: a dozing face opens its eyes
  var r = document.createElement('div');
  r.className = 'ripple';
  $('micRipples').appendChild(r);
  r.addEventListener('animationend', function () { r.remove(); });
}
// ---- Change folder overlay ----
// ("Folder", not "project" -- Claude has its own "projects" concept, so the panel never uses that
// word for directories.) Picks restart the session in the chosen directory (fresh conversation; the
// old session file stays resumable from a terminal). One flowing wall of pill chips: recent folders
// first (accent border), then everything under the root alphabetically; the current folder is the
// single solid accent-filled pill.
function baseName(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p; }
function setProjectHeader(dir) {
  $('project').textContent = dir ? baseName(dir) : '(no folder set)';
  $('folderPickVal').textContent = dir ? baseName(dir) : 'not set';
}
var projRoot = '';
function pickProject(dir) {
  $('projectOverlay').classList.add('hidden');
  setStatus('thinking', '');
  postJSON('/session/start', { projectDir: dir })
    .then(function (r) { return r.json(); })
    .then(function (r) { if (!r || !r.ok) setStatus('error', 'Could not start a session in ' + dir); })
    .catch(reachErr);
}
// Loads (or reloads) the overlay listing `browsePath` -- omitted on first open, so the server
// falls back to the page's configured root. Tapping folders (rows or Recent chips) only NAVIGATES
// -- into the folder, ⬆ Up back out -- and the overlay stays open; the single commit action is
// "Use this folder", which starts a session at whatever level is being browsed (the standard
// mobile folder-picker pattern, chosen explicitly by the user 2026-08-12).
function openProjectOverlay(browsePath) {
  var url = BASE + '/projects' + (browsePath ? '?path=' + encodeURIComponent(browsePath) : '');
  fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (p) {
      projRoot = p.root || '';
      $('projPath').textContent = projRoot;
      $('projUp').disabled = !p.parent;
      $('projUp').onclick = function () { if (p.parent) openProjectOverlay(p.parent); };
      $('projUse').onclick = function () { pickProject(projRoot); };
      // Recent row: chips COMMIT -- one tap starts a session in that folder and closes the menu
      // (that's the whole point of recents). Only the main list navigates.
      var recentsRow = $('projRecentsRow');
      recentsRow.querySelectorAll('.projChip').forEach(function (c) { c.remove(); });
      var pathEl = $('projPath');
      (p.recents || []).slice(0, 5).forEach(function (dir) {
        var chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'projChip';
        chip.textContent = baseName(dir); chip.title = dir;
        chip.onclick = function () { pickProject(dir); };
        recentsRow.insertBefore(chip, pathEl);
      });
      // Folder taps NAVIGATE into the folder (so sub-folders are reachable); only the
      // "Use this folder" button actually starts a session, at whatever level is being browsed.
      $('projList').innerHTML = '';
      (p.dirs || []).forEach(function (dir) {
        var row = document.createElement('div');
        row.className = 'projRow' + (dir === p.current ? ' current' : '');
        var name = document.createElement('button');
        name.type = 'button'; name.className = 'projName';
        name.textContent = baseName(dir); name.title = dir;
        name.onclick = function () { openProjectOverlay(dir); };
        row.appendChild(name);
        $('projList').appendChild(row);
      });
      $('projNewName').value = '';
      $('projectOverlay').classList.remove('hidden');
    })
    .catch(function () { setStatus('error', 'Could not load the folder list.'); });
}
// ▲/▼ page buttons for scroll regions -- replaced the custom drag-thumb, which only registered
// ~1 in 5 finger drags on the real panel. Tap = one page; hold = keeps paging every 400ms.
function wireScrollButtons(listId, upId, downId) {
  var list = $(listId);
  function step(dir) { list.scrollBy({ top: dir * list.clientHeight * 0.9, behavior: 'smooth' }); }
  [[upId, -1], [downId, 1]].forEach(function (pair) {
    var btn = $(pair[0]);
    var repeat = null;
    btn.addEventListener('pointerdown', function (e) {
      btn.setPointerCapture(e.pointerId);
      step(pair[1]);
      repeat = setInterval(function () { step(pair[1]); }, 400);
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      btn.addEventListener(ev, function () { clearInterval(repeat); repeat = null; });
    });
  });
}
wireScrollButtons('projList', 'projScrollUp', 'projScrollDown');
wireScrollButtons('devList', 'devScrollUp', 'devScrollDown');
// Folder lives in Settings (rarely changed) — the row closes Settings and opens the folder picker.
$('folderPickBtn').onclick = function () { $('settingsOverlay').classList.add('hidden'); openProjectOverlay(); };
$('projCancel').onclick = function () { $('projectOverlay').classList.add('hidden'); };
$('projCreate').onclick = function () {
  var name = $('projNewName').value.trim();
  if (!name || !projRoot) return;
  if (/[<>:"|?*\\/]/.test(name)) { setStatus(conversationOpen ? 'listening' : 'idle', 'Folder names can\'t contain < > : " | ? * \\ /'); return; }
  pickProject(projRoot.replace(/[\\/]+$/, '') + '\\' + name);
};
$('vpSettings').onclick = function () {
  syncPickButtons();   // labels come from saved options -- no mic grab needed just to open Settings
  $('settingsOverlay').classList.remove('hidden');
};
$('settingsClose').onclick = function () { $('settingsOverlay').classList.add('hidden'); };

// ---- Panel-tunable settings (persisted server-side into the page's options in config.json) ----
function postOption(key, value) {
  postJSON('/option', { key: key, value: String(value) }).catch(function () {});
}
// Chat text size: applies live via the --chatFont CSS var (bubbles only; chrome is unaffected).
var chatFontSize = parseInt(Q.get('chatFontSize'), 10) || 16;
function applyChatFont() {
  chatFontSize = Math.max(12, Math.min(32, chatFontSize));
  document.documentElement.style.setProperty('--chatFont', chatFontSize + 'px');
  $('fontVal').textContent = chatFontSize + ' px';
}
$('fontMinus').onclick = function () { chatFontSize -= 1; applyChatFont(); postOption('chatFontSize', chatFontSize); };
$('fontPlus').onclick = function () { chatFontSize += 1; applyChatFont(); postOption('chatFontSize', chatFontSize); };
// Voice pause tolerance: how long a mid-sentence silence can last before the utterance is sent.
function applyPause() {
  vadHangoverMs = Math.max(400, Math.min(2500, vadHangoverMs));
  if (vad && vad.setHangoverMs) vad.setHangoverMs(vadHangoverMs);
  $('pauseVal').textContent = (vadHangoverMs / 1000).toFixed(1) + ' s';
}
$('pauseMinus').onclick = function () { vadHangoverMs -= 100; applyPause(); postOption('vadHangoverMs', vadHangoverMs); };
$('pausePlus').onclick = function () { vadHangoverMs += 100; applyPause(); postOption('vadHangoverMs', vadHangoverMs); };
applyChatFont();
applyPause();

// ---- Permission mode (Mode button + overlay) ----
// Switching restarts the claude process with --resume + the new --permission-mode (mode is a
// launch-only CLI flag; the mid-session control message is undocumented/unsupported). The
// conversation itself carries over -- expect a ~2s pause before the next turn responds.
// ---- AI profile (Smart Profiles): big-card grid picker, list delivered via meta ----
var PROFILES = [];            // [{id, name}] from meta.profiles
var currentProfileId = '';
function syncProfileUI() {
  var cur = null;
  for (var i = 0; i < PROFILES.length; i++) if (PROFILES[i].id === currentProfileId) cur = PROFILES[i];
  $('vpProfile').textContent = cur ? 'Profile: ' + cur.name : 'Profile';
  $('vpProfile').classList.toggle('hidden', !PROFILES.length);
  document.querySelectorAll('.profileOpt').forEach(function (b) {
    b.classList.toggle('current', b.getAttribute('data-profile') === currentProfileId);
  });
}
function renderProfileGrid() {
  var grid = $('profileGrid');
  grid.innerHTML = '';
  PROFILES.forEach(function (p) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'profileOpt';
    b.setAttribute('data-profile', p.id);
    b.textContent = p.name;
    b.onclick = function () {
      $('profileOverlay').classList.add('hidden');
      if (p.id === currentProfileId) return;
      postJSON('/profile', { id: p.id })
        .then(function (r) { return r.json(); })
        .then(function (r) { if (!r || !r.ok) setStatus(conversationOpen ? 'listening' : 'idle', 'Profile switch failed.'); })
        .catch(reachErr);
    };
    grid.appendChild(b);
  });
  syncProfileUI();
}
$('vpProfile').onclick = function () { renderProfileGrid(); $('profileOverlay').classList.remove('hidden'); };
$('profileCancel').onclick = function () { $('profileOverlay').classList.add('hidden'); };

// ---- Panel Builder review ----
// The Panel Builder profile makes the AI answer with a page rather than prose. The host validates it
// and pushes it here; this draws it as real tiles so what the user sees is what gets saved. Nothing
// reaches the config until Accept — and a panel containing shell/AutoHotkey steps shows the actual
// commands and needs a second, informed yes.
var panelRiskyPending = false;   // true once the risky commands are on screen awaiting confirmation

function showPanelReview(p) {
  var ov = $('panelOverlay');
  if (!p || !p.active) { ov.classList.add('hidden'); panelRiskyPending = false; return; }
  panelRiskyPending = false;
  var warn = $('panelWarn'), risky = $('panelRisky'), grid = $('panelPreview');
  grid.innerHTML = '';

  if (p.status === 'error' || !p.page) {
    $('panelTitle').textContent = "That panel didn't work";
    $('panelNote').textContent = p.error || '';
    risky.classList.add('hidden');
    warn.classList.add('hidden');
    $('panelAccept').style.display = 'none';
    ov.classList.remove('hidden');
    return;
  }

  var page = p.page;
  var used = 0;
  for (var i = 0; i < page.tiles.length; i++) if (page.tiles[i].type) used++;
  $('panelTitle').textContent = page.name;
  $('panelNote').textContent = used + (used === 1 ? ' button' : ' buttons') + ' · ' + page.cols + '×' + page.rows;
  // After a panel has been accepted, the next proposal in the same conversation is almost always a
  // FIX of it ("the tab-1 button does nothing"), so Replace leads and Accept becomes "Add as new".
  var rep = $('panelReplace');
  $('panelAccept').style.display = '';
  if (p.replaces) {
    rep.classList.remove('hidden');
    rep.textContent = 'Replace ' + (p.replaces.name.length > 18 ? p.replaces.name.slice(0, 17) + '…' : p.replaces.name);
    $('panelAccept').textContent = 'Add as new';
    $('panelAccept').classList.add('secondary');
  } else {
    rep.classList.add('hidden');
    $('panelAccept').textContent = 'Accept';
    $('panelAccept').classList.remove('secondary');
  }

  var riskyIdx = {};
  (p.risky || []).forEach(function (r) { riskyIdx[r.index] = true; });
  grid.style.gridTemplateColumns = 'repeat(' + page.cols + ', 1fr)';
  grid.style.gridTemplateRows = 'repeat(' + page.rows + ', 1fr)';
  grid.style.aspectRatio = page.cols + ' / ' + page.rows;   // square cells, like the real panel
  page.tiles.forEach(function (t, idx) {
    var d = document.createElement('div');
    d.className = 'pvTile' + (t.type ? '' : ' empty') + (riskyIdx[idx] ? ' risk' : '');
    if (t.type) {
      var ic = document.createElement('div');
      ic.className = 'pvIcon';
      ic.textContent = t.icon || '▫️';
      var lb = document.createElement('div');
      lb.className = 'pvLabel';
      lb.textContent = t.label || '';
      d.appendChild(ic); d.appendChild(lb);
    }
    grid.appendChild(d);
  });

  if (p.warnings && p.warnings.length) {
    warn.textContent = '· ' + p.warnings.join('; ');
    warn.title = p.warnings.join('\n');       // the header truncates; the full list stays reachable
    warn.classList.remove('hidden');
  } else warn.classList.add('hidden');
  risky.classList.add('hidden');
  ov.classList.remove('hidden');
}

// Second stage for a panel that would run commands: show exactly what runs before asking again.
function showPanelRisky(list) {
  var risky = $('panelRisky');
  risky.innerHTML = '';
  var head = document.createElement('div');
  head.textContent = 'This panel runs commands on your PC. Accept only if you recognize them:';
  risky.appendChild(head);
  list.forEach(function (r) {
    var line = document.createElement('div');
    line.textContent = '• ' + (r.label || 'unnamed') + ' (' + r.type + ')';
    var code = document.createElement('code');
    code.textContent = r.command;
    line.appendChild(code);
    risky.appendChild(line);
  });
  risky.classList.remove('hidden');
  $('panelAccept').textContent = 'Run these — Accept';
  panelRiskyPending = true;
}

function sendPanelAccept(replace) {
  postJSON('/panel-accept', { confirm: panelRiskyPending, replace: !!replace })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      if (r && r.ok) { $('panelOverlay').classList.add('hidden'); panelRiskyPending = false; return; }
      if (r && r.needsConfirm) { panelReplacePending = !!replace; return showPanelRisky(r.risky || []); }
      setStatus(conversationOpen ? 'listening' : 'idle', (r && r.error) || 'That panel could not be added.');
    })
    .catch(reachErr);
}
var panelReplacePending = false;   // which button opened the consent stage, so the second yes matches it
$('panelAccept').onclick = function () { sendPanelAccept(panelRiskyPending ? panelReplacePending : false); };
$('panelReplace').onclick = function () { panelReplacePending = true; sendPanelAccept(true); };
$('panelRetry').onclick = function () {
  // Refinement is just the next thing you say — the session still has the context, so a new reply
  // supersedes this proposal. Close the overlay and reopen the mic.
  $('panelOverlay').classList.add('hidden');
  panelRiskyPending = false;
  if (!conversationOpen && window.oqxToggleConversation) window.oqxToggleConversation();
};
$('panelCancel').onclick = function () {
  $('panelOverlay').classList.add('hidden');
  panelRiskyPending = false;
  fetch(BASE + '/panel-cancel', { method: 'POST', cache: 'no-store' }).catch(function () {});
};

var MODE_LABELS = { manual: 'Manual', acceptEdits: 'Accept edits', plan: 'Plan', bypassPermissions: 'Full auto' };
var currentMode = '';
function syncModeUI() {
  $('vpMode').textContent = currentMode ? 'Mode: ' + (MODE_LABELS[currentMode] || currentMode) : 'Mode';
  document.querySelectorAll('.modeOpt').forEach(function (b) {
    b.classList.toggle('current', b.getAttribute('data-mode') === currentMode);
  });
}
$('vpMode').onclick = function () { syncModeUI(); $('modeOverlay').classList.remove('hidden'); };
$('modeCancel').onclick = function () { $('modeOverlay').classList.add('hidden'); };
// One wiring path for both the markup's fallback buttons and the meta-built ones (applyMeta).
function wireModeOpt(btn) {
  btn.onclick = function () {
    var mode = btn.getAttribute('data-mode');
    $('modeOverlay').classList.add('hidden');
    if (!mode || mode === currentMode) return;
    postJSON('/permission-mode', { mode: mode })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r || !r.ok) setStatus(conversationOpen ? 'listening' : 'idle', 'Mode switch failed — is a session running yet? (Send a message first.)');
      })
      .catch(reachErr);
  };
}
document.querySelectorAll('.modeOpt').forEach(wireModeOpt);

syncMicUI();
syncSpkUI();
syncModeUI();
syncPickButtons();

// Page load with the wake word on: open the mic once the state is known (the /state fetch fills wakeState).
setTimeout(wakeAutoOpen, 600);
