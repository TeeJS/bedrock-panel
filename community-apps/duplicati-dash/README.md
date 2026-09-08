# Duplicati Dashboard (`duplicati-dash`)

Backup status board for a **Duplicati** server on the 1920×480 panel: every
backup job as a row with a **green/red result dot** (amber for warnings, hollow
gray for never-ran), last run + duration, source→backup size, version count,
and next scheduled run. A failed job shows its error message inline. The right
column shows the server state — including **live phase, progress, and upload
speed while a backup runs** — an OK/warn/fail tally, recent notifications, and
an **Open Duplicati web UI** button that opens the dashboard in the default
browser on the PC.

With more than ~5 jobs the list scrolls (finger-draggable scrollbar) and rows
sort failed → warning → ok → never-ran, so a red backup is always visible
without scrolling.

## Setup

- **Duplicati URL** — e.g. `http://192.168.1.25:8200`.
- **Web UI password** — stored as an encrypted secret, never reaches the page.
- **Pre-auth token (optional)** — used instead of the password when set;
  requires Duplicati started with `--webservice-pre-auth-tokens=<token>`.
- **Refresh interval** — 10/30/60 s (default 30).

## Duplicati-side requirements

- **Hostname allowlist:** Duplicati only accepts requests addressed to
  `localhost` unless started with `--webservice-allowed-hostnames=<name|*>`
  (on Docker/Unraid, add it to the container's extra args). The app also
  retries with a `Host: localhost` override, but setting the flag is the
  reliable fix if every poll returns HTTP 403.
- Remote access needs `--webservice-interface=any` (Docker images usually set
  this already).

## Notes

- Status is derived the way Duplicati itself does it: per-backup notifications
  (auto-cleared on the next clean run) plus the last-error-newer-than-last-backup
  rule — not just "has an error ever happened".
- Read-only: the dashboard never starts, stops, or deletes anything, and never
  dismisses notifications.
- After updating the app, restart Bedrock Panel: `server.js` changes only load
  with the host process.
