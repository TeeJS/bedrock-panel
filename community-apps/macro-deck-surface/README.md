# Macro Deck Surface (`macro-deck-surface`)

Turn the panel into a **[Macro Deck](https://macro-deck.app) surface**. It connects
to a Macro Deck **host** on your network and mirrors that host's current button
page on the panel — icons, labels and colors — and sends your taps, long-presses
and releases back so the host runs the mapped actions. The panel behaves like any
other Macro Deck client (phone, tablet, web client), just on the 1920×480 screen.

You still need the Macro Deck desktop app running somewhere on the LAN; this app is
a **surface**, not the host.

> **Best grids: 2 rows.** Any 2-row Macro Deck profile from **2×2 up to 2×9** looks
> great on the Bedrock Panel's 1920×480 screen — **2×9** fills it edge-to-edge with
> square keys, while fewer columns (2×6, 2×5, 2×3, 2×2 …) give bigger keys with more
> breathing room. Two rows suits the panel's wide shape best; other counts still work,
> they just leave more empty space or use smaller keys. Set the profile's Rows/Columns
> in Macro Deck (bottom-left of its window).

## Setup

1. Install and run **Macro Deck** on a PC on your network.
2. Set **Macro Deck host** to that PC's address, e.g. `127.0.0.1:8191` (same
   machine) or `192.168.1.50:8191`.
3. First connect only: Macro Deck shows a prompt to accept a new device named
   **Bedrock Panel** — accept it. The panel then loads the deck.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| Macro Deck host | `127.0.0.1:8191` | Address of the Macro Deck host. Port defaults to `8191` if omitted. |
| Device name | `Bedrock Panel` | Name this surface shows as on the host's accept prompt. |
| Key shape | `Square keys (host layout)` | Square matches the Macro Deck host and is recommended. **Wide rectangular keys** fills the panel width instead; artwork is letterboxed, never stretched. |
| Long-press delay (ms) | `1000` | *(Advanced)* Hold time before a long-press action is sent. Whole number, `100`–`10000`. |
| Knob key navigation | Off | *(Advanced)* When on, the panel knob highlights the assigned keys (turn) and presses the highlighted key (click). Off by default, so the knob keeps its normal panel behavior. |

## Notes

- **First run needs a click on the host** — Macro Deck gates a new device behind an
  accept prompt. Until you accept, the panel shows "Accept … on Macro Deck".
- The **grid comes from the host** (its profile's rows × columns). Navigate
  folders/pages by tapping the host's own navigation buttons — the knob does not
  switch Macro Deck pages (the protocol has no client→host page command).
- **Knob key navigation** (opt-in) turns to move a highlight across the assigned
  keys (row-major, skipping empty cells, wrapping) and a single click presses the
  highlighted key; double-click and hold keep their normal panel behavior. The
  first click just reveals the highlight without pressing.
- **No live editor preview.** In the Bedrock editor this page shows an informational
  placeholder instead of a live preview, to avoid opening an additional connection to
  Macro Deck. Save and apply your settings, then view the page on your panel.
- **LAN trust only.** The Macro Deck client port is plaintext with no token; keep
  it on a trusted network.
- Requires Macro Deck's newer build (Kestrel host + web client, port `8191`). The
  legacy 2021 build is not targeted.
