'use strict';
/*
 * Aris68Connector — open driver for the DK-QUAKE / ARIS-68 touchscreen + knob device.
 *
 * Reverse-engineered from DK-Suite V0.4.35 (see ../docs/DEVICE_PROTOCOL.md).
 * Licensed PolyForm Noncommercial 1.0.0 — see ./LICENSE. The comm protocol is the
 * vendor's restricted-for-commercial component; non-commercial use only.
 *
 * Pure node-hid — no Electron dependency. Handles HID I/O for the two interfaces, keeps the
 * panel backlight awake, parses incoming reports into events, and exposes outgoing commands.
 * The DISPLAY is a standard external monitor fed over a display cable (HDMI or USB-C
 * DP alt-mode; 480x1920 portrait / 1920x480 landscape) — render to it in your host app;
 * this driver only does the USB HID side (touch/knob/control) + activation/keep-alive.
 *
 * Events:
 *   'touch'  -> [{ action(1=down,0=up), x(0..1920), y(0..480, ORIGIN BOTTOM-LEFT) }, ...]
 *   'knob'   -> { type:'rotate', dir:1|-1 }  |  { type:'press', index }
 *   'key'    -> { action:'down'|'up', row, col }   (button-grid units only)
 *   'state'  -> { firmware } | { mic } | { luminance } | { pong:true }
 *   'connect'/'disconnect' -> { iface:'control'|'touch', info? }
 *   'error'  -> Error
 *
 * Usage:
 *   const HID = require('node-hid');               // built for your runtime/ABI
 *   const dev = new Aris68Connector({ hid: HID }); // omit hid to require('node-hid')
 *   dev.on('touch', pts => ...); dev.on('knob', e => ...);
 *   dev.start();                                   // opens, activates panel, keep-alive
 */
const EventEmitter = require('events');
const hidPlatform = require('./hidPlatform');

// [vendorId, productId, usagePage] — first match wins.
const CONTROL_IFACES = [[16728, 20811, 0xff60], [20498, 26647, 0xff60]]; // QUAKE / ARIS-68 control
const TOUCH_IFACES = [[1810, 16, 0xff73]];                               // hotlotus touch
const RGB_MATRIX_CH = 3; // QMK VIA custom-menu channel for the knob RGB ring (field 1=bright,2=effect,3=speed,4=color)

// 0xA3 short-command frame: [0xA3, len, opCode, ...data, checksum]; checksum=(opCode+Σdata)%0xFF.
function a3(opCode, data) { let s = opCode; for (const d of data) s += d; return [0xA3, data.length + 1, opCode, ...data, s % 0xFF]; }
const FR = {
  SCREEN_ON: a3(0x01, [0x04, 0x01]),   // validated: A3 03 01 04 01 06
  SCREEN_OFF: a3(0x01, [0x04, 0x00]),  // validated
  PING: a3(0x02, [0xEF]),              // validated -> 0x55/0xEF pong
  Q_FIRMWARE: a3(0x02, [0x2E]),        // validated -> 0x55/0x2E name+version
  Q_MIC: a3(0x02, [0x03]),             // validated -> 0x55/0x03
  Q_LUMA: a3(0x02, [0x05]),            // validated -> 0x55/0x05
  DFU: a3(0x01, [0x2F, 0x03]),         // DANGER: firmware-download mode
};
const be = (hi, lo) => ((hi << 8) | lo) >>> 0;
const CTRL_MARKERS = [0x01, 0xA3];   // first byte of every control frame we parse (key matrix / 0xA3 short frame)

