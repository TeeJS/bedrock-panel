# Dev Services

A compact Bedrock Panel drop-in panel for configured local development services.

## What it does

- Checks up to 12 configured HTTP/HTTPS services, four cards per horizontal page.
- Builds and opens the configured URL, copies it through Electron's trusted clipboard, and can
  open an existing absolute project folder.
- Shows listening, stopped, checking, error, and expected-process mismatch states.
- Identifies the owning PID/process on Windows and Linux when the current user can inspect it.
- Offers a guarded stop action only after one owner is identified and confirmed again.

The desktop editor shows this description and a larger service editor when a Dev Services page
is selected. Services can be added, removed, reordered, and edited there, including the optional
expected process and project folder. The same editor remains available on the panel for quick
changes.

Settings are stored once in Bedrock Panel's per-user app-data directory and shared by the desktop
editor and panel. Existing panel-local settings are migrated into that store on first use. The
single polling controller pauses while the page is hidden or while panel settings are open.

## Platform details

- **Windows:** one persistent, hidden, non-interactive Windows PowerShell process handles batched
  Get-NetTCPConnection/Get-Process requests. It is closed when the app server is invalidated.
  Polling never launches one PowerShell process per refresh.
- **Linux:** /proc/net/tcp* and /proc/<pid>/fd are read directly; no helper process is launched.
- **macOS and other platforms:** port checks, URL actions, clipboard, settings, and folders work,
  but process ownership and Stop are unavailable.

Node's native net module performs port checks on every supported platform. Node/Electron does
not expose a portable socket-table-to-PID API, which is why ownership is isolated behind the
platform adapter.

## Stop safety

The renderer never supplies a PID to terminate. A status response includes a short-lived opaque
observation token only when exactly one safe local PID owns the port and any expected process
matches. The server consumes that token once, re-reads the port table, compares PID and process
name, rejects system/current/parent processes, and only then sends SIGTERM. A mismatch,
ambiguous owner, stale token, remote host, or lookup failure stops nothing.

Run the focused checks with:

    node --test community-apps/dev-services/*.test.js
