'use strict';
// macOS permission status, requests, and System Settings deep links — the editor's Settings →
// Hardware "macOS permissions" block, the Accessibility gate robotjs needs, and the Input Monitoring
// prompt the DK-QUAKE touch controller needs. Thin, dependency-injected wiring over Electron's
// systemPreferences / desktopCapturer / shell plus the bundled `privacy` helper (native/mac/privacy.swift,
// the CoreGraphics TCC calls Electron does not expose), so main.js has one call site and the logic is
// unit-testable with fakes. Everything degrades to "unsupported" off macOS.
//
// Rule: features prompt lazily on their first use (getUserMedia, the first recording, the first
// keystroke, the first refused device open); nothing here runs at startup.

// System Settings → Privacy & Security pane anchors (x-apple.systempreferences URL scheme). Every
// anchor here was checked against the macOS 26 SecurityPrivacyExtension bundle; Local Network has no
// anchor, so it opens the Privacy & Security page itself.
const PANES = {
  accessibility: 'Privacy_Accessibility',
  microphone: 'Privacy_Microphone',
  screen: 'Privacy_ScreenCapture',          // "Screen & System Audio Recording"
  systemAudio: 'Privacy_AudioCapture',      // its "System Audio Recording Only" list (meeting recordings)
  inputMonitoring: 'Privacy_ListenEvent',   // "Input Monitoring" (the DK-QUAKE touch controller)
  automation: 'Privacy_Automation',
  calendars: 'Privacy_Calendars',
  localNetwork: '',
  files: 'Privacy_FilesAndFolders',
};
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?';

// The bundle id macOS attributes permissions to: the app's own for the installed build, the terminal
// app's (com.apple.Terminal, …) for `npm start` — LaunchServices hands it down in the environment.
function responsibleBundleId(env = process.env, fallback = 'com.teejs.bedrockpanel') {
  return (env && env.__CFBundleIdentifier) || fallback;
}

