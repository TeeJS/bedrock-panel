'use strict';
/*
 * hidPlatform — the node-hid / hidapi platform quirks both connectors share. Pure (no node-hid
 * require) and `platform`-injectable so the connectors' fake-HID tests cover every branch.
 *
 * macOS:
 *  - IOKit can open a HID device exclusively ("seize": the system and every other client stop
 *    receiving its reports) or non-exclusively. Which one is right depends on the device:
 *      * the knob/control interface is a vendor-only collection nothing else consumes — open it
 *        non-exclusively, as the original DK-Suite driver did (docs/DEVICE_PROTOCOL.md);
 *      * the DK-QUAKE touch controller ALSO carries digitizer and mouse collections (macOS attaches
 *        its own HID event driver to them). The app parses the vendor touch reports itself and needs
 *        nothing from macOS, so it asks for the seize first: with it, whatever the firmware ever
 *        sends on the digitizer/mouse collections stays away from the OS (a pointer click on the
 *        panel display would make it the "active" display, pulling app menus and new windows onto
 *        the panel). IOKit can refuse a seize independently of Input Monitoring (exclusive opens of
 *        some device classes are reserved for root), so a refused seize falls back to the shared
 *        open DK-Suite itself uses on macOS (`{ nonExclusive: true }` for both of its devices), and
 *        the handle is tagged with the mode it got (`hidOpenMode`) so the connector can say which.
 *    node-hid >= 3.1 exposes the choice as `{ nonExclusive }`; its default on macOS is the seize.
 *  - Writes can fail transiently right after a (re)connect; DK-Suite retried them 3x. Everywhere
 *    else a failed write means the device is gone, so the connectors keep tearing down on the
 *    first failure there.
 *  - TCC can refuse the open (Input Monitoring) with hidapi's generic "cannot open device"; the
 *    error is decorated with the System Settings hint so it doesn't read like a cable problem.
 *  - Each connector rescans every few seconds, so a persistent open failure would otherwise log
 *    the same error forever: OpenErrorGate reports a message once until it changes or the open
 *    succeeds.
 */

const INPUT_MONITORING_HINT =
  'macOS may be blocking the device — allow Bedrock Panel (or, for npm start, the terminal app it was launched from) under System Settings → Privacy & Security → Input Monitoring; it reconnects on the next rescan';
// Linux ships /dev/hidraw* as root-only, so the very first open by an ordinary user is refused. This
// is a one-time udev rule, not a cable fault, and the message has to say so or it reads like broken
// hardware. Same shape as the macOS hint: name the fix, and note that a rescan picks the device up.
const UDEV_HINT =
  'Linux keeps raw HID devices root-only until a udev rule grants your user access — the editor\'s Settings → Hardware → Device access has the one-time steps (docs/linux.md has the rule in full); it reconnects on the next rescan';
const OPEN_HINT = { darwin: INPUT_MONITORING_HINT, linux: UDEV_HINT };

/**
 * node-hid open options for this platform, or null when the default open is right.
 * `seize` = take the device away from the OS's own HID drivers (macOS only; see the header).
 */
function openOptions(platform = process.platform, { seize = false } = {}) {
  return platform === 'darwin' ? { nonExclusive: !seize } : null;
}

/**
 * `new HID.HID(path[, options])` with the platform's options. The returned handle carries
 * `hidOpenMode` ('default' | 'shared' | 'seized') and, when a refused seize fell back to the shared
 * open, `hidOpenFallback` (the seize error's message). A refused open in every mode throws.
 */
function openDevice(HID, devicePath, platform = process.platform, { seize = false } = {}) {
  const opts = openOptions(platform, { seize });
  if (!opts) return tagHandle(new HID.HID(devicePath), 'default');
  try {
    return tagHandle(new HID.HID(devicePath, opts), seize ? 'seized' : 'shared');
  } catch (e) {
    if (!seize) throw e;
    return tagHandle(new HID.HID(devicePath, { nonExclusive: true }), 'shared', e);
  }
}
function tagHandle(dev, mode, fallbackFrom) {
  try {
    dev.hidOpenMode = mode;
    if (fallbackFrom) dev.hidOpenFallback = String((fallbackFrom && fallbackFrom.message) || fallbackFrom);
  } catch (e) {}
  return dev;
}

/** How many times a single write may be attempted before the device is considered gone. */
function writeAttempts(platform = process.platform) {
  return platform === 'darwin' ? 3 : 1;
}

/** Run `write` up to writeAttempts() times. Returns null on success, else the last error. */
function writeWithRetry(write, platform = process.platform) {
  let last = null;
  for (let i = 0, n = writeAttempts(platform); i < n; i++) {
    try { write(); return null; } catch (e) { last = e || new Error('write failed'); }
  }
  return last;
}

/** An Error for a failed open, with the platform's permission hint when the message looks like a refusal. */
function openError(err, platform = process.platform) {
  const msg = String((err && err.message) || err || 'could not open device');
  const refused = /cannot open|could not open|not permitted|permission|denied|busy|exclusive|EACCES/i.test(msg);
  const hint = refused ? OPEN_HINT[platform] : null;
  const out = new Error(hint ? msg + ' — ' + hint : msg);
  out.code = 'HID_OPEN_FAILED';
  out.cause = err;
  return out;
}

/** Report a given failure once per key until its message changes or clear() is called. */
class OpenErrorGate {
  constructor() { this._last = new Map(); }
  shouldReport(key, err) {
    const msg = String((err && err.message) || err);
    if (this._last.get(key) === msg) return false;
    this._last.set(key, msg);
    return true;
  }
  clear(key) { this._last.delete(key); }
}

/**
 * Some hidapi builds hand unnumbered reports (report ID 0) over with the 0x00 report-ID byte still
 * in front. Strip it when the byte after it is one of the frame markers the parser expects, so the
 * parsers see the same bytes on every platform.
 */
function stripLeadingReportId(b, markers) {
  if (!b || b.length < 2 || b[0] !== 0x00 || !markers.includes(b[1])) return b;
  return typeof b.subarray === 'function' ? b.subarray(1) : b.slice(1);
}

module.exports = { INPUT_MONITORING_HINT, UDEV_HINT, openOptions, openDevice, writeAttempts, writeWithRetry, openError, OpenErrorGate, stripLeadingReportId };
