'use strict';
// How the Meeting tab's app-list pickers turn a running app (or a typed name) into the string that
// gets saved, per platform. Two lists with different consumers:
//
//   callApps    — auto-record and busy-status "Call apps". Every layer that reads them splits on
//                 commas, semicolons AND whitespace (micMonitorRouting.parseAppList, and the argv
//                 parsers of both mic-session-monitor helpers), so a saved name must never contain a
//                 space. Windows matches "<ProcessName>.exe". macOS matches a token against the app's
//                 name, executable or bundle id (native/mac/lib AppAliases) — so an app whose name
//                 has a space ("Microsoft Teams") is saved as its bundle id (com.microsoft.teams2).
//   slideFilter — the slide-capture window-picker filter. Read only by slideCapture.parseAppFilter,
//                 which splits on commas/semicolons, so macOS names with spaces are kept whole.
//
// UMD-lite: plain <script> in the editor window, require()-able from unit tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.appListTokens = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const HAS_SPACE = /\s/;
  const list = (s, sep) => String(s == null ? '' : s).split(sep).map(x => x.trim()).filter(Boolean);

  // platform: 'win32' | 'darwin' | 'linux'
  function forPlatform(platform) {
    const mac = platform === 'darwin', win = platform === 'win32';

    const callApps = {
      parse: s => list(s, /[,;\s]+/),
      key: n => String(n).trim().toLowerCase().replace(/\.(exe|app)$/, ''),
      // A running app ({ processName, bundleId }) -> saved token, or '' when it can't be expressed.
      fromApp(app) {
        const name = String((app && app.processName) || '').trim();
        if (!name) return '';
        if (mac) {
          if (!HAS_SPACE.test(name)) return name;
          const id = String(app.bundleId || '').trim();
          return id && !HAS_SPACE.test(id) ? id : '';
        }
        if (HAS_SPACE.test(name)) return '';
        return win && !/\.exe$/i.test(name) ? name + '.exe' : name;
      },
      label(app, token) {
        const name = String((app && app.processName) || '').trim();
        return mac && token !== name ? name + ' (' + token + ')' : token;
      },
      // Typed text (one name, or a pasted comma list) -> { tokens } or { error }.
      fromTyped(text) {
        const parts = list(text, /[,;]+/);
        if (parts.some(p => HAS_SPACE.test(p))) {
          return { tokens: [], error: mac
            ? 'Names with spaces can’t be matched. Pick the app from “Add a running app…” instead — it saves the app’s bundle ID.'
            : 'Names with spaces can’t be matched as call apps. Separate several names with commas.' };
        }
        return { tokens: parts.map(p => (win && !/\.exe$/i.test(p)) ? p + '.exe' : p) };
      },
    };

    const slideFilter = {
      parse: s => list(s, /[,;]+/),
      key: n => String(n).trim().toLowerCase(),
      fromApp: app => String((app && app.processName) || '').trim(),
      label: (app, token) => token,
      // The window list reports "ms-teams", not "ms-teams.exe".
      fromTyped: text => ({ tokens: list(text, /[,;]+/).map(p => win ? p.replace(/\.exe$/i, '') : p) }),
    };

    return { callApps, slideFilter };
  }

  return { forPlatform };
});
