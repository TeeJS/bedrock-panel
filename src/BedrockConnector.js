'use strict';
/*
 * BedrockConnector — host driver for the Bedrock open desk console's RP2040 knob.
 *
 * Bedrock is the OSS hardware companion to Bedrock Panel; its USB HID protocol is documented at
 * https://github.com/TeeJS/bedrock-console/blob/main/firmware/PROTOCOL.md. Single 8-byte
 * bidirectional report, tag byte at offset 0. Pure node-hid — no Electron dependency.
 *
 * Distinct from Aris68Connector: this is a brand-new device on its own VID/PID with no touch
 * interface (the Bedrock touchscreen is a separate generic HID device the OS handles itself),
 * no panel control (HDMI display is its own monitor), no microphone, no buzzer. Method surface
 * mirrors Aris68Connector where it makes sense so the launcher can speak to either device with
 * the same call shape; the irrelevant methods (screenOn, queryMic, …) return false.
 *
 * License: MIT — we designed this protocol, so unlike Aris68Connector there is no PolyForm-NC
 * carve-out for the comm layer.
 *
 * Events (same shape as Aris68Connector where applicable):
 *   'knob'   -> { type:'rotate', dir:1|-1 }
 *              | { type:'press', index:1|2 }              // 1 single, 2 double
 *              | { type:'hold', phase:'start'|'end' }
 *   'state'  -> { boot:true, firmware }                   // sent once when the device enumerates
 *              | { pong:true, firmware }                  // response to ping
 *   'connect'/'disconnect' -> { iface:'control', info? }
 *   'error'  -> Error
 *
 * Usage:
 *   const HID = require('node-hid');
 *   const dev = new BedrockConnector({ hid: HID });
 *   dev.on('knob', e => ...); dev.on('state', s => ...);
 *   dev.start();
 */
const EventEmitter = require('events');

// VID 0x1209 (pid.codes) + PID 0xBED0 (proposed; needs claim before any binary release).
// usagePage 0xFFB0 narrows the match to the vendor HID interface — TinyUSB's default
// composite descriptor also exposes a CDC serial interface on the same VID/PID/path.
const VID = 0x1209;
const PID = 0xBED0;
// 0xFF00 is what TinyUSB's TUD_HID_REPORT_DESC_GENERIC_INOUT hardcodes via HID_USAGE_PAGE_VENDOR.
// (PROTOCOL.md originally said 0xFFB0; updated to match what the firmware actually advertises.)
const USAGE_PAGE = 0xFF00;
const REPORT_ID = 0x01;

// Tag namespace (mirror of firmware/bedrock-knob.ino).
const TAG_ROTATE     = 0x01;
const TAG_PRESS      = 0x02;
const TAG_HOLD       = 0x03;
const TAG_STATUS     = 0x04;
const TAG_LED_COLOR  = 0x10;
const TAG_LED_BRIGHT = 0x11;
const TAG_LED_EFFECT = 0x12;
const TAG_LED_SPEED  = 0x13;
const TAG_LED_SAVE   = 0x14;
const TAG_PING       = 0x15;
const STATUS_BOOT    = 0x00;
const STATUS_PONG    = 0x01;

// HSV(0..255, 0..255, value=255) -> RGB(0..255 × 3). Mirrors the conversion the Aris68 path
// uses so a caller that has a hue/sat pair (e.g. the launcher's accent-color picker) renders
// the same color on either device. Standard CSS-style HSV -> RGB.
function hsvToRgb(h255, s255) {
  const h = (h255 / 255) * 360;
  const s = s255 / 255;
  const v = 1;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rp = 0, gp = 0, bp = 0;
  if      (h <  60) { rp = c; gp = x; }
  else if (h < 120) { rp = x; gp = c; }
  else if (h < 180) { gp = c; bp = x; }
  else if (h < 240) { gp = x; bp = c; }
  else if (h < 300) { rp = x; bp = c; }
  else              { rp = c; bp = x; }
  return [
    Math.round((rp + m) * 255),
    Math.round((gp + m) * 255),
    Math.round((bp + m) * 255),
  ];
}

