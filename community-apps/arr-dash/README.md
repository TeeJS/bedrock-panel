# *arr Dashboard (`arr-dash`)

At-a-glance dashboard for a home media-automation stack on the 1920×480 panel:
**Sonarr, Radarr, Lidarr, SABnzbd, Youtarr, and LidaTube** in one view — what's
downloading, what's unhealthy, how much disk is left, and what arrives in the
next 24 hours. Read-only: it watches your servers, it doesn't drive them.

## Layout

- **Left — service rail.** One row per configured service, in its app's brand
  color: status headline (queue count + missing/wanted, SAB speed, Youtarr jobs,
  LidaTube up/down). A service that can't be reached shows **Down** with a red ✕
  through its dot. Unconfigured services are hidden.
- **Center — active downloads.** All services' in-progress downloads merged into
  one list, sorted by progress, with per-item progress bars and ETAs.
- **Right — health & disk.** Health warnings/errors, disk-space bars (deduped
  across services), and the next 24 hours of upcoming episodes/movies/albums.

**Tap a service name** to focus it: the center shows only that app's downloads
plus its last 5 history entries, the right column filters to that app, and an
**Open ‹App› web UI** button opens its web interface in the default browser on
the PC. Tap **‹ All apps** (or the row again) to return to the combined view.

## Setup

Install from **Settings → Drop-In Apps**, then fill in the app's options. Every
service is optional — leave its URL blank to hide it.

| Service | Needs | Where to find it |
|---|---|---|
| Sonarr / Radarr / Lidarr | URL + API key | Settings → General → API Key |
| SABnzbd | URL + API key | Config → General → API Key (the full key) |
| Youtarr | URL, plus username + password unless it runs with `AUTH_ENABLED=false` | Your Youtarr login |
| LidaTube | URL only | — (no API; the dashboard shows reachability only) |

Also configurable: refresh interval (5/10/30 s).

## Notes

- All requests go through the app's own `server.js` on the panel host — API
  keys are stored as encrypted `serverOnly` secrets and never reach the page or
  its URL. This also sidesteps the missing-CORS situation on SABnzbd/Youtarr.
- Health messages matching *"removed from TheTVDB"* or *"completed download
  handling"* are filtered out as noise.
- LidaTube exposes no HTTP status API (socket.io only), so its tile is a
  reachability check — **Down** there means the container really isn't
  answering.
- After updating the app, restart Bedrock Panel: page files reload immediately,
  but `server.js` changes only load with the host process.
