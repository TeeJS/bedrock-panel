# Music controller

A built-in **Music** app shows what's playing on your PC — **album art**, title, artist, and play
state — with big touch **transport controls** (play/pause, next, previous, stop). It's added on
first run; like any app you can delete it (it stays gone) or add more via **+ App**.

- **Now-playing** is read from the Windows media flyout (System Media Transport Controls), so it's
  **app-agnostic** — and the transport buttons send standard media keys, controlling whatever's playing.
  Album art comes from the track's embedded thumbnail (a small bundled helper), with an iTunes-search fallback.
- **No admin, no extra software.**

## Panels (album art · lyrics · button grid)

Open the Music app in the [editor](editor.md) — its **Panels** box has three toggles, **at most two
on at once** (screen space):

- **Show album art** — the cover on the far left. Unchecked, the rest slides left to fill the space.
- **Show lyrics** — a scrollable lyrics panel. Synced lyrics (from [LRCLIB](https://lrclib.net)) highlight
  the current line and **auto-scroll** with playback; plain lyrics scroll manually; no match shows
  "No lyrics found". The knob's *Scroll in window* scrolls it (auto-scroll pauses briefly after).
- **Buttons (grid)** — a launcher strip pinned to the far right (Spotify, YouTube Music, Apple Music,
  Tidal by default). Pick its **size** (2×1 / 2×2 / 2×3) and edit its tiles on the **Buttons** tab,
  exactly like a [dashboard button grid](dashboards.md). Picking 2×3 tightens the player's spacing to fit.

## Compatibility

**Works with** anything that appears in the Windows media flyout — tested with Spotify, YouTube Music,
Music Assistant, Amazon Music, Tidal, Apple Music (web), SoundCloud, Bandcamp, and Plex (web). Browser
players generally "just work" via the browser's media-session integration. A few desktop apps don't
register with the flyout and so won't show now-playing or respond to the buttons (e.g. **VLC**, **Plexamp**).

**macOS:** the Music page has nothing to show yet — now-playing comes from Windows' media flyout, and
the macOS source (Music.app and Spotify) is part of the native-helper port that follows the Software-mode
release. The transport buttons still send media keys once Accessibility is granted (Settings → Hardware →
macOS permissions).

**Volume note:** the knob's *System volume* controls the OS master volume. Windows exposes no per-tab
volume for browser-based players, and the media API carries no volume control, so there's no way to set
a specific web player's volume from here.
