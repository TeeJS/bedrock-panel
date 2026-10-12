'use strict';
// Web pages on the panel that ask for "a microphone" must get the mic chosen in Bedrock Panel, not the
// Windows default. dashboard-preload.js wraps the page's getUserMedia; driven here against a fake
// mediaDevices that, like Chromium, names devices only once the page has captured.
const test = require('node:test');
const assert = require('node:assert/strict');
const { installMicPreference } = require('../app/dashboard-preload');

const JABRA = 'Microphone (Jabra SPEAK 410 USB) (0b0e:0412)';
const DEVICES = [
  { kind: 'audioinput', label: 'Default - Microphone (3- Insta360 Link) (2e1a:4c01)', deviceId: 'default' },
  { kind: 'audioinput', label: 'Microphone (3- Insta360 Link) (2e1a:4c01)', deviceId: 'cam' },
  { kind: 'audioinput', label: JABRA, deviceId: 'jab' },
  { kind: 'videoinput', label: 'Insta360 Link', deviceId: 'v1' },
];

function fakeMedia({ namedFromStart = false, failOn = '' } = {}) {
  let captured = namedFromStart;
  const opens = [], stopped = [];
  const md = {
    async enumerateDevices() { return DEVICES.map(d => (captured ? d : Object.assign({}, d, { label: '' }))); },
    async getUserMedia(c) {
      const id = c.audio && c.audio.deviceId ? c.audio.deviceId.exact : 'cam';   // Chromium's default = the Insta360
      opens.push(id);
      if (failOn && id === failOn) throw Object.assign(new Error('Could not start audio source'), { name: 'NotReadableError' });
      captured = true;
      const track = { getSettings: () => ({ deviceId: id }), stop() { stopped.push(id); } };
      return { id, getAudioTracks: () => [track], getTracks: () => [track] };
    },
  };
  return { md, opens, stopped };
}

test('a page asking for any mic gets the chosen one, even before device names are available', async () => {
  const f = fakeMedia();
  assert.equal(installMicPreference(JABRA, f.md), true);
  const stream = await f.md.getUserMedia({ audio: true });
  assert.equal(stream.id, 'jab');
  assert.deepEqual(f.opens, ['cam', 'jab']);     // had to capture once to learn the names
  assert.deepEqual(f.stopped, ['cam']);          // the stand-in is released
  const again = await f.md.getUserMedia({ audio: { echoCancellation: true } });
  assert.equal(again.id, 'jab');
  assert.deepEqual(f.opens, ['cam', 'jab', 'jab']);   // names now known: straight to the chosen mic
});

test('a page that names its own device, or asks only for video, is left alone', async () => {
  const f = fakeMedia({ namedFromStart: true });
  installMicPreference(JABRA, f.md);
  assert.equal((await f.md.getUserMedia({ audio: { deviceId: { exact: 'cam' } } })).id, 'cam');
  await f.md.getUserMedia({ video: true });
  assert.deepEqual(f.opens, ['cam', 'cam']);
});

test('an unplugged or unopenable chosen mic falls back to what Chromium gives', async () => {
  const gone = fakeMedia({ namedFromStart: true });
  installMicPreference('Microphone (Blue Yeti)', gone.md);
  assert.equal((await gone.md.getUserMedia({ audio: true })).id, 'cam');
  assert.deepEqual(gone.opens, ['cam']);

  const busy = fakeMedia({ namedFromStart: true, failOn: 'jab' });
  installMicPreference(JABRA, busy.md);
  assert.equal((await busy.md.getUserMedia({ audio: true })).id, 'cam');
});

test('no chosen mic means no wrapper at all', () => {
  const f = fakeMedia();
  const original = f.md.getUserMedia;
  assert.equal(installMicPreference('', f.md), false);
  assert.equal(f.md.getUserMedia, original);
});

test('the wrapper still works when copied into a page as source (executeInMainWorld serializes it)', async () => {
  const vm = require('node:vm');
  const f = fakeMedia();
  const sandbox = { navigator: { mediaDevices: f.md }, Object, Promise, String };
  const copied = vm.runInNewContext('(' + installMicPreference.toString() + ')', sandbox);
  assert.equal(copied(JABRA), true);                 // reads navigator.mediaDevices in the page's own world
  assert.equal((await f.md.getUserMedia({ audio: true })).id, 'jab');
});
