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
  targetSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      // A video source is mandatory in the callback even for audio-only capture.
      // The renderer throws this track away; it exists only to satisfy the API.
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (sources.length === 0) {
        callback({});
        return;
      }
      callback({ video: sources[0], audio: 'loopback' });
    } catch (err) {
      if (options.onError) options.onError(err);
      callback({});
    }
  });
}

module.exports = { enableLoopbackAudioCapture };
