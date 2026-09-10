# oMLX Monitor UI specification

Design owner: Admiral Thrawn. Implementation: Lord Vader (structure and state),
BT-1 (styling and visual implementation, replacing R2D2), as coordinated with T.J.

Status: proposed implementation baseline, awaiting rendered and physical review.
Source reviewed: `community-apps/omlx-monitor/{index.html,style.css,app.js,server.js,README.md}`
at commit `36d9887`. This document is design guidance, not a claim that changes are implemented.

## Objective and priorities

T.J. requests emphasis on the most used/helpful information and less blank space.
At arm's length, the panel should answer: which model is loaded, what is happening,
how fast is it running, and how much model memory is in use?

Keep the existing Context | Models | Activity structure. Use available height for
larger useful information, rather than filling space with decoration or duplicate IDs.
Keep session statistics visible; only diagnostics need progressive disclosure.

## Geometry at 1920 x 480

- Outer padding 16px; column and row gaps 16px.
- Header 56px. Content starts at y=88 and ends at y=464: **376px usable height**.
- Columns remain 360px | 936px | 560px. Their x origins are 16, 392, and 1344.
- Use 8/16/24/32px internal spacing. Section headings consume 32px including spacing.
- No page scrolling. Models and request lists scroll within their allocated regions.
- Keep region positions unchanged during loading, activity, failure, and reconnect.

Left column: a 176px memory region, 16px gap, then a 184px throughput region.
Middle: 32px section heading and 344px model list.
Right: 32px section heading, 160px current activity, 16px gap, then 168px session totals.
These are layout budgets; children must fit including padding and line height.

## Header

Retain oMLX branding and up to three server tabs. Show the selected server identity
even with only one configured server. Long hostnames truncate within bounded widths;
their full text is available in a touch-accessible details view.

Right side: explicit connection label with status dot, successful-update age, and a
48px minimum Details control. Do not use version and uptime as the connection label.
Details exposes server identity, version, uptime and available device information;
never credentials. It also exposes the full model identifier when opened from a model.
Use a dismissible in-panel view with focus restoration; essential data must not require hover.

Keep memory pressure distinct from connectivity: a reachable server under pressure
is Connected, with a memory warning in the memory region.

## Context: memory and throughput

Memory: label Model memory; 40px used value; 22px ceiling; 12px bar; readable pressure
label. Say No configured ceiling when appropriate; do not imply a percentage for an
unknown/unlimited ceiling. Known zero is valid; unavailable values use an em dash.

Throughput: label Server average. Show generation first at 40px with tok/s at 20px,
then prefill at 28px with tok/s. These values map to `s.tps.generation` and
`s.tps.prefill`, which originate from `avg_generation_tps` and `avg_prefill_tps`.
Do not relabel them as live throughput, last request, or a verified session average.
Live per-request speeds belong in Activity.

## Models

Heading: Models, followed by loaded/discovered count and loading count when nonzero.
Loaded/loading models precede Available. Keep stable order between polls; do not
re-sort by activity while a user is interacting.

- Standard loaded and available rows: 112px minimum, 16px padding, 8px gap.
- Name at 28px, one line; operational metadata at 20px with 24px line height.
- Name/state and metadata occupy two content lines; controls remain in a fixed end column.
- Action target: at least 128 x 56px. Reserve adequate width for confirmation/pending text.
- With one loaded and one available model, both rows and the Available heading must fit.
- Larger catalogs scroll; give a subtle visible scroll affordance. Do not stretch two
  rows to fill the entire list or invent content to eliminate every empty pixel.

Display the basename of the model ID safely. Do not invent a parsed friendly name
that might omit meaningful architecture/quantization differences. A future explicit
display-name mapping may improve this; identifiers sent to the API remain unchanged.
Full ID is available by tapping an accessible model-details control, not just a title tooltip.
Do not print the full ID as a permanent second line beneath an almost identical basename.

Use metadata for model size, Default/Pinned flags, and unload countdown when applicable.
Prioritize impending unload over long idle-duration text. If space is tight, move idle
duration into details. Never allow metadata to collide with the action target.

States derived from available data:

- Loading: `m.loading`, with estimated time remaining if present, otherwise elapsed time.
- Generating: nonempty `m.generating`; Prefilling: `m.prefilling > 0` when no generation.
- Busy: positive active count without a more specific phase; Waiting: positive waiting
  count when there is no active phase. Mixed activity is summarized by counts.
- Idle: only when admin activity is available and the model has no active/waiting work.
- Loaded: status-only mode; do not interpret fallback per-model zeros as verified idle.
- Unloading: local command pending/accepted, until a fresh snapshot resolves the result.

## Activity and session information

Rename In flight to Activity. Current-activity region remains 160px high in every state.
For active work, show the model, phase, live tok/s and generated tokens; elapsed time and
queue position are secondary. Request rows are at least 72px and scroll independently.
Keep aggregate active/waiting counts in the section heading even if per-request detail
is unavailable. With 14px vertical container padding, one complete row and part of the
next are visible; use a subtle visible scrollbar to reach the remaining requests. The
original two-row budget omitted container padding and is superseded by this decision.

