---
name: quake-touch-ui
description: Design, critique, implement, and verify UI for the Bedrock Panel 1920x480 touchscreen-and-knob panel. Use when creating or restyling any on-panel Electron page, control console, dashboard, picker, overlay, recording flow, theme, touch target, scrollbar, focus state, or screenshot-based UI revision. Complements docs/design-system.md.
---

# Design UI for the Quake panel

Treat the panel as a purpose-built appliance, not a desktop app or phone UI stretched into a 1920x480 viewport. It is viewed at arm's length through glare and fingerprints and operated by touch and a physical knob.

Read `AGENTS.md` and `docs/design-system.md` first. Verify documentation against current source.

## Work from evidence

1. Inspect the real HTML, CSS, renderer logic, theme parameters, and state transitions.
2. Inspect attached screenshots at original resolution. Distinguish browser captures from photos of the physical device.
3. Enumerate important states before changing the layout.
4. Rank content as primary, contextual, utility, status, or diagnostic.
5. For critique-only requests, explain the cause and provide a concrete brief without editing. For build requests, preserve behavior and validate the real page.

Review revisions in this order:

1. Composition: regions, proportions, focal point, and hierarchy.
2. Interaction: touch safety, knob focus, state transitions, and disclosure.
3. Surface: color, contrast, typography, icons, and separators.
4. Polish: animation, truncation, hit areas, boot states, and physical-device behavior.

Do not polish a structurally bad card grid. Once the composition works, freeze it and make focused corrections instead of repeatedly redesigning it.

## Size for the physical panel

Use these as starting values, then verify on the device:

| Element | Guidance |
|---|---|
| Minimum touch target | 48x48px; never smaller |
| Standard row or button | 64-80px high |
| Primary console control | 96-112px |
| Gap between adjacent targets | At least 12px |
| Primary icon | 38-44px |
| Short action label | 18-22px, weight 600-700 |
| Body or list text | 22-28px |
| Group label, status, metadata | 13-18px only when non-critical |

Short, predictable action labels do not need to be oversized. Nothing the user must read to act may be treated as tiny metadata.

Use the repository spacing scale: 8, 16, 24, 32, 48, and 64px. Avoid arbitrary spacing unless optical alignment requires it.

## Choose the right composition

Every page should answer within one second:

- Where am I?
- What is happening?
- What can I do?

For information-rich pages, prefer:

```text
Context | Primary content | Secondary content
```

For control-heavy pages, use one shared control deck plus a narrow utility rail. Group related actions with spacing and subtle separators inside the deck. Use a compact horizontal selector for modes or platforms.

Do not build:

- One card per action
- Cards nested inside cards
- Huge empty slabs around small icons
- A utility region that consumes primary-action space
- A permanently dominant destructive area larger than its peers
- A vertical column for two mode tabs

Calm negative space is useful when it improves recognition. Empty cards are not.

### Proven meeting-console pattern

- Use a 48-56px context strip with Zoom/Teams selection, readiness status, and Record/status.
- Use one control deck for Audio & Video and Call clusters.
- Use approximately 112px circular controls with 38-42px icons and labels below.
- Use a 300-360px utility rail for volume and app shortcuts.
- Keep one solid-red destructive control. Use icon color or a restrained ring for Accept and Decline until real state justifies stronger treatment.
- Use `Leave` for Zoom and `Hang up` for Teams.
- Fit Teams `Accept audio` and `Accept video` without shrinking the primary control size.

## Keep state spatially stable

Keep primary controls pixel-identical across idle, active, recording, loading, and error states.

- Float overlays above secondary content; never shrink or reflow the primary deck.
- Anchor temporary configuration over the utility region.
- After setup, collapse persistent activity into a compact header status pill.
- Keep diagnostic strings and filenames out of the persistent status line.
- Truncate long values on one line and reveal the full value in a picker or details view.
- Preserve established regions when an integration is unavailable; show an honest neutral or disabled state.

Never fabricate state:

- Do not show a volume percentage or meter until a real value is known.
- At boot, unknown volume is a centered approximately 38px muted speaker icon with no meter or wrapped placeholder text.
- Do not show muted, camera-off, incoming-call, or active styling until confirmed by application state.

Distinguish available, selected, active, pressed, focused, disabled, and unknown states. Selection, activity, and knob focus must not look identical.

## Use progressive disclosure

