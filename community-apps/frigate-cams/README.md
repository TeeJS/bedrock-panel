# Frigate Cameras

Live camera wall for a local [Frigate](https://frigate.video) NVR on the 1920×480 panel. Enter one URL — the app reads Frigate's `/api/config` and discovers every camera itself.

## Setup

1. Add the app to a page and open its **App options**.
2. Set **Frigate URL** to Frigate's **internal (unauthenticated) address**, e.g. `http://<your-frigate-ip>:5000`.
   - This is Frigate's internal port **5000**, not the login port **8971**. The authenticated port uses a JWT cookie that image tags can't carry; support for it may come later.
   - Works on a trusted LAN where port 5000 is reachable from the machine running Bedrock Panel.

## View modes

- **Grid** — every camera at once, auto-tiled to fill the panel (1 to 24+ cameras). Tap a tile to jump to Spotlight on it.
- **Spotlight** — one big feed plus a thumbnail rail of the rest. Tap a thumbnail to promote it; tap the big feed to go back to Grid.
- **Cycle** — a single full-panel feed that auto-advances through all cameras. Tap to pause/resume.

## Live vs stills

Tiles show **moving MJPEG video** by default (`/api/<cam>`, ~5 fps). The **LIVE/STILLS** chip (or the *Stills* option) switches to auto-refreshing snapshots (`latest.jpg`) — much lighter on the Frigate server and recommended for grids past ~8 cameras.

Spotlight's thumbnail rail always uses stills — only the big tile holds a stream open.

Browsers and reverse proxies cap concurrent streams (HTTP/1.1 allows ~6 per host, and proxies often allow fewer), so on big grids some live tiles can starve. The app watches for that: a live tile that never paints is kicked with a fresh connection, and if it still won't start, that tile falls back to auto-refreshing stills (badge shows STILLS) while the camera stays reachable. Truly unreachable cameras show SIGNAL LOST and are retried every 15 s.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| Frigate URL | — | `http://<host>:5000` |
| View mode | Grid | Grid / Spotlight / Cycle |
| Stills instead of live video | off | snapshot refresh instead of MJPEG |
| Still refresh rate | 2 s | 1–10 s |
| Cycle dwell time | 10 s | 5–30 s |
| Cameras | all | comma-separated names, in display order |

## Not in v1

- Frigate's authenticated port (8971) — needs a login proxy.
- HD/audio streams (go2rtc MSE/WebRTC), events feed, PTZ.
