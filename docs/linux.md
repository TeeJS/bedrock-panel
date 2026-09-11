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
# uinput — the virtual keyboard behind macros, media keys and the paste shortcut, and the
# virtual pointer behind Monitor mode
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

## 4. Macros, media keys, and typed text

These work through a **virtual keyboard**. Bedrock Panel creates one at startup through
`/dev/uinput`, so the kernel presents it as an ordinary keyboard and the compositor routes its
keystrokes like any other — the same on X11 and Wayland, with nothing to approve.

Two consequences worth knowing:

- **It needs write access to `/dev/uinput`**, which the udev rule from section 2 grants. The `.deb`
  installs that rule for you.

  If macros stop working and the log says *permission denied on /dev/uinput*, add yourself to the
  `input` group and log out and back in:

  ```bash
  sudo usermod -aG input $USER
  ```

  The rule asks for access two ways, and the group is the dependable one. The modern `uaccess`
  mechanism hands a device to whoever is logged in, but the desktop applies it when a device is
  *added* to your session, and `/dev/uinput` is created once at boot — so that grant can be applied
  and then quietly lost. Group membership does not come and go.
- **Key combos are layout-independent, typed text is not.** A virtual keyboard sends key *codes* and
  your layout decides what they print, exactly as for real hardware. Ctrl+C is Ctrl+C everywhere; a
  macro that types literal text assumes US QWERTY, and characters with no key on your layout are
  skipped with a line in the log rather than failing the whole macro.

`python3` is required, and the `.deb` depends on it. Creating a uinput device needs `ioctl`, which
Node cannot do, so a small bundled Python script owns the device and nothing else. It exits with the
app.

Monitor mode adds a **virtual pointer** alongside the keyboard, covered in the next section.

## 5. Monitor mode

Monitor mode hands the QUAKE to your desktop: the panel hides, the display becomes an ordinary
screen, touch moves the cursor, and the knob scrolls or clicks. On Linux the cursor is driven by a
second virtual device, an absolute pointer, created the moment you enter the mode rather than at
startup — most sessions never need one.

It needs the same `/dev/uinput` access as the keyboard, so if macros work, this works.

One consequence worth knowing: **the pointer is positioned across your whole desktop**, because that
is the area the compositor gives an absolute device. Bedrock Panel therefore re-reads your display
arrangement on every move, and a screen you plug in mid-session is accounted for immediately. Nothing
to configure.

If the cursor does not move, the log says why. *cannot create pointer* is a permissions problem and
section 4 has the fix; the mode is otherwise unaffected, and macros and media keys keep working even
when the pointer cannot be made.

## 6. Global hotkeys

Hotkeys work, with one consent step the other platforms do not have. The first time Bedrock Panel
registers them, KDE shows a **Global Shortcuts Requested** dialog listing each one with the key you
chose already filled in. Click **OK** and they are live. You can change a key in that dialog before
accepting, or later in System Settings → Shortcuts under Bedrock Panel.

This is Wayland's design, not a Bedrock Panel limitation: no application is allowed to take a key
combination for itself, so it asks the desktop and the desktop asks you. Chromium and Electron's own
hotkey support goes through the same portal and needs the same consent.

Two things follow from it:

- **If you dismiss the dialog, the hotkeys are registered with no key.** Nothing breaks and nothing
  fires. Assign them in System Settings → Shortcuts, or restart Bedrock Panel to be asked again.
- **The editor shows what the desktop actually granted**, not what you typed, so an unbound hotkey is
  visible rather than silently dead.

## 7. Speech

Bedrock Panel can speak **and listen** on this computer with nothing to install and no GPU. In the
editor, open **Settings → TTS/STT**, pick a voice and a listening language, and press **Set up** on
each. Together they download about 140 MB the first time and work from then on, offline.

That is the whole setup. There is no server to run, no port to enter, and no account.

- **The two halves are separate.** Take speaking, listening, or both. Neither needs the other, and
  each can be replaced by your own server independently — your own Whisper for listening with the
  built-in voice for speaking is a perfectly normal arrangement.
