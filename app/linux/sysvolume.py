#!/usr/bin/env python3
"""
sysvolume.py — the real output volume, for the meeting console's output rail.

The Linux answer to sysvolume.exe / the macOS sysvolume helper. PipeWire (and PulseAudio before it)
answers this through `pactl`, which every desktop audio stack on Linux provides, so there is nothing
to install and nothing desktop-specific here.

    sysvolume.py          one-shot: print 'LEVEL MUTE' once and exit (LEVEL 0-100 or -1; MUTE 1/0/-1)
    sysvolume.py watch    one integer percentage per line, on change, until stdin closes

The no-arg one-shot matches sysvolume.exe and the macOS helper; the settings editor's mic/speaker test
uses it for a single click-time read of both the level and the mute flag. `watch` stays level-only (a
bare integer per line) so the meeting console's output rail, which parses that, is unchanged. `watch` is event-driven rather than polled, deliberately:
`pactl subscribe` is one long-lived process that says when something changed; polling twice a second
would mean thousands of short-lived processes an hour with the meeting page open, which is exactly the
churn the Windows helper was rewritten to avoid and which endpoint-security tools flag as malware-like.

Reads the DEFAULT sink, so it follows the output the person actually switched to rather than pinning
itself to whatever was default at launch.
"""

import re
import shutil
import subprocess
import sys
import threading

SINK = '@DEFAULT_SINK@'


def read_muted():
    """True/False if the default sink is muted, or None when it cannot be read."""
    try:
        out = subprocess.run(['pactl', 'get-sink-mute', SINK],
                             capture_output=True, text=True, timeout=5).stdout.lower()
    except (OSError, subprocess.SubprocessError):
        return None
    if 'yes' in out:
        return True
    if 'no' in out:
        return False
    return None


def read_volume():
    """The default sink's volume as a percentage, or None when it cannot be read."""
    try:
        out = subprocess.run(['pactl', 'get-sink-volume', SINK],
                             capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    # "Volume: front-left: 65536 / 100% / 0.00 dB,   front-right: ..." -- the channels can differ, so
    # take the loudest: that is what a person means by "the volume".
    percents = [int(m) for m in re.findall(r'/\s*(\d+)%', out)]
    return max(percents) if percents else None


def subscribe_command():
    """`pactl subscribe`, made to flush.

    pactl block-buffers when its output is a pipe rather than a terminal, so its events sit in a 4 KB
    buffer and arrive in a burst or never. That is not a theory: watching a volume change produced
    nothing until the process was killed. stdbuf forces line buffering; without it the subscription
    is useless, so a system that somehow lacks coreutils falls back to the unbuffered pactl and this
    helper simply reports less often rather than not running.
    """
    if shutil.which('stdbuf'):
        return ['stdbuf', '-oL', 'pactl', 'subscribe']
    return ['pactl', 'subscribe']


def emit(value, last):
    if value is None or value == last[0]:
        return last[0]
    last[0] = value
    try:
        sys.stdout.write('%d\n' % value)
        sys.stdout.flush()
    except (BrokenPipeError, ValueError):
        raise SystemExit(0)
    return value


def watch():
    last = [None]
    emit(read_volume(), last)
    try:
        proc = subprocess.Popen(subscribe_command(), stdout=subprocess.PIPE, text=True, bufsize=1)
    except OSError as exc:
        sys.stderr.write('cannot watch audio changes: %s\n' % exc)
        return 3

    # The parent going away closes our stdin; kill the subscription so we do not outlive it.
    def wait_for_parent():
        try:
            for _ in sys.stdin:
                pass
        except (OSError, ValueError):
            pass
        try:
            proc.terminate()
        except OSError:
            pass

    threading.Thread(target=wait_for_parent, daemon=True).start()
    for line in proc.stdout:
        # Sink events cover volume, mute and the default output changing. Anything else here is
        # someone else's stream starting, which does not move the volume.
        if "on sink" in line or "on server" in line:
            emit(read_volume(), last)
    return 0


def once():
    """Print 'LEVEL MUTE' once and exit — the no-arg mode used by the settings editor's audio test.
    LEVEL is 0-100 (or -1 if unreadable); MUTE is 1 (muted), 0 (not muted) or -1 (unreadable)."""
    value = read_volume()
    muted = read_muted()
    lvl = value if value is not None else -1
    mu = '1' if muted is True else '0' if muted is False else '-1'
    try:
        sys.stdout.write('%d %s' % (lvl, mu))
        sys.stdout.flush()
    except (BrokenPipeError, ValueError):
        return 1
    return 0 if (value is not None or muted is not None) else 1


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else ''
    if arg == 'watch':
        return watch()
    if arg:
        sys.stderr.write('usage: sysvolume.py [watch]\n')
        return 2
    return once()


if __name__ == '__main__':
    sys.exit(main())
