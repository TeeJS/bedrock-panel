#!/usr/bin/env python3
"""
uinput-helper.py — the Linux input backend's virtual keyboard and virtual pointer.

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

Two devices, not one. The keyboard is created at startup; the pointer is created on the first pointer
command, because it exists only for Monitor mode and most runs never enter it. They are separate
uinput devices because libinput classifies a device by what it declares, and no real hardware is both
a keyboard and an absolute pointer — declaring both on one node invites a wrong classification.

The pointer is shaped like the QEMU USB tablet: buttons, absolute X/Y, and a wheel. libinput has
always handled that shape as an absolute pointer, and the compositor maps its 0..65535 range across
the whole desktop. Verified on KDE Plasma 6.6 (Wayland): a move to a given fraction of the desktop
bounding box puts KWin's cursor on the intended pixel, on either display.

Protocol — one command per line on stdin, one reply per line on stdout:
    ping                     -> ok
    tap CODE [MOD...]        -> ok        press MODs, tap CODE, release MODs (reverse order)
    key CODE VALUE           -> ok        VALUE 1 = press, 0 = release
    pointer                  -> ok        create the pointer device now (Monitor mode is starting)
    move ABSX ABSY           -> ok        absolute position, each 0..65535 across the whole desktop
    btn CODE VALUE           -> ok        CODE is BTN_LEFT/RIGHT/MIDDLE; VALUE 1 = down, 0 = up
    wheel N                  -> ok        N wheel notches, positive is up
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
UI_SET_RELBIT = _IOC(1, 'U', 102, 4)
UI_SET_ABSBIT = _IOC(1, 'U', 103, 4)
UI_ABS_SETUP = _IOC(1, 'U', 4, 28)      # sizeof(struct uinput_abs_setup): u16 code + 2 pad + 6 s32
UI_DEV_SETUP = _IOC(1, 'U', 3, 92)      # sizeof(struct uinput_setup): input_id 8 + name 80 + u32 4
UI_DEV_CREATE = _IOC(0, 'U', 1, 0)
UI_DEV_DESTROY = _IOC(0, 'U', 2, 0)

EV_SYN, EV_KEY, EV_REL, EV_ABS, SYN_REPORT = 0, 1, 2, 3, 0
ABS_X, ABS_Y = 0x00, 0x01
REL_WHEEL = 0x08
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
POINTER_BUTTONS = (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE)
ABS_MAX = 65535
BUS_USB = 0x03
# Same vendor as the open Bedrock knob, so both virtual devices are identifiable in
# `libinput list-devices` as belonging to this app rather than looking like unknown hardware.
VENDOR, KEYBOARD_PRODUCT, POINTER_PRODUCT, VERSION = 0x1209, 0xbed0, 0xbed1, 1
KEYBOARD_NAME = b'Bedrock Panel Virtual Keyboard'
POINTER_NAME = b'Bedrock Panel Virtual Pointer'

# The kernel creates the device immediately, but udev and libinput need a moment to notice it. Events
# written before the compositor has opened the device are delivered nowhere, silently.
SETTLE_SECONDS = 0.6


def reply(text):
    sys.stdout.write(text + '\n')
    sys.stdout.flush()


def device_setup(fd, product, name):
    setup = struct.pack('HHHH80sI', BUS_USB, VENDOR, product, VERSION, name, 0)
    fcntl.ioctl(fd, UI_DEV_SETUP, setup)
    fcntl.ioctl(fd, UI_DEV_CREATE)
    time.sleep(SETTLE_SECONDS)
    return fd


def create_keyboard(codes):
    fd = os.open(UINPUT, os.O_WRONLY | os.O_NONBLOCK)
    fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
    for code in codes:
        fcntl.ioctl(fd, UI_SET_KEYBIT, code)
    return device_setup(fd, KEYBOARD_PRODUCT, KEYBOARD_NAME)


def create_pointer():
    fd = os.open(UINPUT, os.O_WRONLY | os.O_NONBLOCK)
    for ev in (EV_KEY, EV_ABS, EV_REL):
        fcntl.ioctl(fd, UI_SET_EVBIT, ev)
    for button in POINTER_BUTTONS:
        fcntl.ioctl(fd, UI_SET_KEYBIT, button)
    fcntl.ioctl(fd, UI_SET_RELBIT, REL_WHEEL)
    for axis in (ABS_X, ABS_Y):
        fcntl.ioctl(fd, UI_SET_ABSBIT, axis)
        # struct uinput_abs_setup { u16 code; struct input_absinfo absinfo; }, absinfo being
        # value/min/max/fuzz/flat/resolution. Fuzz and flat stay 0: this is a synthetic device with
        # no jitter, and a non-zero flat would swallow small moves near the centre.
        fcntl.ioctl(fd, UI_ABS_SETUP, struct.pack('Hh6i', axis, 0, 0, 0, ABS_MAX, 0, 0, 0))
    return device_setup(fd, POINTER_PRODUCT, POINTER_NAME)


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
        fd = create_keyboard(codes)
    except PermissionError:
        reply('err permission denied on ' + UINPUT)
        return 3
    except OSError as exc:
        reply('err cannot create device: ' + str(exc))
        return 3

    reply('ready')

    # The pointer is created on demand and at most once. A failure is remembered rather than retried,
    # so a machine that cannot make one does not attempt it on every touch report.
    pointer = {'fd': None, 'failed': None}

    def pointer_fd():
        if pointer['fd'] is None and not pointer['failed']:
            try:
                pointer['fd'] = create_pointer()
                reply('pointer ready')
            except OSError as exc:
                pointer['failed'] = str(exc)
                reply('err cannot create pointer: ' + str(exc))
        return pointer['fd']

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
                elif cmd == 'pointer':
                    reply('ok' if pointer_fd() is not None else 'err no pointer')
                elif cmd == 'move' and len(parts) >= 3:
                    ax, ay = int(parts[1]), int(parts[2])
                    if not (0 <= ax <= ABS_MAX and 0 <= ay <= ABS_MAX):
                        reply('err position out of range')
                        continue
                    pfd = pointer_fd()
                    if pfd is None:
                        continue
                    emit(pfd, EV_ABS, ABS_X, ax)
                    emit(pfd, EV_ABS, ABS_Y, ay)
                    sync(pfd)
                    reply('ok')
                elif cmd == 'btn' and len(parts) >= 3:
                    code, value = int(parts[1]), int(parts[2])
                    if code not in POINTER_BUTTONS or value not in (0, 1):
                        reply('err not a pointer button')
                        continue
                    pfd = pointer_fd()
                    if pfd is None:
                        continue
                    emit(pfd, EV_KEY, code, value)
                    sync(pfd)
                    reply('ok')
                elif cmd == 'wheel' and len(parts) >= 2:
                    notches = int(parts[1])
                    pfd = pointer_fd()
                    if pfd is None:
                        continue
                    emit(pfd, EV_REL, REL_WHEEL, notches)
                    sync(pfd)
                    reply('ok')
                else:
                    reply('err unknown command')
            except ValueError:
                reply('err arguments must be integers')
            except OSError as exc:
                reply('err write failed: ' + str(exc))
    finally:
        # Leaving a device behind would strand a phantom keyboard or pointer in the compositor's
        # device list.
        for handle in (fd, pointer['fd']):
            if handle is None:
                continue
            try:
                fcntl.ioctl(handle, UI_DEV_DESTROY)
            except OSError:
                pass
            os.close(handle)
    return 0


if __name__ == '__main__':
    sys.exit(main())
