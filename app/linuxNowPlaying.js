'use strict';
/*
 * linuxNowPlaying.js — what is playing on this computer, read straight from D-Bus in this process.
 *
 * MPRIS (org.mpris.MediaPlayer2) is the interface every media application on a Linux desktop already
 * publishes: Firefox, Chromium, Spotify, VLC, Elisa, mpv and the rest. KDE's and GNOME's own media
 * applets read exactly this, so whatever the desktop shows is what the panel shows.
 *
 * This talks to the session bus directly with dbus-next, the way node-dbus-next's own MPRIS example
 * and the published Node/Electron media clients do, rather than through a helper process. The helper
 * that used to do this job worked perfectly when run by hand and delivered nothing at all to the
 * packaged app: it wrote a line a second into its stdout socket while the app's stream for it sat
 * readable, flowing, with a listener attached and bytesRead=0 forever. Reading the bus here removes
 * that whole transport -- there is no pipe to go wrong, no process to respawn, and no python3 to
 * depend on -- and it is a smaller amount of code than the helper was.
 *
 * The low-level Message API is used rather than proxy objects on purpose: a proxy costs an
 * Introspect round trip per player and fails outright on players whose introspection XML is broken,
 * while Properties.GetAll is one call that every MPRIS implementation answers.
 *
 * Snapshots come out in the shape nowplaying.js already reads from the Windows and macOS helpers:
 * seconds rather than MPRIS's microseconds, "Playing" / "Paused" / "Stopped", and null for a field a
 * player does not supply.
 */
const fs = require('fs');

const OBJECT = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const PROPS = 'org.freedesktop.DBus.Properties';
const PREFIX = 'org.mpris.MediaPlayer2.';
const BUS = { path: '/org/freedesktop/DBus', destination: 'org.freedesktop.DBus', interface: 'org.freedesktop.DBus' };

// Position simply advances; no player signals it. One second is what a progress bar needs and is the
// rate the Windows helper effectively ran at.
const TICK_MS = 1000;
const ART_MAX = 4 * 1024 * 1024;   // a cover a player wrote to disk; anything larger is not a cover
const ART_MIN_PX = 200;            // below this it is an icon, not a cover -- see artUrl

let dbus = null;
let bus = null, timer = null, onSnapshot = null, running = false;
const artData = {};    // file:// URL -> data: URL | null  (read once)

function log(message) { console.log('[nowplaying] ' + message); }

/** dbus-next, or null where it is not installed. Required lazily so Windows and macOS never load it. */
function library() {
  if (dbus === null) {
    try { dbus = require('dbus-next'); }
    catch (e) { dbus = false; log('dbus-next is not available — ' + (e && e.message)); }
  }
  return dbus || null;
}

/** Whether this machine can be asked at all: Linux, with a session bus and the library present. */
function available(platform = process.platform, env = process.env) {
  if (platform !== 'linux') return false;
  if (!env.DBUS_SESSION_BUS_ADDRESS && !env.XDG_RUNTIME_DIR) return false;
  return !!library();
}

function call(options) {
  const { Message } = library();
  return bus.call(new Message(options));
}

/** Ask the bus which MPRIS players exist right now. Cheap: a local round trip to dbus-daemon. */
async function players() {
  const reply = await call(Object.assign({ member: 'ListNames' }, BUS));
  return (reply.body[0] || []).filter(n => n.startsWith(PREFIX)).sort();
}

/**
 * Unwrap what the bus hands back into ordinary JavaScript.
 *
 * Every value in an a{sv} arrives wrapped in a Variant -- including the values inside Metadata, which
 * is itself a Variant holding a dictionary of Variants -- and mpris:length arrives as a BigInt
 * because it does not fit a double. Unwrapping the whole thing once here keeps that detail out of
 * the snapshot code.
 */
function plain(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    if ('value' in value && 'signature' in value) return plain(value.value);
    const out = {};
    for (const key of Object.keys(value)) out[key] = plain(value[key]);
    return out;
  }
  return value;
}

