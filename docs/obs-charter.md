# OBS Studio control — build charter & plan

## Context

Give the DK-QUAKE / bedrock panel **live, state-driven control of OBS Studio** — scenes, sources,
audio, outputs (stream/record/replay), Studio Mode, and a Panic recovery action. Two surfaces on one
shared backend:

- an **`obs` tile type** — compose OBS controls onto any grid, like Home Assistant entity tiles;
- a **served OBS switcher app** — a polished, dense, purpose-built production surface (the "better UI").

Baseline: OBS Studio 28+, obs-websocket **v5**, default `ws://127.0.0.1:4455`, auth enabled. Driven by
the coding handoff at `.codex/.../obs-panel-coding-handoff.md`.

## Charter — the five questions

1. **The one thing it must do:** every OBS control reflects OBS's **real** state, from events — never
   just the last command the client sent.
2. **Wrong if shipped "working" without it:** tiles that lie (stale/optimistic state). An on-air
   switcher you can't trust is worse than none.
3. **Off-limits workarounds:** no hard-coded scene/source/input names in transport (they are user
   config); no permanent optimistic tile flips (state comes from OBS events, with a brief pending
   state); no parallel page/state framework — reuse the Discord-stack pattern and the tile/grid
   system; never log the OBS password.
4. **Deploy target + backup:** Bedrock Panel on the DK-QUAKE / bedrock 1920×480 panel and software mode;
   backup = git (this repo).
5. **Done =** both surfaces render correct live state, survive reconnect with full rehydration, the
   safety gestures + Panic work, automated tests cover layout counts / action routing / state updates
   / reconnect / failure, and setup docs explain enabling OBS WebSocket + mapping resources.

## Architecture — the Discord stack is the exact template

One shared backend; two thin consumers. Every existing file below is a proven pattern to clone.

**Shared backend (main process, CommonJS):**
- `app/obsService.js` — `class ObsService extends EventEmitter`, modeled on `app/discordService.js`
  (start/stop/`configure`, `backoff` + `_scheduleReconnect`, `_setState`, snapshot getters, command
  methods). Internally wraps **`obs-websocket-js`** directly (`const { OBSWebSocket, EventSubscription }
  = require('obs-websocket-js')` — confirmed CommonJS-safe via its `require` export). The library owns
  transport/framing/handshake, so **no hand-rolled transport is needed** (unlike Discord's
  `discordRpcTransport`). The library has **no auto-reconnect** — obsService listens for
  `ConnectionClosed`/`ConnectionError` and re-`connect()`s on the backoff, exactly as `discordService`
  does today.
- `app/obsAppHost.js` — snapshot bridge modeled on `app/discordAppHost.js`: subscribes to obsService
  events, maintains a serializable `snapshot` (`{connection, studioMode, programScene, previewScene,
  scenes[], streaming, recording, replay, inputs[], sceneItems[], transition}`), emits `update`, and
  exposes `action(name, value)`.
- Password: **`settings.obs.password`** encrypted at rest by adding one block to
  `transformSettingsSecrets` in `app/secretStore.js` (mirror the `settings.owui.apiKey` block) + its
  header list. Nothing else needs changing — encrypt/decrypt/migration all route through that one walk.
- Connection settings (Auth tab, `app/config.js`): host / port / `secretInput` password + a **Test**
  button, mirroring the Open WebUI section (`sOwTest` → `probeOwui`). New `ipcMain.handle('probeObs')`
  (opens a connection + Identify, returns `{ok, obsVersion}`), `configApi.probeObs()` in
  `config-preload.js`, `obsSettings()`/`OBS_DEFAULTS`/`normalizeObsSettings` in main, and a
  reconfigure-on-save block like Discord's (re-dial when host/port/password change).

**Surface 1 — served switcher app** (needs **zero** panel changes):
- `apps/apps.json` entry: `served:true`, `options:[]`, a `settings` block (host/port/password live in
  Auth; app `settings` carry layout/behavior toggles).
- `app/obsview.html` + `app/obsview.js` (+ `.css`) — JS external (CSP blocks inline `<script>`); dense
  CSS-grid layout cloned from `app/discordview.css` (fixed-px columns, 56–112px touch controls).
- `app/sysserver.js`: `STATIC_FILES` entries, a `/obs` page route, and **live state over SSE** —
  `/api/obs/events` + `obsBroadcast` wired to `obsAppHost.on('update')`, `/api/obs/state` snapshot, and
  `POST /api/obs/action` → `obsAppHost.action()` — a direct mirror of the Discord routes (599–609).