For verified idle admin activity, use a prominent Idle label and No requests in progress.
Avoid an empty loading ring. If models are loading, describe loading; if none are loaded,
say No model loaded and point to Available models. If available models exist, omit the
redundant full-height empty row in Models so the available actions use that space.
Do not promise readiness merely
because the server responds. There is no completed-request history in the current API;
omit any last-request summary from this pass.

For `admin === false`, show Activity details unavailable with a concise explanation;
retain aggregate status counts and loaded names. Do not claim nothing is happening from
empty placeholder request arrays. Separate permission limitations from connection failure.

Lower region: Session totals, always visible when status data is available. A 2 x 2 grid
shows Requests, Cache efficiency, Prompt tokens, Generated tokens. Values 30px with
33px line height, labels 16px with 20px line height. Use 8px vertical card padding,
8px grid top margin and 8px row gap so children fit the 168px card. Use Cache efficiency
rather than the unverified interpretation Prompt cache
hits. Reuse established numeric scaling for this pass; confirm fractional-versus-percent
semantics before changing the conversion. Do not add charts without historical data.

## Controls and update behavior

Preserve the documented confirming second tap for both Load and Unload (4-second window).
Default Load is filled accent; Unload is a quiet outline. Armed labels explicitly state
Confirm load / Confirm unload, with sufficient width. Unload confirmation may use warning
or destructive treatment. While the command is pending, prevent duplicate commands even
if a poll rebuilds the row. Show Loading / Unloading feedback. Keep errors near the relevant
model/action until dismissed or retried, not solely in a health label overwritten by polling.
Contain long errors, provide the full error in Details, and make dismissal keyboard
accessible with at least a 48px touch target.
No controls when admin access or the allowControl setting prohibits them.

Polling must preserve focused control, model/request scroll positions, and pending/error
state. Key state by server and model ID. A response from an old server selection must not
replace the newly selected server or report success/failure on the wrong row.

Preserve the existing knob contract: rotate switches servers with multiple servers,
otherwise scrolls Models; press refreshes. Do not silently introduce knob activation of
load/unload. Keyboard controls and touch-accessible details need a visible focus ring,
logical order, Escape/Close behavior, and no focus loss on the two-second update.
Contain keyboard focus within the open modal, preserve opener restoration, and prevent
knob-driven server changes behind it. Gate per-model request counts in Details on admin
activity availability, just as on the main view.

## Connectivity and unavailable data

Connecting: no successful snapshot yet. Starting: backend explicitly reports startup.
Connected: successful current status. Offline/error: failed status, with a concise cause.
Keep last successful data, if retained, explicitly marked Last known; disable model actions.
Initial failure uses placeholders and explanation within the established regions.
Mark retained throughput and totals as Last known too; hide historical Activity counts
or explicitly label them Last known, rather than presenting them as current.

Proposed freshness threshold: max(15 seconds, 3 x configured polling interval), measured
since the last successful snapshot for that server. Show Stale if this expires without a
new result, including a stalled request. A known failed result changes the error state
immediately. Update age must advance independently of polling and must not reset on failures.
Threshold is a UI policy to verify against observed poll latency, not an API guarantee.

The current server normalizes missing numeric fields to zero; renderer-only changes cannot
distinguish these from actual zeros. Implementation should record this limitation and, if
absence must be represented, preserve availability through the server mapping with tests.
Do not pretend a cosmetic formatter fixes the underlying distinction.

## Visual review and acceptance

Use the existing theme/accent system and a consistent icon family if icons are needed.
Approved light text tokens: success #076b4f, warning #8a5a00, error #c02026, faint #596967.
These pass 4.5:1 against the four existing light surfaces. Generation is 40px with 44px
line height; prefill is 28px with 32px line height; throughput units are 20px. Activity
state titles are 32px. Both list regions expose a subtle scrollbar. Details Close is
at least 48px tall.
Essential body text should achieve 4.5:1 contrast; large text and control/focus boundaries
at least 3:1. Check custom accents as well as default blue, especially in light mode.
Avoid flashing, decorative spinners, tiny labels for important metrics, and layout jumps.

Provide 1920x480 renders in dark and light for:

1. One idle loaded model plus one available model, matching the supplied photo's data shape.
2. Generating + prefilling + queued work, including enough rows to exercise scrolling.
3. Loading, pending unload, confirmation timeout, action failure and retry.
4. No loaded models; no discovered models; many models; very long IDs and hostnames.
5. Status-only access, controls disabled, startup, initial failure, stale data, offline/recovery.
6. Up to three server tabs, including switching while a poll or action is pending.

Use synthetic data without secrets for previews. Mark synthetic previews as such.
Verify touch and keyboard interaction, focus persistence and scroll persistence in the
running app. Verify physical knob behavior and readability on hardware when available;
report untested hardware checks explicitly. Run npm test and focused tests for any new
testable state logic. Update the drop-in README for changed visible behavior. Design
approval requires inspecting actual renders; passing tests alone is not visual approval.

## Handoff

Lord Vader: implement structure and data/state behavior; identify any backend availability
changes needed before editing the data contract. BT-1: implement geometry, type hierarchy,
themes and control styling against the agreed markup. Coordinate shared selectors before
parallel edits. Admiral Thrawn: review both themes and state examples against this spec,
record findings, and revise design where physical evidence requires it.

Every participant should post START and END updates in the room for every step, including
checks and blockers. No design or implementation step is approved merely because another
participant has finished their task.
