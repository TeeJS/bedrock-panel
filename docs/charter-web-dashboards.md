# Charter — Web dashboards on the panel

> Status: **APPROVED (2026-06-17).** Decisions: first-class pages; tap-click + knob-scroll in v1.

## 1. The one thing this must do
Show a live web page (NanoClaw dashboard, Home Assistant, Grafana / server
monitoring, Flipboard, …) **full-screen on the DK-QUAKE panel**, switchable
alongside the existing tile grids via the knob selector.

## 2. What would be wrong if we shipped "working" without it
- A dashboard you can open but **can't get back out of** (stranded screen).
- An **interactive** dashboard (Home Assistant) that **ignores touch** — useless
  for control, only good for staring at.

**Non-negotiables:** you can switch *to* a dashboard *and back* via the knob
selector, and interactive dashboards accept at least **taps and scrolling**.

## 3. Off-limits workarounds
- Opening the dashboard in the **PC browser** instead of on the device (that's
  the existing `url` tile — not this feature).
- **Hardcoding** dashboard URLs in code — they must be user-set in the editor.
- Running external pages in our **privileged** (nodeIntegration) context — guest
  pages must be sandboxed.

## 4. Deployment target & backup
`D:\Github\bedrock-panel` (Electron 23, runs on the device). Backup = git
(github.com/TeeJS/bedrock-panel).

## 5. How we verify it's done
1. In the editor, create a **dashboard page** (name + URL); it shows up in the
   knob grid-selector by name.
2. Double-click knob → pick it → the page renders **full-screen, correct
   landscape orientation** on the device.
3. **Knob rotate scrolls** the page; a **tap clicks** at that point (verified on
   an interactive page, e.g. Home Assistant).
4. **Knob double-click** reopens the selector to switch back to a grid.
5. URLs are user-configured (not hardcoded); the guest page runs sandboxed (no
   Node access), with login/session **persisted** across restarts.

---

## Design (how)
- **Page model:** a "page" is either a **tile grid** (today) or a **web
  dashboard** (`{ kind: 'web', name, url }`). The knob selector already switches
  pages by name, so dashboards are just another entry. (This generalizes the
  left list from "grids" to "pages" — consistent with the earlier
  drop-"Grid"-from-the-name change.)
- **Embedding:** an Electron **`<webview>`** placed inside the rotated `#stage`,
  so it inherits the 90° rotation and renders landscape automatically. Sandboxed
  (no nodeIntegration in the guest), with a **persistent session partition** so
  logins stick.
- **Interaction bridge:** when a dashboard page is active —
  - **knob rotate → scroll** the page,
  - **tap → click** (HID touch mapped into the webview via `sendInputEvent`,
    undoing the Y-flip; the webview already inherits the stage rotation),
  - **knob double-click → grid selector** (unchanged).
- **Editor:** the left list becomes **Pages**; adding a page chooses Grid or
  Dashboard; a dashboard page has a Name + URL field. Save model unchanged.

## Two decisions to confirm
- **A — page vs. popup:** dashboards as first-class **switchable pages**
  (recommended) vs. a tile that pops a dashboard overlay.
- **B — v1 interaction scope:** include **tap-click + knob-scroll in v1**
  (recommended — it's the Q2 non-negotiable for Home Assistant) vs. ship
  display-only first and add interaction next.

## Out of scope (v1)
Multi-touch gestures, pinch-zoom, on-screen keyboard for the webview, per-tile
dashboard pop-overs. Revisit after v1.
