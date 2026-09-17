---
name: bedrock-panel-release
description: >-
  Cut a release of Bedrock Panel (repo TeeJS/bedrock-panel, formerly open-quake) across
  Windows, macOS, and Linux. Use whenever the task is to release, ship, publish, or cut a
  version (e.g. "release 0.9.7", "prepare a release", "build the signed installers",
  "publish the draft release"), to bump the version for a release, to build/sign/notarize
  installers, or to coordinate a multi-platform build across the on-hardware Mac/Linux
  sessions. Encodes the validated flow and points at the authoritative repo docs so the
  process is never re-derived or guessed from memory.
---

# Bedrock Panel release process

The single source of truth for cutting a release. **Trust the repo docs over any memory** —
`docs/building.md` (Packaging sections), `docs/mac-signing.md` (macOS notarization handoff),
`docs/linux.md`, and the `windows-app-signing` skill. Read the relevant one before concluding
anything is missing or broken.

## Repo facts (do not re-learn these)

- Repo: **`TeeJS/bedrock-panel`** (renamed from `open-quake`). `gh` has **NO default repo** in this
  checkout — **always pass `-R TeeJS/bedrock-panel`** or `gh` fails with "No default remote repository".
- **`main` is the release branch.** Concurrent agents commit to `main` mid-release — expect HEAD to
  move under you. **Stage only your own explicit paths, never `git add -A`.**
- The shared checkout `D:\Github\open-quake\repo` is used by multiple sessions and often carries other
  sessions' uncommitted files. To commit to `main` without disturbing it, either stage only your file
  on the current branch, or use a throwaway `git worktree add --detach <tmp> origin/main`.
- Find the **true last-released version with `gh release list -R TeeJS/bedrock-panel`**, NOT local
  `git tag` (local tags can be unfetched). Scope release notes to `<last-released>..HEAD`.

## 1. Preflight

- `main` synced; `npm test` green (node:test; DPAPI tests skip off Windows).
- Any release-gating TODOs fixed or explicitly waived by T.J.

## 2. Bump the version

`npm version X.Y.Z --no-git-tag-version` (updates `package.json` + `package-lock.json`; no git tag —
the tag comes with the GitHub release, not here). T.J.'s historical practice was package.json-only, but
keeping the lockfile in sync is fine and avoids a dirty tree on the next `npm install`. Commit
(`vX.Y.Z` or `Bump version to X.Y.Z`) and push to `main`. **Never bump the version outside a delegated
release.**

## 3. Release notes — HARD GATE (T.J. reviews BEFORE publishing)

House format: title `vX.Y.Z — <headline>`, one intro sentence, `##` prose sections with **bold UI
names**, community PRs credited `@author` + PR link, drop-in-app changes noted as shipping "via app
updates". Draft, present to T.J., wait for approval. **Building may run in parallel — only PUBLISHING
is gated.** A draft GitHub release with placeholder notes is fine to create early; do not publish it
until T.J. approves the notes.

## 4. Build + sign + verify — per platform