/**
 * A player's cover, as something the page can put in an <img>.
 *
 * Players hand out an artUrl, and on Linux it is usually a file:// path to a thumbnail the player
 * wrote itself (Firefox does exactly this). The page is not served from that directory, so the file
 * is read once and turned into a data: URL; an http(s) artUrl is already usable and passes through.
 */
function artUrl(url) {
  if (!url || !url.startsWith('file://')) return url || null;
  if (url in artData) return artData[url];
  artData[url] = null;                       // claim it, so a slow read is not started twice
  const file = decodeURIComponent(url.slice('file://'.length));
  fs.stat(file, (err, st) => {
    if (err || !st.isFile() || st.size > ART_MAX) return;
    fs.readFile(file, (readErr, buf) => {
      if (readErr || tooSmall(buf)) return;   // stays null, so the online cover lookup runs instead
      artData[url] = 'data:' + artMime(file) + ';base64,' + buf.toString('base64');
    });
  });
  return null;
}
function artMime(file) {
  const ext = file.toLowerCase().slice(file.lastIndexOf('.') + 1);
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext] || 'image/png';
}
/**
 * Whether a player's artwork is too small to show.
 *
 * A browser playing from a web player publishes its own favicon-sized thumbnail -- Firefox writes a
 * 44-pixel PNG -- which would look like a smear across a 1920x480 panel. A PNG says its size in the
 * IHDR chunk that always starts the file, so it costs nothing to check, and a thumbnail rejected
 * here falls through to the Spotify and iTunes cover lookups that already back this page up. Anything
 * that is not a PNG is accepted: a player that goes to the trouble of writing a JPEG cover wrote a
 * real one.
 */
function tooSmall(buf) {
  if (!buf || buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') return false;
  return Math.max(buf.readUInt32BE(16), buf.readUInt32BE(20)) < ART_MIN_PX;
}

/**
 * Spotify's track URI, when the player is playing something from Spotify.
 *
 * Firefox's Spotify tab reports the web player's https URL in xesam:url. The art lookup in
 * nowplaying.js already knows how to turn a spotify:track: URI into a cover through Spotify's public
 * oEmbed endpoint, so converting it here gets the web player real album art instead of the browser's
 * favicon-sized thumbnail.
 */
function spotifyTrack(url) {
  const m = /^https?:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]+)/.exec(String(url || ''));
  return m ? 'spotify:track:' + m[1] : null;
}

/** One player's state, or null when it holds no track or cannot be read this instant. */
async function snapshotOf(name) {
  try {
    const reply = await call({ path: OBJECT, destination: name, interface: PROPS, member: 'GetAll', signature: 's', body: [PLAYER] });
    return snapshotFrom(name, reply.body[0] || {});
  } catch (e) { return null; }
}

/** The player properties as they come off the bus, in the shape the app reads. Null means no track. */
function snapshotFrom(name, all) {
  const meta = plain(all.Metadata) || {};
  const title = meta['xesam:title'] || '';
  if (!title) return null;
  let artists = meta['xesam:artist'] || [];
  if (typeof artists === 'string') artists = [artists];
  return {
    title: String(title),
    artist: artists.filter(Boolean).join(', ') || null,
    album: meta['xesam:album'] || null,
    status: plain(all.PlaybackStatus) || 'Stopped',
    app: name.slice(PREFIX.length),
    position: Math.round((plain(all.Position) || 0) / 1e5) / 10,
    duration: Math.round((meta['mpris:length'] || 0) / 1e5) / 10,
    art: artUrl(meta['mpris:artUrl']),
    trackId: spotifyTrack(meta['xesam:url']),
  };
}

/**
 * The player the panel should show, and whether "nothing" is a fact or a guess.
 *
 * Playing beats paused, which is the rule the desktop's own applet uses and the rule the Windows
 * helper uses: otherwise a paused browser tab outranks the music actually playing. `certain` is
 * false when players exist but none could be read — a momentary failure is not silence, and saying
 * so would clear the display of a track that is still playing.
 */
