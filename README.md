<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/bedrock-panel-branding/logo/primary/bedrock-panel-logo-horizontal-dark.png">
    <img alt="Bedrock Panel" src="docs/bedrock-panel-branding/logo/primary/bedrock-panel-logo-horizontal.png" width="440">
  </picture>
</p>

**[Website](https://bedrockpanel.com)** · **[Discord](https://discord.gg/7F8DFMVQMv)** · **[Download](https://github.com/TeeJS/bedrock-panel/releases/)** · **[Docs](docs/README.md)**

*A multi-use control platform for your computer.*

## Your tools. Your space. Your control.

One launcher for your apps, media, dashboards, and smart home — on your computer or a
touchscreen. No hardware required to start.

![Bedrock Panel pages: grid launcher, media grid, flip clock, weather map, Home Assistant dashboard](docs/showcase.png)

*From top: the grid launcher · a merged-tile Media grid · the flip-clock app · a [Windy](https://www.windy.com) weather map and a [Home Assistant](https://www.home-assistant.io) dashboard — each with the optional knob's RGB ring lit a different color.*

**Start with software. Add hardware if you want to.** A solid foundation for hands-on control.

> Formerly **open-quake** — old links redirect here. Details under [Origins](#origins-supported-hardware-and-licensing).

## Get started

1. **[Download](https://github.com/TeeJS/bedrock-panel/releases/)** the current release for Windows or macOS (Apple Silicon) — or [build from source](docs/building.md).
2. **Launch Bedrock Panel** — no hardware required. A first-run picker asks how you want to run it (see [Ways to run it](#ways-to-run-it)).
3. **Build your first page** in the editor — tiles for apps, macros, and desktop actions — then **Save**. Add a compatible touchscreen or the Bedrock knob when you're ready.

## What you can do

### Launch & control

A multi-grid launcher puts every app, routine, and dashboard one tap away.

- **Multi-grid launcher** — each page is a grid of tiles; tap a tile — or click it
  with your PC mouse — to open an app, URL, shell command, file, a system action
  (lock screen), or jump to another Bedrock Panel page. Icons can be an emoji, the
  program's own icon, or a custom image. → [Editor](docs/editor.md)
- **Macros & routines** — hotkey tiles and multi-step keystroke macros (AutoHotkey
  optional), plus saved AI routines you re-run from a tile. → [Macros](docs/macros.md) · [Routines](docs/routines.md)
- **Knob control (optional)** — rotate for volume (or dashboard scroll), single-click to mute,
  **double-click for the page selector**, and **hold to talk** (voice input). The
  knob's **RGB ring** is configurable. → [Settings](docs/settings.md)
- **Switching pages** — the panel shows one page at a time: **double-click the knob** to open
  the page selector, rotate to highlight a page, then press to switch. Bedrock Panel shows
  this tip right on the panel the first time you launch it.

### Dashboards & smart home

Build web-based dashboards and wire in Home Assistant — room controls, scenes, and
monitors live on the panel.

- **Web dashboard pages** — a page can be a live web view (Home Assistant, Grafana,
  a status page…) shown full-screen; the knob scrolls, a tap clicks, logins persist,
  with per-page auth (HA token, Basic, custom headers). → [Dashboards](docs/dashboards.md)
- **Home Assistant integration** — set your HA URL + long-lived token once in
  **Settings → Auth**, and three things light up: a **Home Assistant Dashboard** app
  (pick from your real dashboards in a dropdown, with optional kiosk-mode flags to hide
  HA's header/sidebar), **HA entity tiles** (tap a tile to call a service on a light /
  switch / media player / scene / automation / …, filtered by device type, room, label,
  or favorites), and **real MDI icons** rendered live from jsDelivr so tiles look like HA
  does. → [Home Assistant](docs/home-assistant.md)

### Everyday apps

Productivity and media from one surface.

- **Bundled apps** — a Flip Clock, a **World Clock** (US time zones or a pick of world
  cities, digital or analog), a **[Music controller](docs/music.md)** (now-playing +
  transport + app grid), a **[Meeting](docs/meeting.md)** app (one-tap mute/video/accept
  /decline/leave for Zoom and Teams, plus recording — see below), a **[System Monitor](docs/system-monitor.md)** (live
  CPU/GPU/RAM/disk/network/battery), a **[Microsoft 365](docs/apps.md)** panel (sign in with
  your Microsoft account for live profile, presence, and upcoming-calendar view, plus up to
  eight configurable app shortcuts and one-tap **Join meeting**), and **[AI Voice](docs/ai-voice.md)**
  — one app, five backends: a real **Claude Code**, **Codex**, or **Copilot** agent session on the
  panel, or plain chat against your **Open WebUI** server or **any OpenAI-compatible API**
  (OpenAI, DeepSeek, OpenRouter, LiteLLM/Ollama — your own key) — tap the knob to start/stop a
  hands-free conversation, with touch approvals, a full text transcript, and switchable **AI
  profiles** (Translator, Summarizer, Writer, … — editable instructions that reshape the AI in one
  tap). → [Apps](docs/apps.md)
- **Meeting recording → transcript → meeting notes** — the Meeting app **records your
  calls** (your mic on the left channel, everyone else on the right; can auto-start with
  Zoom/Teams calls and auto-stop on silence), then — right from the panel — sends
  recordings to a **diarizing transcription server** ([tts-sst](https://github.com/TeeJS/tts-stt-windows)
  or [meeting-diarizer](https://github.com/TeeJS/meeting-diarizer)) for a **speaker-labeled transcript**, and turns transcripts into
  **AI meeting notes** (summary, attendees, decisions, action items, cleaned transcript)
  with your locally installed **Claude Code, Codex, or Copilot CLI** — no API key — or your
  own **Open WebUI** server (local models). With the
  optional **Outlook calendar integration** (classic Outlook, COM — no tokens), each
  recording also captures its meeting's details (subject, organizer, attendees, join
  link), which sharpens speaker identification (attendee-guided matching, plus your own
  mic channel labeled with certainty) and can **name recordings after the meeting**.
  Filing options: per-date or **per-recurring-meeting folders**, a separate clean
  transcript, and a tidy `details\` layout. Multi-select queues and an on-panel notes
  reader included. → [Meeting](docs/meeting.md)
- **LucidType dictation** — system-wide voice typing: press a **global hotkey**, speak, and
  your words appear in an editable box on the panel; press apply and they paste at your **PC
  cursor** — from any app, whether or not Bedrock Panel is focused. Optional one-tap **Cleanup**
  (grammar + filler removal) and **Rewrite** (Professional / Concise / Confident / your own
  prompt) run the text through your locally installed **Claude Code, Codex, or Copilot CLI**
  or **Open WebUI** — no API key — or a direct **OpenAI-compatible endpoint**, and show a
  full-screen **word-diff review** you can refine before applying. Uses the same
  Wyoming/Whisper transcription server as the Meeting app.
- **Live Translate** — real-time speech **translation captions on the panel**: point the mic at a
  conversation, film, or meeting and watch it translated into your language, live, word by word (not
  after a pause). Powered by **[Soniox](https://soniox.com)** (cloud, ~$0.18/hr while translating) —
  paste an API key, pick a target language, done — or bring your own AI key (**DeepSeek, OpenAI, or
  any OpenAI-compatible endpoint**) paired with your local Whisper STT for per-phrase captions with
  cross-sentence context. Optional save-to-file and a global **toggle hotkey**.
  → [Live Translate](docs/live-translate.md)
- **Screensaver** — a screensaver page with **built-in animated scenes** (Waves, Starfield,
  Lava lamp, Fireflies, Flurry — drawn live, no downloads) or **your own photos and videos**
  (separate folders; photos as a crossfading slideshow or a scrapbook **collage**). Starts **by itself** after a configurable idle time and wakes back to
  exactly the page you left on any touch or knob input; also selectable manually or in the page
  rotation like any other page. → [Screensaver](docs/screensaver.md)

### Customize & extend

Rebuild the panel with the PC-side editor, theme it your way, and pull in community apps
and wallpapers.

- **A PC-side editor** — build pages of tiles, merge adjacent tiles into larger buttons,
  drag-and-drop to rearrange, then **Save** to push to the panel. → [Editor](docs/editor.md)
- **Theming** — a global **light / dark / system** mode and an **accent color** (with savable
  presets) that drives the panel, the bundled apps, and the knob's RGB ring; web dashboards
  follow the light/dark mode, and any page can override the theme in its Advanced settings.
  → [Settings](docs/settings.md)
- **Community apps & wallpapers** — browse and install shared drop-in apps straight from
  **Settings → Drop-In Apps**, write your own, and pull screensaver wallpapers from the
  community collection. → [Apps & drop-ins](docs/apps.md) · [Community apps](docs/community-apps.md) · [Wallpapers](community-wallpapers/)
- **Settings** — choose how it launches, **auto-rotate** through pages on a timer, toggle
  the mic, and tune the knob ring; plus a system-tray menu of quick toggles. → [Settings](docs/settings.md)
- **Reserved Display (Windows, optional)** — keep ordinary application windows from
  settling on the panel display when your primary displays disconnect; automatically suspends
  while using the display in Monitor mode. → [Reserved Display](docs/reserved-display.md)
- **Build your own** — the [Bedrock Console](https://github.com/TeeJS/bedrock-console-hardware) is
  a complete DIY touchscreen console: off-the-shelf parts, a 3D-printed case, and an optional knob.

## Ways to run it

- **Desktop software** — a Windows PC or an Apple Silicon Mac is all you need. Install, launch, done.
- **Compatible touchscreen** — run the same software on a touchscreen display with compatible
  dimensions (1920×480 page units) for the full hands-on experience.
- **DIY Bedrock Console** — a complete DIY build: 1920×480 touchscreen console with an optional
  knob. Hardware, enclosure, and firmware are open source. → [bedrock-console-hardware](https://github.com/TeeJS/bedrock-console-hardware)

**Three run modes** cover all of these: **Software** is a normal resizable desktop window (no
device required — every bundled app, dictation, meeting notes, and the agent panels are fully
usable with no hardware at all), **Panel** drives a compatible touchscreen full-screen, and
**Monitor** uses the touchscreen as an ordinary extra monitor. A **first-run picker** asks which
you want; switch anytime from **Settings** or the tray's **Run mode** menu. → [Settings](docs/settings.md)

## Download

Grab a build from the **[Releases](https://github.com/TeeJS/bedrock-panel/releases)** page:
- **`bedrock-panel-portable.exe`** — Windows x64, run directly, no install.
- **`bedrock-panel-setup.exe`** — Windows x64 installer (Start-menu shortcut + uninstaller).
- **`bedrock-panel-arm64.dmg`** — macOS on Apple Silicon (macOS 14.2+), **beta**: knob, touchscreen,
  Panel mode, Reserved Display, meeting recording with on-Mac transcription, and voice through macOS's
  own speech. First-launch steps and permissions: [docs/macos.md](docs/macos.md); what to test and
  known limits: [docs/releases/v0.9.5-beta.2-macos.md](docs/releases/v0.9.5-beta.2-macos.md).

The exe is **code-signed** (Azure Trusted Signing, publisher *Thomas Schmitz*) — so you see a
verified publisher, not "Unknown publisher." Windows SmartScreen may still show a **"Windows
protected your PC"** prompt on first download; that's reputation-based (it eases as a release
gains downloads), not a problem with the file. Confirm the publisher reads **Thomas Schmitz**,
then click **More info → Run anyway**. Config is stored in `%APPDATA%\bedrock-panel`; upgrading from an
open-quake install moves the old `%APPDATA%\open-quake` folder there automatically.

The macOS build is **not yet notarized** (Apple Developer ID pending), so on first launch macOS says it
could not verify the app: click **Done**, open **System Settings → Privacy & Security**, scroll to
*Security*, click **Open Anyway**, then **Open** — again after each update until builds are
notarized. (Or run `xattr -dr com.apple.quarantine "/Applications/Bedrock Panel.app"`.) Config lives in
`~/Library/Application Support/bedrock-panel`. The Mac needs a few permissions (touchscreen, keystrokes,
recording): **[docs/macos.md](docs/macos.md)** lists each one and exactly where to grant it. Linux is
still in progress.

## 📖 Documentation

Detailed guides live in **[docs/](docs/README.md)**:

- [The editor](docs/editor.md) · [Web dashboards](docs/dashboards.md) · [Bundled apps](docs/apps.md)
- [Music controller](docs/music.md) · [System monitor](docs/system-monitor.md) · [AI Voice](docs/ai-voice.md) · [Live Translate](docs/live-translate.md) · [Screensaver](docs/screensaver.md)
- [Home Assistant integration](docs/home-assistant.md) · [Settings & knob lighting](docs/settings.md) · [Reserved Display](docs/reserved-display.md) · [Building & how it works](docs/building.md) · [Device protocol](docs/DEVICE_PROTOCOL.md)

## Companion projects

**[Bedrock Console](https://github.com/TeeJS/bedrock-console-hardware)** — an open-source
hardware project to build your own 1920×480 touchscreen + knob console for use with Bedrock Panel.
Generic parts, 3D-printable enclosure, RP2040 firmware for the knob. Firmware is built,
flashed, and verified against real hardware; enclosure parts are printable. Still early —
full assembly/wiring docs are in progress.

**[tts-stt-windows](https://github.com/TeeJS/tts-stt-windows)** — local speech-to-text and
text-to-speech for Windows, served over the [Wyoming protocol](https://github.com/rhasspy/wyoming)
on `127.0.0.1` with no Docker, no Python, no cloud, and no account. This is the easiest way to
power Bedrock Panel's voice features: run the tray app, point **Settings → TTS/STT** at `127.0.0.1`,
and the AI Voice apps, meeting dictation, and the Interactive Fiction player's narration and spoken
commands all work — the default ports match (STT on `10300`, TTS on `10200`), so it connects out of
the box. A ~11 MB tray app that runs entirely on the CPU: 200+ Piper and Coqui voices plus Whisper /
Parakeet / SenseVoice / Moonshine / Dolphin speech models across 53 languages, all downloaded on
demand.

## Community

Join the conversation on **[Discord](https://discord.gg/7F8DFMVQMv)**, star the project, or
contribute — apps, themes, and dashboards are all community-built. Reproducible software issues go
in the **[issue tracker](https://github.com/TeeJS/bedrock-panel/issues)**.

## FAQ

- **Can I use it without a touchscreen?** Yes. Software mode runs on a Windows PC or an Apple Silicon
  Mac with no hardware at all. A touchscreen or knob adds the hands-on layer.
- **Which computers does it run on?** Windows, and macOS on Apple Silicon (Software mode; knob and
  touchscreen support is in progress). Linux is in progress.
- **Does it need internet?** The core launcher works offline. Some apps — AI voice, translation,
  meeting transcription — need an internet connection.
- **Is it free?** Yes, it's free and open source. Nearly everything is MIT licensed; the QUAKE
  driver is PolyForm Noncommercial (see [Licensing](#licensing)).
- **How do I get help?** Start on Discord — the community and maintainers hang out there.

## Origins, supported hardware, and licensing

### Origins

Bedrock Panel grew out of the **open-quake** community project for the QUAKE panel — today it is a
standalone platform for any compatible setup. Old `TeeJS/open-quake` links redirect to this
repository, and installing over an open-quake install carries your config, logins, and drop-in
apps across.

### Supported controllers

Nothing requires them, but these work as first-class controllers when present:

- **DK-QUAKE / ARIS-68** — the 1920×480 touchscreen-plus-knob macro device (sold with the
  closed-source DK-Suite app). Bedrock Panel talks to it directly over HID, with no vendor software
  running: touch, knob (incl. RGB ring + hold-to-talk), the on-board mic, and page grids are all
  validated against real hardware. The panel is driven as a normal external monitor (Windows sees a
  480×1920 / 1920×480 display); pushing frames over the HID resource channel is not implemented.
  → [Device protocol](docs/DEVICE_PROTOCOL.md)
- **Bedrock knob** — the open RP2040 knob from the [Bedrock Console](https://github.com/TeeJS/bedrock-console-hardware)
  project, driven through the same code path. → [Building & how it works](docs/building.md)

> **Status:** early but capable. Touch, knob, grids, merged buttons, web dashboards, the bundled
> apps (clock / world clock / music / meeting / system monitor / AI chat / Microsoft 365 / AI Voice
> (Claude Code · Codex · Copilot · Open WebUI · API) / LucidType / Live Translate / Screensaver),
> the three run modes (panel / software / monitor), light/dark + accent theming, the on-board mic,
> and the editor are working and validated against real hardware.

### Licensing

Split-licensed — see **[NOTICE](NOTICE)**:

- **MIT** ([LICENSE](LICENSE)) — the launcher and editor (`app/`), original work.
- **PolyForm Noncommercial 1.0.0** ([src/LICENSE](src/LICENSE)) — every file that
  embeds the reverse-engineered protocol: the driver (`src/Aris68Connector.js`),
  the protocol notes (`docs/DEVICE_PROTOCOL.md`), and the two `tools/` scripts.
  The vendor described the comm protocol as restricted for commercial use; these
  files are **non-commercial only** unless you obtain written commercial
  permission from the protocol holders.

No vendor code, binaries, or API keys are included in this repository.

### Safety

`Aris68Connector.js` knows the firmware-download (DFU) command but never sends
it. **Do not call `enterDfu()`** — it puts the device into firmware-flash mode
and can brick it. The write-test in `tools/` only issues read-only query frames.

### Disclaimer

Bedrock Panel is an independent third-party community project. It is not affiliated with, endorsed by, maintained by, verified by, certified by, or officially supported by DECOKEE. DK-Suite is the official software for DECOKEE Quake. Bedrock Panel is not an official open-source version of DK-Suite. Use of Bedrock Panel is at your own risk.
