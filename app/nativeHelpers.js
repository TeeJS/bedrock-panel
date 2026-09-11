'use strict';
/*
 * nativeHelpers.js — one table for every bundled native helper: which binary serves a feature on
 * which platform. Windows helpers are the C# executables from build-smtc.js; macOS helpers are the
 * Swift binaries from build-mac-helpers.js under app/native/mac; Linux helpers are the Python
 * scripts under app/linux, which need no build step and are executable in place. Paths resolve next
 * to this file and are rewritten for the packaged app (asar -> asar.unpacked, where
 * electron-builder puts them).
 *
 * `helperPath(name)` returns null when the platform has no helper for that feature; callers treat
 * that exactly like a missing binary (the feature reports itself unavailable), so every former
 * `process.platform !== 'win32'` guard is now just `!HELPER`. Pure so it unit-tests without Electron.
 */
const path = require('path');

// Linux helpers live beside the other app/linux scripts rather than under native/, because they are
// not built artifacts -- ../linux is the same tree the uinput and portal helpers live in.
const LINUX = name => path.join('..', 'linux', name);

const HELPERS = {
  nowplayingMonitor: { win32: 'smtc-monitor.exe',        darwin: path.join('mac', 'nowplaying-monitor'), linux: LINUX('mpris.py') },
  nowplayingControl: { win32: 'smtc-control.exe',        darwin: path.join('mac', 'nowplaying-control'), linux: LINUX('mpris.py') },
  nowplayingArt:     { win32: 'smtc-art.exe' },          // Linux needs none: MPRIS carries the art URL
  sysvolume:         { win32: 'sysvolume.exe',           darwin: path.join('mac', 'sysvolume'), linux: LINUX('sysvolume.py') },
  micSessionMonitor: { win32: 'mic-session-monitor.exe', darwin: path.join('mac', 'mic-session-monitor'), linux: LINUX('mic-monitor.py') },
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

/**
 * How to actually run a helper: `{ command, args }` to put in front of the caller's own arguments.
 *
 * The Windows and macOS helpers are executables and run themselves. The Linux ones are Python, and
 * they are run as `python3 <script>` rather than executed through their shebang -- which is how every
 * other Linux helper in this app is already launched, and those work. The now-playing helper was the
 * one exception: executed directly, it ran and wrote continuously while the app's stream for it
 * reported readable, flowing, one listener, and bytesRead=0 forever. Same script, same app, and the
 * only difference from its working siblings was this. Running it the same way as the rest also drops
 * the dependency on an executable bit surviving packaging.
 */
function helperCommand(name, platform = process.platform, dir = path.join(__dirname, 'native')) {
  const file = helperPath(name, platform, dir);
  if (!file) return null;
  return file.endsWith('.py') ? { command: 'python3', args: [file] } : { command: file, args: [] };
}

module.exports = { helperPath, helperCommand, HELPERS };
