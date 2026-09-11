#!/usr/bin/env python3
"""
mpris.py — what is playing on this computer, and the buttons that control it.

The Linux answer to smtc-monitor.exe / nowplaying-monitor: MPRIS, the D-Bus interface every media
application on a Linux desktop already publishes. Firefox, Chromium, VLC, Spotify, Elisa and the
rest all speak it, and KDE's and GNOME's own media controls read exactly this, so whatever the
desktop's media applet shows is what the panel shows.

Two jobs in one file because they are two argv shapes of one idea, and the helper table maps a
feature to a file:

    mpris.py                      monitor: a JSON line per change on stdout, "{}" when nothing plays
    mpris.py playpause|next|prev [target]     control: acts, prints "ok", exits

`target` is the player the panel is displaying, passed through from the snapshot's `app`. Targeting
matters with two players open: without it, "next" goes to whichever application currently owns the
media keys, which is not necessarily the one on screen.

Which player is "the" player: the one that is Playing, else the first that has a track. That matches
the rule the desktop's own applet uses and, more importantly, the rule the Windows helper uses --
otherwise a paused browser tab outranks the music actually playing.

Units are the ones the app already expects from the Windows helper: position and duration in
SECONDS, status as "Playing" / "Paused" / "Stopped". Art comes free here, as a URL in the metadata,
where Windows needs a second helper to extract a thumbnail.

Exits on stdin EOF, the parent-death guard every helper in this project uses.
"""

import json
import sys
import threading

try:
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib
except Exception as exc:  # noqa: BLE001
    sys.stdout.write('{}\n')
    sys.stdout.flush()
    sys.stderr.write('PyGObject missing: %s\n' % exc)
    sys.exit(4)

MPRIS_PREFIX = 'org.mpris.MediaPlayer2.'
OBJECT = '/org/mpris/MediaPlayer2'
PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player'
PROPS_IFACE = 'org.freedesktop.DBus.Properties'

# Position has no change signal — it simply advances — so it is read on a timer. One second matches
# the Windows helper's effective rate and is what a progress bar needs.
TICK_MS = 1000


def bus():
    return Gio.bus_get_sync(Gio.BusType.SESSION, None)


def players(conn):
    """Every MPRIS player on the bus, in a stable order."""
    reply = conn.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                           'ListNames', None, GLib.VariantType.new('(as)'),
                           Gio.DBusCallFlags.NONE, 3000, None)
    return sorted(n for n in reply[0] if n.startswith(MPRIS_PREFIX))


def prop(conn, name, key):
    try:
        reply = conn.call_sync(name, OBJECT, PROPS_IFACE, 'Get',
                               GLib.Variant('(ss)', (PLAYER_IFACE, key)),
                               GLib.VariantType.new('(v)'), Gio.DBusCallFlags.NONE, 2000, None)
        return reply[0]
    except GLib.Error:
        return None


def snapshot_of(conn, name):
    """One player's state in the shape the app already reads, or None when it has no track."""
    meta = prop(conn, name, 'Metadata') or {}
    status = prop(conn, name, 'PlaybackStatus') or 'Stopped'
    title = meta.get('xesam:title') or ''
    if not title:
        return None
    artists = meta.get('xesam:artist') or []
    if isinstance(artists, str):
        artists = [artists]
    length = meta.get('mpris:length') or 0          # microseconds
    position = prop(conn, name, 'Position') or 0    # microseconds
    return {
        'title': title,
        'artist': ', '.join(a for a in artists if a) or None,
        'album': meta.get('xesam:album') or None,
        'status': status,
        'app': name[len(MPRIS_PREFIX):],
        'position': round(position / 1e6, 1),
        'duration': round(length / 1e6, 1),
        'art': meta.get('mpris:artUrl') or None,
    }


def choose(conn):
    """
    The player the panel should show, and whether "nothing" is a fact or a guess.

    Returns (snapshot, certain). `certain` is what stops a transient D-Bus hiccup from being
    reported as silence: reading a player takes three round trips to another process, any of which
    can time out while that application is busy, and a helper that answers "{}" on a slow read tells
    the app the music stopped. The app believes it -- "{}" is defined as no media session -- and
    clears the display. With a player on the bus but unreadable this instant, the honest answer is
    to say nothing and let the last line stand.
    """
    names = players(conn)
    if not names:
        return None, True            # no player on the bus at all: genuinely nothing playing
    best = None
    for name in names:
        snap = snapshot_of(conn, name)
        if not snap:
            continue
        if snap['status'] == 'Playing':
            return snap, True
        if best is None:
            best = snap
    return best, best is not None


def monitor():
    conn = bus()
    last = {'line': None}
    loop = GLib.MainLoop()

    def emit():
        snap, certain = choose(conn)
        if not snap and not certain:
            return True              # players exist but could not be read: keep the last line
        line = json.dumps(snap, sort_keys=True) if snap else '{}'
        if line != last['line']:
            last['line'] = line
            try:
                sys.stdout.write(line + '\n')
                sys.stdout.flush()
            except (BrokenPipeError, ValueError):
                # Whoever was reading has gone. That is how this helper is meant to end.
                loop.quit()
                return False
        return True

    # Players appearing and disappearing, and any of them changing what they are doing. Both matter:
    # a player that quits must clear the panel, not leave the last track showing forever.
    conn.signal_subscribe(None, PROPS_IFACE, 'PropertiesChanged', OBJECT, None,
                          Gio.DBusSignalFlags.NONE, lambda *a: emit(), None)
    conn.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                          '/org/freedesktop/DBus', None, Gio.DBusSignalFlags.NONE,
                          lambda *a: emit(), None)
    GLib.timeout_add(TICK_MS, emit)
    emit()

    def wait_for_parent():
        try:
            for _ in sys.stdin:
                pass
        except (OSError, ValueError):
            pass
        loop.quit()

    threading.Thread(target=wait_for_parent, daemon=True).start()
    loop.run()
    return 0


def control(command, target=''):
    method = {'playpause': 'PlayPause', 'next': 'Next', 'prev': 'Previous'}.get(command)
    if not method:
        sys.stdout.write('err unknown command\n')
        return 2
    conn = bus()
    names = players(conn)
    # The displayed player first. Falling back to whoever is playing keeps the buttons working when
    # the panel's snapshot is a moment stale, which is better than doing nothing.
    wanted = [n for n in names if target and n[len(MPRIS_PREFIX):] == target]
    if not wanted:
        wanted = [n for n in names if (prop(conn, n, 'PlaybackStatus') or '') == 'Playing'] or names
    for name in wanted:
        try:
            conn.call_sync(name, OBJECT, PLAYER_IFACE, method, None, None,
                           Gio.DBusCallFlags.NONE, 3000, None)
            sys.stdout.write('ok\n')
            return 0
        except GLib.Error:
            continue
    sys.stdout.write('err no player\n')
    return 1


def main():
    if len(sys.argv) > 1:
        return control(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else '')
    return monitor()


if __name__ == '__main__':
    sys.exit(main())
