'use strict';
/*
 * nativeHelpers.js — one table for every bundled native helper: which binary serves a feature on
 * which platform. Windows helpers are the C# executables from build-smtc.js; macOS helpers are the
 * Swift binaries from build-mac-helpers.js under app/native/mac. Paths resolve next to this file and
 * are rewritten for the packaged app (asar -> asar.unpacked, where electron-builder puts them).
 *
 * `helperPath(name)` returns null when the platform has no helper for that feature; callers treat
 * that exactly like a missing binary (the feature reports itself unavailable), so every former
 * `process.platform !== 'win32'` guard is now just `!HELPER`. Pure so it unit-tests without Electron.
 */
const path = require('path');

const HELPERS = {
  nowplayingMonitor: { win32: 'smtc-monitor.exe',        darwin: path.join('mac', 'nowplaying-monitor') },
  nowplayingControl: { win32: 'smtc-control.exe',        darwin: path.join('mac', 'nowplaying-control') },
  nowplayingArt:     { win32: 'smtc-art.exe' },
  sysvolume:         { win32: 'sysvolume.exe',           darwin: path.join('mac', 'sysvolume') },
  micSessionMonitor: { win32: 'mic-session-monitor.exe', darwin: path.join('mac', 'mic-session-monitor') },
  foregroundWatch:   { win32: 'foreground-watch.exe',    darwin: path.join('mac', 'foreground-watch') },
  outlookMeeting:    { win32: 'outlook-meeting.exe',   darwin: path.join('mac', 'calendar-meeting') },   // classic Outlook (COM) / macOS Calendar (EventKit): same argv and JSON
  reservedDisplay:   { win32: 'reserved-display.exe',     darwin: path.join('mac', 'reserved-display') },
  displayArrange:    {                                     darwin: path.join('mac', 'display-arrange') },   // panel display far right, never mirrored/main
  privacy:           {                                     darwin: path.join('mac', 'privacy') },           // TCC preflight/request (Input Monitoring, Screen Recording)
  speechServer:      {                                     darwin: path.join('mac', 'speech-server') },     // built-in macOS STT/TTS as a local Wyoming server
};

function helperPath(name, platform = process.platform, dir = path.join(__dirname, 'native')) {
  const entry = HELPERS[name];
  const file = entry && entry[platform];
  if (!file) return null;
  return path.join(dir, file).replace('app.asar', 'app.asar.unpacked');
}

module.exports = { helperPath, HELPERS };
