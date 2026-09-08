# if-player — real filesystem saves + auto-save (project charter)

Two Claude sessions collaborating. This file is the shared record.

## Goals (T.J., 2026-08-22)
1. **Save files to the PC's filesystem** — in-game SAVE/RESTORE writes/reads real, portable
   save files on disk (not browser/Dialog storage).
2. **Auto-save** — periodic timer snapshot written to disk, overwriting a fixed autosave slot,
   with a "Resume where you left off?" prompt on reopening a story.

## The one thing this must do
In-game SAVE and the autosave both land as **real files on disk** that survive OQ restarts and are
usable outside OQ.

## What would be wrong if we shipped "working" software without it
Saves that only live in per-origin browser storage — silently lost on a port/origin change or
reinstall (the failure that started this). Not acceptable.

## Explicitly off-limits
- Weakening Bedrock Panel's drop-in CSP.
- Faking "filesystem save" with localStorage-only storage.
- Bumping the app/release version without T.J.'s say-so (his process).

## Deployment target / backup
Bedrock Panel `community-apps/if-player`. Fork refactor in `D:\Github\parchment` (git-tracked =
backup). Shared Bedrock Panel working tree `D:\Github\open-quake\repo`, branch
`if-player-autosave-to-file`.

## Architecture (one refactor point → both goals)
asyncglk (submodule of the parchment fork) routes ALL file I/O — manual saves AND autosave —
through a **Dialog storage-provider**. Replace that provider with one that moves save bytes over
HTTP to Bedrock Panel's `/app-api/` byte store. One provider delivers both goals.

## Ownership (near-total independence)
- **This session (fork + integration):** asyncglk storage provider → `/app-api/`; enable it +
  autosave in the parchment build; build the fork; `vendor-parchment.js`; rebuild `index.html`
  + `if-player.zip` + `community-apps/index.json`.
- **Peer session (Bedrock Panel app):** `server.js` byte-store endpoints; `app.js` UI (autosave
  toggle/interval, Resume prompt); `app.json` options.
- Shared tree rules: stage only our own files by name, no `git add -A`, ping before commit.

## Locked interface — `/app-api/` byte store
Raw bytes IN (write body), base64-in-JSON OUT (read), all responses JSON (router only emits JSON).
- `POST /app-api/save-write?game=&slot=` — body = raw save bytes → `{ok:true}`. Overwrites.
- `GET  /app-api/save-read?game=&slot=`  → `{ok:true, b64}` | `{ok:false, error:'not found'}`.
- `GET  /app-api/save-list?game=`        → `{ok:true, slots:[{slot,size,mtime}]}`.
- `POST /app-api/save-delete?game=&slot=`→ `{ok:true}`.
Path-safety: guard BOTH `game` and `slot` (basename-only, no separators/traversal, reject empty).
On-disk layout `saves/<game>/<slot>.glksave` (peer owns). Same-origin relative URLs from
index.html (required by the router's origin gate). autosave uses a fixed slot (e.g. `__auto`);
manual saves use the player-chosen name as the slot. Save format = raw Quetzal/Glk bytes.

## Verify done
- In-game SAVE creates a real file under `saves/`; RESTORE lists + loads it; file usable outside OQ.
- Autosave writes on its interval; reopening offers Resume and restores mid-game state.
- Survives an OQ restart (stable-port fix, commit 3905392) and a drop-in update/reinstall.
- `npm test` green; on-panel smoke test on the real device.
