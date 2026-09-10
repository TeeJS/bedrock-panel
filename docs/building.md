# Building & how it works

## How the hardware works

Bedrock Panel drives two different knob devices through the same code path, routed by
`app/multiKnob.js`: whichever one is actually plugged in wins, checked in this order —
**Bedrock** (`app/BedrockConnector.js`, the open RP2040 knob — see the companion
[bedrock-console](https://github.com/TeeJS/bedrock-console) project) first, falling back
to **ARIS-68** (`src/Aris68Connector.js`, reverse-engineered) if no Bedrock device is
found. Both connectors emit the same internal knob-event shape, so the rest of the app
(panel, rotation, desktop focus, etc.) doesn't know or care which one is attached.

The DK-QUAKE's screen is a standard external monitor (HDMI or USB-C DisplayPort
alt-mode) recognized by Windows as a 480×1920 portrait display. A separate USB
link handles touch and control/knob/mic interfaces. Video travels over the
display cable; Bedrock Panel renders an Electron window onto that monitor, exactly
as DK-Suite did. Unplug the display cable and the panel goes dark, but the USB
side keeps working.

The USB side is two HID interfaces: a control interface (knob, mic/state,
firmware, keep-alive) and a multi-touch interface. The panel ships dark and
idle-blanks; the driver wakes it and sends a periodic keep-alive so it stays on.
The on-board mic enumerates as a standard **"5- USB PnP Audio Device"** — any app
can read it directly; Bedrock Panel doesn't wrap it.

Full reverse-engineered ARIS-68 protocol: [DEVICE_PROTOCOL.md](DEVICE_PROTOCOL.md).
The Bedrock knob's own (non-reverse-engineered, open) HID protocol is documented in
the bedrock-console repo's `firmware/PROTOCOL.md`.

## Build & run (Windows)

> **Node 20, 22, 24, or 26** (`package.json` declares `"engines": node >=18 <27`; `.nvmrc` pins
> **26**, verified end-to-end on 26.8.1). Node 25.7.0 and 26 used to break the build with
> *"ReferenceError: require is not defined in ES module scope"* — that came from `yargs` 17.7.2
> (pulled in by electron-builder's CLI) and from the old `@electron/rebuild` 3.x. Both are fixed:
> the lockfile now carries `yargs` 17.7.3 and `@electron/rebuild` 4.x parses its own args. If you
> still see that error, `node --version`, delete `node_modules`, and reinstall from this lockfile.

The app's one compiled native module, **`node-hid`**, must be built for this app's
Electron ABI (**Electron 44**), *not* your host Node. (`@jitsi/robotjs` ships
ABI-stable **N-API** prebuilds, so it needs no rebuild.) A plain `npm install` tries
to build natives against your host Node and can fail, so install without scripts,
fetch the Electron binary, then rebuild `node-hid` against Electron 44:

```powershell
npm install --ignore-scripts            # packages on disk, no native build
node node_modules/electron/install.js   # fetch the Electron 44 binary
npm run rebuild                          # electron-rebuild -v 44.3.0 -f --only node-hid
npm start
```

> If `npm install` fails with `EBUSY … electron.exe`, a copy of the app is still
> running — close it first, then retry.

`npm start` / `npm run dist` also run `node build-smtc.js` first, which compiles the C#
native helpers in `native/` (album art, SMTC transport + now-playing monitor, reserved
display, mic session monitor, system volume, Outlook meeting info, foreground watcher)
with the .NET Framework `csc.exe` — needs the Windows 10/11 SDK. It's idempotent (skips
already-current builds) and best-effort: a missing/failed build means the dependent
feature logs itself unavailable at runtime, it won't block `npm start`.

These helpers exist deliberately: features that once shelled out to `powershell.exe`
(now-playing, foreground-app tracking, window focus, volume reads) now use small signed
persistent helpers instead, because repeated PowerShell process creation is flagged by
endpoint-security tools as malware-like behavior. Keep it that way — new Windows
integrations should be a `native/*.cs` helper (persistent + streaming if called
repeatedly), not a PowerShell spawn.

Building the natives on modern Windows needs Visual Studio 2022 Build Tools
(Desktop C++ workload) and a Python with `distutils` (`pip install
"setuptools<81"` on Python 3.12+). Set `GYP_MSVS_VERSION=2022` if node-gyp picks
the wrong toolset.

Plug in the DK-QUAKE before `npm start`. The launcher finds the panel display,
places a borderless window on it, wakes the backlight, and starts listening for
touch and knob input.

Set the DK-QUAKE's **display orientation to Landscape** in Windows (Settings →
System → Display) so Windows treats it as a 1920×480 landscape display — that
keeps the mouse and touch aligned with what you see. Bedrock Panel auto-rotates its
render if you leave it portrait, but then a desktop mouse moved onto the panel
reads 90° off.