function createMacPermissions({
  platform = process.platform, systemPreferences = null, desktopCapturer = null, shell = null, log = () => {},
  helperPath = null, execFile = null,           // the `privacy` helper (null = not built / not this platform)
  bundleId = responsibleBundleId(),             // whose TCC entries a stale-grant reset clears
  tccutil = '/usr/bin/tccutil',
  pollMs = 1000, pollTimeoutMs = 30000,         // how long request('inputMonitoring') waits for the person to answer the prompt
  staleGraceMs = 6000,                          // no grant this long after a request = the prompt never appeared: reset the stale entry and ask again
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  signatureId = null,                           // () => Promise<string|null>: what identifies this build's code signature (its designated requirement)
  resetMarker = null,                           // { read: () => object, write: object => void }: which signature each service was last reset for
} = {}) {
  const supported = platform === 'darwin' && !!systemPreferences;
  const helper = supported && helperPath && execFile ? helperPath : null;
  let promptedAccessibility = false;
  const resetDone = new Set();   // one stale-grant reset per service per session

  // Until builds are notarized every ad-hoc build is a new app to TCC: the entry from the previous
  // build still shows as "on" in System Settings but no longer matches, macOS denies the permission
  // AND, because an entry exists, never shows the prompt again. `tccutil reset <service> <bundle>`
  // removes that entry (it needs no admin rights for one's own bundle id), after which the next
  // request prompts like a first install. Resolves true when the reset ran.
  // A reset is right exactly once per code signature: the entry that stops matching is the one an
  // earlier signature left behind. Resetting again for the SAME signature would wipe the entry the
  // person just added by hand (seen 2026-09-10: refused open on the next launch → reset → grant gone),
  // so the signature each service was last reset for is remembered across launches.
  async function alreadyResetForThisSignature(service) {
    if (!signatureId || !resetMarker) return false;
    try {
      const sig = await signatureId();
      if (!sig) return false;
      const marker = resetMarker.read() || {};
      if (marker[service] === sig) return true;
      resetMarker.write(Object.assign({}, marker, { [service]: sig }));
    } catch (e) { log('reset marker unavailable: ' + (e && e.message)); }
    return false;
  }
  async function resetStaleGrant(service) {
    if (!supported || !execFile || !bundleId || resetDone.has(service)) return false;
    resetDone.add(service);
    if (await alreadyResetForThisSignature(service)) {
      log(service + ' was already reset once for this build\'s signature — leaving the entry alone (added by hand?); check the toggle in System Settings');
      return false;
    }
    return new Promise(resolve => {
      try {
        execFile(tccutil, ['reset', service, bundleId], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
          if (err) { log('tccutil reset ' + service + ' ' + bundleId + ' failed: ' + ((stderr && String(stderr).trim()) || err.message || err)); return resolve(false); }
          log('cleared a stale ' + service + ' entry for ' + bundleId + ' (a previous build\'s grant) — asking again');
          resolve(true);
        });
      } catch (e) { log('tccutil start failed: ' + (e && e.message)); resolve(false); }
    });
  }

  // `privacy preflight|request listenEvent|screenCapture` -> true/false, or null when the helper is
  // missing or fails (the caller then treats the permission as "check in System Settings").
  function helperCall(mode, kind) {
    if (!helper) return Promise.resolve(null);
    return new Promise(resolve => {
      try {
        execFile(helper, [mode, kind], { timeout: 20000, windowsHide: true }, (err, stdout) => {
          if (err) { log('privacy helper ' + mode + ' ' + kind + ' failed: ' + (err.message || err)); return resolve(null); }
          try { resolve(!!JSON.parse(String(stdout).trim().split('\n').pop()).granted); }
          catch (e) { log('privacy helper output unreadable: ' + String(stdout).trim()); resolve(null); }
        });
      } catch (e) { log('privacy helper start failed: ' + (e && e.message)); resolve(null); }
    });
  }

  // Electron's media statuses are 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
  // Accessibility is a boolean, normalised to the same vocabulary. Input Monitoring comes from the
  // helper (CGPreflightListenEventAccess) and is absent when the helper is not available.
  async function status() {
    if (!supported) return { supported: false, platform };
    let accessibility = 'unknown', microphone = 'unknown', screen = 'unknown';
    try { accessibility = systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'; } catch (e) {}
    try { microphone = systemPreferences.getMediaAccessStatus('microphone'); } catch (e) {}
    try { screen = systemPreferences.getMediaAccessStatus('screen'); } catch (e) {}
    const out = { supported: true, platform, accessibility, microphone, screen };
    const im = await helperCall('preflight', 'listenEvent');
    if (im != null) out.inputMonitoring = im ? 'granted' : 'denied';
    return out;
  }

  // Raise the Input Monitoring prompt (macOS never does it on its own for a HID open) and wait for the
  // answer: CGRequestListenEventAccess lists the app under Input Monitoring and returns immediately,
  // so the grant shows up in a later preflight. Resolves { ok: true } as soon as it is granted.
  async function requestInputMonitoring() {
    if (!helper) return { ok: false, reason: 'no-helper' };
    const deadline = Date.now() + pollTimeoutMs;
    const pollUntil = async until => {
      while (Date.now() < until) {
        await sleep(pollMs);
        if (await helperCall('preflight', 'listenEvent') === true) return true;
      }
      return false;
    };
    let now = await helperCall('request', 'listenEvent');
    if (now === true) return { ok: true };
    if (now === null) return { ok: false, reason: 'helper-failed' };
    if (await pollUntil(Math.min(deadline, Date.now() + staleGraceMs))) return { ok: true };
    // Nothing within the grace period: either the person is still reading the prompt, or there was no
    // prompt because a stale entry exists. A reset is harmless in the first case (the prompt is
    // re-issued) and the only cure in the second.
    if (await resetStaleGrant('ListenEvent')) {
      now = await helperCall('request', 'listenEvent');
      if (now === true) return { ok: true, reset: true };
    }
    if (await pollUntil(deadline)) return { ok: true, reset: resetDone.has('ListenEvent') };
    return { ok: false, reason: 'not-granted' };
  }

  // Accessibility: one prompt call (macOS shows it where it shows one at all), then wait for the
  // grant. No automatic reset here: on a Mac without prompts the person is adding the entry with +
  // while we wait, and a reset would wipe that entry before it is toggled on (it did, once). A stale
  // entry from an older build is removed and re-added by hand (docs/macos.md); resetStaleGrant stays
  // available for callers that know the entry is stale.
  async function requestAccessibility() {
    promptedAccessibility = true;
    const trusted = () => { try { return !!systemPreferences.isTrustedAccessibilityClient(false); } catch (e) { return false; } };
    if (systemPreferences.isTrustedAccessibilityClient(true)) return { ok: true };
    const deadline = Date.now() + pollTimeoutMs;
    while (Date.now() < deadline) { await sleep(pollMs); if (trusted()) return { ok: true }; }
    return { ok: false, reason: 'not-granted' };
  }

  // Trigger the OS prompt for the permissions that have one we can drive; the rest are prompted by
  // the system on first use and can only be granted from System Settings.
  async function request(kind) {
    if (!supported) return { ok: false, reason: 'unsupported' };
    try {
      if (kind === 'microphone') return { ok: !!(await systemPreferences.askForMediaAccess('microphone')) };
      if (kind === 'accessibility') return await requestAccessibility();
      if (kind === 'screen') {
        if (desktopCapturer) await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
        return { ok: systemPreferences.getMediaAccessStatus('screen') === 'granted' };
      }
      if (kind === 'inputMonitoring') return await requestInputMonitoring();
    } catch (e) { log('permission request failed (' + kind + '): ' + (e && e.message || e)); return { ok: false, reason: String(e && e.message || e) }; }
    return { ok: false, reason: 'system-prompted-on-first-use' };
  }

  function openSettings(kind) {
    const anchor = PANES[kind];
    if (!supported || anchor == null || !shell) return Promise.resolve(false);
    const url = anchor ? SETTINGS_URL + anchor : SETTINGS_URL.replace(/\?$/, '');
    return Promise.resolve(shell.openExternal(url)).then(() => true, () => false);
  }

  // For robotjs call sites: true when keystrokes will actually be delivered. Prompts the OS once per
  // process, lazily, on the first attempt — never at startup.
  function ensureTrusted() {
    if (!supported) return true;
    try {
      if (systemPreferences.isTrustedAccessibilityClient(false)) return true;
      if (!promptedAccessibility) {
        promptedAccessibility = true;
        systemPreferences.isTrustedAccessibilityClient(true);
        log('Accessibility permission not granted — keystrokes and mouse input are dropped until it is (System Settings → Privacy & Security → Accessibility)');
      }
    } catch (e) {}
    return false;
  }

  return { supported, canPromptInputMonitoring: !!helper, bundleId, status, request, openSettings, ensureTrusted, resetStaleGrant };
}

module.exports = { createMacPermissions, responsibleBundleId, PANES, SETTINGS_URL };
