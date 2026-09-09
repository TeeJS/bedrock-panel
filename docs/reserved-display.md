# Reserved Display

Reserved Display keeps ordinary application windows off the Quake while Bedrock Panel is
using it as the panel. Enable it under **Settings → Monitor → Reserved Display**. It is
off by default and does not change the USB HID screen-on/keepalive behavior. Windows and
macOS have their own helper; the macOS notes are at the end.

Electron identifies the reserved display from the panel window's current bounds and
sends replaceable topology snapshots to a persistent, per-user C# helper. The helper
uses documented Win32 event hooks plus a low-frequency reconciliation scan. It filters
for visible, non-minimized, unowned top-level application windows, excluding child/tool
windows, cloaked UWP surfaces, shell classes, Bedrock Panel's process, and the helper.

A window counts as occupying the Quake when its center is inside the display or more
than half its rectangle overlaps it. After a drag finishes, the helper preserves the
normal rectangle and maximized state and moves the window to its cached prior display,
the nearest non-Quake display, or the primary display. A few pixels of shadow overlap
do not trigger a move.

If no other display exists, eligible windows relocated to the Quake are minimized and
marked on their HWND for deferred restoration. When a non-Quake display returns, they are validated
by HWND, process id, and window class before being restored. Closed or handle-reused
windows are discarded. The marker also lets a restarted helper distinguish these from
windows the user minimized. **Monitor Mode suspends all enforcement** until it exits.

## macOS

On a Mac the same controller drives `native/mac/reserved-display.swift` (built by
`build-mac-helpers.js`), which takes the same configuration snapshots. It finds windows with
CGWindowList on a half-second scan and moves them through the **Accessibility** API, so the
permission must be granted to Bedrock Panel (or to the terminal app when running `npm start`);
until then the helper logs one `permission` event and moves nothing. The rules match Windows: a
window occupying the panel (center inside it, or more than half its area) goes back to the
display it last lived on, else the nearest other display, else the primary, same size and kept
inside that display's work area; nothing moves while a mouse button is held, so a drag completes
before the window is returned; only regular apps' normal windows are touched (never Bedrock
Panel, the Dock, menu-bar extras, or system UI); with no other display a window is minimized and
un-minimized onto a display when one returns. Two macOS differences: there is no maximized state
to preserve, and a window in its own full-screen Space cannot be moved.

Independently of the helper, the kiosk panel window on macOS is a plain frameless window covering
exactly the panel display — the way DK-Suite's own RemoteScreen window is built, not a full-screen
or simple-full-screen window (simple full screen sets app-wide presentation options that hide the
menu bar on every display whenever Bedrock Panel is the active app). It is placed without taking key
focus (the display owning the key window is where macOS prefers to open other apps' new windows),
takes it only on a deliberate click when "Mouse and keyboard can use the panel" is on (off: touch-only,
click-through, never key), is visible on every Space, and sits at the screen-saver window level
+ 1, above the menu bar (level 24), Control Center's menu items (25), and the Dock (20) that macOS
draws on every display when "Displays have separate Spaces" is on. A window that macOS opens on the
panel display therefore lands behind the panel, which is why Reserved Display is on by default on a
Mac and the panel shows a notice while Accessibility is still missing. macOS still decides where an
app opens its windows — on the display that was clicked last — so a second macOS helper,
`native/mac/display-arrange.swift` (`app/displayArrange.js`), keeps the panel display at the far
right of the arrangement, never mirrored and never the main display, exactly as DK-Suite's
display_manager tool does: the cursor cannot slide onto the panel and click it active. The
reserved-display helper is what keeps the panel clear of whatever still lands there.

## Build and automated checks

```powershell
npm run build:smtc
npm test
```

`build:smtc` compiles `native/reserved-display.cs` to
`app/native/reserved-display.exe`. Electron Builder already unpacks and signs every
executable in that directory.

## Repeatable manual checks

Use a build with console logging visible; reserved-display messages use the
`[reserved-display]` prefix.

1. Enable Reserved Display and save. Drag Notepad onto the Quake and release it.
   Confirm Notepad moves back and the panel does not move.
2. Enter Monitor Mode. Drag Notepad onto the Quake and confirm it stays. Exit Monitor
   Mode and repeat; it must move away again.
3. Arrange normal and maximized windows across both primary displays. Power both
   displays off while leaving the Quake connected. Confirm no ordinary window remains
   visible on the Quake.
4. Restore the displays. Confirm deferred windows return to sensible work-area
   positions and maximized windows remain maximized.
5. Repeat with dialogs, multiple windows from one process, UWP apps, minimized apps,
   DevTools, the Start menu, notifications, and the taskbar. Shell surfaces, Bedrock Panel
   windows, minimized windows, and owned dialogs should not be independently moved.
6. Repeat after changing the Quake orientation, reconnecting HDMI, restarting Open
   Quake, and terminating `reserved-display.exe` in Task Manager (it should restart
   while protection remains enabled).
