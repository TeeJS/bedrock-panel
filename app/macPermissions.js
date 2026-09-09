'use strict';
// macOS permission status, requests, and System Settings deep links — the editor's Settings →
// Hardware "macOS permissions" block and the Accessibility gate robotjs needs. Thin, dependency-
// injected wiring over Electron's systemPreferences / desktopCapturer / shell so main.js has one
// call site and the logic is unit-testable with fakes. Everything degrades to "unsupported" off macOS.
//
// Rule: features prompt lazily on their first use (getUserMedia, the first recording, the first
// keystroke); nothing here runs at startup. `request()` is only ever driven by the editor's button.

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

function createMacPermissions({ platform = process.platform, systemPreferences = null, desktopCapturer = null, shell = null, log = () => {} } = {}) {
  const supported = platform === 'darwin' && !!systemPreferences;
  let promptedAccessibility = false;

  // Electron's media statuses are 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
  // Accessibility is a boolean, normalised to the same vocabulary.
  function status() {
    if (!supported) return { supported: false, platform };
    let accessibility = 'unknown', microphone = 'unknown', screen = 'unknown';
    try { accessibility = systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'; } catch (e) {}
    try { microphone = systemPreferences.getMediaAccessStatus('microphone'); } catch (e) {}
    try { screen = systemPreferences.getMediaAccessStatus('screen'); } catch (e) {}
    return { supported: true, platform, accessibility, microphone, screen };
  }

  // Trigger the OS prompt for the permissions that have one we can drive; the rest are prompted by
  // the system on first use and can only be granted from System Settings.
  async function request(kind) {
    if (!supported) return { ok: false, reason: 'unsupported' };
    try {
      if (kind === 'microphone') return { ok: !!(await systemPreferences.askForMediaAccess('microphone')) };
      if (kind === 'accessibility') { promptedAccessibility = true; return { ok: !!systemPreferences.isTrustedAccessibilityClient(true) }; }
      if (kind === 'screen') {
        if (desktopCapturer) await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
        return { ok: systemPreferences.getMediaAccessStatus('screen') === 'granted' };
      }
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

  return { supported, status, request, openSettings, ensureTrusted };
}

module.exports = { createMacPermissions, PANES, SETTINGS_URL };
