# Music Assistant (`music-assistant`)

Full controller for a [Music Assistant](https://www.music-assistant.io/) server on the
1920×480 panel: now playing with album art, transport and scrubbing, per-player and
group volume, live queue (reorder, remove, play-from-here, transfer), speaker
selection and grouping, and a full library browser with search on an on-screen
keyboard. Real-time — the page talks to MA's WebSocket API directly and follows
every change instantly.

## Setup

1. In Music Assistant (2.7 or newer), open **Settings → Profile** and create a
   **long-lived token**.
2. In the page's options in the Bedrock Panel editor:
   - **Music Assistant URL** — e.g. `http://192.168.1.25:8095` or your reverse-proxy
     address (`https://…` works too).
   - **API token** — paste the long-lived token (stored encrypted).
   - **Default player** — optional player name to control on open; blank remembers
     the last-used player.

MA servers older than 2.7 (no authentication) work without a token.

## Using it

- **Middle**: transport, scrub bar (drag, seek on release), wide volume slider.
  The heart adds the current track to favorites.
- **Queue** (right of center): tap a row to play it, long-press for options
  (play from here / move next / move to end / remove), drag the ≡ handle to
  reorder. ∞ Auto = MA's Don't Stop The Music. ⋯ = clear, save as playlist,
  transfer to another player.
- **Players** (right edge): tap to switch the controlled player, long-press for
  transfer/group/power. The link button opens grouping with per-member volume.
- **Library / Search**: full-screen browser — Home shelves (recently played,
  favorites, MA recommendations), cover grids with an A–Z jump bar, tracks list,
  and search with an on-screen keyboard. Tap plays now; long-press for
  play next / add to queue / replace / favorites.
- **Knob**: rotate = volume, press = play/pause. Double-press and hold keep
  their panel defaults (page selector, push-to-talk).

## Notes

- The token never appears in URLs; the page fetches it over the host's local,
  same-origin config route and keeps it in memory only.
- Cover art loads straight from the MA image proxy.
- Very large libraries: the grid tabs load up to 2000 entries per type — use
  Search beyond that.
- `node check.js` runs the self-check of the pure helpers.
