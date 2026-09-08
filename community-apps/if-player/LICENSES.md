# Licenses

The app itself (`app.js`, `boot.js`, `server.js`, `style.css`, `chrome.html`, `app.json`,
`vendor-parchment.js`) is MIT, same as Bedrock Panel.

## Bundled third-party code

`index.html` and everything in `interpreter/` are built by `vendor-parchment.js` from the
**single-file build of Parchment**, the interactive-fiction web interpreter. The code is upstream's,
unmodified — the build only splits it into separate files and drops two interpreters (see below).

| Component | Upstream | License |
| --- | --- | --- |
| Parchment | [curiousdannii/parchment](https://github.com/curiousdannii/parchment) | MIT |
| AsyncGlk | [curiousdannii/asyncglk](https://github.com/curiousdannii/asyncglk) | MIT |
| Emglken | [curiousdannii/emglken](https://github.com/curiousdannii/emglken) | MIT |
| RemGlk-rs | [curiousdannii/remglk-rs](https://github.com/curiousdannii/remglk-rs) | MIT |
| Bocfel (Z-machine) | [garglk/garglk](https://github.com/garglk/garglk) | MIT |
| Glulxe (Glulx) | [erkyrath/glulxe](https://github.com/erkyrath/glulxe) | MIT |
| Git (Glulx) | [DavidKinder/Git](https://github.com/DavidKinder/Git) | MIT |
| Hugo | [hugoif/hugo-unix](https://github.com/hugoif/hugo-unix) | BSD-2-Clause |
| jQuery | [jquery/jquery](https://github.com/jquery/jquery) | MIT |
| Iosevka (font) | [be5invis/Iosevka](https://github.com/be5invis/Iosevka) | OFL |

Parchment's full component list is in its
[README](https://github.com/curiousdannii/parchment#readme).

Two interpreters in the upstream single-file build — **Scare** (Adrift) and **TADS** — are
**GPL-2.0**, unlike everything else above. `vendor-parchment.js` removes both, so what ships here is
entirely MIT/BSD/OFL. They are also ~2MB, and this app targets Inform/Z-machine and Glulx, so
nothing is lost for its purpose. If you re-add them, this table and the app's licensing change.

`wyoming.js` and `vad.js` are vendored copies of Bedrock Panel's own
`app/claudevoice-wyoming.js` and `app/claudevoice-vad.js` (MIT). Drop-in apps live in the
user-data folder and cannot require platform modules, so the app carries its own copies.

## Why there is a build step, and how to upgrade

Bedrock Panel serves drop-in app files under a strict CSP, and Parchment's single-file build is blocked
by it three ways over. `vendor-parchment.js` resolves each **without** editing Parchment's code:

1. ~4MB of the build is inline `<script>`, which `script-src 'self'` blocks. Each executable block is
   written out to `interpreter/parchment-N.js` and referenced with `<script src>`.
2. The interpreter cores are embedded as `text/plain` blocks and loaded with
   `import("data:text/javascript,…")` — also blocked. Parchment's loader looks for an embedded block
   first and otherwise resolves the name against `lib_path`, so each core is extracted to a real file
   in `interpreter/` (`.wasm` blocks are base64'd gzip and are decoded to real binaries) and
   `boot.js` points `lib_path` at that folder.
3. `frame-ancestors 'none'` forbids framing the page, so Parchment's own page *is* the app entry with
   our chrome injected, rather than being wrapped in an iframe.

Running WebAssembly additionally needs `'wasm-unsafe-eval'` in the host's CSP — that keyword permits
`WebAssembly.instantiate` only, not `eval()` — which Bedrock Panel's local app CSP now includes.

To upgrade, download `parchment-single-file-*.zip` from
[Parchment's releases](https://github.com/curiousdannii/parchment/releases), unzip it, and run:

```bash
node vendor-parchment.js /path/to/parchment.html
```

It fails loudly rather than writing a broken page if the structures it depends on are no longer
there, so a breaking upstream change is caught rather than silently mis-applied.

Current bundled version: **Parchment 2026.8.1**.

## Story files

None are bundled. Works of interactive fiction are copyrighted by their authors — Infocom titles
such as Zork are not free to redistribute. See `stories/README.txt`.
