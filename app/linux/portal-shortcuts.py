#!/usr/bin/env python3
"""
portal-shortcuts.py — global hotkeys on Linux, through the XDG GlobalShortcuts portal.

Why the portal and not Electron: `globalShortcut.register` returns true under XWayland and the
shortcut never fires, even when the key is pressed by a real kernel-level keyboard (measured with
this project's own uinput device). X11 key grabs do not reach an application through XWayland, and
Wayland has no key-grab protocol at all. The portal is the only sanctioned route.

Why Python and not JavaScript: the portal answers a request with a signal addressed to the exact
D-Bus connection that made the call. Command-line tools cannot be used — each `gdbus call` is its own
short-lived connection, so the reply lands nowhere — and Node has no D-Bus client without adding a
dependency. PyGObject gives a real persistent connection, and python3 is already required for the
keyboard helper.

What the desktop does with it: the app registers NAMED ACTIONS and proposes a trigger, and the
desktop decides whether to honour the proposal. KDE Plasma 6.6 honours it. It shows one "Global
Shortcuts Requested" dialog listing the actions with the proposed keys filled in; OK binds them and
they fire (measured by pressing them with this project's own uinput keyboard). The name in that
dialog comes from the process's systemd scope, so it reads "Bedrock Panel" when launched from the
desktop entry -- and something else entirely when launched from a terminal, which is worth knowing
before believing a test run.

BindShortcuts does not answer until the dialog is dealt with. Ignore it or cancel it and the actions
stay registered with no key, `trigger_description` comes back empty, and the keys can still be
assigned by hand in System Settings -> Shortcuts. An empty trigger therefore means "not bound yet",
never "this desktop refuses to bind".

Protocol:
    argv[1]  JSON array of {"id": "...", "description": "...", "trigger": "CTRL+ALT+s"}
    stdout   `ready <json of id -> trigger_description>` once bound, then `activated <id>` per press,
             `changed <json>` when the desktop rebinds something, `err <reason>` on failure.
    stdin    closed => exit (the parent-death guard the other helpers use).
"""

import json
import sys
import uuid

try:
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib
except Exception as exc:  # noqa: BLE001 - any import problem means the same thing to the caller
    sys.stdout.write('err PyGObject missing: %s\n' % exc)
    sys.stdout.flush()
    sys.exit(4)

BUS = 'org.freedesktop.portal.Desktop'
OBJ = '/org/freedesktop/portal/desktop'
IFACE = 'org.freedesktop.portal.GlobalShortcuts'
REQUEST_IFACE = 'org.freedesktop.portal.Request'


def out(line):
    sys.stdout.write(line + '\n')
    sys.stdout.flush()


class Shortcuts:
    def __init__(self, wanted):
        self.wanted = wanted
        self.conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        # The portal derives a request's object path from the caller's unique name, so a reply can be
        # subscribed to BEFORE the call is made. Doing it after is a race the portal spec warns about.
        self.sender = self.conn.get_unique_name()[1:].replace('.', '_')
        self.token = 'bedrock' + uuid.uuid4().hex[:8]
        self.loop = GLib.MainLoop()
        self.session = None

    def request_path(self, token):
        return '/org/freedesktop/portal/desktop/request/%s/%s' % (self.sender, token)

    def subscribe_response(self, token, handler):
        self.conn.signal_subscribe(BUS, REQUEST_IFACE, 'Response', self.request_path(token), None,
                                   Gio.DBusSignalFlags.NONE, handler, None)

    def call(self, method, args):
        self.conn.call_sync(BUS, OBJ, IFACE, method, args, None, Gio.DBusCallFlags.NONE, 15000, None)

    # ---- step 1: a session ----
    def start(self):
        self.conn.signal_subscribe(BUS, IFACE, 'Activated', OBJ, None, Gio.DBusSignalFlags.NONE,
                                   self.on_activated, None)
        self.conn.signal_subscribe(BUS, IFACE, 'ShortcutsChanged', OBJ, None, Gio.DBusSignalFlags.NONE,
                                   self.on_changed, None)
        self.subscribe_response(self.token, self.on_session)
        opts = {'handle_token': GLib.Variant('s', self.token),
                'session_handle_token': GLib.Variant('s', self.token)}
        self.call('CreateSession', GLib.Variant('(a{sv})', (opts,)))

    def on_session(self, _c, _s, _p, _i, _sig, params, _u):
        code, results = params.unpack()
        if code != 0 or 'session_handle' not in results:
            out('err session refused (code %s)' % code)
            self.loop.quit()
            return
        self.session = results['session_handle']
        bind_token = self.token + 'b'
        self.subscribe_response(bind_token, self.on_bound)
        shortcuts = []
        for s in self.wanted:
            meta = {'description': GLib.Variant('s', s.get('description') or s['id'])}
            if s.get('trigger'):
                meta['preferred_trigger'] = GLib.Variant('s', s['trigger'])
            shortcuts.append((s['id'], meta))
        args = GLib.Variant('(oa(sa{sv})sa{sv})',
                            (self.session, shortcuts, '', {'handle_token': GLib.Variant('s', bind_token)}))
        self.call('BindShortcuts', args)

    # ---- step 2: the bindings the desktop actually granted ----
    def on_bound(self, _c, _s, _p, _i, _sig, params, _u):
        code, results = params.unpack()
        if code != 0:
            out('err bind refused (code %s)' % code)
            self.loop.quit()
            return
        out('ready ' + json.dumps(self.triggers(results.get('shortcuts', []))))

    @staticmethod
    def triggers(shortcuts):
        # An empty trigger_description means the desktop took the action but bound no key to it yet.
        return {sid: (meta or {}).get('trigger_description', '') for sid, meta in shortcuts}

    def on_changed(self, _c, _s, _p, _i, _sig, params, _u):
        unpacked = params.unpack()
        shortcuts = unpacked[1] if len(unpacked) > 1 else []
        out('changed ' + json.dumps(self.triggers(shortcuts)))

    def on_activated(self, _c, _s, _p, _i, _sig, params, _u):
        out('activated ' + params.unpack()[1])


def main():
    if len(sys.argv) < 2:
        out('err no shortcuts given')
        return 2
    try:
        wanted = json.loads(sys.argv[1])
        assert isinstance(wanted, list) and all('id' in s for s in wanted)
    except Exception:  # noqa: BLE001
        out('err shortcuts must be a JSON array of objects with an id')
        return 2
    if not wanted:
        out('err no shortcuts given')
        return 2

    try:
        app = Shortcuts(wanted)
        app.start()
    except GLib.Error as exc:
        out('err portal unavailable: %s' % exc.message)
        return 3

    # Exit when the parent closes our stdin, same contract as the other helpers.
    def on_stdin(channel, condition):
        if condition & (GLib.IOCondition.HUP | GLib.IOCondition.ERR):
            app.loop.quit()
            return False
        if not sys.stdin.readline():
            app.loop.quit()
            return False
        return True

    GLib.io_add_watch(GLib.IOChannel.unix_new(sys.stdin.fileno()),
                      GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP, on_stdin)
    app.loop.run()
    return 0


if __name__ == '__main__':
    sys.exit(main())
