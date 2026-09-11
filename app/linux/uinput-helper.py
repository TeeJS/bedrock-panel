#!/usr/bin/env python3
"""
uinput-helper.py — the Linux input backend's virtual keyboard.

Why a helper at all, when the rest of the Linux port is plain JavaScript: creating a uinput device
needs ioctl (UI_SET_EVBIT, UI_SET_KEYBIT, UI_DEV_SETUP, UI_DEV_CREATE) and Node has no ioctl. Writing
the events afterwards is an ordinary write(), but the device cannot exist without those calls. Python
is used rather than a compiled helper because it keeps the Linux port free of a build toolchain, and
python3 is present on every desktop distribution.

Why uinput rather than XTEST or a portal: the app runs through XWayland, and XTEST does not deliver
there — robotjs loads, reports success, and nothing arrives (measured). A uinput device is a keyboard
as far as the kernel is concerned, so the compositor routes its events like any other keyboard, on
X11 and Wayland alike, with no consent dialog. It needs read/write on /dev/uinput, which the udev
rule in packaging/linux/70-bedrock-panel.rules grants to the logged-in seat.

Protocol — one command per line on stdin, one reply per line on stdout:
    ping                     -> ok
    tap CODE [MOD...]        -> ok        press MODs, tap CODE, release MODs (reverse order)
    key CODE VALUE           -> ok        VALUE 1 = press, 0 = release
    anything else            -> err <reason>
Exits on stdin EOF, which is the parent-death guard every other helper in this project uses.

argv[1] is a comma-separated list of every key code the device must declare. A uinput device can only
emit codes it declared before creation, so the caller sends its whole key set up front.
"""

import fcntl
import os
import struct
import sys
import time

UINPUT = '/dev/uinput'

# _IOC(dir, type, nr, size) from asm-generic/ioctl.h; _IOC_WRITE is 1.
def _IOC(direction, letter, nr, size):
    return (direction << 30) | (size << 16) | (ord(letter) << 8) | nr

UI_SET_EVBIT = _IOC(1, 'U', 100, 4)
UI_SET_KEYBIT = _IOC(1, 'U', 101, 4)
UI_DEV_SETUP = _IOC(1, 'U', 3, 92)      # sizeof(struct uinput_setup): input_id 8 + name 80 + u32 4
UI_DEV_CREATE = _IOC(0, 'U', 1, 0)
UI_DEV_DESTROY = _IOC(0, 'U', 2, 0)

EV_SYN, EV_KEY, SYN_REPORT = 0, 1, 0
BUS_USB = 0x03
# Same vendor/product as the open Bedrock knob, so the virtual keyboard is identifiable in
# `libinput list-devices` as belonging to this app rather than looking like unknown hardware.
VENDOR, PRODUCT, VERSION = 0x1209, 0xbed0, 1
DEVICE_NAME = b'Bedrock Panel Virtual Keyboard'

# The kernel creates the device immediately, but udev and libinput need a moment to notice it. Events
# written before the compositor has opened the device are delivered nowhere, silently.
SETTLE_SECONDS = 0.6


def reply(text):
    sys.stdout.write(text + '\n')
    sys.stdout.flush()


def create_device(codes):
    fd = os.open(UINPUT, os.O_WRONLY | os.O_NONBLOCK)
    fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
    for code in codes:
        fcntl.ioctl(fd, UI_SET_KEYBIT, code)
    setup = struct.pack('HHHH80sI', BUS_USB, VENDOR, PRODUCT, VERSION, DEVICE_NAME, 0)
    fcntl.ioctl(fd, UI_DEV_SETUP, setup)
    fcntl.ioctl(fd, UI_DEV_CREATE)
    time.sleep(SETTLE_SECONDS)
    return fd


def emit(fd, etype, code, value):
    # struct input_event: struct timeval (two longs) + u16 type + u16 code + s32 value. A zero
    # timestamp tells the kernel to fill it in.
    os.write(fd, struct.pack('llHHi', 0, 0, etype, code, value))


def sync(fd):
    emit(fd, EV_SYN, SYN_REPORT, 0)


def main():
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        reply('err no key codes given')
        return 2
    try:
        codes = sorted({int(c) for c in sys.argv[1].split(',') if c.strip()})
    except ValueError:
        reply('err key codes must be integers')
        return 2
    allowed = set(codes)

    try:
        fd = create_device(codes)
    except PermissionError:
        reply('err permission denied on ' + UINPUT)
        return 3
    except OSError as exc:
        reply('err cannot create device: ' + str(exc))
        return 3

    reply('ready')

    try:
        for line in sys.stdin:
            parts = line.split()
            if not parts:
                continue
            cmd = parts[0]
            try:
                if cmd == 'ping':
                    reply('ok')
                elif cmd == 'tap' and len(parts) >= 2:
                    code = int(parts[1])
                    mods = [int(m) for m in parts[2:]]
                    if code not in allowed or any(m not in allowed for m in mods):
                        reply('err undeclared key code')
                        continue
                    for mod in mods:
                        emit(fd, EV_KEY, mod, 1)
                    sync(fd)
                    emit(fd, EV_KEY, code, 1)
                    sync(fd)
                    emit(fd, EV_KEY, code, 0)
                    sync(fd)
                    for mod in reversed(mods):
                        emit(fd, EV_KEY, mod, 0)
                    sync(fd)
                    reply('ok')
                elif cmd == 'key' and len(parts) >= 3:
                    code, value = int(parts[1]), int(parts[2])
                    if code not in allowed or value not in (0, 1):
                        reply('err undeclared key code')
                        continue
                    emit(fd, EV_KEY, code, value)
                    sync(fd)
                    reply('ok')
                else:
                    reply('err unknown command')
            except ValueError:
                reply('err arguments must be integers')
            except OSError as exc:
                reply('err write failed: ' + str(exc))
    finally:
        # Leaving the device behind would strand a phantom keyboard in the compositor's device list.
        try:
            fcntl.ioctl(fd, UI_DEV_DESTROY)
        except OSError:
            pass
        os.close(fd)
    return 0


if __name__ == '__main__':
    sys.exit(main())
