# Persona editor harness (manual)

Drives the **real** `app/config.html` + `app/config.js` Settings → AI Profiles → Personas editor in one
offscreen Electron window, over async stubs of the persona IPC (`preload-stub.js`, backed by the real
`app/face/persona.js`). It never starts `app/main.js`, so no panel, server, device or network is touched;
output goes to `<os-tmpdir>/persona-editor-harness/` (shots + `result.json`).

Checks: valid import, credential key refused, bad JSON, 70 KB paste, no-id, collision Cancel and
Replace, Export JSON → remove → re-import, Export file…, >64 KB and small file picks, add + edit +
Save, and no horizontal overflow at 1180 and 900 px.

```
npx electron test/manual/persona-editor-harness/main-standalone.js
```

Exit code `0` = every check passed. Needs a display for `capturePage`; not part of `npm test`.
