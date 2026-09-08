# Vendored git-updater engine

Copied VERBATIM from https://github.com/TeeJS/git-updater `src/*.js`
at commit **0dc74d34673506c6b928d2a1086a36cc7fbb91fa** (2026-08-29).

Do not edit these files here. Fixes land in the standalone repo first, then refresh:

```
cp D:/Github/git-updater/src/*.js community-apps/git-updater/engine/
```

…and update the commit hash above. The engine's runtime deps (`adm-zip`, `7z-wasm`) are
shipped in this app's `node_modules/` (a drop-in installed under `%APPDATA%\bedrock-panel\apps\`
is outside every node_modules tree, so bare requires must resolve inside the app folder).

Shared data (read/written by BOTH the standalone app and this drop-in, safe via the
engine's cross-process lock + atomic writes in `state.js`):
- `%APPDATA%\git-updater\config.json` — tracked apps + portable root
- `%APPDATA%\git-updater\state.json`  — install history / portable manifests
- `%APPDATA%\git-updater\logs\`       — shared log
- `%LOCALAPPDATA%\git-updater\staging\` — download staging (never %TEMP%)
