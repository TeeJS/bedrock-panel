'use strict';
/*
 * hidPlatform — the node-hid / hidapi platform quirks both connectors share. Pure (no node-hid
 * require) and `platform`-injectable so the connectors' fake-HID tests cover every branch.
 *
 * macOS:
 *  - IOKit opens HID devices exclusively by default. The original DK-Suite driver opened the panel
 *    non-exclusively (docs/DEVICE_PROTOCOL.md), and an exclusive open fails whenever the OS's own
 *    driver (the touch digitizer) or another process already holds the device. node-hid >= 3.1
 *    exposes this as `{ nonExclusive: true }`.
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
  'macOS may be blocking the device — allow Bedrock Panel under System Settings → Privacy & Security → Input Monitoring, then reconnect it';

/** node-hid open options for this platform, or null when the default open is right. */
function openOptions(platform = process.platform) {
  return platform === 'darwin' ? { nonExclusive: true } : null;
}

/** `new HID.HID(path[, options])` with the platform's options. */
function openDevice(HID, devicePath, platform = process.platform) {
  const opts = openOptions(platform);
  return opts ? new HID.HID(devicePath, opts) : new HID.HID(devicePath);
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

/** An Error for a failed open, with the macOS permission hint when the message looks like a refusal. */
function openError(err, platform = process.platform) {
  const msg = String((err && err.message) || err || 'could not open device');
  const refused = /cannot open|could not open|not permitted|permission|denied|busy|exclusive/i.test(msg);
  const out = new Error(platform === 'darwin' && refused ? msg + ' — ' + INPUT_MONITORING_HINT : msg);
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

module.exports = { INPUT_MONITORING_HINT, openOptions, openDevice, writeAttempts, writeWithRetry, openError, OpenErrorGate, stripLeadingReportId };