- **Everything offered is free of restrictions.** Piper's voices inherit their training data's
  licence and most of the good-sounding ones are non-commercial, so the list here is only the ones
  that are public domain or CC0. The recognition models are MIT. The licence is shown next to each.
- **They are real speech servers.** Speaking answers on 127.0.0.1:10200 and listening on
  127.0.0.1:10300, both speaking the Wyoming protocol, so anything else on this machine that speaks
  Wyoming — Home Assistant, for one — can use them too. Same arrangement as the macOS build and the
  Windows helper.
- **If you already run your own Piper or Whisper on those ports, yours wins.** Bedrock Panel notices
  a port is taken, leaves it alone, and uses what is already there.
- **Listening is built for short speech** — dictation and voice commands — rather than transcribing
  long recordings. It is quick about it: a few seconds of speech comes back in well under a second on
  an ordinary laptop.

Once listening is set up, two other things start working on this machine with no server at all:

- **LucidType dictation** uses it automatically.
- **Meeting transcription** can too. In **Settings → Meetings**, set Engine to *Built-in speech on
  this computer*. Recordings are stereo with your microphone on one channel and everyone else on the
  other, so who spoke is known rather than guessed: your lines are labelled with **Your name** and the
  rest "Others". That is as fine-grained as it goes — to name individual attendees you still need a
  diarizer server. A sixteen-second recording transcribes in under a second, so an hour of meeting is
  about a minute of work.

Both live in `~/.config/bedrock-panel/speech` and upgrading Bedrock Panel never touches them.
Removing either is a button in the same tab.

## 8. Secrets

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

## 9. Starter pages

A fresh install starts with the **Linux starter pages** — Default, Media, and Dev — mirroring
the Windows and macOS ones page for page.

Linux has no single calculator, file manager, or terminal, so those tiles name the *job*
("files", "editor", "calculator", "terminal", "monitor", "settings") and Bedrock Panel launches
whichever program your machine actually has, checking a candidate list against `PATH`. A tile
that names a real binary is used exactly as typed, so `dolphin` or `firefox` keeps working.

A config copied from Windows or a Mac is translated the same way: Windows program names map to
their Linux equivalents, and `start <url>` becomes `xdg-open`.

## 10. What is not available on Linux

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
- **Built-in listening is English only for now.** Other languages mean pointing STT at your own
  Wyoming server, such as faster-whisper. Speaking has English voices in US and UK accents.
- **Named speakers in meeting transcripts** need a diarizer server. The built-in engine separates you
  from everyone else by audio channel, which never mis-attributes a line but cannot tell two remote
  participants apart.

## 11. Troubleshooting

**The knob and touchscreen are not detected.** Install the udev rule above and replug. Device
Diagnostics names the cause on the Touchscreen and Knob rows.

**Device Diagnostics says the HID module did not load.** Running from source, the `node-hid`
binding has to match Electron's ABI rather than your system Node: `npm run rebuild`. The app
still starts and Software mode is unaffected.

**Saving a secret fails.** See section 8. Install and unlock a keyring, then restart.

**Tiles launch nothing.** The program is not installed under any of the names Bedrock Panel
tries. The log says which candidates it looked for.

**Macros or media keys do nothing.** The log says why. *permission denied on /dev/uinput* is the
group problem in section 4. *cannot start python3* means `python3` is missing, which the `.deb`
depends on but a source checkout does not enforce.

**Nothing speaks, or nothing is heard.** Settings → TTS/STT says what the built-in engine is doing,
and names which halves are running. *Not installed* means press Set up. *Using the Wyoming server
already running on this computer* means something else holds port 10200 or 10300 and Bedrock Panel is
using it rather than fighting it. If that server is not actually working, stop it and restart
Bedrock Panel.

**A global hotkey never fires.** The consent dialog in section 6 was probably dismissed, which
registers the hotkeys with no key attached. Restart Bedrock Panel to be asked again, or open System
Settings → Shortcuts, find Bedrock Panel, and give the action a key. The log says how many of the
app's shortcuts the desktop actually bound.
