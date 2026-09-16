# Macro Deck Surface (`macro-deck-surface`)

Turn the panel into a **[Macro Deck](https://macro-deck.app) surface**. It connects
to a Macro Deck **host** on your network and mirrors that host's current button
page on the panel — icons, labels and colors — and sends your taps, long-presses
and releases back so the host runs the mapped actions. The panel behaves like any
other Macro Deck client (phone, tablet, web client), just on the 1920×480 screen.

You still need the Macro Deck desktop app running somewhere on the LAN; this app is
a **surface**, not the host.

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
| Long-press (ms) | `1000` | Hold time before a long-press action is sent. |

## Notes

- **First run needs a click on the host** — Macro Deck gates a new device behind an
  accept prompt. Until you accept, the panel shows "Accept … on Macro Deck".
- The **grid comes from the host** (its profile's rows × columns). Navigate
  folders/pages by tapping the host's own navigation buttons; the panel knob does
  not switch Macro Deck pages (the protocol has no client→host page command).
- **LAN trust only.** The Macro Deck client port is plaintext with no token; keep
  it on a trusted network.
- Requires Macro Deck's newer build (Kestrel host + web client, port `8191`). The
  legacy 2021 build is not targeted.
