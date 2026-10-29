'use strict';
// system-audio-capture.js
//
// RENDERER. Framework-agnostic capture of local mic + system (speaker) audio,
// merged into a single 2-channel stream and delivered as interleaved int16 PCM.
// Requires the main process to have registered the loopback display-media
// handler for this window's session — see loopback-audio.js.
//
//   Channel 0 = microphone   ("you")
//   Channel 1 = system audio (everyone else / whatever the speakers play)
//
// Plain-JS port of the handoff system-audio-capture.ts (types stripped). Exposed
// as window.SystemAudioCapture. Default output rate 16000 (STT-friendly); the
// meeting recorder runs at 16000 for a 16 kHz stereo WAV (mic=L, system=R).
//
// options:
//   sampleRate            output rate of the merged PCM. Default 16000.
//   bufferSize            PCM processing block size (frames). Default 4096.
//   echoGate              mute mic while speakers are loud AND on speakers
//                         (not headphones). Default true. The recorder sets
//                         this false for faithful capture.
//   systemGateThreshold   RMS above which system audio counts as "playing".
//   micConstraints        getUserMedia audio constraints for the mic.
//   onPcm(pcm, meta)      REQUIRED. Interleaved stereo int16 [mic0,sys0,...].
//                         Buffer is reused — copy it if retained past the call.
//   onSourceEnded()       fired once if the shared source ends (Stop sharing).
//   onError(err)          non-fatal error reporting.
// meta = { micRms, systemRms, micGated }.

const HEADPHONE_PATTERNS = [
  'headphone', 'airpod', 'earpod', 'earphone', 'earbud',
  'bluetooth', 'bt_', 'jabra', 'bose', 'sony wh', 'sony wf',
];

// Best-effort: is the default audio output a headset (so echo bleed is a
// non-issue and the mic never needs gating)? Label-based heuristic.
async function usingHeadphones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const def = devices.find(d => d.kind === 'audiooutput' && d.deviceId === 'default');
    const label = (def && def.label ? def.label : '').toLowerCase();
    return HEADPHONE_PATTERNS.some(p => label.includes(p));
  } catch (e) {
    return false;
  }
}

class SystemAudioCapture {
  constructor(options) {
    this.state = 'idle';
    this.gen = 0;              // bumped by stop(); lets an in-flight start() detect it was cancelled
    this.micStream = null;
    this.systemStream = null;
    this.audioCtx = null;
    this.processor = null;
    this.endedHandler = null;
    this.opts = {
      sampleRate: options.sampleRate != null ? options.sampleRate : 16000,
      bufferSize: options.bufferSize != null ? options.bufferSize : 4096,
      echoGate: options.echoGate != null ? options.echoGate : true,
      systemGateThreshold: options.systemGateThreshold != null ? options.systemGateThreshold : 0.005,
      onPcm: options.onPcm,
      micConstraints: options.micConstraints,
      onSourceEnded: options.onSourceEnded,
      onError: options.onError,
    };
  }

  isRunning() {
    return this.state === 'running';
  }