If your taps land on the **wrong monitor** (Windows binds touch to the primary
display by default for any HID touchscreen that doesn't include the proper
Container ID in its USB descriptor — which most generic HDMI touchscreens don't),
open the editor → **Settings → Hardware → Set up touchscreen**. That launches
Windows' built-in `multidigimon -touch` wizard, the same backend tool Tablet PC
Settings → Setup → Touch Input used to fire before Microsoft broke that UI in
Win 11 24H2.

**How to drive the wizard:** Accept the UAC prompt. The wizard shows
*"Tap this screen with a single finger to identify it as a touch screen — if
this is not the touch screen, press Enter to move to the next screen"* on each
display in sequence, starting with your primary. **Press Enter on your keyboard
to skip past every monitor that isn't the panel.** Only when the prompt window
appears on the 480-tall panel itself do you tap the panel with your finger.
That writes a persistent override under
`HKLM\SOFTWARE\Microsoft\Wisp\Pen\Digimon` that survives reboot, sleep, USB
reconnect, and primary-display swaps.

**Clear all calibrations** is only for fixing stale `tabcal` coordinate
calibration (taps land on the right display but slightly off). You don't
normally need it for initial binding — `Set up touchscreen` alone is sufficient.

## Build & run (macOS)

> End-user setup — installing the unsigned build, every macOS permission and where to grant it,
> Reserved Display on a Mac — is in [macos.md](macos.md). This section is the developer side.

Apple Silicon only for now (the packaged app declares macOS 14.2+; Electron 44 itself needs 13+).
**Software mode** — the resizable desktop window, the editor, and every platform-neutral app — is
the supported surface today. The Windows C# helpers have macOS counterparts in `native/mac/`
(Swift, compiled by `build-mac-helpers.js` into `app/native/mac/`): the **system-volume readout**
(Core Audio), **foreground-app follow and window find/focus** (NSWorkspace, CGWindowList),
**mic-session auto-record** (Core Audio process objects, macOS 14.2+; the Windows names in the
call-app list — Zoom.exe, Teams.exe, ms-teams.exe — are mapped to the Mac apps), **now-playing**
(Spotify and Music.app through their playback notifications; browser players are not covered), and
**transport** aimed at the displayed player (AppleScript — the first press asks for the Automation
permission; a refusal falls back to media keys), **Reserved Display** (windows that land on the
panel display are moved back through the Accessibility API — see [reserved-display.md](reserved-display.md)),
**display-arrange** (keeps the DK-QUAKE at the far right of the arrangement, never mirrored or
main — DK-Suite's display_manager rule; `check`/`fix`, exit codes 0/2/3/4) and **privacy** (the
CoreGraphics Input Monitoring / Screen Recording preflight and prompt Electron does not expose), and
**calendar-meeting** (today's meeting from macOS Calendar through EventKit, speaking
`outlook-meeting.exe`'s `check`/`meeting` JSON so `main.js` drives both; the Calendars prompt names
the app that launched it, whose Info.plist must carry `NSCalendarsFullAccessUsageDescription` **and**
whose hardened-runtime entitlements must include `com.apple.security.personal-information.calendars`
— without the entitlement tccd never shows the prompt and logs "Policy disallows prompt"; both live
in `packaging/mac/`).
Still Windows-only, each reporting itself unavailable: touchscreen setup and album-art thumbnails
(art comes from Spotify's oEmbed or the iTunes lookup).
`app/nativeHelpers.js` is the one table that maps a feature to its per-platform binary.

**Knob and touchscreen hardware** is wired for macOS but not yet validated on a real console from a
Mac: both HID connectors open devices non-exclusively (IOKit opens exclusively by default, which
fails whenever the OS's own driver holds the touch digitizer), retry a failed write three times
before giving the device up (the original DK-Suite driver did the same), tolerate a leading
report-id byte on incoming frames, and report a refused open once instead of every rescan. A
refusal on macOS is the **Input Monitoring** permission (System Settings → Privacy & Security),
which macOS demands for the DK-QUAKE touch controller because it also exposes mouse and digitizer
collections (the knob interface is vendor-only and opens without it). Grant it to **Bedrock Panel**,
or to the terminal app when running `npm start` — macOS does not always prompt for a command-line
launch — and the connector picks the device up on its next rescan. The **Device Diagnostics** app
shows a refusal on the Knob or Touchscreen row with that hint. Panel
mode places the window on the 1920×480 display with macOS simple fullscreen (no separate Space).
How macOS delivers the touch digitizer (pointer events versus nothing) is the open question for
the first real-hardware run.

Prerequisites: the Xcode Command Line Tools (`xcode-select --install` — `clang`, `codesign`,
`hdiutil`, and the `swiftc` that builds the helpers) and Node 26 (`brew install node`). No Xcode,
no Python: both compiled node modules ship macOS prebuilds (`node-hid` N-API arm64,
`@jitsi/robotjs` universal), so nothing is rebuilt. `npm start` and `npm run dist:mac` run
`build-mac-helpers.js` first (idempotent, best-effort like `build-smtc.js`; `npm run build:mac-helpers`
runs it alone; `--dist` builds fat arm64 + x86_64 binaries for a universal package).

```bash
npm install --ignore-scripts            # packages on disk, no native build
node node_modules/electron/install.js   # fetch the Electron 44 binary
npm test                                 # node:test suite (the DPAPI test skips off Windows)
npm start
```

Optional check that the prebuilds load under Electron's ABI:
`ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -e "console.log(require('node-hid').devices().length, !!require('@jitsi/robotjs'))"`.
Only if that fails: `npm run rebuild` (uses the Command Line Tools' clang and Python 3).

`npm start` still runs `build-dpapi.js` and `build-smtc.js` first; both exit immediately off
Windows. User data lives in `~/Library/Application Support/bedrock-panel` (config, session data,
drop-in apps under `apps/`), shared by `npm start` and the packaged app — which also share the
single-instance lock, so quit one before starting the other.

What to expect on a Mac:

- **Secrets** are encrypted with Electron `safeStorage` (Keychain). Every new build asks *"Bedrock
  Panel wants to access key 'bedrock-panel Safe Storage' in your keychain"* once, even after **Always
  Allow**: the keychain item's partition list (`security dump-keychain -a`) records each build's
  `cdhash:` because the signing certificate carries no Apple Team ID (`TeamIdentifier=not set`), and
  only a `teamid:` partition survives rebuilds — the stable "Bedrock Panel Dev" identity keeps TCC
  grants, not keychain access. A Developer ID ends it. Deny leaves secrets unavailable for that session (saving a
  config with secrets fails until relaunch). A `config.json` copied from Windows keeps its DPAPI
  (`oqenc:v2:`) secrets, which a Mac cannot read: re-enter them in the editor.
- **Permissions** are requested lazily, the first time a feature needs them: Accessibility
  (keystrokes: paste tiles, macros, meeting hotkeys, media keys), Microphone, Screen & System Audio
  Recording (the first meeting recording asks for Screen Recording — that video is discarded — and
  for *System Audio Recording Only*, which captures the other side of the call), Files & Folders
  (Documents, at the first recording), Local Network (packaged app only, macOS 15+).
  **Settings → Hardware → macOS permissions** shows what is granted and opens the matching System
  Settings pane. In dev the grants belong to *Electron* (`com.github.Electron`) and are shared with
  every other Electron project on the machine; after an Electron upgrade reset them with
  `tccutil reset ScreenCapture|Microphone|Accessibility com.github.Electron`.
- **Notifications** are not delivered by unsigned/ad-hoc builds (Electron 44 uses UNNotification);
  the app logs them and parks the text in the menu-bar icon's tooltip instead.
- Global hotkeys written as `Ctrl+Alt+…` register as Control+Option on a Mac.
- Transcription pre/post hooks run through `/bin/sh` (`cmd.exe` on Windows).

### Packaging (macOS)

```bash
npm run dist:mac      # dist/bedrock-panel-arm64.dmg + .zip — ad-hoc signed, hardened runtime
```

**Sign every build with the same certificate.** macOS ties every privacy grant (Input Monitoring for
the touchscreen, Accessibility, Microphone, …) to the app's code signature. The default signature is
**ad-hoc** (`mac.identity: "-"`), which is different on every build, so every build is a new app to
macOS: the grants go stale, the prompts do not come back, and the person has to re-add the app by
hand. `npm run dist:mac` therefore runs `build-mac.js`, which signs with a stable identity when one
is configured: the `BEDROCK_MAC_IDENTITY` environment variable, else the one-line file
`.signing/mac-identity` (the folder is gitignored, so it is per machine). Until an Apple Developer ID
exists, create a self-signed code-signing certificate once and name it there:

```bash
# one time, on the build Mac — creates "Bedrock Panel Dev" in the login keychain
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Bedrock Panel Dev" \
  -addext "extendedKeyUsage=critical,codeSigning" -addext "keyUsage=critical,digitalSignature" \
  -keyout /tmp/bpdev.key -out /tmp/bpdev.crt \
&& /usr/bin/openssl pkcs12 -export -inkey /tmp/bpdev.key -in /tmp/bpdev.crt -name "Bedrock Panel Dev" -passout pass:bpdev -out /tmp/bpdev.p12 \
&& security import /tmp/bpdev.p12 -k ~/Library/Keychains/login.keychain-db -P bpdev -T /usr/bin/codesign \
&& security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db /tmp/bpdev.crt \
&& rm /tmp/bpdev.key /tmp/bpdev.p12 && mkdir -p .signing && echo "Bedrock Panel Dev" > .signing/mac-identity
```

(The `/usr/bin/openssl` for the PKCS#12 step matters: that is Apple's LibreSSL, which writes the
classic format `security import` accepts; a Homebrew OpenSSL 3.4+ on the PATH writes a MAC with a
16-byte salt that fails with "MAC verification failed during PKCS12 import", whatever cipher flags
you pass. `add-trusted-cert` asks for your login password; the first build asks once whether
`codesign` may use the key — click **Always Allow**. Keychain Access → Certificate Assistant → Create a
Certificate, type *Code Signing*, does the same thing with a GUI.) Check with
`security find-identity -v -p codesigning`. Because the certificate's fingerprint is what macOS
stores with each grant, every build signed with it keeps its permissions, including the copies
other people install from the DMG. Gatekeeper still treats the app as from an unidentified
developer, exactly as with the ad-hoc signature; only a Developer ID plus notarization ends that.

Whichever identity signs, the build uses the entitlements in `packaging/mac/` (`build/` is
gitignored, so they live there), and the DMG is not notarized. On a downloaded copy macOS therefore says it *could not verify* the app: click
**Done**, open **System Settings → Privacy & Security**, scroll to *Security*, click **Open Anyway**,
then **Open** — once per new build. Or clear the quarantine flag:
`xattr -dr com.apple.quarantine "/Applications/Bedrock Panel.app"`. (A *"damaged"* dialog instead
means the bundle was packaged without any signature — only `xattr` helps; check that `identity` is
still `"-"`.) Permission grants are tied to the signature too, so a new build may ask again; remove
stale rows in System Settings before re-granting.

Verify a build: `codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Bedrock Panel.app"`
passes, `codesign -dvv` shows `Signature=adhoc` with `flags=…(runtime)`, and
`codesign -d --entitlements :-` lists the entitlements; `spctl -a -t exec -vv` says *rejected*
until notarization. `mac.minimumSystemVersion` is 14.2 because Chromium captures system audio
through a CoreAudio tap from there (`NSAudioCaptureUsageDescription` in `mac.extendInfo`; the dev
Electron.app already carries it). `BEDROCK_MAC_LEGACY_LOOPBACK=1` forces the older ScreenCaptureKit
loopback for troubleshooting. Never add a top-level `productName` to `package.json`: `app.name` is
`bedrock-panel` in dev and packaged alike, and the Keychain item ("bedrock-panel Safe Storage") is
named after it.

**Signing with a Developer ID and notarizing** (one-time setup on the build Mac; nothing in
`package.json` changes — `build-mac.js` turns notarization on when it finds credentials):

1. Certificate. Keychain Access → Certificate Assistant → *Request a Certificate From a Certificate
   Authority…* (your email, your name, **Saved to disk**). On developer.apple.com → Certificates →
   **+** → **Developer ID Application** → upload that request → download the `.cer` and double-click
   it. `security find-identity -v -p codesigning` then lists
   `Developer ID Application: Your Name (TEAMID)`; put that exact line in `.signing/mac-identity`.
2. Notarization credentials. appleid.apple.com → Sign-In and Security → **App-Specific Passwords**
   → generate one. Team ID: developer.apple.com → Membership. Store both once:
   `xcrun notarytool store-credentials bedrock-notary --apple-id you@example.com --team-id TEAMID`
   (it asks for the app-specific password). Put the profile name, `bedrock-notary`, in
   `.signing/notary-profile`. Environment variables work too: `APPLE_KEYCHAIN_PROFILE`, or the
   `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` trio, or the App Store Connect API key
   trio (`APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`).
3. `npm run dist:mac`. electron-builder signs with the Developer ID, notarizes and staples the app;
   the script then submits the DMG and staples it (Apple answers within minutes; the build waits).
   Check: `spctl -a -t exec -vv "dist/mac-arm64/Bedrock Panel.app"` says *accepted, source=Notarized
   Developer ID*, and `xcrun stapler validate dist/bedrock-panel-arm64.dmg` passes.

What changes for users after the switch: no *Open Anyway* step, and the keychain "Always Allow"
dialog appears once more and then never again (a Team ID gives the item a stable partition). The
privacy grants (Input Monitoring, Accessibility, Calendars, Automation) are tied to the signing
certificate, so the first Developer ID build asks for them one final time.

## Build & run (Linux)

> End-user setup — installing the `.deb` or AppImage, the udev rule, what Linux cannot do — is in
> [linux.md](linux.md). This section is the developer side. Verified on Ubuntu 26.04 / KDE Plasma 6.6
> (Wayland) with Node 22.

**Software mode** — the resizable desktop window, the editor, and every platform-neutral app — plus
the knob and touchscreen work today. There is deliberately **no `native/linux/` helper tree**: on
Linux the equivalents of the Windows C# and macOS Swift helpers are reachable from JavaScript
(MPRIS over D-Bus for now-playing, PipeWire for volume and capture-session detection), so
`app/nativeHelpers.js` returns `null` for every Linux entry and nothing needs a compiler.

```bash
npm install --ignore-scripts            # packages on disk, no native build
node node_modules/electron/install.js   # fetch the Electron 44 binary
npm test                                 # node:test suite (the DPAPI tests skip off Windows)
npm start
```

`node-hid` ships a linux-x64 N-API prebuild that loads under Electron 44 as-is, so no rebuild is
normally needed. Check it with
`ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -e "console.log(require('node-hid').devices().length)"`;
only if that fails, run `npm run rebuild` (needs `build-essential`, `libudev-dev`, and Python).
If the binding cannot load at all the app still starts — `app/main.js` falls back to a stub that
enumerates nothing, and Device Diagnostics says the module is the reason rather than blaming a cable.

`npm start` still runs `build-dpapi.js`, `build-smtc.js`, and `build-mac-helpers.js` first; all three
exit immediately off their platform. User data lives in `~/.config/bedrock-panel`.

What to expect on Linux:

- **The app pins the X11 backend on Linux** (`app/main.js`, before app-ready), so it runs through
  XWayland even in a Wayland session. Electron otherwise picks Wayland on its own, and a Wayland
  client cannot place itself in global screen coordinates — measured on Plasma 6.6, requesting
  1920,0 480x1920 gives 1920,0 479x1919 under x11 and 480x1080 under wayland. Panel mode IS
  placement, so it silently lands on the wrong screen without this. X11 also keeps `globalShortcut`
  and robotjs working, neither of which has a native Wayland path. `BEDROCK_LINUX_OZONE` overrides.
- **Raw HID is root-only** until `packaging/linux/70-bedrock-panel.rules` is installed. The deb does
  that in its postinst; a checkout or an AppImage has no installer, so the editor's Settings →
  Hardware → Device access resolves the rule's path for that install and prints the command. Until
  the rule is in place every open is refused with EACCES, and `src/hidPlatform.js` decorates that
  error with the fix, the same way it decorates the macOS Input Monitoring refusal.
- **Secrets** use Electron `safeStorage` (KWallet or GNOME Keyring). With no keyring, Chromium
  silently selects a backend that "encrypts" under a hardcoded key — `app/secretStore.js` detects it
  and refuses to write, rather than storing tokens that only look encrypted.
- **The first-run config** is `app/config.default.linux.json`. Its app tiles name a job, not a
  program, because Linux has no single calculator or file manager; `app/actionRunner.js` resolves
  each against `PATH` from a candidate list.
- **Reserved Display and follow-the-focused-app are not possible** and report themselves
  unavailable. Both need foreign-window enumeration and movement, which Wayland does not offer.
- Transcription pre/post hooks run through `/bin/sh`, as on macOS.

### Packaging (Linux)

```bash
npm run dist:linux    # dist/bedrock-panel-x86_64.AppImage + dist/bedrock-panel_amd64.deb
```

No signing and no notarization: Linux has no equivalent gatekeeper. `afterpack.js` returns early for
a non-Windows target, and `sign.js` is never reached.

Prefer the **`.deb`** when testing on Ubuntu or Debian. AppImages need FUSE 2, which Ubuntu 24.04 and
newer no longer ship, so the AppImage exits with *"dlopen(): error loading libfuse.so.2"* on a stock
26.04 box until `libfuse2t64` is installed.

Two packaging rules worth keeping:

- **Never add `build.linux.files`** — same trap as `build.mac.files`; a platform list replaces the
  global one instead of extending it. All exclusions stay in the global `build.files`.
- `packaging/**` is excluded from the bundle, with `packaging/linux/70-bedrock-panel.rules`
  re-included after it so the udev rule ships inside the app. A later pattern wins, so order matters.
  `linux.extraFiles` also drops the rule beside the executable as a real file, because a path inside
  `app.asar` is not something a person can point `install` at.
- **`deb.afterInstall` and `deb.afterRemove` REPLACE electron-builder's postinst/postrm, they do not
  append.** `packaging/linux/after-install.sh` therefore reproduces the stock template verbatim before
  adding the udev step; dropping it costs the `/usr/bin` symlink, the chrome-sandbox mode fix, and the
  AppArmor profile. If you upgrade electron-builder, diff those two scripts against
  `node_modules/app-builder-lib/templates/linux/after-{install,remove}.tpl`.

## Code layout

```
src/Aris68Connector.js   the HID driver (events out, commands in)   [PolyForm NC]
docs/DEVICE_PROTOCOL.md   reverse-engineered protocol spec           [PolyForm NC]
tools/                    standalone HID probe / write-test scripts  [PolyForm NC]
app/                      the Electron launcher + PC grid editor     [MIT]
  main.js                 host: windows, IPC, launch/volume/config
  multiKnob.js            picks Bedrock or ARIS-68, whichever is plugged in
  BedrockConnector.js     the open RP2040 knob's HID driver (mirrors Aris68Connector's shape)
  secretStore.js          encrypts secret-typed config fields at rest (dispatches to backend)
  dpapi.js                Windows secret backend: raw DPAPI, no key file (see Settings & Auth docs)
  index.html              the on-panel UI (grids + web dashboards)
  config.html             the PC editor (pages, tiles, icons)
  config.default.json     seed config (copied to config.json on first run)
  nowplaying.js           Music: now-playing from Windows SMTC (via smtc-monitor.exe); inactive on macOS until the native-helper port
  sysserver.js            localhost server for the served app pages (Music, AI Voice, meetings)
  musicview.html          Music: now-playing + transport + the embedded app grid
  claudevoice-markdown.js AI Voice reply renderer (marked + sanitizer)  [vendored, MIT]
apps/                     bundled local web apps + apps.json manifest [MIT]
```

Secrets (dashboard/HA tokens, app secret options) are encrypted at rest via `secretStore.js`,
which dispatches to a platform backend: an in-process, first-party raw Windows DPAPI Node-API
binding (`dpapi.js`, per-value, current-user scope, no key file) on Windows, and Electron
`safeStorage` (Keychain-backed) elsewhere. Run `npm run build:dpapi` to build that binding alone;
`npm start`, `npm run rebuild`, and `npm run dist` build it automatically when stale.

## Installer identity

`build.nsis.guid` is pinned to `6b73d4a7-2e13-5aef-9474-9432dfa413dd` — the GUID electron-builder derived from the
pre-rename `appId` (`com.teejs.openquake`). The installer finds and replaces an existing install by that GUID, so it
must never change; the `appId` itself is now `com.teejs.bedrockpanel` (also the macOS bundle id).
