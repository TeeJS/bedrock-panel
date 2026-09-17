# Round 2 — Macro Deck Surface working in-editor preview (Approach A)

Branch: `macro-deck-preview` (worktree, off `main`/bb48392). Solo (no agent room this round).

## Charter

1. **The one thing this must do:** the Bedrock editor's app-page **preview shows the live Macro Deck deck** (host icons/labels/colors) rendered with the **currently-edited options**, and lets you look at it at a usable size — **without disturbing the running panel**.

2. **What would be wrong if shipped "working" without it:** a preview that opens a second host connection using the *panel's* identity (collides with the live panel), or that auto-connects a device the user never opted into, or that shows a dead thumbnail you can't actually read/use.

3. **Off-limits (anti-goals):**
   - Reusing the panel's Client-Id for the preview (must be the distinct persisted `Bedrock Panel Preview <id>`).
   - Auto-connecting on page open — the user opts in with a reachable **Connect**.
   - Reparenting or re-`src`-ing the iframe to expand it (that reloads → drops the connection). Expand must restyle the **same** iframe in place.
   - Claiming the preview "mirrors the panel" if the host actually serves the preview device a different profile — copy stays honest.

4. **Deployment target + backup:** TeeJS/bedrock-panel `main` — changes span the drop-in (`community-apps/macro-deck-surface/*`, already round-1-ready app-side) and the host editor (`app/config.js`). Backup = this git branch.

5. **How we verify it's done:**
   - Renderer harness: editor **Connect** actually connects (via postMessage to the iframe), **Expand/Close** keeps the *same* `contentWindow` + connection count (no reload), Escape restores focus.
   - App tests: editor→app `oq-preview-connect` message triggers connect with the distinct identity; dispatch still disabled in preview.
   - **Live-host check (needs your OK):** connect one distinct read-only client to your running Macro Deck host and confirm it receives the **panel's active profile** (not a different/blank one). This is the load-bearing unknown for Approach A. If the host serves a *different* profile, we keep the copy honest ("a separate device; its page may differ") rather than promising a mirror.

## Plan (once signed off)
- **Editor (config.js):** replace the B placeholder for `preview.separateDevice` apps with the real iframe + `_preview=<persisted id>` (re-add the id machinery), an editor-level **Connect** button, and an **Expand-in-place** control (CSS-only resize of the same frame; Escape/Close + focus restore). Make the frame interactive when expanded.
- **App (app.js):** listen for the editor's `postMessage({type:'oq-preview-connect'})` to trigger `connect()` (so the reachable editor Connect works); keep everything from round 1 (distinct id, dispatch-disabled, previewIdle).
- **Verify** per §5, then version bump + notes + merge (your review, as always).
