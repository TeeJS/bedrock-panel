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
| **DK-QUAKE touchscreen** (the app takes the touch controller away from macOS, which otherwise treats it as a mouse: every tap would be a click on the Quake, making it the active display and pulling menus and new windows onto it) | **Input Monitoring** | Bedrock Panel / Terminal | Often not at all for the touch controller — so the app opens this pane for you the first time the touchscreen is refused, and says so on the panel | Turn **Bedrock Panel** on; click **+** and pick it from Applications if it is not listed. **If it is listed and already on, remove it with − and add it again**: until builds are notarized, every new build is a new app to macOS and the old grant is stale. The panel picks the touchscreen up within about three seconds, no restart. Device Diagnostics shows the refusal on the Touchscreen row until then. |
| **Knob** | none | | | Works as soon as it is plugged in. |
| **Keystrokes** (paste tiles, macros, meeting hotkeys, media and volume keys) and **Reserved Display** | **Accessibility** | Bedrock Panel / Terminal | The first keystroke, or the **Request** button | Open the pane and turn the entry on. Takes effect immediately. |
| **Microphone** (meeting recordings, dictation, AI Voice, Live Translate) | **Microphone** | Bedrock Panel / Terminal | The first recording or dictation | Open the pane and turn the entry on. |
| **Meeting recording — system audio** (the other side of the call) | **Screen & System Audio Recording** → the **System Audio Recording Only** list | Bedrock Panel / Terminal | The first recording | Open the pane, turn the app on under **System Audio Recording Only**, then start the recording again. Without it the recording stops with a "system audio is blocked" error rather than saving a silent channel. Needs macOS 14.2 or newer. |
| **Meeting recording — screen** and **slide capture** | **Screen & System Audio Recording** → the **Screen Recording** list | Bedrock Panel / Terminal | The first recording or capture | Turn it on under **Screen Recording**. For recordings the video is discarded; denying only affects slide capture and window titles in its picker. macOS 15+ re-confirms this permission every month. |
| **Recording folder under Documents** | **Files & Folders** | Bedrock Panel / Terminal | The first time a recording is saved | Open the pane, expand the app, turn **Documents Folder** on. |
| **Home Assistant, OBS, WLED, MQTT** | **Local Network** | Bedrock Panel | The first connection (installed app only, macOS 15+) | Open the pane and turn the entry on. This one cannot be reset by the app; a new user account is the only reset. |
| **Music page transport** (play/pause/next on Spotify or Music) | **Automation** | Bedrock Panel / Terminal | The first transport press | Open the pane, expand the app, turn on **Spotify** and/or **Music**. A refusal falls back to media keys (Accessibility). |
| **Calendar meeting info** | not needed | | | Use the **Microsoft 365** calendar source (Settings → Automation → Meeting). The Outlook desktop source is Windows-only. |

After installing a new build, a permission can show as on but stop working: macOS ties the grant to
the build's signature until builds are notarized, so every new build is a new app to it. Remove the
entry with **−** and re-add it (toggling off and on is not always enough). From a terminal this
clears them in one go so the next launch prompts again:

```bash
tccutil reset ListenEvent com.teejs.bedrockpanel; tccutil reset Accessibility com.teejs.bedrockpanel
```

(`Microphone`, `ScreenCapture`, `AppleEvents`, or `All` work the same way; use `com.apple.Terminal`
for `npm start` runs.)

## 4. Reserved Display: keep other windows off the panel

macOS decides where an app opens its windows and will happily put them on the panel — where they
end up behind it, because in Panel mode the panel always covers that display, menu bar and Dock
included. Reserved Display moves them to another display within half a second. It is on by default
on a Mac and only needs Accessibility.

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

Panel mode places the panel on the 1920×480 display using macOS simple full screen (no separate
Space) and never takes keyboard focus, so touching the panel does not steal focus from what you are
doing. The panel window sits above the menu bar and the Dock on that display, so neither shows on
the Quake. The one thing that can still appear over it is macOS's privacy indicator in the top-right
corner: orange for the microphone, green for the camera, **purple for screen recording** — and a
DisplayLink adapter shows the purple one permanently, because DisplayLink Manager records the screen
to drive its displays. That indicator belongs to macOS; no app can hide it. The Windows-only **Set up
touchscreen** wizard has no macOS counterpart and is not shown.

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
- **App menus disappear, or the menu bar looks inactive on your main display** — macOS made the
  Quake the active display. Click once on your main display to bring it back. It happens when
  something clicks on the Quake: before Input Monitoring is granted the touchscreen itself does that
  (macOS treats it as a mouse until the app can take it over), and quitting Bedrock Panel lets the
  Quake go dark while macOS still uses it. If windows are stuck on a dark Quake, unplug its display
  cable for a few seconds; macOS moves them to the remaining displays.