class Aris68Connector extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.HID = opts.hid || require('node-hid');
    this.platform = opts.platform || process.platform;            // injectable for the fake-HID tests
    this.lastOpenError = { control: null, touch: null };          // last failed open per interface (Device Diagnostics)
    this._openGate = new hidPlatform.OpenErrorGate();
    this.keepAliveMs = opts.keepAliveMs || 1500;
    this.rescanMs = opts.rescanMs || 3000;
    this.autoActivate = opts.autoActivate !== false;
    this.ctrl = null; this.touch = null;
    this._keepAlive = null; this._rescan = null; this._running = false;
  }

  start() {
    if (this._running) return this;
    this._running = true;
    this._open();
    this._rescan = setInterval(() => this._open(), this.rescanMs); // reconnect if a device drops
    return this;
  }

  stop() {
    this._running = false;
    clearInterval(this._keepAlive); this._keepAlive = null;
    clearInterval(this._rescan); this._rescan = null;
    this._closeCtrl(); this._closeTouch();
  }

  _find(spec, devs = this.HID.devices()) {
    for (const [vid, pid, up] of spec) {
      const d = devs.find(x => x.vendorId === vid && x.productId === pid && (up === undefined || x.usagePage === up));
      if (d) return d;
    }
    return null;
  }

  _open() {
    let devices;
    try {
      devices = this.HID.devices();
    } catch (e) {
      this.emit('error', e);
      return;
    }
    if (!this.ctrl) {
      const info = this._find(CONTROL_IFACES, devices);
      if (info) try {
        const d = hidPlatform.openDevice(this.HID, info.path, this.platform); this.ctrl = d;   // non-exclusive on macOS
        this.lastOpenError.control = null; this._openGate.clear('control');
        d.on('data', b => this._onCtrl(b));
        d.on('error', () => this._closeCtrl());
        this.emit('connect', { iface: 'control', info });
        if (this.autoActivate) this.activate();
      } catch (e) { this._reportOpenError('control', e); }
    }
    if (!this.touch) {
      const info = this._find(TOUCH_IFACES, devices);
      // Independent of the control interface (a failure here never takes the knob down). On macOS the
      // touch controller is SEIZED: it also exposes digitizer/mouse collections that macOS's own HID event
      // driver would turn into pointer clicks on the panel display, and a click makes that display the
      // active one — app menus and new windows then land on the panel. Seizing (the original DK-Suite
      // driver's plain open) keeps the reports for us and hides the taps from macOS. Needs Input Monitoring.
      if (info) try {
        const d = hidPlatform.openDevice(this.HID, info.path, this.platform, { seize: true }); this.touch = d;
        this.lastOpenError.touch = null; this._openGate.clear('touch');
        d.on('data', b => this._onTouch(b));
        d.on('error', () => this._closeTouch());
        this.emit('connect', { iface: 'touch', info });
      } catch (e) { this._reportOpenError('touch', e); }
    }
  }

  _closeCtrl() { if (this.ctrl) { try { this.ctrl.close(); } catch (e) {} this.ctrl = null; this.emit('disconnect', { iface: 'control' }); } }
  _closeTouch() { if (this.touch) { try { this.touch.close(); } catch (e) {} this.touch = null; this.emit('disconnect', { iface: 'touch' }); } }

  // The rescan retries every few seconds: report a given failure once (decorated with the macOS Input
  // Monitoring hint when it looks like a refusal) and keep it for Device Diagnostics.
  _reportOpenError(iface, e) {
    const err = hidPlatform.openError(e, this.platform);
    this.lastOpenError[iface] = err.message;
    if (this._openGate.shouldReport(iface, err)) this.emit('error', err);
  }

  // ---- outgoing commands (all written to the control interface, report-id 0x00 prefixed) ----
  _send(frame) {
    if (!this.ctrl) return false;
    const err = hidPlatform.writeWithRetry(() => this.ctrl.write([0x00, ...frame]), this.platform);   // macOS retries transient failures
    if (!err) return true;
    this.emit('error', err); this._closeCtrl(); return false;
  }
  screenOn() { return this._send(FR.SCREEN_ON); }
  screenOff() { return this._send(FR.SCREEN_OFF); }
  ping() { return this._send(FR.PING); }
  queryFirmware() { return this._send(FR.Q_FIRMWARE); }
  queryMic() { return this._send(FR.Q_MIC); }
  queryLuminance() { return this._send(FR.Q_LUMA); }
  buzzer(tone = 100) { return this._send(a3(0x01, [0x02, tone & 0xFF])); }   // derived from DK-Suite
  setKnobLed(on) { return this._send(a3(0x01, [0x06, on ? 0 : 1])); }        // derived
  setMic(on) { return this._send(a3(0x01, [0x03, on ? 1 : 0])); }            // cmd3: 1=mic on, 0=off (from DK-Suite)
  setBrightness(v) { return this._send(a3(0x01, [0x05, v & 0xFF])); }        // legacy 0xA3 path — use setLedBrightness (VIA) for the ring
  enterDfu() { return this._send(FR.DFU); }                                  // DANGER: firmware flash mode

  // ---- knob RGB ring: QMK VIA lighting (a 2nd command channel on the SAME control interface) ----
  // Standard QMK VIA: command 0x07=set, 0x08=get, 0x09=save-to-flash; RGB-Matrix on custom channel 3,
  // field byte 1=brightness 2=effect(index 0..43) 3=speed 4=color[hue,sat]. Verified live (VIA proto 12).
  // Report = [0x00 report-id, command, ...data] zero-padded to 33 bytes.
  _via(command, data) {
    if (!this.ctrl) return false;
    const r = new Array(33).fill(0); r[0] = 0x00; r[1] = command & 0xFF;
    data.forEach((b, i) => { r[2 + i] = b & 0xFF; });
    const err = hidPlatform.writeWithRetry(() => this.ctrl.write(r), this.platform);
    if (!err) return true;
    this.emit('error', err); this._closeCtrl(); return false;
  }
  setLedBrightness(v) { return this._via(0x07, [RGB_MATRIX_CH, 0x01, v & 0xFF]); }      // device quantizes; max ~247
  setLedEffect(i) { return this._via(0x07, [RGB_MATRIX_CH, 0x02, i & 0xFF]); }          // 0=All Off … 43 (RGB-Matrix list)
  setLedSpeed(v) { return this._via(0x07, [RGB_MATRIX_CH, 0x03, v & 0xFF]); }
  setLedColor(hue, sat) { return this._via(0x07, [RGB_MATRIX_CH, 0x04, hue & 0xFF, sat & 0xFF]); }
  saveLighting() { return this._via(0x09, []); }                                        // persist ring lighting to device flash

  /** Read the ring's current lighting from the device -> {brightness,effect,speed,hue,sat} (missing keys = no reply). */
  getLighting(timeoutMs = 700) {
    const readOne = (field, n) => new Promise(resolve => {
      if (!this.ctrl) return resolve(null);
      const expect = [0x08, RGB_MATRIX_CH, field];
      let done = false;
      const finish = v => { if (done) return; done = true; clearTimeout(to); try { this.ctrl.removeListener('data', onData); } catch (e) {} resolve(v); };
      const onData = b => { const a = Array.from(hidPlatform.stripLeadingReportId(b, [0x08])); if (expect.every((x, i) => a[i] === x)) finish(a.slice(3, 3 + n)); };
      const to = setTimeout(() => finish(null), timeoutMs);
      this.ctrl.on('data', onData);
      this._via(0x08, [RGB_MATRIX_CH, field]);
    });
    return (async () => {
      const out = {};
      const b = await readOne(0x01, 1); if (b) out.brightness = b[0];
      const e = await readOne(0x02, 1); if (e) out.effect = e[0];
      const s = await readOne(0x03, 1); if (s) out.speed = s[0];
      const c = await readOne(0x04, 2); if (c && c.length === 2) { out.hue = c[0]; out.sat = c[1]; }
      return out;
    })();
  }

  /** Wake the panel (it ships dark) + start the keep-alive heartbeat so it never idle-blanks. */
  activate() {
    [0, 300, 800, 1500].forEach(ms => setTimeout(() => this.screenOn(), ms));
    if (!this._keepAlive) this._keepAlive = setInterval(() => this.ping(), this.keepAliveMs);
    this.queryFirmware();
  }

  // ---- incoming parse (ports recovered ProtocolUtil.checkDataValid) ----
  _onCtrl(b) {
    try {
      b = hidPlatform.stripLeadingReportId(b, CTRL_MARKERS);   // tolerate a leading report-id byte (platform-dependent)
      if (b[0] === 0x01) { // key matrix (button-grid units)
        for (let i = 0; i < 15; i++) if (b[4 + i] === 0x01) return this.emit('key', { action: 'down', row: Math.floor(i / 5) + 1, col: (i % 5) + 1 });
        return this.emit('key', { action: 'up' });
      }
      if (b[0] === 0xA3) {
        const len = b[1], op = b[2], cmd = b[3], sub = Array.from(b.slice(4, 4 + Math.max(0, len - 2)));
        if (op === 3) {
          if (cmd === 1) this.emit('knob', { type: 'rotate', dir: sub[0] === 1 ? 1 : -1 });
          else if (cmd === 2) {
            // Press frame index: 1=single click, 2=double click; a HOLD reports its edges separately —
            // 5 = pressed down, 0xFF = released (gap between them = hold duration → push-to-talk).
            const i = sub[0];
            if (i === 5) this.emit('knob', { type: 'hold', phase: 'start' });
            else if (i === 0xFF) this.emit('knob', { type: 'hold', phase: 'end' });
            else this.emit('knob', { type: 'press', index: i });
          }
        } else if (op === 0x55) {
          if (cmd === 0x2E) this.emit('state', { name: sub[0], firmware: `${sub[1]}.${sub[2]}.${sub[3]}` });
          else if (cmd === 0x03) this.emit('state', { mic: sub[0] === 1 });
          else if (cmd === 0x05) this.emit('state', { luminance: sub[0] });
          else if (cmd === 0xEF) this.emit('state', { pong: true });
          else if (cmd === 0x00) this.emit('state', { stateSync: true, busy: sub[0] === 0x90 });
          else this.emit('state', { rawCmd: cmd, sub });
        }
      }
    } catch (e) { this.emit('error', e); }
  }

  _onTouch(b) {
    b = hidPlatform.stripLeadingReportId(b, [0xA3]);
    if (b[0] !== 0xA3 || b[3] !== 0x1A) return; // touch report id
    const n = b[4], o = 5, pts = [];
    for (let i = 0; i < n; i++) { const t = 5 * i; pts.push({ action: b[o + t], x: be(b[o + t + 4], b[o + t + 3]), y: be(b[o + t + 2], b[o + t + 1]) }); }
    this.emit('touch', pts); // x:0..1920, y:0..480 (origin BOTTOM-LEFT) — host flips Y for top-left display
  }

  /** Native panel resolution (landscape). */
  static get SCREEN() { return { width: 1920, height: 480 }; }
}

module.exports = Aris68Connector;