For pick-one settings such as microphone, speaker, voice, or theme, show the current value on one large row. Tapping it opens a dedicated picker overlay with uniform full-width rows. Do not embed a permanently scrollable device list inside a compact dialog.

For recording:

- Closed: show a compact Record control with a small red indicator.
- Setup: open an approximately 520-600px anchored panel over the utility region. Keep the underlying structure recognizable through a modest scrim.
- Show `Microphone`, a one-line ellipsized value, one dominant accent-colored `Start recording` action, and tertiary auto-start guidance.
- Active: collapse setup into a persistent `Recording`, tabular timer, and Stop pill. Keep filenames in details.
- Keep Stop directly accessible. Do not hide the only stop action.

Compact visible controls may use larger invisible hit zones. A 38px visible pill Stop may expand to roughly 54px tall. A 48px close button may use a roughly 60px surrounding zone. Ensure pseudo-element hit zones do not overlap adjacent targets.

## Handle lists and scrolling for fingers

- Use uniform-width, left-aligned rows for long pick-one lists. Chips are for filters, not primary selection sets.
- Consider recents or favorites for frequently chosen values.
- Prefer filtering when a keyboard is already natural. Do not add tiny alphabet jump rails to this short screen.
- For folder pickers, let row taps navigate and provide a persistent `Use this folder` action, breadcrumb, and Up control.
- Scroll only the region that needs it; never the entire page.
- Apply `overscroll-behavior: contain` to scroll regions and `touch-action: manipulation` globally.

When a visible scrollbar is needed, use the established finger-draggable custom control: an approximately 44px track and rounded thumb implemented as real DOM with pointer events, thumb drag, and tap-track-to-page behavior. Chromium scrollbar styling alone does not provide this touch behavior. See `syncProjThumb` and `wireProjScroll` in `app/claudevoiceview.js`.

## Keep focus and selection honest

Suppress the pointer-created Chromium focus ring without breaking keyboard or knob focus:

```css
button:focus:not(:focus-visible) { outline: none; }
```

Never blanket-remove focus outlines. Use a filled runtime-accent treatment for the selected item in a mutually exclusive group, with a contrast-safe foreground. Use a distinct focus ring for keyboard or knob navigation.

## Apply color, typography, and icons consistently

- Reserve the runtime accent for selection, focus, confirmed active state, and the single primary action.
- Reserve green for accept/success and red for decline, leave/hang up, errors, and live recording.
- Avoid painting every clickable surface with a bright semantic color.
- Compute a contrast-safe `--accent-fg`; do not assume every configured accent accepts dark text.
- Verify light and dark themes independently rather than inverting colors mechanically.
- Use one font family everywhere, including buttons and form controls: `"Segoe UI", system-ui, sans-serif`.
- Use one icon family with consistent optical weight and semantics.
- Make injected SVGs inherit color: `.ic svg { fill: currentColor; display: block; }`.
- Use a handset-down glyph for leaving or ending a call; do not substitute an application-exit icon.

## Preserve application boundaries

When implementing:

- Preserve renderer isolation and existing main/preload/renderer contracts.
- Preserve IDs, HTTP routes, IPC shapes, option delivery, and theme parameters unless a coordinated behavior change is required.
- Keep optional integrations and unavailable hardware graceful.
- Avoid adding frameworks or build steps to plain HTML/CSS/JavaScript pages.

## Verify the real page

Capture the real page at exactly 1920x480, one screenshot per state. Do not stack variants in a scrolling preview or approve only a detached mockup.

Cover at least:

| Area | Required states |
|---|---|
| Platform/content | Every variant and the maximum action count |
| Overlays | Closed, open, active, and stop/close controls |
| Data | Known values, unknown boot values, and long labels |
| Theme | Dark, light, and runtime accent contrast |
| Interaction | Pressed, focused, knob-focused, selected, and disabled |
| Runtime | Idle, active, loading, error, and unavailable integration |

For Electron captures, use the real page and drive its own state functions. A proven repository harness uses an offscreen shown window (`showInactive()` rather than a hidden non-composited window), waits two animation frames, then calls `capturePage()`. Use one Electron process per state if Chromium's network service becomes unreliable after repeated loads.

Diff state captures to confirm primary controls do not move or resize. Then test the physical panel for arm's-length readability, glare resistance, bezel reach, touch feedback, destructive-action safety, and knob navigation. Run `npm test` and exercise the relevant Electron flow after implementation.
