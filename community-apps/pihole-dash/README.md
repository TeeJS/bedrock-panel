# Pi-hole Dashboard (`pihole-dash`)

Multi-server **Pi-hole** dashboard for the 1920×480 panel: up to four Pi-holes
as **tabs on one pane of glass**, each with live stats, a 24-hour query chart,
top-blocked/top-client lists, and blocking controls.

## Layout

- **Tab strip** — one tab per configured server: name + status dot (green =
  blocking, amber = blocking off/paused, red ✕ = unreachable) and a small live
  stat, so every server is visible at a glance.
- **Stat tiles** — queries, blocked, percent blocked (rolling 24 h), blocklist
  size, active clients, query rate.
- **Chart + lists** — 24-hour query volume with the blocked share in red inside
  each bar; top blocked domains; top clients.
- **Controls** — **Pause 5 min / Disable / Enable now** for the active server's
  blocking (paused shows a live resume countdown), and **Open Pi-hole web UI**
  in the default browser on the PC.

## Setup

Requires **Pi-hole v6** (a v5 server is detected and reported on its tab —
update it). For each server slot: a tab name, the base URL (e.g.
`http://192.168.1.2`), and the password. Leave a slot's URL blank to hide it.

**Use an app password**, not your admin password: Pi-hole web UI → Settings →
Web Interface / API → **App password**. It works even with 2FA enabled and can
be revoked without changing your admin login.

Also configurable: refresh interval (5/10/30 s).

## Notes

- All requests go through the app's `server.js` on the panel host — passwords
  are encrypted `serverOnly` secrets and never reach the page. One API session
  per server is reused (Pi-hole caps concurrent sessions), re-authenticating
  only when it expires. Pi-holes with **no password** work too.
- Pi-hole v6 sends no CORS headers, so the server-side relay is required — by
  design here anyway.
- Stats are FTL's rolling 24-hour window (not "today since midnight").
- HTTPS with Pi-hole's self-signed certificate isn't supported yet — use the
  plain http:// LAN address.
- After updating the app, restart Bedrock Panel: `server.js` changes only load
  with the host process.
