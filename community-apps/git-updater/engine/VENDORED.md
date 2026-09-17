# Vendored git-updater engine

Copied VERBATIM from https://github.com/TeeJS/git-updater `src/` at commit
**d432bd878aec8ba4c578eb1f251205c4009e6465** (v0.2.1, 2026-09-11).

Do not edit these files here. Fixes land in the standalone repo first, then refresh:

```
cp    D:/Github/git-updater/src/*.js       community-apps/git-updater/engine/
cp -r D:/Github/git-updater/src/platform   community-apps/git-updater/engine/platform
rm    community-apps/git-updater/engine/selfupdate.js
```

…and update the commit hash above. The `platform/` directory is NOT optional: since the
macOS/Linux port every OS-specific call (installed apps, running processes, archive
handling) lives behind it, and a flat `cp src/*.js` leaves the engine requiring a folder
that isn't there. `selfupdate.js` is the standalone updating its own binary — nothing else
in the engine requires it, and the drop-in must never do it, so it is deliberately absent.

The engine's runtime deps (`adm-zip` 0.6.1, `7z-wasm` 1.2.0) are shipped in this app's
`node_modules/` (a drop-in installed under the host's `apps/` folder is outside every
node_modules tree, so bare requires must resolve inside the app folder). Keep them at the
versions the standalone's `package.json` pins.

Shared data — read/written by BOTH the standalone app and this drop-in, safe via the
engine's cross-process lock + atomic writes in `state.js`. `paths.js` picks the location
per OS: `%APPDATA%` / `%LOCALAPPDATA%` on Windows, `~/Library/Application Support` on
macOS, and the XDG base directories on Linux. Under `<config>/git-updater/`:

- `config.json` — tracked apps + portable root
- `state.json`  — install history / portable manifests
- `logs/`       — shared log

…and under `<data>/git-updater/`: `staging/` — download staging (never the temp dir).