function pick(snapshots, anyPlayers) {
  if (!anyPlayers) return { snapshot: null, certain: true };
  const readable = snapshots.filter(Boolean);
  const playing = readable.find(s => s.status === 'Playing');
  const best = playing || readable[0] || null;
  return { snapshot: best, certain: !!best };
}

async function choose() {
  const names = await players();
  if (!names.length) return pick([], false);
  const snapshots = [];
  for (const name of names) {
    const snap = await snapshotOf(name);
    if (snap && snap.status === 'Playing') return pick([snap], true);   // a playing player ends the search
    snapshots.push(snap);
  }
  return pick(snapshots, true);
}

async function tick() {
  if (!running) return;
  let result;
  try { result = await choose(); } catch (e) { return; }
  if (!running || (!result.snapshot && !result.certain)) return;
  if (onSnapshot) onSnapshot(result.snapshot);
}

/** Tell the bus we want change signals, so a track change shows before the next tick. */
async function watchSignals() {
  const rules = [
    "type='signal',interface='" + PROPS + "',member='PropertiesChanged',path='" + OBJECT + "'",
    "type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0namespace='org.mpris.MediaPlayer2'",
  ];
  for (const rule of rules) {
    try { await call(Object.assign({ member: 'AddMatch', signature: 's', body: [rule] }, BUS)); } catch (e) {}
  }
  bus.on('message', msg => {
    if (msg && (msg.member === 'PropertiesChanged' || msg.member === 'NameOwnerChanged')) tick();
  });
}

function start(callback) {
  if (running) return true;
  if (!available()) return false;
  const lib = library();
  try { bus = lib.sessionBus(); }
  catch (e) { log('could not reach the session bus — ' + (e && e.message)); bus = null; return false; }
  bus.on('error', e => log('session bus error — ' + (e && e.message)));
  running = true;
  onSnapshot = typeof callback === 'function' ? callback : null;
  log('reading MPRIS on the session bus');
  watchSignals().catch(() => {});
  tick();
  timer = setInterval(tick, TICK_MS);
  return true;
}

function stop() {
  running = false;
  onSnapshot = null;
  if (timer) clearInterval(timer);
  timer = null;
  if (bus) { try { bus.disconnect(); } catch (e) {} }
  bus = null;
  for (const k in artData) delete artData[k];
}

/**
 * Press a transport button on a player. `target` is the `app` from the snapshot the panel is
 * showing, so with two players open the buttons drive the one on screen rather than whichever
 * application currently owns the media keys. Resolves false when nothing could be acted on, which
 * is the caller's cue to fall back to a media-key tap.
 */
async function control(command, target) {
  const member = { playpause: 'PlayPause', next: 'Next', prev: 'Previous' }[command];
  if (!member || !available()) return false;
  const own = !bus;
  const lib = library();
  if (own) { try { bus = lib.sessionBus(); } catch (e) { return false; } }
  try {
    const names = await players();
    let wanted = names.filter(n => target && n.slice(PREFIX.length) === target);
    if (!wanted.length) {
      const playing = [];
      for (const name of names) {
        const snap = await snapshotOf(name);
        if (snap && snap.status === 'Playing') playing.push(name);
      }
      wanted = playing.length ? playing : names;
    }
    for (const name of wanted) {
      try {
        await call({ path: OBJECT, destination: name, interface: PLAYER, member });
        return true;
      } catch (e) {}
    }
    return false;
  } catch (e) {
    return false;
  } finally {
    if (own && bus) { try { bus.disconnect(); } catch (e) {} bus = null; }
  }
}

module.exports = { available, start, stop, control, artUrl, spotifyTrack, plain, tooSmall, snapshotFrom, pick, _internals: { snapshotOf, choose } };
