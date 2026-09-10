# Bedrock Panel on Linux

Everything a Linux machine needs to run Bedrock Panel: installing it, the one udev rule the
console needs, and what works today versus what Linux cannot do. Verified on Ubuntu 26.04
with KDE Plasma 6.6 on Wayland and PipeWire.

Requirements: a 64-bit x86 desktop with GTK 3, and a keyring (KWallet or GNOME Keyring) if you
want to save passwords or tokens. Software mode, the tile grids, the editor, dashboards, and
every platform-neutral app work. The knob and touchscreen work once the udev rule is in place.

## 1. Install

Two artifacts are published:

- **`bedrock-panel_amd64.deb`** — the normal choice on Debian and Ubuntu. Installs a desktop
  entry, pulls its own dependencies, and updates through your package manager.
  `sudo apt install ./bedrock-panel_amd64.deb`
- **`bedrock-panel-x86_64.AppImage`** — a single portable file for everything else.
  `chmod +x` it and run it.

> **AppImage on Ubuntu 24.04 and newer needs FUSE 2**, which those releases no longer ship. If
> the AppImage exits with *"dlopen(): error loading libfuse.so.2"*, install `libfuse2t64` or
> use the `.deb` instead. This is an AppImage limitation, not a Bedrock Panel one.

Or [build from source](building.md).

## 2. Device access (only if you have the hardware)

Linux keeps raw HID devices root-only, so the knob and touchscreen are invisible to any ordinary
program until a udev rule grants your user access. What you do about it depends on how you
installed.

**If you installed the `.deb`, nothing.** The package installs the rule for you, because `apt`
already runs as root. Plug the console in and it works.

**If you run the AppImage or a source checkout,** there is no installer, so it is one command.
Open **Settings → Hardware → Device access** in the editor: it shows whether the rule is active
and, if not, the exact command for your install, with a **Copy command** button. The path differs
between an AppImage and a checkout, which is why the editor prints it rather than this page.

The command looks like this:

```bash
sudo install -Dm644 <path the editor shows> /usr/lib/udev/rules.d/70-bedrock-panel.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Afterwards, **unplug the console and plug it back in** — the permission is applied when the device
connects. Bedrock Panel picks it up on its next rescan, with no restart. Until then, Device
Diagnostics shows the Knob and Touchscreen rows as refused and names this as the cause.

Removing the `.deb` takes the rule back out again.

If you would rather write the file by hand, this is what it contains:

```
# DK-QUAKE control interface (knob, mic/state, firmware, keep-alive)
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="4158", ATTRS{idProduct}=="514b", TAG+="uaccess", MODE="0660", GROUP="plugdev"
# ARIS-68 control interface
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="5012", ATTRS{idProduct}=="6817", TAG+="uaccess", MODE="0660", GROUP="plugdev"
# "hotlotus" multi-touch digitizer — the console's touch cable, a separate USB device
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0712", ATTRS{idProduct}=="0010", TAG+="uaccess", MODE="0660", GROUP="plugdev"
# open Bedrock RP2040 knob
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1209", ATTRS{idProduct}=="bed0", TAG+="uaccess", MODE="0660", GROUP="plugdev"
# uinput — the virtual keyboard behind macros, media keys, and the paste shortcut
KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess", MODE="0660", GROUP="input", OPTIONS+="static_node=uinput"
```

`TAG+="uaccess"` hands the device to whoever is logged in at the seat, which is the right grant for
a desktop app: no group membership, no logout, and it follows fast user switching. The `MODE`/`GROUP`
fallbacks only matter on systems without systemd-logind.

## 3. Display setup

The DK-QUAKE is an ordinary external monitor. It reports itself as a **480×1920 portrait**
display; set it to **landscape** in your display settings so the desktop treats it as 1920×480
and the pointer lines up with what you see. Bedrock Panel finds the panel by its resolution,
so either orientation is detected.

**Set the panel to landscape.** It reports itself as a 480x1920 portrait display, so rotate it in
your display settings until the desktop sees 1920x480. On KDE that is
`kscreen-doctor output.DP-1.rotation.right`, or Display Configuration in System Settings. Bedrock
Panel detects the panel in either orientation, but only landscape lines the pointer up with what you
see.

Panel mode places a borderless window on that display. In a Wayland session Bedrock Panel restarts
itself once at launch to run through XWayland, because a native Wayland client is not allowed to
place itself on a chosen screen — it lands slightly off the panel and slightly too large. You will
see one line about this in the log. Set `BEDROCK_LINUX_OZONE=wayland` to skip the restart and run
natively, for example for fractional scaling, and expect Panel mode to be misplaced if you do.

## 4. Secrets

Saved passwords and tokens are encrypted with Electron `safeStorage`, backed by KWallet or
GNOME Keyring.

If no keyring is reachable, Chromium falls back to a backend that encrypts with a hardcoded key
and still reports encryption as available. Bedrock Panel refuses that backend on purpose: it
would store your tokens in something that only looks like ciphertext. You will see *"secret
storage unavailable: this session has no keyring"* in the log, and saving a config that
contains a secret will fail until a keyring is installed and unlocked. Secrets saved earlier
still decrypt normally, so nothing is lost in the meantime.

A `config.json` copied from Windows keeps its DPAPI-encrypted secrets, which Linux cannot read.
Re-enter those in the editor.

## 5. Starter pages

A fresh install starts with the **Linux starter pages** — Default, Media, and Dev — mirroring
the Windows and macOS ones page for page.

Linux has no single calculator, file manager, or terminal, so those tiles name the *job*
("files", "editor", "calculator", "terminal", "monitor", "settings") and Bedrock Panel launches
whichever program your machine actually has, checking a candidate list against `PATH`. A tile
that names a real binary is used exactly as typed, so `dolphin` or `firefox` keeps working.

A config copied from Windows or a Mac is translated the same way: Windows program names map to
their Linux equivalents, and `start <url>` becomes `xdg-open`.

## 6. What is not available on Linux

These features report themselves unavailable rather than failing quietly:

- **Reserved Display.** Moving another application's window off the panel display requires
  enumerating and repositioning foreign windows, which Wayland deliberately does not allow.
- **Follow the focused app.** Same reason: there is no cross-desktop way to be told which
  application is in front.
- **Teams window control.** The meeting tiles that focus the Teams window first cannot work.
  Zoom is unaffected, because its shortcuts need no focus.
- **Touchscreen setup wizard.** A Windows-only fix for a Windows-only problem. Linux binds a
  digitizer to the output its USB device reports, and Bedrock Panel reads the panel's touch
  reports over HID itself.
- **Outlook meeting info.** Use the Microsoft 365 source instead, which works everywhere.
- **Built-in speech.** Point the voice apps at a Wyoming server such as faster-whisper or
  piper; Bedrock Panel already speaks that protocol.

## 7. Troubleshooting

**The knob and touchscreen are not detected.** Install the udev rule above and replug. Device
Diagnostics names the cause on the Touchscreen and Knob rows.

**Device Diagnostics says the HID module did not load.** Running from source, the `node-hid`
binding has to match Electron's ABI rather than your system Node: `npm run rebuild`. The app
still starts and Software mode is unaffected.

**Saving a secret fails.** See section 4. Install and unlock a keyring, then restart.

**Tiles launch nothing.** The program is not installed under any of the names Bedrock Panel
tries. The log says which candidates it looked for.
