'use strict';
// Now playing on Linux, read straight off the session bus. Everything here is the shaping of what
// the bus returns: unwrapping variants, choosing between players, artwork, and the units the app
// reads. No bus is contacted, so it runs on any platform.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const np = require('../app/linuxNowPlaying');

// How dbus-next hands values back: everything in an a{sv} is a Variant, and a 64-bit integer is a
// BigInt because it does not fit a double.
const v = (signature, value) => ({ signature, value });
const player = (over = {}) => Object.assign({
  PlaybackStatus: v('s', 'Playing'),
  Position: v('x', 62500000n),
  Metadata: v('a{sv}', Object.assign({
    'xesam:title': v('s', 'Oblivion'),
    'xesam:artist': v('as', ['Grimes']),
    'xesam:album': v('s', 'Visions'),
    'mpris:length': v('x', 251000000n),
  }, over.meta || {})),
}, over.props || {});

test('a variant tree comes back as plain values, BigInts included', () => {
  assert.equal(np.plain(v('s', 'hello')), 'hello');
  assert.equal(np.plain(v('x', 251000000n)), 251000000);
  assert.deepEqual(np.plain(v('as', ['a', 'b'])), ['a', 'b']);
  // Metadata is a variant holding a dictionary of variants: both layers have to come off, or the
  // artist list is a Variant and nothing downstream can read it.
  assert.deepEqual(np.plain(v('a{sv}', { 'xesam:artist': v('as', ['Grimes']) })), { 'xesam:artist': ['Grimes'] });
});

test('a track arrives in the units and fields the app already reads', () => {
  const s = np.snapshotFrom('org.mpris.MediaPlayer2.vlc', player());
  assert.equal(s.title, 'Oblivion');
  assert.equal(s.artist, 'Grimes');
  assert.equal(s.album, 'Visions');
  assert.equal(s.status, 'Playing');
  assert.equal(s.app, 'vlc', 'the app name drops the MPRIS prefix, since transport targets it');
  // MPRIS reports microseconds. Passing those through would show a progress bar a million times
  // too long, which is what the Windows helper's seconds contract exists to prevent.
  assert.equal(s.position, 62.5);
  assert.equal(s.duration, 251);
});

test('several artists read as one line, and missing fields are null rather than empty', () => {
  const many = np.snapshotFrom('org.mpris.MediaPlayer2.x', player({ meta: { 'xesam:artist': v('as', ['A', '', 'B']) } }));
  assert.equal(many.artist, 'A, B');
  const bare = np.snapshotFrom('org.mpris.MediaPlayer2.x', player({ meta: { 'xesam:artist': v('as', []), 'xesam:album': v('s', '') } }));
  assert.equal(bare.artist, null);
  assert.equal(bare.album, null);
});

test('a player holding no track is not a track', () => {
  // Browsers keep an MPRIS name alive with an empty Metadata between videos. Reporting that would
  // put a blank row on the Music page.
  assert.equal(np.snapshotFrom('org.mpris.MediaPlayer2.firefox', { Metadata: v('a{sv}', {}) }), null);
  assert.equal(np.snapshotFrom('org.mpris.MediaPlayer2.firefox', {}), null);
});

test('playing beats paused, so a paused tab cannot outrank the music', () => {
  const playing = np.snapshotFrom('org.mpris.MediaPlayer2.spotify', player());
  const paused = np.snapshotFrom('org.mpris.MediaPlayer2.firefox', player({ props: { PlaybackStatus: v('s', 'Paused') } }));
  assert.equal(np.pick([paused, playing], true).snapshot.app, 'spotify');
  assert.equal(np.pick([paused], true).snapshot.app, 'firefox', 'paused is still something to show');
});

test('a player that cannot be read this instant is not reported as silence', () => {
  // null means the app clears the display. Reading a player is a round trip into another
  // application, which can fail while that application is busy — saying "nothing" then tells the
  // page the music stopped, and the page believes it.
  assert.deepEqual(np.pick([], false), { snapshot: null, certain: true }, 'an empty bus is genuinely nothing');
  const guess = np.pick([null, null], true);
  assert.equal(guess.snapshot, null);
  assert.equal(guess.certain, false, 'unreadable players must leave the last snapshot standing');
});

test("a web player's Spotify link becomes a track URI, so the cover lookup can use it", () => {
  // Firefox playing the Spotify web player reports the page URL. nowplaying.js already knows how to
  // turn a track URI into a cover through Spotify's public oEmbed endpoint.
  assert.equal(np.spotifyTrack('https://open.spotify.com/track/39VxarnBZV8POFPXvnAD2U'), 'spotify:track:39VxarnBZV8POFPXvnAD2U');
  assert.equal(np.spotifyTrack('https://example.com/track/1'), null);
  assert.equal(np.spotifyTrack(undefined), null);
  const s = np.snapshotFrom('org.mpris.MediaPlayer2.firefox', player({ meta: { 'xesam:url': v('s', 'https://open.spotify.com/track/abc123') } }));
  assert.equal(s.trackId, 'spotify:track:abc123');
});

test('an http cover passes through and a local one is read from disk', async () => {
  assert.equal(np.artUrl('https://example.com/cover.jpg'), 'https://example.com/cover.jpg');
  assert.equal(np.artUrl(''), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-art-'));
  const file = path.join(dir, 'cover.png');
  fs.writeFileSync(file, png(600, 600));
  const url = 'file://' + file;
  assert.equal(np.artUrl(url), null, 'the first look starts the read rather than blocking on it');
  await new Promise(r => setTimeout(r, 60));
  assert.match(np.artUrl(url), /^data:image\/png;base64,/, 'the page cannot load a path, only a URL');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a favicon-sized thumbnail is refused so a real cover can be looked up', () => {
  // A browser publishes its own 44-pixel thumbnail, which would be a smear across a 1920x480 panel.
  // Refusing it leaves the artwork unset, and the Spotify and iTunes lookups fill it in.
  assert.equal(np.tooSmall(png(44, 44)), true);
  assert.equal(np.tooSmall(png(600, 600)), false);
  assert.equal(np.tooSmall(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), false, 'a player writing a JPEG wrote a real cover');
  assert.equal(np.tooSmall(Buffer.alloc(4)), false);
});

test('nothing is attempted off Linux or without a session bus', () => {
  assert.equal(np.available('win32', { DBUS_SESSION_BUS_ADDRESS: 'x' }), false);
  assert.equal(np.available('darwin', { DBUS_SESSION_BUS_ADDRESS: 'x' }), false);
  assert.equal(np.available('linux', {}), false, 'no session bus means no MPRIS');
});

// A PNG states its size in the IHDR chunk that always starts the file.
function png(width, height) {
  const buf = Buffer.alloc(24);
  buf.write('\x89PNG', 0, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}
