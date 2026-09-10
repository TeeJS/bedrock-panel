# Bedrock Panel on macOS

Everything a Mac needs to run Bedrock Panel: installing the unsigned build, the macOS permissions
each feature needs and exactly where to grant them, and the Reserved Display setup for the DK-QUAKE.
Every path below was checked against macOS 26 (Tahoe); the same panes exist on 14 and 15.

Requirements: an Apple Silicon Mac on macOS 14.2 or newer. Software mode, the knob, the DK-QUAKE
touchscreen, Panel mode, meeting recording, and the Music page all work; see the end of this page for
what is still Windows-only.

## 1. Install and first launch

1. Open `bedrock-panel-arm64.dmg` and drag **Bedrock Panel** to **Applications**. Do not run it from
   the disk image.
2. Launch it from Applications. Because the build is not notarized yet (Apple Developer ID pending),
   macOS says it *could not verify* the app. Click **Done**.
3. Open **System Settings → Privacy & Security**, scroll down to the **Security** section, find the
   line "Bedrock Panel was blocked…", click **Open Anyway**, then **Open** in the dialog that follows.
   You do this once per new build. Terminal alternative:
   `xattr -dr com.apple.quarantine "/Applications/Bedrock Panel.app"`.
4. The first time the app touches a saved secret, macOS asks whether "Bedrock Panel" may access the
   key "bedrock-panel Safe Storage" in your keychain. Click **Always Allow** (it needs your login
   password). **This comes back once per new build**, Always Allow or not: the build is signed with a
   certificate that has no Apple Team ID, so the keychain files each build under its own code hash
   and a new build is a new app to it. It ends with an Apple Developer ID. (Deny leaves saved
   passwords and tokens unreadable until the next launch.)
5. A fresh install starts with the **macOS starter pages** — Default, Media, and Dev, built from apps
   every Mac has (Safari, Finder, Notes, Calculator, Activity Monitor, Terminal, System Settings,
   Screenshot, Mission Control, Music, Calendar, Messages, Console, System Information), web links,
   and volume tiles that need no permission. A config copied from Windows keeps its pages; its
   Windows program names are mapped to Mac apps where one exists (Chrome, Edge, Explorer → Finder,
   Notepad → TextEdit, Calc, Task Manager → Activity Monitor, `wt` → Terminal, …) and the `start
   ms-settings:` / `start sndvol` commands open System Settings and Sound. To add the Mac pages to
   an existing config: editor → **+ Add page → Starter pages…** and pick a page (or all three).

Running from source (`npm start`) works the same way, with one difference that matters for every
permission below: macOS attributes a command-line launch to the terminal application, so the entry
to enable in System Settings is **Terminal** (or iTerm, Warp, …), not Bedrock Panel or Electron.

## 2. Where the permissions live in the app

In the editor, click **⚙ Settings** (top right). The settings page has a list on the left; under
**Device**, open **Hardware** and scroll to the last section, **macOS permissions**. It has one row per
permission with a status pill and an **Open System Settings** button that jumps to the right pane.
Rows for Accessibility, Microphone, and Screen & System Audio Recording also have a **Request** button
that raises the macOS prompt; the other rows can only be granted in System Settings, because macOS
offers no prompt for them.

Nothing is requested at startup: each feature asks the first time it needs a permission. The
status pills refresh when you come back to the editor from System Settings.

## 3. The permissions, feature by feature

System Settings → **Privacy & Security** is the starting point for every row. "Who" is the entry to
turn on: **Bedrock Panel** for the installed app, **Terminal** when running `npm start`.

