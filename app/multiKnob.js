'use strict';
/*
 * MultiKnob — owns both Aris68Connector (DK-QUAKE / ARIS-68 panel) and BedrockConnector
 * (open Bedrock RP2040 knob), runs both, forwards events from whichever finds its device
 * first, routes commands to the active one.
 *
 * Drop-in for main.js's `dev` global — same event shape ('knob' / 'state' / 'touch' /
 * 'connect' / 'disconnect' / 'error'), same method surface ('screenOn', 'setLedColor',
 * 'getLighting', etc.). Commands made before any device shows up route to the first
 * connector in the list (Bedrock) so they're harmless no-ops; once a device connects,
 * commands route to whichever connector owns that device.
 *
 * Hot-swap is supported: if the active connector loses its 'control' interface and the
 * other connector then finds a device, the new one becomes active automatically.
 */
const EventEmitter = require('events');
const path = require('path');

const Aris68Connector  = require(path.join(__dirname, '..', 'src', 'Aris68Connector'));
const BedrockConnector = require(path.join(__dirname, '..', 'src', 'BedrockConnector'));

class MultiKnob extends EventEmitter {
  constructor(opts = {}) {
    super();
    // Bedrock first — if both somehow show up, the open-hardware device wins (no PolyForm-NC
    // restriction on the control path).
    this.connectors = [
      { name: 'bedrock', impl: new BedrockConnector(opts) },
      { name: 'aris68',  impl: new Aris68Connector(opts) },
    ];
    this.active = null;

    for (const c of this.connectors) {
      const { impl, name } = c;
      impl.on('connect', info => {
        if (info && info.iface === 'control' && !this.active) {
          this.active = c;
          this.emit('activeChanged', name);
        }
        this.emit('connect', info);
      });
      impl.on('disconnect', info => {
        if (info && info.iface === 'control' && this.active && this.active.impl === impl) {
          this.active = null;
          this.emit('activeChanged', null);
        }
        this.emit('disconnect', info);
      });
      // Pass-through events. Aris68 emits 'touch' and 'key'; Bedrock never does.
      ['knob', 'state', 'touch', 'key'].forEach(ev => impl.on(ev, x => this.emit(ev, x)));
      impl.on('error', error => this.emit('error', this._connectorError(name, 'runtime', error)));
    }
  }

  // ---- lifecycle ----
  start() {
    for (const c of this.connectors) {
      try { c.impl.start(); }
      catch (error) { this.emit('error', this._connectorError(c.name, 'start', error)); }
    }
    return this;
  }
  stop()  { for (const c of this.connectors) c.impl.stop(); }
  activate() { return this._call('activate'); }

  // Route command to the active connector; if nothing has connected yet, default to the first
  // in the list so the call is just a benign no-op (Bedrock Panel makes lots of dev.* calls during
  // startup before the device is necessarily plugged in).
  _call(name, ...args) {
    const target = (this.active && this.active.impl) || this.connectors[0].impl;
    const fn = target[name];
    return typeof fn === 'function' ? fn.apply(target, args) : false;
  }

  _connectorError(connector, phase, error) {
    const detail = error && error.message ? error.message : String(error);
    const wrapped = new Error(`${connector} ${phase} failed: ${detail}`);
    wrapped.connector = connector;
    wrapped.phase = phase;
    wrapped.cause = error;
    return wrapped;
  }

  // ---- panel / power (Aris68 only — Bedrock returns false harmlessly) ----
  screenOn()  { return this._call('screenOn'); }
  screenOff() { return this._call('screenOff'); }
  enterDfu()  { return this._call('enterDfu'); }

  // ---- diagnostics ----
  ping()           { return this._call('ping'); }
  queryFirmware()  { return this._call('queryFirmware'); }
  queryMic()       { return this._call('queryMic'); }
  queryLuminance() { return this._call('queryLuminance'); }

  // ---- mic / buzzer (Aris68 only) ----
  buzzer(tone)   { return this._call('buzzer', tone); }
  setMic(on)     { return this._call('setMic', on); }

  // ---- knob LED / ring ----
  setKnobLed(on)         { return this._call('setKnobLed', on); }
  setBrightness(v)       { return this._call('setBrightness', v); }
  setLedBrightness(v)    { return this._call('setLedBrightness', v); }
  setLedEffect(i)        { return this._call('setLedEffect', i); }
  setLedSpeed(v)         { return this._call('setLedSpeed', v); }
  setLedColor(hue, sat)  { return this._call('setLedColor', hue, sat); }
  saveLighting()         { return this._call('saveLighting'); }
  getLighting(timeoutMs) { return this._call('getLighting', timeoutMs); }

  /** Identify which connector is currently active — null until a device connects. */
  activeName() { return this.active ? this.active.name : null; }

  /**
   * Last failed device opens per interface ({ control, touch }: message or null). Device Diagnostics
   * shows these when a device is enumerated but could not be opened (macOS Input Monitoring, another
   * process holding it). The active connector's view wins; otherwise the first connector reporting.
   */
  lastOpenErrors() {
    const out = { control: null, touch: null };
    const order = this.active ? [this.active, ...this.connectors.filter(c => c !== this.active)] : this.connectors;
    for (const c of order) {
      const e = c.impl.lastOpenError || {};
      if (!out.control && e.control) out.control = e.control;
      if (!out.touch && e.touch) out.touch = e.touch;
    }
    return out;
  }
}

module.exports = MultiKnob;
