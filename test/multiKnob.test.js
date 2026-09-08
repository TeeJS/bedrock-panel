'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MultiKnob = require('../app/multiKnob');
const BedrockConnector = require('../src/BedrockConnector');
const Aris68Connector = require('../src/Aris68Connector');

function failingHid(message) {
  return {
    devices() { throw new Error(message); },
    HID: class {},
  };
}

test('Bedrock start contains synchronous HID enumeration failures and keeps retrying', t => {
  const connector = new BedrockConnector({ hid: failingHid('bedrock enumeration failed'), rescanMs: 60000 });
  t.after(() => connector.stop());
  const errors = [];
  connector.on('error', error => errors.push(error));

  assert.doesNotThrow(() => connector.start());
  assert.equal(connector._running, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /bedrock enumeration failed/);

});

test('ARIS start contains synchronous HID enumeration failures and keeps retrying', t => {
  const connector = new Aris68Connector({ hid: failingHid('aris enumeration failed'), rescanMs: 60000 });
  t.after(() => connector.stop());
  const errors = [];
  connector.on('error', error => errors.push(error));

  assert.doesNotThrow(() => connector.start());
  assert.equal(connector._running, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /aris enumeration failed/);

});

test('MultiKnob starts remaining backends when one backend start throws', () => {
  const hid = { devices: () => [], HID: class {} };
  const knob = new MultiKnob({ hid, rescanMs: 60000 });
  const errors = [];
  let arisStarted = false;
  knob.on('error', error => errors.push(error));
  knob.connectors[0].impl.start = () => { throw new Error('bedrock start exploded'); };
  knob.connectors[1].impl.start = () => { arisStarted = true; };

  assert.doesNotThrow(() => knob.start());
  assert.equal(arisStarted, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].connector, 'bedrock');
  assert.equal(errors[0].phase, 'start');
  assert.match(errors[0].message, /bedrock start failed.*bedrock start exploded/i);
});

test('lastOpenErrors merges the connectors, preferring the active one', () => {
  const hid = { devices: () => [], HID: class {} };
  const knob = new MultiKnob({ hid, rescanMs: 60000 });
  knob.connectors[0].impl.lastOpenError = { control: null };
  knob.connectors[1].impl.lastOpenError = { control: 'aris control refused', touch: 'aris touch refused' };
  assert.deepEqual(knob.lastOpenErrors(), { control: 'aris control refused', touch: 'aris touch refused' });
  knob.connectors[0].impl.lastOpenError = { control: 'bedrock refused' };
  knob.active = knob.connectors[0];
  assert.deepEqual(knob.lastOpenErrors(), { control: 'bedrock refused', touch: 'aris touch refused' });
});