class BedrockConnector extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.HID = opts.hid || require('node-hid');
    this.keepAliveMs = opts.keepAliveMs || 1500;
    this.rescanMs    = opts.rescanMs    || 3000;
    this.watchdogMs  = opts.watchdogMs  || 3500;     // if no pong/event in this long, treat as gone
    this.ctrl = null;
    this._keepAlive = null;
    this._rescan = null;
    this._running = false;
    this._lastSeq = null;                            // dropped-event detection (per-direction sequence)
    this._lastRxAt = 0;                              // watchdog
    this.firmware = null;                            // populated from boot/pong status
    // Last-written LED state — Bedrock's V1 protocol has no get-current-state report, so we
    // mirror what we've sent for getLighting()'s sake. Persisted flash settings that predate
    // this connector's lifetime are visible on the ring but not readable here.
    this._lastLighting = null;
  }

  start() {
    if (this._running) return this;
    this._running = true;
    this._open();
    this._rescan = setInterval(() => this._tick(), this.rescanMs);
    return this;
  }

  stop() {
    this._running = false;
    clearInterval(this._keepAlive); this._keepAlive = null;
    clearInterval(this._rescan);    this._rescan = null;
    this._close();
  }

  _find() {
    return this.HID.devices().find(d =>
      d.vendorId === VID && d.productId === PID && d.usagePage === USAGE_PAGE
    ) || null;
  }

  _open() {
    if (this.ctrl) return;
    let info;
    try {
      info = this._find();
    } catch (e) {
      this.emit('error', e);
      return;
    }
    if (!info) return;
    try {
      const d = new this.HID.HID(info.path);
      this.ctrl = d;
      d.on('data', b => this._onCtrl(b));
      d.on('error', e => { this.emit('error', e); this._close(); });
      this.emit('connect', { iface: 'control', info });
      this._lastRxAt = Date.now();                   // grace period — don't immediately watchdog
      this.activate();
    } catch (e) {
      this.emit('error', e);
    }
  }

  _close() {
    if (!this.ctrl) return;
    try { this.ctrl.close(); } catch (e) {}
    this.ctrl = null;
    this._lastSeq = null;
    this.emit('disconnect', { iface: 'control' });
  }

  // Periodic rescan + heartbeat watchdog. If a connected device stops responding to pings
  // for watchdogMs, drop it so the next tick re-opens. Catches unplug events that don't
  // surface as node-hid errors right away.
  _tick() {
    if (!this._running) return;
    if (!this.ctrl) { this._open(); return; }
    if (this._lastRxAt && (Date.now() - this._lastRxAt) > this.watchdogMs) this._close();
  }

  /** Start the keep-alive heartbeat and probe the device. */
  activate() {
    if (!this._keepAlive) this._keepAlive = setInterval(() => this.ping(), this.keepAliveMs);
    this.ping();
  }

  // ---- outgoing: REPORT_ID + 8-byte payload (tag in [0], data in [1..7]) ----
  _send(tag, v1 = 0, v2 = 0, v3 = 0, v4 = 0, v5 = 0, v6 = 0, v7 = 0) {
    if (!this.ctrl) return false;
    try {
      this.ctrl.write([REPORT_ID, tag, v1 & 0xFF, v2 & 0xFF, v3 & 0xFF, v4 & 0xFF, v5 & 0xFF, v6 & 0xFF, v7 & 0xFF]);
      return true;
    } catch (e) {
      this.emit('error', e); this._close(); return false;
    }
  }

  ping() { return this._send(TAG_PING); }

  // ---- knob RGB ring ----
  setLedColorRgb(r, g, b) {
    if (!this._lastLighting) this._lastLighting = {};
    this._lastLighting.r = r & 0xFF;
    this._lastLighting.g = g & 0xFF;
    this._lastLighting.b = b & 0xFF;
    return this._send(TAG_LED_COLOR, r, g, b);
  }
  /** API parity with Aris68Connector — accepts the launcher's HSV-255 form and converts. */
  setLedColor(hue, sat) {
    if (!this._lastLighting) this._lastLighting = {};
    this._lastLighting.hue = hue & 0xFF;
    this._lastLighting.sat = sat & 0xFF;
    const [r, g, b] = hsvToRgb(hue & 0xFF, sat & 0xFF);
    return this.setLedColorRgb(r, g, b);
  }
  setLedBrightness(v) {
    if (!this._lastLighting) this._lastLighting = {};
    this._lastLighting.brightness = v & 0xFF;
    return this._send(TAG_LED_BRIGHT, v);
  }
  /**
   * Set the active LED effect. Bedrock firmware (>= v0.2.0) implements the full QMK / Aris68
   * RGB-Matrix effect ID space (0–30 native; reactive IDs 31+ fall through to solid since a
   * knob has no key matrix to react to), so the launcher's effect picker — which speaks the
   * Aris68 / QMK ID space — passes its byte through unchanged.
   */
  setLedEffect(i) {
    if (!this._lastLighting) this._lastLighting = {};
    this._lastLighting.effect = i & 0xFF;
    return this._send(TAG_LED_EFFECT, i);
  }
  setLedSpeed(v) {
    if (!this._lastLighting) this._lastLighting = {};
    this._lastLighting.speed = v & 0xFF;
    return this._send(TAG_LED_SPEED, v);
  }
  saveLighting() { return this._send(TAG_LED_SAVE); }

  /**
   * Returns the most recent LED settings written via this connector, or null if none have
   * been written yet. V1 firmware has no host-readable "current state" report, so settings
   * persisted to flash from a previous run can't be queried — only the live in-process
   * mirror. (V2 protocol candidate: add a TAG_LED_QUERY → device replies with current state.)
   */
  getLighting() { return Promise.resolve(this._lastLighting ? Object.assign({}, this._lastLighting) : null); }

  // ---- incoming parse ----
  // node-hid behavior re: the report-ID byte differs by platform: on Windows it's INCLUDED at
  // b[0] (giving us 9 bytes for our 8-byte report); on Linux/macOS it's typically stripped
  // (8 bytes). Detecting by length is the only robust way — we can't sniff b[0] against
  // REPORT_ID because TAG_ROTATE coincidentally has the same value.
  _onCtrl(b) {
    try {
      this._lastRxAt = Date.now();
      const off = (b.length >= 9) ? 1 : 0;
      const tag = b[off];
      const v1  = b[off + 1];
      const v2  = b[off + 2];

      if (tag === TAG_ROTATE) {
        if (this._lastSeq !== null && v2 !== ((this._lastSeq + 1) & 0xFF)) {
          this.emit('error', new Error(`dropped event(s) — seq ${this._lastSeq} -> ${v2}`));
        }
        this._lastSeq = v2;
        this.emit('knob', { type: 'rotate', dir: v1 === 0x01 ? 1 : -1 });
      } else if (tag === TAG_PRESS) {
        this._lastSeq = v2;
        this.emit('knob', { type: 'press', index: v1 });
      } else if (tag === TAG_HOLD) {
        this._lastSeq = v2;
        this.emit('knob', { type: 'hold', phase: v1 === 0x00 ? 'start' : 'end' });
      } else if (tag === TAG_STATUS) {
        const kind = v1;
        this.firmware = `${b[off + 2]}.${b[off + 3]}.${b[off + 4]}`;
        if (kind === STATUS_BOOT)      this.emit('state', { boot: true, firmware: this.firmware });
        else if (kind === STATUS_PONG) this.emit('state', { pong: true, firmware: this.firmware });
      }
      // Unknown tags are silently ignored so older hosts stay forward-compatible with new firmware.
    } catch (e) { this.emit('error', e); }
  }

  // ---- API-parity no-ops with Aris68Connector ----
  // Bedrock has no display control (separate HDMI monitor), no mic, no buzzer, no luminance.
  // These return false so launcher code that calls dev.screenOn() / dev.setMic() / etc. can run
  // unmodified against either device. setBrightness aliases setLedBrightness so the
  // appearance-pane brightness slider works without a conditional.
  screenOn()        { return false; }
  screenOff()       { return false; }
  queryFirmware()   { return this.ping(); }                // boot/pong both carry the version
  queryMic()        { return false; }
  queryLuminance()  { return false; }
  buzzer()          { return false; }
  setKnobLed()      { return false; }                      // covered by brightness/effect=0
  setMic()          { return false; }
  setBrightness(v)  { return this.setLedBrightness(v); }
  enterDfu()        { return false; }                      // RP2040 enters BOOTSEL via the BOOT button

  static get IDENT() { return { vendorId: VID, productId: PID, usagePage: USAGE_PAGE }; }
}

module.exports = BedrockConnector;
