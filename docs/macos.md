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
4. The first time the app touches a saved secret, macOS asks whether "bedrock-panel" may access a key
   in your keychain. Click **Always Allow**. (Deny leaves saved passwords and tokens unreadable until
   the next launch.)

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
| **DK-QUAKE touchscreen** | **Input Monitoring** (Accessibility covers it too) | Bedrock Panel / Terminal | On some Macs never: macOS 26.6 on the development Mac answers every Input Monitoring or Accessibility request from a third-party app silently, shows no prompt, and does not list the app (verified with signed test apps calling each API Apple offers). A few seconds after launch the app therefore opens this pane itself and puts the steps on the panel. | Click **+**, pick **Bedrock Panel** from Applications, turn it on. The touchscreen connects within about three seconds, no restart. Once per Mac, as long as builds carry the same signing certificate ([building.md](building.md)). |
| **Knob** | none | | | Works as soon as it is plugged in. |
| **Reserved Display** and **keystrokes** (paste tiles, macros, meeting hotkeys, media and volume keys) | **Accessibility** | Bedrock Panel / Terminal | Where macOS shows it: on the first keystroke, the first window that lands on the panel, or the **Request** button — "Bedrock Panel would like to control this computer using accessibility features", then **Open System Settings**. On the development Mac it never appears (see above). | Click **+**, pick **Bedrock Panel** from Applications, turn it on. Takes effect immediately. Accessibility also covers the touchscreen (the rule Karabiner-Elements documents), so it can stand in for the Input Monitoring entry. |
| **Microphone** (meeting recordings, dictation, AI Voice, Live Translate) | **Microphone** | Bedrock Panel / Terminal | The first recording or dictation | Open the pane and turn the entry on. |
| **Meeting recording — system audio** (the other side of the call) | **Screen & System Audio Recording** → the **System Audio Recording Only** list | Bedrock Panel / Terminal | The first recording | Open the pane, turn the app on under **System Audio Recording Only**, then start the recording again. Without it the recording stops with a "system audio is blocked" error rather than saving a silent channel. Needs macOS 14.2 or newer. |
| **Meeting recording — screen** and **slide capture** | **Screen & System Audio Recording** → the **Screen Recording** list | Bedrock Panel / Terminal | The first recording or capture | Turn it on under **Screen Recording**. For recordings the video is discarded; denying only affects slide capture and window titles in its picker. macOS 15+ re-confirms this permission every month. |
| **Recording folder under Documents** | **Files & Folders** | Bedrock Panel / Terminal | The first time a recording is saved | Open the pane, expand the app, turn **Documents Folder** on. |
| **Home Assistant, OBS, WLED, MQTT** | **Local Network** | Bedrock Panel | The first connection (installed app only, macOS 15+) | Open the pane and turn the entry on. This one cannot be reset by the app; a new user account is the only reset. |
| **Music page transport** (play/pause/next on Spotify or Music) | **Automation** | Bedrock Panel / Terminal | The first transport press | Open the pane, expand the app, turn on **Spotify** and/or **Music**. A refusal falls back to media keys (Accessibility). |
| **Calendar meeting info** | not needed | | | Use the **Microsoft 365** calendar source (Settings → Automation → Meeting). The Outlook desktop source is Windows-only. |

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
the Quake), never the keyboard focus, and ignoring the mouse — touch arrives over the USB
connection, so a cursor that strays onto the Quake cannot press a tile, and nothing on the panel
steals focus from what you are doing. The one thing that can still appear over it is macOS's
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
