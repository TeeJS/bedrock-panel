# DK-Suite feature parity

What the commercial package advertises versus what Bedrock Panel ships. Comparison sources: the
[DECOKEE Quake product page](https://www.decokee.com/products/decokee-quake-desktop-ai-assistant)
plus their [Kickstarter](https://www.kickstarter.com/projects/decokee/decokee-quake-the-ultimate-desktop-ai-copilot)
and [AI-copilot](https://www.decokee.com/pages/quake-ai-copilot) pages (as advertised 2026-08),
cross-checked against a teardown of the installed DK-Suite (v0.4.69, unpacked Electron); the
Bedrock Panel side is the current release (**v0.9.6**). This is the running list of what they have
that we don't — update it when either side changes.

> **What was re-checked, and when.** The Bedrock Panel column was brought up to date at v0.9.6
> (2026-09-11). The DK-Suite column still reflects the 2026-08 reading of their pages and the
> v0.4.69 teardown — nobody has re-read their marketing or unpacked a newer build since, so treat
> their side as "as of 2026-08" rather than current.

> Bedrock Panel is an independent community project, not affiliated with DECOKEE — see the
> [README disclaimer](../README.md). Feature names in the "theirs" column are their marketing terms.

## ✅ Have (or have more)

| DK-Suite advertises | Bedrock Panel |
|---|---|
| AI Chat (credit-metered, 100 credits/mo free) | One **AI Voice** app, five backends, **no credits**: real **Claude Code / Codex / Copilot agent sessions** (tools, approvals, your existing plan), **Open WebUI** chat against your own models, or **any OpenAI-compatible API by key** (OpenAI, DeepSeek, OpenRouter, LiteLLM/Ollama). |
| OpenClaw integration ("run your favorite OpenClaw tasks with one tap" — via the OpenAI API server-side) | Bedrock Panel runs **real agent sessions natively** — Claude Code, Codex, Copilot — with tools, touch approvals, your own plan; no intermediary service. (Their one-tap *saved routines* idea is a genuine gap — see Missing.) |
| Saved AI routines as tiles (OpenClaw: capture a spoken task, save it, re-run with one tap) | **AI Routine** tiles. Save a request straight from the panel (`+ Routine` beside Send on any AI Chat page) or type one on Settings → Routines, then put it on a tile — or inside a macro. Agent-backed routines carry the **working folder** too, so one tap lands in the right repo. Theirs re-runs an API call; ours re-runs a **real agent turn**, with tools, touch approvals and spoken replies. |
| Mid-meeting [Mark] highlights (tap Mark; the summary extracts the flagged moments) | A **Highlight** column on the meeting panel: tap to open a span, tap to close it. Spans are ms offsets on the diarizer's own clock, stored in the recording's sidecar and handed to the analysis AI, which opens the notes with a **Highlights** section. Theirs marks an instant; ours marks a **range**, auto-closed if the call ends mid-span. |
| Voice commands (press-and-speak) | Knob **hold-to-talk** everywhere + tap-to-toggle conversations; your own local Whisper STT (tts-sst), no cloud dependency. |
| AI Meeting Assistant (record → transcribe → summarize) | Meeting app: stereo-split recording, auto start/stop, **speaker-diarized transcripts** (self-hosted), attendee-guided speaker ID via Outlook calendar, AI notes (summary/decisions/actions), per-meeting filing, **Joplin export**. Materially deeper than the advertised feature. |
| Translation (Silver+ paid tiers) | **Live Translate**: word-by-word streaming captions (Soniox, ~$0.18/hr) or bring-your-own AI key (DeepSeek ≈ $0.10/hr, OpenAI, OpenRouter, LiteLLM/Ollama) with cross-sentence context, save-to-file, global hotkey. Not tier-gated. |
| Instant answers | Any of the AI apps; hold the knob and ask. |
| Global mic mute (system-level, one tap) | Knob single-click defaults to **mute**; the Meeting app adds per-call mute/video for Zoom and Teams. |
| Drag-and-drop customization / preset app shortcuts | The PC-side editor: tile grids, merged tiles, per-page apps/dashboards, drag-and-drop, hotkeys. |
| Music player | Music controller: now-playing, transport, app grid, lyrics. |
| Smart home hub (use-case example) | First-class **Home Assistant integration**: entity tiles, real dashboards, MDI icons. |
| Stock dashboard / expense automation / 3D-printer control (use-case examples) | Web-dashboard pages + shell/macro tiles + HA cover the same ground generically. |
| LED ring status for recording/translation/AI states | RGB ring is theme-driven and state-driven (listening/thinking/speaking/approval), fully configurable. |
| Knob + touchscreen + gestures | Full knob support (rotate/click/double/hold), touch, page selector. |
| Credit packs / subscriptions | Nothing metered. Costs are only what your own keys/servers cost. |
| 9 Smart Profiles (knob-switchable "modes") | Teardown: their 9 "profiles" are **page layouts** (Discord/MeetAI/SysView/AI Chat/Music/Clock/…) — already Bedrock Panel **pages** with the knob selector and per-page hotkeys. The real feature inside their AI Chat — named prompt modes (theirs: 6, Chinese-only) — **shipped as AI Profiles** (PR #23): 9 editable English instruction presets on all five AI Voice backends, switchable from the panel's full-screen Profile picker, remembered per page. |
| AI-generated shortcut panels ("hold the knob and say *create a shortcut set for Photoshop masking*") | **[AI panels](ai-panels.md)**: a **Panel Builder** AI Profile — pick it on an AI Voice page, say what you want, and the proposed page is drawn as real tiles for **Accept / Try again / Cancel**. Works on all five backends; Claude and Codex can look up an app's real shortcuts. Every generated page is schema-validated before it can be saved, and anything that would run a shell/AutoHotkey command shows the literal command and needs a second explicit yes. |
| Wallpapers / screensaver ("Vivid" — teardown: a manually-selected crossfading image/video page, **no idle detection**) | **[Screensaver](screensaver.md)** (PR #24): five built-in live-drawn scenes (Waves, Starfield, Lava lamp, Fireflies, Flurry), your own photos (slideshow or scrapbook **collage**) and videos in separate folders, downloadable loops in [community-wallpapers](../community-wallpapers), and — theirs can't — **idle auto-start** (default 30 min) that wakes back to exactly the page you left. |
| Weather on the clock page | Flip Clock has an optional **weather widget** (Open-Meteo, off by default): city-or-address lookup, live conditions, temperature, and a readable headline. |
| Device diagnostics panel | **Device Diagnostics** app: Display / Touch / Knob connection check — confirmed working on real Bedrock + DK-QUAKE hardware. |
| Multi-OS: Windows, macOS, Linux | **All three ship.** Windows throughout; **macOS** (Apple Silicon, 14.2+) since **v0.9.5**, signed with a Developer ID and notarized; **Linux** (x64, `.deb` and AppImage) since **v0.9.6**. Knob, touchscreen and all three run modes work on each. The Windows C# helpers have Swift counterparts on macOS, and on Linux the same jobs are done by what the desktop already publishes — MPRIS, PipeWire, uinput, XDG portals — so there is no native helper tree at all. Linux also gains **built-in speech**, 90 voices in 36 languages plus a ladder of listening models, with no server, GPU or account. Wayland forbids two things and they are greyed out with the reason: Reserved Display and follow-the-focused-app. See [macos.md](macos.md) and [linux.md](linux.md). |
| OBS Studio controls (their "coming soon", targeted Sep 5 2026) | **Shipped** as a first-class **OBS** app speaking obs-websocket: scenes, sources, audio, stream/record state on the panel, Studio Mode and a Panic recovery action — state-driven rather than fire-and-forget hotkeys. |
| Game voice control | **[IF Player](../community-apps/if-player)** (community app): plays Z-machine / Glulx interactive fiction with voice narration (TTS reads each new passage aloud) and voice commands (speak "go north", "take lamp" — STT transcribes and enters automatically), plus a touch compass for directional controls. |

## ❌ Missing (the actual todo)

| Feature | What they advertise | Lift for Bedrock Panel |
|---|---|---|
| **System monitor** | Real-time CPU, memory, GPU, disk, network, battery ("SysView" in DK-Suite's page wheel) | **Medium.** Shipped once, then **retired at v0.5.2**: its metrics layer spawned a PowerShell process per reading, hundreds a minute, which endpoint-security tools reasonably flag as malware-like. It needs a replacement collection layer, not a revival — see [system-monitor.md](system-monitor.md). |
| **Colored iconfont import** | Import colored icon font ZIP files — preserves viewBox, path, and fill attributes; exports as transparent PNGs (shipped DK-Suite v0.4.71) | **Small/Medium.** Bedrock Panel has emoji search in the tile editor; this would let users bring custom icon sets from iconfont sources. |
| **QUAKE firmware OTA** | Over-the-air firmware updates for the console (their "coming soon", targeted Oct 12 2026) | **Medium**, and only partly ours: updating DECOKEE's own firmware is their business. The open **Bedrock** knob is the part we could serve. Today any firmware update means flashing by hand. |

## 🔮 Their "coming soon" list

| They promise | Bedrock Panel today |
|---|---|
| Discord Game Controls (a Discord panel already exists in DK-Suite's page wheel per teardown; the Kickstarter pitches an always-on overlay) | **Already shipped** (PR #29): OAuth (PKCE) login, Discord desktop RPC integration, and a first-class panel app — Bedrock Panel beat them to it. |
| OBS Studio Controls (targeting Sep 5, 2026) | **Already shipped** — a first-class **OBS** app over obs-websocket, with live scene, source, audio and output state on the panel. Moved to Have. |
| Spotify integration (targeting ~Sep 15, 2026) | Bedrock Panel ships a generic **Music controller** (now-playing, transport, lyrics) that covers Spotify wherever the OS publishes it — the Windows media flyout, Spotify's own notifications on a Mac, MPRIS on Linux. Spotify-specific support would need Spotify SDK/OAuth; their version is pending Spotify's commercial review process. |
| Profile switching via touchscreen (targeting Sep 26, 2026) | **Already have**: the knob page-selector and the AI Profiles full-screen picker both work from the touchscreen. |
| Clock & system monitor UI styles (targeting Sep 26, 2026) | Bedrock Panel ships several clock apps, so the clock half is covered. The system-monitor half is not: ours is retired, which is the open row in Missing above. |
| QUAKE firmware OTA update (targeting Oct 12, 2026) | No equivalent — firmware updates today require manual flashing. Tracked in Missing above. |
| Themes | **Already shipped**: light/dark/system + savable accent presets driving the panel, apps, and the knob ring — they're promising what Bedrock Panel has. |
| "And more" | New items land here as they announce them. |

## Notes

- Their "no cloud subscription required / open-source engine" claim still routes AI through their
  credit system — and their Kickstarter AI disclosure names the backend: everything is the OpenAI
  ChatGPT API, called server-side. Bedrock Panel's stance is stronger in practice (your CLIs, your
  servers, your keys).
- Hardware-only items (chassis, stand, transparent window, HDMI/USB wiring) are out of scope — both
  sides run the same device.