- Reads `?_dark`/`_accent` for theme; state-driven coloring (Program red / Preview green), pending
  states, hold-to-confirm all handled in the app's own JS.

**Surface 2 — `obs` tile type** (needs new, broadly-useful panel infrastructure):
- Register `obs` in `TYPES` (`config.js`) **and** `panelSchema.js` TILE_TYPES/STEP_KINDS.
- Editor picker cloned from `haTileBodyHtml`/`wireHaTile` — pick an OBS resource+action, store on the
  tile (`t.value`/`t.obsAction`).
- Action dispatch: an `obs` branch in `runAction` (`main.js`) → obsService command.
- **The panel is static today** — HA tiles bake an icon once and never show live state, tiles have no
  per-tile color/subtitle, and there is no hold gesture. State-driven OBS tiles therefore require three
  additions to the panel, which **also upgrade every tile type** (HA included): (a) extend the tile
  view-model in `resolveTiles` (`main.js:1210`) + `makeTile` (`index.js:118`) with `state`/`color`/
  `subtitle`; (b) a live-state push channel to the panel window (re-`send('grid', …)` on change, or a
  new per-tile state IPC); (c) a hold timer in the panel's `onTouch`/click handlers (`index.js`).

## Phasing

- **Phase 0 — prove the transport (spike, throwaway).** A tiny script using `obs-websocket-js`:
  connect + Identify against **real OBS**, `GetSceneList`, subscribe to `CurrentProgramSceneChanged`,
  `SetCurrentProgramScene`, confirm via the event. Validate auth + round-trip latency + reconnect. No
  Bedrock Panel integration yet. *(Per "prove the binding constraint before building the pipeline.")*
- **Phase 1 — shared service + served switcher (MVP).** `obsService` + `obsAppHost` + secret + Auth-tab
  connection UI + the served app with Live Production / Sources / Audio for one panel size, live state
  over SSE, scene select (Studio-aware), mute/visibility toggles, stream/record/replay with
  hold-to-confirm, Panic. This delivers the polished, trustworthy switcher with **no panel changes**.
- **Phase 2 — `obs` tile type + panel state infrastructure.** The view-model/state-channel/hold work
  above, then the tile picker + starter template grids (12×4 / 8×2). Bonus: this makes HA tiles
  state-driven on the panel for the first time.
- **Phase 3 — later/optional.** Media transport, input gain/sliders, transition editing, filters,
  browser-source refresh, screenshots, second surfaces, import/export.

## Decisions locked (from research + your calls)

- **Both surfaces**, one shared `obsService`. ✔ (your call)
- **`obs-websocket-js`** as the client — CommonJS-safe, no hand-rolled protocol. ✔ (your call)
- **SSE push** for served-app live state (event-driven), mirroring the Discord app — not polling.
- Password in **secretStore** (`settings.obs.password`), connection settings on the **Auth tab**.
- **Served-app-first** (Phase 1) because it needs no panel changes; tile type (Phase 2) carries the
  panel-infrastructure cost. *(This reverses the initial "tile type first" ordering.)*
- Grid max is **12×6**, so 12×4 (48) and 8×2 (16) template grids both fit.
- Dense-vs-sparse tension resolved by the split: **tile type = sparse/custom, served app = dense/Stream-Deck.**

## Open product decisions (do not block Phase 0/1 transport work)

1. Default workflow: **Studio Mode** (scene → Preview, then Cut/Auto) or **direct takes**? (Affects
   scene-tile semantics; the interaction spec supports both.)
2. Which panel size ships first in Phase 1 — 12×4 or 8×2? (Both eventually.)
3. Icon set / branding for OBS controls.

## Verification

- **Phase 0:** the spike prints the scene list, switches a scene, and logs the confirming event against
  your live OBS — proving auth + command + event round-trip and measuring latency.
- **Unit tests** (node:test, like the Discord suite): exact slot counts (48 for 12×4, 16 for 8×2);
  scene action picks Preview in Studio Mode and Program otherwise; explicit Start/Stop chosen from
  confirmed output state; hold controls don't fire on a short press; Panic builds the expected
  safe-scene + mute batch; scene-item bindings stay scoped to their scene; missing bindings/resources
  render unavailable.
- **Integration (mocked obs-websocket client):** connect → hydrate → correct Program/Preview/mute/
  visibility/stream/record/replay; disconnect → unavailable → reconnect → full rehydration without
  losing the page; external OBS changes update the panel; partial Panic failure is visible.
- **Manual:** ≥44px touch targets; Program/Preview/muted/recording/streaming legible at a glance;
  accidental taps can't stop a stream/recording (hold-gated).
