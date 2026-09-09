'use strict';
// loopback-audio.js
//
// MAIN PROCESS. Call this once for every Electron `session` whose renderer will
// request system (speaker) audio via getDisplayMedia({ audio: true }).
//
// Electron requires a *video* source to be offered even when the caller only
// wants audio, so we hand back the first screen source and rely on the renderer
// to immediately drop the video track. `audio: 'loopback'` is what tells
// Chromium to capture the OS render-endpoint loopback:
//   - Windows  -> WASAPI loopback of the default render device (no native code)
//   - macOS    -> CoreAudio tap (Electron >= 39, macOS 14.2+; "System Audio Recording Only"
//                 permission). Needs NSAudioCaptureUsageDescription in Info.plist or the track is
//                 silently dead: Electron's own dev binary carries it, the packaged app gets it from
//                 build.mac.extendInfo. The video source we return also triggers the Screen Recording
//                 prompt on the first recording; denying that only blanks the discarded video track.
//   - Linux    -> PulseAudio/PipeWire monitor of the default sink
//
// This auto-approves the request with NO user picker. That is exactly what you
// want for a trusted first-party capture (meeting recorder), but it means any
// page loaded in this session can grab system audio silently — only register it
// on sessions you control, never on one that loads arbitrary third-party web
// content. (Plain-JS port of the handoff loopback-audio.main.ts.)

const { desktopCapturer } = require('electron');

/**
 * Register an auto-approving display-media handler that routes system audio as
 * loopback. Idempotent per session (Electron only keeps the last handler set).
 * options.onError(err) is called for logging/telemetry only; the request is
 * denied (callback({})) either way when sources can't be enumerated.
 */
function enableLoopbackAudioCapture(targetSession, options) {
  options = options || {};
  // Denying: Electron 44 rejects `callback({})` with a TypeError (an unhandled rejection inside the
  // handler, which surfaced as the "unexpected background error" dialog on macOS when Screen Recording
  // was not granted yet); `callback(null)` is the documented rejection.
  const deny = callback => { try { callback(null); } catch (e) { try { callback(); } catch (e2) {} } };
  targetSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      // A video source is mandatory in the callback even for audio-only capture.
      // The renderer throws this track away; it exists only to satisfy the API.
      // macOS: the requesting frame itself is a valid video source (tab capture, no permission), and
      // Electron >= 39 on macOS 14.2+ takes loopback audio from a CoreAudio tap (the "System Audio
      // Recording Only" permission) independently of the video source — so no Screen Recording grant
      // is needed for an audio-only recording. desktopCapturer.getSources, which does need Screen
      // Recording, stays as the fallback when no frame is available.
      if (process.platform === 'darwin' && request && request.frame) {
        callback({ video: request.frame, audio: 'loopback' });
        return;
      }
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (sources.length === 0) {
        if (options.onError) options.onError(new Error('no screen source available' + (process.platform === 'darwin' ? ' — Screen Recording permission is needed (System Settings → Privacy & Security → Screen & System Audio Recording)' : '')));
        deny(callback);
        return;
      }
      callback({ video: sources[0], audio: 'loopback' });
    } catch (err) {
      // desktopCapturer rejects with a bare string ("Failed to get sources") when macOS refuses
      // screen access; hand the logger a real Error either way.
      const e = err instanceof Error ? err : new Error(String(err));
      if (process.platform === 'darwin' && /get sources|not permitted|denied/i.test(e.message)) e.message += ' — Screen Recording permission is needed (System Settings → Privacy & Security → Screen & System Audio Recording)';
      if (options.onError) options.onError(e);
      deny(callback);
    }
  });
}

module.exports = { enableLoopbackAudioCapture };
