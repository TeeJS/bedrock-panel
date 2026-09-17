# MD editor renderer harness (manual)

A low-side-effect way to exercise the **real** shared editor renderer (`app/config.js` via
`app/config.html`) in one offscreen Electron window, over a stubbed `window.bedrockConfig`. It does
**not** require `app/main.js`, so it never starts the panel, servers, devices, MQTT or Home
Assistant, and it makes no network requests (the stub returns `about:blank` for preview URLs). It
does write to a temp directory: an isolated Electron profile (`userData`/`sessionData`) and the
screenshots/`result.json`, all under `<os-tmpdir>/md-editor-harness/` — the real app profile is
never read or written.

It verifies the generic option-validation the Macro Deck Surface work added and the separate-device
preview placeholder, on the actual renderer (which `node --test` can't, since there's no jsdom):

- number option: on-load invalid draft shows an inline error + Reset (no auto-correction), help/error
  `aria-describedby`, the model-level **Save gate** that blocks across pages and reveals/focuses the
  offending field, the delegated Reset, and a clean valid save — for both page (`.aopt`) and
  settings (`.aset`) scopes;
- advanced-disclosure open-state persistence across a re-render;
- cross-page reveal (invalid draft on a page you're not viewing still blocks Save);
- the `preview.separateDevice` placeholder (no iframe, no host connection, no over-claim copy).

## Run

From the repo root:

```
npx electron test/manual/md-editor-harness/main-standalone.js
```

Each step prints a `[H] {…}` JSON line. Screenshots and `result.json` are written to
`<os-tmpdir>/md-editor-harness/` (never the repo); the final `[H] result + shots in …` line prints
the exact path. Exit code `0` = all steps ran.

This is a **manual** harness (needs a display for `capturePage`), not part of `npm test`.
