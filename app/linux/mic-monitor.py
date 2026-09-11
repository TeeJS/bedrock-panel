#!/usr/bin/env python3
"""
mic-monitor.py — which applications are holding the microphone, for auto-record and the busy light.

The Linux answer to mic-session-monitor.exe / the macOS Core Audio monitor. PipeWire and PulseAudio
both expose capture streams through `pactl list source-outputs`, which is the same question Windows
asks of WASAPI sessions: not "is the mic on" but "who has it".

    mic-monitor.py "zoom,teams,chromium"     a JSON line per change: {"active": bool, "apps": [...]}

The allowlist is passed straight through from the app and parsed the same way it parses it — commas,
semicolons or spaces. Everything capturing is reported in `apps`, not just the allowlisted ones,
because the app re-derives its own answer per consumer: the recorder wants the first app on ITS list
and the busy light only wants to know whether any app on its own list is present. Filtering here
would make that impossible and has already caused one class of bug on Windows.

Names are reported in several forms per stream -- the application name, its binary, and its process
name -- because a Linux allowlist written by a person says "zoom" while the stream might identify
itself as "ZOOM VoiceEngine" or "zoom.real". Reporting all of them lets a short, obvious allowlist
match, and costs nothing: the app looks for ITS names in the list rather than the reverse.

Event-driven for the same reason as sysvolume.py: `pactl subscribe` is one process, polling would be
thousands an hour.
"""

import json
import re
import shutil
import subprocess
import sys
import threading


def parse_allowlist(text):
    return [p for p in re.split(r'[,;\s]+', str(text or '')) if p]


def capture_streams():
    """Every application currently capturing, as the set of names it could reasonably be called."""
    try:
        out = subprocess.run(['pactl', 'list', 'source-outputs'],
                             capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    names = []
    for block in out.split('Source Output #')[1:]:
        # A monitor source is the desktop's own loopback of what is PLAYING, not a microphone. Any
        # recorder or meter would otherwise look like a call in progress forever.
        if re.search(r'device\.class\s*=\s*"monitor"', block):
            continue
        found = []
        for key in ('application.process.binary', 'application.name', 'application.process.name'):
            m = re.search(r'%s\s*=\s*"([^"]*)"' % re.escape(key), block)
            if m and m.group(1):
                found.append(m.group(1))
        for name in found:
            if name not in names:
                names.append(name)
    return names


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


def emit(apps, last):
    line = json.dumps({'active': bool(apps), 'apps': apps})
    if line == last[0]:
        return
    last[0] = line
    try:
        sys.stdout.write(line + '\n')
        sys.stdout.flush()
    except (BrokenPipeError, ValueError):
        raise SystemExit(0)


def watch(_allow):
    last = [None]
    # The opening line is a baseline, and the app knows to treat it as one rather than as a call
    # ending, so it is sent even when nothing is capturing.
    emit(capture_streams(), last)
    try:
        proc = subprocess.Popen(subscribe_command(), stdout=subprocess.PIPE, text=True, bufsize=1)
    except OSError as exc:
        sys.stderr.write('cannot watch capture streams: %s\n' % exc)
        return 3

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
        if 'source-output' in line:
            emit(capture_streams(), last)
    return 0


def main():
    return watch(parse_allowlist(sys.argv[1] if len(sys.argv) > 1 else ''))


if __name__ == '__main__':
    sys.exit(main())
