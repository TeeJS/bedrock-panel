# Bedrock Panel — /docs v1 (minimal-but-real)

> BT-1 (content lane). Three real pages for launch, grown later. Drafted from the
> current repo docs (docs/*.md) and source (app/runMode.js, app/main.js, app/panes.js).
> No empty shells — every page has working content. On the site these become /docs
> articles; where a full article isn't written yet they link out to the source doc
> on GitHub (https://github.com/TeeJS/bedrock-panel/tree/main/docs).

**Doc groups (matching the design):** Getting started · Devices & hardware · (Apps &
integrations, Troubleshooting, Development added as they're written.)

---

## Page 1 — Quick start  (`/docs/quick-start`)

**Intro:** Get Bedrock Panel running on Windows in a few minutes. No hardware is
required — you can start in software mode and add a touchscreen or knob later.

### 1. Download
Grab the current Windows release from /download. Pick the installer or portable
build (the verified choices for the current release are listed there).

### 2. Launch and pick a run mode
On first launch, Bedrock Panel asks how you want to run it:

- **Software** — a normal resizable window on your desktop. No hardware needed.
  The recommended way to try it.
- **Panel** — full-screen on a compatible touchscreen (e.g. the DK-QUAKE /
  ARIS-68 panel or a DIY Bedrock Console).
- **Monitor** — the panel display behaves as an ordinary Windows monitor (the
  panel UI is hidden).

New installs get the picker. A missing or invalid saved run mode resolves to
**panel**; existing installs keep their saved mode. You can change it later under
Settings.

### 3. Build your first page
Open the editor. A page is one of a few **page types** — a grid of tiles, a web
dashboard, or an app page. Start with a grid: add tiles for app shortcuts, macros,
and desktop actions, arrange them, and Save. You can also open a full-screen web
dashboard or a bundled app (like clocks or system stats) as its own page. Your
first control surface is ready.

**Learn more:**
- [The editor](https://github.com/TeeJS/bedrock-panel/tree/main/docs/editor.md)
- [Settings & knob](https://github.com/TeeJS/bedrock-panel/tree/main/docs/settings.md)
- [Apps & drop-ins](https://github.com/TeeJS/bedrock-panel/tree/main/docs/apps.md)

---

## Page 2 — Run modes & compatibility  (`/docs/run-modes`)

**Intro:** Bedrock Panel is device-independent. Three run modes cover software-only,
touchscreen, and monitor use. Hardware is optional.

### Software mode
A standard resizable desktop window. No special hardware is required. In software
mode the layout is flexible: 1–5 stacked pages and 1–2 columns, using 1920×480 page
units. Best for trying the launcher, dashboards, and apps on an ordinary monitor.
Reserved Display protection is disabled in software mode.

### Panel mode
Frameless, full-screen on a compatible touchscreen — the DK-QUAKE / ARIS-68 panel
or a DIY Bedrock Console. This is the hands-on, always-on control surface.
Reserved Display protection (keeps ordinary Windows windows off the panel display)
is an **optional** setting you can enable in panel mode.

### Monitor mode
The panel display acts as a normal Windows desktop monitor while the panel UI is
hidden. Reserved Display protection is **suspended** for the duration and resumes
when you exit. **Availability note:** confirm monitor-mode behavior on a given
device before relying on it.

### Compatibility
- **Software:** any compatible Windows PC.
- **Touchscreen (panel mode):** Bedrock Panel detects a device display at
  **1920×480 or 480×1920** (app/main.js isDeviceDisplay). The Bedrock Console and
  DK-QUAKE / ARIS-68 are both 1920×480. Windows display scaling and runtime state
  can affect detection — verify on the target display before committing (see
  /download for verified requirements).
- **Optional controllers:** the open Bedrock RP2040 knob (encoder + RGB ring) works
  as a first-class controller when present; nothing requires it.

---

## Page 3 — Devices & hardware  (`/docs/hardware`)

**Intro:** Bedrock Panel runs without any hardware. You can pair it with compatible
displays and optional controllers — several of which are open-hardware projects.

### No hardware (software mode)
The recommended starting point. A compatible Windows PC is enough to run the full
launcher, dashboards, and apps.

### Compatible displays
Bedrock Panel's panel mode is full-screen on a touchscreen display with compatible
dimensions. The DK-QUAKE / ARIS-68 panel (1920×480) and the DIY Bedrock Console
(1920×480) are both supported.

### Bedrock RP2040 knob (open hardware)
An open-source knob with an encoder and an RGB ring. Turn to scroll/select, click
to act, and drive the ring's lighting from the panel.
Link: https://github.com/TeeJS/bedrock-console-hardware

### Bedrock Console (DIY build)
A complete DIY touchscreen console: 1920×480 display, off-the-shelf parts, a
3D-printed case, and an optional RP2040 knob. Built and open-sourced — build it
yourself.
Link: https://github.com/TeeJS/bedrock-console-hardware

### Under the hood
- [Device protocol](https://github.com/TeeJS/bedrock-panel/tree/main/docs/DEVICE_PROTOCOL.md) — the reverse-engineered HID protocol
- [Building & how it works](https://github.com/TeeJS/bedrock-panel/tree/main/docs/building.md)
- [UI design system](https://github.com/TeeJS/bedrock-panel/tree/main/docs/design-system.md) — the on-panel layout/typography rules

---

## Notes for Claude (build)
- These are three of the planned /docs groups; Apps & integrations, Troubleshooting,
  and Development pages come next (drafted from the existing docs/*.md, linking out
  to GitHub rather than shipping thin stubs).
- The existing repo docs are the content source.
- Verified facts only for hardware/dimensions; the runtime-confirmation caveat on
  monitor mode and non-1920×480 screens is intentional.

## v1 revisions (per Picasso source review)
1. Hardware intro no longer claims all devices are open-source — DK-QUAKE is not our
   open-hardware project; reframed as "compatible displays and optional controllers."
2. No-hardware section = "recommended starting point," not the runtime default (panel
   is the fallback default per app/runMode.js).
3. Reserved Display: optional in panel mode, suspended in monitor mode (confirmed in
   app/main.js enterMonitorMode), disabled in software mode.
4. Distinguished page types (grid / dashboard / app) from grid tiles.
5. Malformed `[label] (path)` links fixed to real GitHub destinations.
6. Removed the "if you skip it..." claim — new installs use the picker; a missing/
   invalid saved run mode resolves to panel (app/main.js createWelcomeWindow).
7. Panel-mode touchscreen support now states the detected dimensions (1920×480 or
   480×1920, app/main.js isDeviceDisplay) with a Windows scaling/runtime caveat,
   rather than unverified full-screen support on arbitrary touchscreens.