Each platform builds from the release commit. Windows is built on tjs-dell (here); **macOS and Linux
are built and smoke-tested on their real-hardware sessions** (`BP-mac`, `BP-linux` — coordinate via an
agent room; relay by `SendMessage` if a node can't join). A `package-lock.json`-only diff does not
change any binary, so nodes one commit behind on that alone need no rebuild.

### Windows (here) — `npm run dist`
Auto-signs via the `sign.js` hook + **Azure Trusted Signing** (see the `windows-app-signing` skill).
- Precheck the signing session: `& "$env:LOCALAPPDATA\pwsh7\pwsh.exe" -NoProfile -Command "if (Get-AzContext){'LIVE'}else{'NONE'}"`. If NONE, the user runs `Connect-AzAccount -UseDeviceAuthentication -Subscription cead6a29-d285-4141-a4e3-b249afbe1944` (their credentials, never yours).
- `npm run dist` = `build-dpapi` + `build-smtc` (recompiles the `native/*.cs` helpers incl. `sysvolume.exe`) + `electron-builder --win`, signing setup + portable during the build. ~few min; run in the background.
- Output (stable, **unversioned** names — do NOT re-add `${version}`, T.J.'s git-updater depends on them): `dist/bedrock-panel-setup.exe`, `dist/bedrock-panel-portable.exe` (+ blockmap, `latest.yml`).
- **Verify with `Get-AuthenticodeSignature` in PowerShell** (NOT signtool via Bash — path quoting there silently reports NOT-SIGNED). Expect Status Valid, `Thomas Schmitz`, timestamped, on BOTH exes.
- Gotchas: build stalls at "output file is locked" if a `dist/` exe is open (ask T.J. to close it); SignTool "file in use" is Defender scanning the fresh exe — `sign.js` retries and the final signature verifies.

### macOS (`BP-mac`, real hardware) — `npm run dist:mac`
`build-mac.js` signs with the Developer ID and **notarizes + staples** when credentials are present.
**v0.9.5 and v0.9.6 both shipped NOTARIZED — that is the bar; do not downgrade to un-notarized.** The
un-notarized `xattr` quarantine-strip story is from the *beta* notes only.
- **If notarization fails or credentials look missing, FOLLOW `docs/mac-signing.md` FIRST.** That doc's
  handoff says this Mac has already produced signed+notarized+stapled releases and the credentials are
  stored where you don't see them. Run its discovery commands before concluding anything is missing —
  especially `xcrun notarytool history --keychain-profile <profile>` (proves the profile authenticates).
  "No Keychain password item found for profile" usually means a locked/other login keychain or a
  trailing newline in `.signing/notary-profile`, NOT a missing secret. Do not ask T.J. for an Apple ID.
- **Keychain-context gotcha (seen on 0.9.7):** an AI agent's non-interactive shell often can't reach
  the user's UNLOCKED login keychain, so `codesign` succeeds (its key's ACL allows it) but
  `notarytool`'s generic-password lookup fails with the "No Keychain password item" error — even though
  the credential is fine. Fix: **T.J. runs `npm run dist:mac` (or first `xcrun notarytool history
  --keychain-profile bedrock-notary`) in his own interactive terminal**, the same shell that built
  0.9.5/0.9.6. Only if it fails THERE too is the profile actually missing (re-store per
  `docs/mac-signing.md`). No Apple ID or password is handed to the agent.
- **To make the agent build+notarize UNATTENDED (no T.J. terminal):** switch notarization to an App
  Store Connect **API key** (`.p8`, file-based, keychain-free) — full procedure in `docs/mac-signing.md`
  ("Unattended notarization from an agent shell"). The `.p8` is already in `.signing/`; it still needs
  the Issuer ID, the `APPLE_API_KEY` trio in the agent env, `.signing/notary-profile` retired, and one
  unattended build to confirm.
- Output: `dist/bedrock-panel-arm64.dmg` (+ `.zip`). Verify: `spctl -a -t exec -vv` says *accepted,
  source=Notarized Developer ID*; `xcrun stapler validate dist/bedrock-panel-arm64.dmg` passes.

### Linux (`BP-linux`, real hardware) — `npm run dist:linux`
→ `dist/bedrock-panel_amd64.deb` + `dist/bedrock-panel-x86_64.AppImage` + `latest-linux.yml`.
**UNSIGNED and un-notarized — Linux has no gatekeeper (documented, `docs/building.md:400`).** Both the
`.deb` and the AppImage ship.
- **Test with the `.deb`, not the AppImage**, on any box without FUSE 2: the AppImage needs `libfuse2`
  and exits with `dlopen(): error loading libfuse.so.2` on stock Ubuntu 24.04+/26.04 until
  `libfuse2t64` is installed (`docs/building.md:403`, `docs/linux.md:21`). This is a documented,
  long-standing property of the AppImage, **not a release bug** — do not chase it or add it to the
  notes as new. `--appimage-extract-and-run` is NOT how the artifact ships (its own /tmp teardown
  produces failures that look like app bugs) — don't diagnose from it.
- **Installing the `.deb` needs sudo, so it is T.J.'s command, not the agent's** — hand it over:
  `sudo apt install -y <path>/dist/bedrock-panel_amd64.deb` (upgrades in place over a prior version,
  sets up the `/usr/bin/bedrock-panel` alternative).
- **Smoke-testing the installed app:** launch `/usr/bin/bedrock-panel --remote-debugging-port=9333` and
  attach CDP to the `app/config.html` target. On a Wayland session the app re-execs onto X11
  (`docs/building.md:309`) but the debug port **survives** the re-exec (the child carries the flag
  through argv), so CDP still attaches — don't doubt the port. Verify: editor header reads the new
  version, both device pickers populate, and the mute warning fires on the tone and mic-playback paths.

## 5. Assets + publish (T.J.-gated)

Create the release as a **draft** early (`gh release create vX.Y.Z -R TeeJS/bedrock-panel --draft --target main --title "vX.Y.Z — <headline>" --notes-file notes.md`), each build box uploads its own artifacts to it, then publish once everything is present and notes are approved.
- **`--target main`** (a branch name) — a short SHA fails HTTP 422 "target_commitish is invalid".
- **Asset set (from 0.9.7 on, per T.J.: SHIP the update manifests + blockmaps, not installers-only — prior releases 0.9.5/0.9.6 were installers-only, 0.9.7 changed that).** The exact set **differs per platform**, so **CHECK `dist/` on each box** (`ls dist/`, `find dist -name '*.blockmap'`) rather than enumerating from memory — that assumption bit all three of us on 0.9.7. Typical:
  - **Windows:** `bedrock-panel-setup.exe`, `bedrock-panel-portable.exe`, `latest.yml`, `bedrock-panel-setup.exe.blockmap` (portable has NO blockmap).
  - **macOS:** `bedrock-panel-arm64.dmg`, `bedrock-panel-arm64.zip`, `latest-mac.yml`, `bedrock-panel-arm64.dmg.blockmap`, `bedrock-panel-arm64.zip.blockmap`.
  - **Linux:** `bedrock-panel_amd64.deb`, `bedrock-panel-x86_64.AppImage`, `latest-linux.yml` (NO sidecar blockmaps — the AppImage's is embedded in the artifact, the `.deb` has none).
- **VERIFY each `latest-*.yml` against its real artifacts (sha512 AND size) before upload** — load-bearing now that the manifests ship. **macOS stale-hash gotcha:** `latest-mac.yml`'s DMG entry is written by electron-builder BEFORE `build-mac.js` staples the DMG, so its dmg sha512+size are stale by the notarization ticket (~2290 B); **regenerate the dmg entry AND `bedrock-panel-arm64.dmg.blockmap` from the STAPLED dmg** — exact recipe (electron-builder's own `buildBlockMap`, `gzip` format, cross-checked against `openssl`) in `docs/mac-signing.md` ("Regenerating latest-mac.yml + dmg.blockmap after stapling"). The zip entry (electron-updater's `path:`) is already correct. Windows/Linux ymls finalize after their artifacts so they match as-is — verify anyway.
- Upload onto the draft: `gh release upload vX.Y.Z <files> -R TeeJS/bedrock-panel --clobber`; large uploads exceed the 2-min foreground timeout → background; confirm with `gh release view vX.Y.Z -R TeeJS/bedrock-panel --json assets`.
- **Publish (finalize):** with all assets present + notes approved, flip the draft live — `gh release edit vX.Y.Z -R TeeJS/bedrock-panel --draft=false --notes-file notes.md`. This is the T.J.-gated step; he may delegate it explicitly (he did on 0.9.7). `gh` is sometimes classifier-blocked — if so, hand T.J. the exact one-liner.

## 6. After

Update project memories from "unreleased" to shipped (`reference_openquake_release_process`,
`project_audio_settings`, etc.).

## Gotchas worth re-reading (all documented above / in the repo docs)

- **Verify against reality, don't assert from memory.** Query `gh release view vX.Y.Z --json assets`
  and read the actual files/`dist/` before claiming what a prior release shipped, what a yml contains,
  or what the asset set is. On 0.9.7 all three build agents each asserted something false from a
  plausible memory (the prior-release asset set, the mac yml delta) and two nearly shipped a wrong
  change — one `gh` query settled each.
- `gh` needs `-R`; `--target main` not a SHA; last-released from `gh release list` not local tags.
- `nsis.guid` is pinned (`6b73d4a7-2e13-5aef-9474-9432dfa413dd`) — never change it or upgrades become a
  second install.
- Never add `build.{win,mac,linux}.files` — a platform list REPLACES the global exclusions (there is
  exactly one `files` key). This is now SECURITY-load-bearing: the global list carries `!.signing/**`,
  and the macOS notary API key (`.p8`) lives in `.signing/`; a `mac.files` override would silently drop
  that exclusion and ship the **private key inside a notarized, publicly downloadable DMG**. Keep all
  exclusions in the single global `build.files`.
- Stage only your own paths; never `git add -A` on the shared checkout.
