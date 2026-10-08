'use strict';
// Voice-activity detection for the tap-to-toggle conversation. Deliberate implementation choice
// (documented per the plan's "spike @ricky0123/vad-web, energy-threshold as fallback" item): this
// ships the zero-dependency RMS-energy-with-hangover approach as the actual v1, not the Silero/WASM
// library. Reasoning: a WASM+AudioWorklet library's compatibility inside an Electron <webview> guest
// specifically (not a normal top-level tab, which is what it's usually deployed in) is a real
// unknown that can only be fully verified with a human mic present anyway -- same as this approach.
// Given that, the dependency-free path is the one that's actually finishable and testable without
// the user here, and it can be swapped later without touching any other file (this module's public
// shape -- start(onSpeechStart, onSpeechEnd) / stop() -- is exactly what a Silero-based
// implementation would also expose).
//
// Output format: 16-bit PCM, mono, 16kHz -- matches Wyoming STT's native rate (see
// claudevoice-wyoming.js's header comment), so the server never has to resample.

function createVAD(opts) {
  opts = opts || {};
  const SAMPLE_RATE = 16000;
  const threshold = opts.threshold || 0.02;        // RMS amplitude above which audio counts as speech
  let hangoverMs = opts.hangoverMs || 800;          // sustained silence before an utterance is considered over (user-tunable)
  // Measured as VOICED time (20ms frames above the threshold), not wall-clock: the wall-clock span
  // always includes the hangover, so a lone click or knock used to clear any minimum and reach
  // Whisper, which hallucinates a stock phrase ("Thank you.") for it.
  // 100ms rejects clicks and knocks (under ~60ms voiced) but keeps a soft one-syllable "yes" or "no".
  const minSpeechMs = opts.minSpeechMs || 100;      // ignore blips with less voiced audio than this (taps, clicks, knocks)
  const TAIL_MIN_MS = 40;   // a force-cut utterance's tail ships with less, but not with none (that is only noise)
  // 0 = off (the voice pages' behavior). When set, a continuous speaker who never pauses gets
  // force-cut at this duration — the utterance ships and capture continues seamlessly — so live
  // translation can't stall waiting for a pause that never comes.
  const maxUtteranceMs = opts.maxUtteranceMs || 0;
  const bufferSize = 4096;
  const FRAME = SAMPLE_RATE / 50;   // 20ms -- the unit voiced time is counted in (a buffer is 256ms)

  let stream = null, audioCtx = null, source = null, processor = null, silentGain = null;
  let speaking = false, speechStartedAt = 0, hangoverTimer = null;
  let chunks = [];   // Float32Array pieces captured since the current utterance began
  let voicedSamples = 0;   // samples in above-threshold frames since the current utterance began
  let continued = false;   // this utterance is the tail of a force-cut one -- held to TAIL_MIN_MS only
  let gen = 0;             // bumped by every start() and stop(): a start() that a stop() overtook stands down
  let inputDeviceId = '';   // '' = system default; set via setInputDevice() before start()

  function rms(float32) {
    let sum = 0;
    for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
    return Math.sqrt(sum / float32.length);
  }
  function countVoiced(float32) {
    let n = 0;
    for (let i = 0; i < float32.length; i += FRAME) {
      const end = Math.min(i + FRAME, float32.length);
      let sum = 0;
      for (let j = i; j < end; j++) sum += float32[j] * float32[j];
      if (Math.sqrt(sum / (end - i)) >= threshold) n += end - i;
    }
    return n;
  }
  function voicedMs() { return voicedSamples * 1000 / SAMPLE_RATE; }
  function capture(data) {
    chunks.push(new Float32Array(data));   // copy -- `data` is a reused buffer, would be clobbered next callback
    voicedSamples += countVoiced(data);
  }
  function toPCM16(float32Chunks) {
    let total = 0; for (const c of float32Chunks) total += c.length;
    const out = new Int16Array(total);
    let o = 0;
    for (const c of float32Chunks) {
      for (let i = 0; i < c.length; i++) {
        const s = Math.max(-1, Math.min(1, c[i]));
        out[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    return out;
  }

  // onLevel(rms) fires on every audio buffer (~4 times/second) regardless of speech state -- it
  // drives the mic visualizer's ripples, which should react to ANY sound the mic hears, not just
  // audio that crosses the utterance threshold.
  async function start(onSpeechStart, onSpeechEnd, onLevel) {
    // deviceId as `ideal`, never `exact`: if the picked mic was unplugged, fall back to the system
    // default rather than failing the whole conversation toggle.
    const audio = { channelCount: 1, sampleRate: SAMPLE_RATE };
    if (inputDeviceId) audio.deviceId = { ideal: inputDeviceId };
    const mine = ++gen;
    const opened = await navigator.mediaDevices.getUserMedia({ audio });
    // stop() ran while the mic was opening: release it rather than start an orphan capture.
    if (mine !== gen) { try { opened.getTracks().forEach(t => t.stop()); } catch (e) {} return; }
    stream = opened;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    // A suspended context delivers no audio at all, silently. One started without a user gesture can
    // come up that way (LucidType's hidden capture window starts from a hotkey/main-process command).
    // resume() stays pending while the browser refuses, so it is capped: start() carries on and
    // info().state says 'suspended' rather than start() hanging.
    if (audioCtx.state === 'suspended') {
      try { await Promise.race([audioCtx.resume(), new Promise(r => setTimeout(r, 500))]); } catch (e) {}
      if (mine !== gen) return;   // stop() ran during the wait and already released both
    }
    source = audioCtx.createMediaStreamSource(stream);
    processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    // ScriptProcessorNode needs a path to the destination to fire reliably in some engines; route
    // through a silent (gain=0) node so the raw mic is never actually audible (no feedback/echo).
    silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    processor.onaudioprocess = e => {
      const data = e.inputBuffer.getChannelData(0);
      const level = rms(data);
      if (onLevel) { try { onLevel(level); } catch (err) {} }
      if (level >= threshold) {
        if (!speaking) {
          speaking = true;
          speechStartedAt = Date.now();
          chunks = [];
          voicedSamples = 0;
          continued = false;
          if (onSpeechStart) onSpeechStart();
        }
        clearTimeout(hangoverTimer);
        hangoverTimer = null;
        capture(data);
        if (maxUtteranceMs && Date.now() - speechStartedAt >= maxUtteranceMs) {
          const captured = chunks; chunks = [];   // force-cut mid-speech: ship it, keep capturing
          voicedSamples = 0;
          continued = true;
          speechStartedAt = Date.now();
          if (onSpeechEnd) onSpeechEnd(toPCM16(captured));
        }
      } else if (speaking && !hangoverTimer) {
        capture(data);   // keep a little trailing silence too, cheap and harmless
        hangoverTimer = setTimeout(() => {
          hangoverTimer = null;
          speaking = false;
          const enough = voicedMs() >= (continued ? Math.min(TAIL_MIN_MS, minSpeechMs) : minSpeechMs);
          const captured = chunks; chunks = [];
          if (enough && onSpeechEnd) onSpeechEnd(toPCM16(captured));
        }, hangoverMs);
      } else if (speaking) {
        capture(data);
      }
    };
  }

  function stop() {
    gen++;
    clearTimeout(hangoverTimer); hangoverTimer = null;
    speaking = false; chunks = [];
    try { if (processor) processor.disconnect(); } catch (e) {}
    try { if (silentGain) silentGain.disconnect(); } catch (e) {}
    try { if (source) source.disconnect(); } catch (e) {}
    try { if (audioCtx) audioCtx.close(); } catch (e) {}
    try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    stream = audioCtx = source = processor = silentGain = null;
  }

  // Live-tunable pause tolerance (the settings overlay's "Voice pause tolerance" stepper): the
  // hangover closure reads the current value on every silence check, so this applies immediately.
  function setHangoverMs(ms) { ms = parseInt(ms, 10); if (ms > 0) hangoverMs = ms; }
  // Mic pick from the settings overlay; takes effect on the next start() (the caller restarts a
  // live conversation itself so the change applies immediately).
  function setInputDevice(id) { inputDeviceId = id || ''; }

  // What start() actually opened, for diagnostics: the device label the OS reports, the context's
  // state and rate, and the level speech has to reach.
  function info() {
    const track = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
    return { label: (track && track.label) || '', state: audioCtx ? audioCtx.state : 'closed',
      sampleRate: audioCtx ? audioCtx.sampleRate : 0, threshold };
  }

  return { start, stop, setHangoverMs, setInputDevice, info };
}

window.createClaudeVoiceVAD = createVAD;
