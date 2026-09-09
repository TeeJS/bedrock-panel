'use strict';

// Controller for native/mac/display-arrange (macOS only): keeps the DK-QUAKE display un-mirrored, not
// the main display, and at the far right of the arrangement — the policy DK-Suite's own
// display_manager tool enforces, for the same reason: with "Displays have separate Spaces" the display
// that was clicked last owns the active menu bar and receives new windows, and a 1920x480 strip
// arranged under another display is exactly where a cursor moving down ends up. `check` runs first
// and `fix` only when the helper reports a fixable arrangement (exit 2 mirrored, 3 position/main).
// No helper on this platform (or no Swift toolchain) = a no-op. Requests are debounced because
// display changes arrive in bursts, and a fix itself produces another burst.

const childProcess = require('child_process');
const nativeHelpers = require('./nativeHelpers');

const EXIT = { VALID: 0, ERROR: 1, MIRRORED: 2, FIXABLE: 3, NO_PANEL: 4 };

function createDisplayArrange(options) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  const log = opts.log || (() => {});
  const execFile = opts.execFile || childProcess.execFile;
  const helperPath = opts.helperPath !== undefined ? opts.helperPath : nativeHelpers.helperPath('displayArrange', platform);
  const onFixed = typeof opts.onFixed === 'function' ? opts.onFixed : null;   // (result, checkCode) after a successful fix
  const debounceMs = opts.debounceMs == null ? 1000 : opts.debounceMs;

  let enabled = false;
  let timer = null;
  let chain = Promise.resolve();   // runs are serialized: a fix must finish before the next check reads the arrangement

  function run(cmd) {
    return new Promise(resolve => {
      let done = false;
      const finish = (code, stdout, stderr) => { if (done) return; done = true; resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') }); };
      try {
        execFile(helperPath, [cmd], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
          finish(err ? (typeof err.code === 'number' ? err.code : EXIT.ERROR) : EXIT.VALID, stdout, stderr);
        });
      } catch (e) { finish(EXIT.ERROR, '', e && e.message); }
    });
  }
  function parse(stdout) {
    const line = String(stdout || '').trim().split('\n').pop();
    try { return line ? JSON.parse(line) : null; } catch (e) { return null; }
  }
  const brief = r => (r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0] || '';

  // Check, then fix when needed. Resolves to { code, info, fixed } — code is the check's exit code
  // (or the fix's when a fix ran), info the helper's parsed JSON, fixed true after a successful fix.
  async function ensure(reason) {
    if (!helperPath || !enabled) return { code: null, skipped: true };
    const chk = await run('check');
    const info = parse(chk.stdout);
    if (chk.code === EXIT.VALID || chk.code === EXIT.NO_PANEL) return { code: chk.code, info, fixed: false };
    if (chk.code !== EXIT.MIRRORED && chk.code !== EXIT.FIXABLE) {
      log('check failed (' + reason + '): exit ' + chk.code + ' ' + brief(chk));
      return { code: chk.code, info, fixed: false };
    }
    log((chk.code === EXIT.MIRRORED ? 'panel display is mirrored' : (info && info.panelIsMain ? 'panel display is the main display' : 'panel display is not at the far right'))
      + ' (' + reason + ') — fixing the arrangement');
    const fx = await run('fix');
    const result = parse(fx.stdout);
    if (fx.code !== EXIT.VALID) {
      log('fix failed: exit ' + fx.code + ' ' + brief(fx));
      return { code: fx.code, info: result || info, fixed: false };
    }
    log('arrangement fixed: ' + JSON.stringify((result && result.changed) || []));
    if (onFixed) { try { onFixed(result, chk.code); } catch (e) { log('onFixed error: ' + (e && e.message)); } }
    return { code: fx.code, info: result, fixed: true };
  }

  // Serialized, unbatched run (tests, and the settings toggle).
  function runNow(reason) {
    const p = chain.then(() => ensure(reason || 'request'), () => ensure(reason || 'request'));
    chain = p.catch(e => { log('error: ' + (e && e.message)); });
    return p;
  }
  // Debounced request; a burst of display events becomes one check.
  function request(reason) {
    if (!helperPath || !enabled) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; runNow(reason); }, debounceMs);
  }
  function setEnabled(v) {
    enabled = !!v;
    if (!enabled) { clearTimeout(timer); timer = null; }
  }
  function stop() { setEnabled(false); }

  return { available: !!helperPath, isEnabled: () => enabled, setEnabled, request, runNow, stop, EXIT };
}

module.exports = { createDisplayArrange, EXIT };
