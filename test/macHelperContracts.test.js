'use strict';
// The JS wrappers drive CAPTURED helper output, so the suite passes even if a Swift helper drifts from
// the contract the JS depends on. These assertions are the only link between the wrappers and the
// macOS helper sources — the same idea as the C# checks in meetingDefaultsSync.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = name => fs.readFileSync(path.join(__dirname, '..', 'native', 'mac', name), 'utf8');

test('mic-session-monitor emits the whole matching set as verbatim allowlist tokens, with no baseline line', () => {
  const s = src('mic-session-monitor.swift');
  assert.match(s, /"apps": apps/, 'the emitted JSON must carry the apps array app/micMonitorRouting.js reads');
  assert.match(s, /allow\.filter \{ matched\.contains\(\$0\.lowercased\(\)\) \}/, 'apps[] must be the caller\'s own tokens, verbatim, in allowlist order');
  assert.match(s, /active != lastActive \|\| now != lastApps/, 'the transition test must compare the whole set, not just the first match');
  assert.match(s, /if active \{ row\["app"\] = apps\[0\] \}/, '"app" stays the first match for older readers only');
  assert.doesNotMatch(s, /Out\.line\(Out\.json\(\["active": false/, 'no synthetic idle baseline: it reads as call-ended and splits recordings');
  assert.match(s, /exitWhenOrphaned/, 'spawned with stdin ignored, so the parent-death guard is the re-parenting check');
});

test('nowplaying-monitor speaks the smtc-monitor contract: status literals, both players, "{}" when idle', () => {
  const s = src('nowplaying-monitor.swift');
  for (const lit of ['"Playing"', '"Paused"', '"Stopped"']) assert.match(s, new RegExp(lit.replace(/"/g, '\\"')), lit + ' is compared verbatim by app/musicview.js');
  assert.match(s, /com\.spotify\.client\.PlaybackStateChanged/);
  assert.match(s, /com\.apple\.Music\.playerInfo/);
  assert.match(s, /com\.apple\.iTunes\.playerInfo/);
  for (const key of ['"title"', '"artist"', '"album"', '"status"', '"app"', '"position"', '"duration"', '"bundleId"']) assert.match(s, new RegExp(key.replace(/"/g, '\\"')), key + ' is a field app/nowplaying.js reads');
  assert.match(s, /var line = "\{\}"/, '"{}" means no media session');
  assert.match(s, /exitOnStdinEOF/, 'spawned with stdin piped');
});

test('sysvolume keeps the integer-line contract and -1 for no control', () => {
  const s = src('sysvolume.swift');
  assert.match(s, /return -1/);
  assert.match(s, /Out\.line\(String\(v\)\)/);
  assert.match(s, /exitOnStdinEOF/);
});

test('foreground-watch keeps the PascalCase rows and OK/NOTFOUND words', () => {
  const s = src('foreground-watch.swift');
  for (const key of ['"Hwnd"', '"ProcessName"', '"MainWindowTitle"', '"Minimized"']) assert.match(s, new RegExp(key.replace(/"/g, '\\"')), key + ' is read by app/desktopFocus.js');
  assert.match(s, /Out\.line\("OK"\)/);
  assert.match(s, /Out\.line\("NOTFOUND"\)/);
});

test('nowplaying-control prints "ok" and only addresses running players', () => {
  const s = src('nowplaying-control.swift');
  assert.match(s, /print\("ok", terminator: ""\)/);
  assert.match(s, /isRunning\(p\.bundleId\) \? p\.bundleId : nil/, 'an AppleScript tell would launch a player that is not running');
});

test('the Windows aliases cover the shipped meeting defaults', () => {
  const s = src('lib/Common.swift');
  const defaults = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8').match(/recordApps: '([^']+)'/)[1].split(',');
  for (const token of defaults) {
    const key = token.replace(/\.exe$/i, '').toLowerCase();
    assert.match(s, new RegExp('"' + key.replace(/[-]/g, '\\-') + '": \\['), 'meeting default ' + token + ' has no macOS bundle-id alias');
  }
});

test('reserved-display takes the Windows helper\'s commands and emits the events the controller logs', () => {
  const s = src('reserved-display.swift');
  for (const field of ['command', 'sequence', 'enabled', 'suspended', 'ownProcessId', 'reserved', 'displays']) assert.match(s, new RegExp('var ' + field), 'configure field ' + field);
  assert.match(s, /c\.command == "stop"/);
  for (const ev of ['"ready"', '"configured"', '"moved"', '"minimized"', '"restored"', '"permission"']) assert.match(s, new RegExp('emit\\(' + ev.replace(/"/g, '\\"')), 'event ' + ev);
  assert.match(s, /"fallback": how/, 'moved events name the placement fallback like the Windows helper');
  assert.match(s, /buttonState\(\.combinedSessionState, button: \.left\)/, 'never moves a window mid-drag');
  assert.match(s, /AXIsProcessTrusted\(\)/, 'reports the Accessibility permission instead of failing silently');
});

test('privacy drives the CoreGraphics TCC calls the wrapper relies on and prints {"granted"}', () => {
  const s = src('privacy.swift');
  for (const fn of ['CGPreflightListenEventAccess', 'CGRequestListenEventAccess', 'CGPreflightScreenCaptureAccess', 'CGRequestScreenCaptureAccess']) assert.match(s, new RegExp(fn + '\\(\\)'), fn);
  assert.match(s, /\["granted": granted\]/, 'app/macPermissions.js reads the granted field');
  assert.match(s, /"preflight", "request"/);
  assert.match(s, /"listenEvent", "screenCapture"/);
});

test('display-arrange keeps DK-Suite\'s display_manager policy and exit codes', () => {
  const s = src('display-arrange.swift');
  assert.match(s, /CGConfigureDisplayOrigin/, 'moves the panel display');
  assert.match(s, /CGConfigureDisplayMirrorOfDisplay\(cfg, panel\.id, kCGNullDirectDisplay\)/, 'un-mirrors the panel display');
  assert.match(s, /CGCompleteDisplayConfiguration\(cfg, \.permanently\)/, 'the arrangement persists like a System Settings change');
  assert.match(s, /if mirrored \{ return 2 \}/, 'exit 2 = mirrored (DK-Suite)');
  assert.match(s, /if panelIsMain \|\| !farRight \{ return 3 \}/, 'exit 3 = position or main-display fix (DK-Suite)');
  assert.match(s, /guard panel != nil else \{ return 4 \}/, 'exit 4 = no panel display (app/displayArrange.js EXIT.NO_PANEL)');
  assert.match(s, /o\["changed"\] = c/, 'fix output carries the changed list the log shows');
  for (const key of ['"mirrored"', '"panelIsMain"', '"farRight"', '"valid"', '"code"']) assert.match(s, new RegExp(key.replace(/"/g, '\\"')), key + ' is a field app/displayArrange.js reads');
  assert.match(s, /panelVendor: UInt32 = 0x09E5/, 'the DK-QUAKE EDID vendor id');
  assert.doesNotMatch(s, /CGConfigureDisplayWithDisplayMode|CGDisplaySetDisplayMode/, 'never changes resolution or rotation');
});

test('speech-server speaks the Wyoming events the client sends and asks for speech recognition lazily', () => {
  const s = src('speech-server.swift');
  for (const ev of ['"describe"', '"transcribe"', '"audio-start"', '"audio-chunk"', '"audio-stop"', '"synthesize"']) assert.match(s, new RegExp('case ' + ev.replace(/"/g, '\\"')), 'handles ' + ev);
  for (const reply of ['send("transcript"', 'send("audio-start"', 'send("audio-chunk"', 'send("audio-stop"', 'send("info"']) assert.ok(s.includes(reply), 'replies with ' + reply);
  assert.match(s, /"data_length"/, 'data is externalized the way real Wyoming servers do (app/claudevoice-wyoming.js reads both forms)');
  assert.match(s, /requiresOnDeviceRecognition = onDevice/, 'on-device recognition when the language supports it');
  assert.match(s, /isDictationDisabled\(e\), onDevice\(r\)/, 'with Dictation off (error 1101) the request is retried through Apple\'s servers');
  assert.match(s, /"code": "dictation-off"/, 'app/macSpeech.js shows the Dictation setting from this status');
  assert.doesNotMatch(s.slice(s.indexOf('static func main()')), /requestAuthorization/, 'no authorization request at startup: TTS-only use never touches TCC');
  assert.match(s, /RunLoop\.main\.run\(\)/, 'AVSpeechSynthesizer needs a real main run loop');
  assert.match(s, /static var active: \[ObjectIdentifier: Session\]/, 'sessions are retained (Network.framework does not hold them)');
  assert.match(s, /exitOnStdinEOF/, 'spawned with stdin piped');
  const plist = fs.readFileSync(path.join(__dirname, '..', 'native', 'mac', 'speech-server.plist'), 'utf8');
  assert.match(plist, /NSSpeechRecognitionUsageDescription/, 'TCC aborts a speech-recognition caller without this key');
  const build = fs.readFileSync(path.join(__dirname, '..', 'build-mac-helpers.js'), 'utf8');
  assert.match(build, /name: 'speech-server', plist: 'speech-server\.plist'/);
});