  // Acquire both streams, wire up the merge graph, and begin emitting PCM.
  // Resolves once capture is live. Throws if mic or system audio is denied —
  // any partially-acquired resource is cleaned up before throwing.
  async start() {
    if (this.state !== 'idle') return;
    this.state = 'starting';
    const gen = ++this.gen;

    const micAudio = this.opts.micConstraints || {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    // A named mic is asked for with `deviceId: { exact }` (an `ideal` id makes Chromium open the
    // Windows default instead). If that device can't be opened (unplugged, not readable), record
    // from the system default rather than failing the recording; a permission error still fails.
    const openMic = async () => {
      try { return await navigator.mediaDevices.getUserMedia({ audio: micAudio }); }
      catch (e) {
        const n = e && e.name;
        if (!(micAudio && micAudio.deviceId) || n === 'NotAllowedError' || n === 'SecurityError') throw e;
        const plain = Object.assign({}, micAudio); delete plain.deviceId;
        this.micFellBack = true;
        return navigator.mediaDevices.getUserMedia({ audio: plain });
      }
    };
    this.micFellBack = false;
    const results = await Promise.allSettled([
      usingHeadphones(),
      openMic(),
      (async () => {
        // Ask for video too (Electron requires it), then discard it — we only
        // want the loopback audio track the main-process handler attaches.
        const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        stream.getVideoTracks().forEach(t => t.stop());
        if (stream.getAudioTracks().length === 0) {
          stream.getTracks().forEach(t => t.stop());
          throw new Error('getDisplayMedia returned no audio track — is the loopback handler registered on this session?');
        }
        // macOS: without the "System Audio Recording Only" permission (or the Info.plist usage string)
        // Chromium still hands back an audio track — created already 'ended', never delivering a
        // sample. Fail loudly instead of recording a silent right channel.
        if (stream.getAudioTracks()[0].readyState === 'ended') {
          stream.getTracks().forEach(t => t.stop());
          throw new Error('SYSTEM_AUDIO_DENIED: system audio is blocked — on macOS allow Bedrock Panel under System Settings → Privacy & Security → Screen & System Audio Recording (System Audio Recording Only), then start the recording again.');
        }
        return stream;
      })(),
    ]);
    const headphoneRes = results[0];
    const micRes = results[1];
    const systemRes = results[2];

    if (micRes.status === 'rejected' || systemRes.status === 'rejected') {
      // Roll back whatever succeeded so we never leak a live mic/loopback.
      if (micRes.status === 'fulfilled') micRes.value.getTracks().forEach(t => t.stop());
      if (systemRes.status === 'fulfilled') systemRes.value.getTracks().forEach(t => t.stop());
      this.state = 'idle';
      throw micRes.status === 'rejected' ? micRes.reason : systemRes.reason;
    }

    // stop() may have run while the mic/loopback grants were still in flight. It found every
    // field below still null and tore down nothing, so without this check the capture would go
    // live AFTER being stopped — unreferenced, unstoppable, and streaming PCM into whatever
    // recording starts next. Release the streams and stay idle instead.
    if (gen !== this.gen) {
      micRes.value.getTracks().forEach(t => t.stop());
      systemRes.value.getTracks().forEach(t => t.stop());
      this.state = 'idle';
      return;
    }

    const headphones = headphoneRes.status === 'fulfilled' ? headphoneRes.value : false;
    this.micStream = micRes.value;
    this.systemStream = systemRes.value;

    // Auto-stop when the shared source goes away. On Windows/Linux the track
    // fires "ended"; our own stop() calls track.stop() which does NOT fire
    // "ended", so this won't double-trigger on a manual stop.
    const sysTrack = this.systemStream.getAudioTracks()[0];
    this.endedHandler = () => { if (this.opts.onSourceEnded) this.opts.onSourceEnded(); };
    sysTrack.addEventListener('ended', this.endedHandler);

    // A silent sink keeps the rendering clock running without opening the speakers.
    // No destination connection is needed: the worklet receives the two live inputs.
    try {
      const audioCtx = new AudioContext({ sampleRate: this.opts.sampleRate, sinkId: { type: 'none' } });
      this.audioCtx = audioCtx;
      if (!audioCtx.sinkId || audioCtx.sinkId.type !== 'none') throw new Error('silent audio sink unavailable');
      await audioCtx.audioWorklet.addModule('/recorder-audio-worklet.js');
      if (gen !== this.gen) return; // stop() already closed the context and tracks
      const micSource = audioCtx.createMediaStreamSource(this.micStream);
      const systemSource = audioCtx.createMediaStreamSource(this.systemStream);
      const merger = audioCtx.createChannelMerger(2);
      micSource.connect(merger, 0, 0);
      systemSource.connect(merger, 0, 1);
      const processor = new AudioWorkletNode(audioCtx, 'recorder-pcm', {
        numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2,
        channelCountMode: 'explicit', channelInterpretation: 'discrete',
        processorOptions: { echoGate: this.opts.echoGate && !headphones, threshold: this.opts.systemGateThreshold, bufferSize: this.opts.bufferSize },
      });
      this.processor = processor;
      processor.port.onmessage = e => {
        if (gen !== this.gen) return;
        try { this.opts.onPcm(new Int16Array(e.data.pcm), e.data.meta); }
        catch (err) { if (this.opts.onError) this.opts.onError(err); }
      };
      processor.onprocessorerror = () => { if (this.opts.onError) this.opts.onError(new Error('recorder audio processor failed')); };
      merger.connect(processor);
    } catch (err) {
      if (gen !== this.gen) return; // a stopped or superseded start owns nothing now
      this.stop();
      throw err;
    }

    this.state = 'running';
  }

  // Tear down all capture. Safe to call multiple times / from any state.
  stop() {
    this.gen++;                      // cancels a start() still awaiting its device grants
    if (this.state === 'idle') return;
    this.state = 'stopping';

    if (this.processor) {
      this.processor.port.onmessage = null;
      this.processor.onprocessorerror = null;
      this.processor.port.close();
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    if (this.systemStream) {
      const t = this.systemStream.getAudioTracks()[0];
      if (t && this.endedHandler) t.removeEventListener('ended', this.endedHandler);
      this.systemStream.getTracks().forEach(tr => tr.stop());
      this.systemStream = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach(tr => tr.stop());
      this.micStream = null;
    }
    this.endedHandler = null;
    this.state = 'idle';
  }
}

if (typeof window !== 'undefined') window.SystemAudioCapture = SystemAudioCapture;