| Feature | Pane | Who | When macOS asks | If it does not ask |
|---|---|---|---|---|
| **DK-QUAKE touchscreen** | **Input Monitoring** | Bedrock Panel / Terminal | On some Macs never: macOS 26.6 on the development Mac answers every Input Monitoring or Accessibility request from a third-party app silently, shows no prompt, and does not list the app (verified with signed test apps calling each API Apple offers). A few seconds after launch the app therefore opens this pane itself and puts the steps on the panel. | With the app installed in **Applications** (grant only from its final location): click **+**, pick **Bedrock Panel** from Applications, turn it on. The touchscreen connects within about three seconds, no restart; if the app was replaced or moved after the entry was made, quit and relaunch it. Once per Mac, as long as builds carry the same signing certificate ([building.md](building.md)). |
| **Knob** | none | | | Works as soon as it is plugged in. |
| **Reserved Display** and **keystrokes** (paste tiles, macros, meeting hotkeys, media and volume keys) | **Accessibility** | Bedrock Panel / Terminal | Where macOS shows it: on the first keystroke, the first window that lands on the panel, or the **Request** button — "Bedrock Panel would like to control this computer using accessibility features", then **Open System Settings**. On the development Mac it never appears (see above). | Click **+**, pick **Bedrock Panel** from Applications, turn it on. Takes effect immediately. (Apple's rule says Accessibility also covers input from physical devices; on the development Mac it did not open the touchscreen on its own, so make the Input Monitoring entry as well.) |
| **Microphone** (meeting recordings, dictation, AI Voice, Live Translate) | **Microphone** | Bedrock Panel / Terminal | The first recording or dictation | Open the pane and turn the entry on. |
| **Meeting recording — system audio** (the other side of the call) | **Screen & System Audio Recording** → the **System Audio Recording Only** list | Bedrock Panel / Terminal | The first recording | Open the pane, turn the app on under **System Audio Recording Only**, then start the recording again. Without it the recording stops with a "system audio is blocked" error rather than saving a silent channel. Needs macOS 14.2 or newer. |
| **Slide capture** (and, as a fallback, meeting recording) | **Screen & System Audio Recording** → the **Screen Recording** list | Bedrock Panel / Terminal | The first capture | Turn it on under **Screen Recording**. A meeting recording captures its own hidden window as the throwaway video track, so it normally needs no Screen Recording; only if the log shows `loopback handler error: Failed to get sources` does it fall back to a screen source, which needs this. macOS 15+ re-confirms this permission every month. |
| **Recording folder under Documents** | **Files & Folders** | Bedrock Panel / Terminal | The first time a recording is saved | Open the pane, expand the app, turn **Documents Folder** on. |
| **Home Assistant, OBS, WLED, MQTT** | **Local Network** | Bedrock Panel | The first connection (installed app only, macOS 15+) | Open the pane and turn the entry on. This one cannot be reset by the app; a new user account is the only reset. |
| **Music page** (what is playing on Spotify or Music, and play/pause/next) | **Automation** | Bedrock Panel / Terminal | At launch when Spotify or Music is already open, or the first transport press | Open the pane, expand Bedrock Panel, turn on **Spotify** and/or **Music**. A refusal leaves the page to the players' own change notices (nothing shows until the next track change) and transport falls back to media keys. |
| **Calendar meeting info** (Settings → Meeting → Advanced, source **macOS Calendar**) | **Calendars** | Bedrock Panel / Terminal | The first **Check Connection**, or the first recording with the feature on | Open the pane, turn the entry on, choose **Full Access**. Outlook for Mac shares no calendar with other apps: add the account under **System Settings → Internet Accounts** with Calendars on, or use the **Microsoft 365** source. |

After installing a new build, a permission can show as on but stop working: macOS ties the grant to
the build's signature, so an **ad-hoc-signed** build (the default when nobody set up a signing
certificate — see the macOS section of [building.md](building.md)) is a new app to it every time,
and while the stale entry exists macOS shows no prompt. Builds signed with the same certificate,
which is how releases should be made, keep their grants from one version to the next. For
**Accessibility** the app repairs this itself the first time it needs the permission and no grant
arrives within a few seconds: it clears its own entry (the log says "cleared a stale Accessibility
entry") and asks again, which brings the prompt back; it also clears any Input Monitoring entry an
older build left behind, so that cannot override the Accessibility grant. For the others, remove the
entry with **−** and re-add it (toggling off and on is not always enough). From a terminal this clears them in one go so the next launch prompts again:

```bash
tccutil reset ListenEvent com.teejs.bedrockpanel; tccutil reset Accessibility com.teejs.bedrockpanel
```

(`Microphone`, `ScreenCapture`, `AppleEvents`, or `All` work the same way; use `com.apple.Terminal`
for `npm start` runs.)

## 4. Reserved Display: keep other windows off the panel

macOS opens an app's new windows on the *active* display — the one you clicked last — and will
happily put them on the panel, where they end up behind it, because in Panel mode the panel always
covers that display, menu bar and Dock included. Two things keep that from happening: the display
arrangement rule in section 5 keeps the cursor (and so your clicks) off the Quake, and Reserved
Display moves any window that still lands there to another display within half a second. Reserved
Display is on by default on a Mac and only needs Accessibility.

1. Grant **Accessibility** (section 3). Until it is granted, the panel shows a notice the moment a
   window lands behind it.
2. **⚙ Settings → Device → Monitor**: **Keep application windows off the panel display** should
   already be ticked; if not, tick it and click **Save & apply** (bottom right).
3. Drag any window onto the panel and let go: it jumps back to your main display and the log shows
   `[reserved-display] moved hwnd=…`. If the log shows a `permission` line instead, Accessibility is
   not granted to the right app.

Windows already sitting behind the panel are moved as soon as protection starts. Reserved Display
is only active in Panel mode and pauses while Monitor mode is on. A window in its own full-screen
Space cannot be moved by any app.

## 5. Panel mode on a Mac

Panel mode covers the 1920×480 display with a plain window built the way DK-Suite builds its own:
no full-screen Space, pinned above the menu bar and the Dock on that display (so neither shows on
the Quake), and placed without taking keyboard focus. By default the mouse and keyboard can use the
panel just as on Windows — click a tile, type into a dashboard after clicking it. A click on the
panel makes the Quake the active display until you click elsewhere (macOS puts the menu bar and new
windows on the active display; Reserved Display brings windows back). If you would rather have a
touch-only panel that clicks pass through and that never takes focus — the way DK-Suite's panel
behaves — untick **Mouse and keyboard can use the panel** under ⚙ Settings → Device → Monitor. The one thing that can still appear over it is macOS's
privacy indicator in the top-right corner: orange for the microphone, green for the camera,
**purple for screen recording** — and a DisplayLink adapter shows the purple one permanently,
because DisplayLink Manager records the screen to drive its displays. That indicator belongs to
macOS; no app can hide it. The Windows-only **Set up touchscreen** wizard has no macOS counterpart
and is not shown.

**Display arrangement.** With "Displays have separate Spaces" (the macOS default) the display you
clicked last owns the active menu bar and gets every new window, and a 1920×480 strip arranged
under a big display is exactly where the cursor lands when it moves down off that display — one
click there and your menus open on the Quake, behind the panel. So Bedrock Panel keeps the Quake at
the **far right of your other displays, never mirrored and never the main display**, the same rule
DK-Suite enforces. It checks at launch, whenever a display is added or changes, and whenever you
save Settings; when it has to move the Quake the panel says so and the log shows
`[display-arrange] arrangement fixed`. The change is written to macOS like a change in System
Settings → Displays, so it stays after Bedrock Panel quits, and nothing else about your displays is
touched. To arrange the Quake yourself, untick **Keep the panel display at the far right of the
display arrangement** under ⚙ Settings → Device → Monitor first, or it will be moved back.

## 6. What is still Windows-only

Outlook desktop meeting info (use Microsoft 365), the touchscreen binding wizard, album-art
thumbnails from the media session (art comes from Spotify or the iTunes lookup instead), and the
community apps that depend on Windows executables (`spotify-volume`, `deck-host`, `git-updater`).
Secrets saved on Windows cannot be read on a Mac: after copying a config over, re-enter them.

## 6a. Speech without a server: the built-in macOS engine

On a Mac the voice features (AI Voice pages, LucidType dictation, the Test-speech button) use
macOS itself unless you point them at speech servers: Apple's speech recognition, on-device where
the language supports it, and the system voices. Nothing to install and nothing leaves the Mac.

- ⚙ Settings → Integrations → **TTS/STT** → **Engine**: *Built-in macOS speech* (the default when
  the host fields are empty), or *Speech servers* to use Whisper/Piper hosts of your own. The
  **Voice** list holds every installed system voice, filtered by language and with a **Preview**
  button. The default-quality voices are the small, dated ones; a voice's **Enhanced** or
  **Premium** version is a separate download (a few hundred MB each) that the app cannot make for
  you: System Settings → Accessibility → **Read & Speak** → the **ⓘ** next to *System voice* → pick
  the language on the left → click the voice → **Download** (macOS 26; on macOS 14/15 it is
  Spoken Content → System voice → **Manage Voices**). Click **Rescan** afterwards to see it here.
- The first time something is transcribed, macOS asks for **Speech Recognition** — allow it. Until
  then speaking works and dictation returns nothing; the Status line on the tab says which.
- **macOS 26:** live recognition uses Apple's SpeechAnalyzer — on this Mac, no Dictation setting, no
  prompt. The Status line says `speechanalyzer`. Each language's model downloads once, on first use
  (about a minute; the voice page waits). It covers German, English, Spanish, French, Italian,
  Portuguese, Japanese, Korean, Chinese, and Cantonese; a bare code such as `de` means the home
  region (Germany, Spain, France, Brazil for `pt`), and `de-AT`-style codes are used as given.
  Other languages fall back to the older recognizer below, Dictation and all.
- **macOS 14 and 15 — on-device recognition needs Dictation turned on**: System Settings → **Keyboard** → **Dictation**
  → on (macOS then downloads the language). With Dictation and Siri both off, Apple's recognizer
  refuses with "Siri and Dictation are disabled"; the engine then falls back to Apple's servers for
  that request and the Status line says so. Turn Dictation on to keep everything on the Mac.
- The engine is the `speech-server` helper serving the Wyoming protocol on 127.0.0.1:10300 (STT)
  and :10200 (TTS), so anything else on this Mac that speaks Wyoming (Home Assistant's Wyoming
  integration, for one) can use it too while Bedrock Panel runs. If those ports are taken by a
  server of your own, choose *Speech servers* instead.
- The **Microphone** permission is still needed for the pages that listen (section 3).
- **Meeting recordings are transcribed on this Mac too** (Settings → Automation → Meeting →
  Transcription → *Built-in macOS speech*, the default on a Mac): Apple's on-device speech
  (SpeechAnalyzer on macOS 26, SFSpeechRecognizer on 14/15) reads the recording's two channels —
  your microphone, labelled with **Your name**, and the system audio, labelled "Others" — and files
  the same transcript JSON a diarizer server would, so the AI meeting notes work unchanged. It cannot
  tell one remote voice from another; for named attendees and enrolled voices point the Server URL at
  a tts-sst or meeting-diarizer server and choose *Diarizer server*. The language model is downloaded
  once, on the first transcription (a few hundred MB, needs the network that one time).

## 7. Troubleshooting

- **Editor opens blank on the first launch of a new build** — the keychain prompt is waiting behind
  another window; answer it (Always Allow).
- **`dev error: aris68 runtime failed: cannot open device … Input Monitoring`** — section 3, first row.
- **Apps launched from the grid seem to do nothing** — their window opened on the panel display. Turn
  on Reserved Display (section 4); it moves them to your main display.
- **`[reserved-display] Accessibility permission is needed…`** — grant Accessibility to Bedrock Panel,
  or to Terminal for `npm start`.
- **Recording stops with "system audio is blocked"** — System Audio Recording Only, section 3.
- **Macros, paste tiles, or media keys do nothing** — Accessibility.
- **"Secret encryption is unavailable" when saving** — the keychain prompt was denied; relaunch and
  click Always Allow.
- **Notifications never appear** — expected for the unsigned build; they are logged instead.
- **A purple dot in the panel's top-right corner** — macOS's screen-recording indicator, usually
  DisplayLink Manager (click the dot in the menu bar to see who is recording). Not Bedrock Panel, and
  not hideable.
- **App menus open behind the panel, or the menu bar looks inactive on your main display** — macOS
  made the Quake the active display, which takes a click on it: the cursor slid onto the Quake
  (arranged under or beside a display) and the next click landed there. Click once on your main
  display to bring the menus back, and leave the far-right arrangement rule on (section 5) so the
  cursor cannot get there. Quitting Bedrock Panel lets the Quake go dark while macOS still uses it;
  if windows are stuck on a dark Quake, unplug its display cable for a few seconds and macOS moves
  them to the remaining displays.
- **The Quake jumped to the far right of the display arrangement** — the arrangement rule in
  section 5 did that (the panel said so, and the log has `[display-arrange]`). Untick the setting
  under ⚙ Settings → Device → Monitor to arrange it yourself.
- **`connect: touch (shared, seize refused: …)` in the log** — macOS let the app read the
  touchscreen but not take it away from its own drivers; touch works, and the app is in the same
  mode DK-Suite runs in. Nothing to do.
