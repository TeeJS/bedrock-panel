# Rocky Face — a built-in animated face for AI Voice (charter)

**Status 2026-10-20:** phases 1 and 2 shipped on this branch and verified live (`npm start`, Whisper/Piper
from Settings → TTS/STT). Backends exercised with a real turn each: **Claude Code** (Rocky, then Jarvis after a
persona switch), **Codex** (Norm), **Copilot** (Intern), **Open WebUI** (Rocky, Norm, Mimi). Each reply came
back in character, the emotion tag was stripped from speech and transcript, Piper spoke it in the persona's
voice (confirmed on the wire: joe / alan / ryan / bryce). Seven personas ship (Rocky, Norm, Mimi, Jarvis, CRT
Terminal, Startup Intern, Dust Sprite), each with a stock Piper voice and a safe fallback to the server's
default; import/export (paste, file, https URL) and a `<userData>/personas` drop-in folder; Side and Creature
layouts. **Later the same day Rocky and Norm were removed from the built-ins** (third-party characters are not
shipped in the app); they live as packs in `D:\Github\bedrock-personas` (`rocky.persona.json`,
`norm.persona.json`) and come back through import. Five built-ins remain: Mimi, Jarvis, CRT Terminal, Startup
Intern, Dust Sprite. Not working, outside this branch: the "AI Voice - GLM-4.7" page's LiteLLM endpoint lists only the
retired glm models (HTTP 500 on every turn); the Codex CLI's own config names `gpt-6.1-sol`, which the ChatGPT
account refuses, so the Codex page is pinned to `gpt-6-astra` in its Model setting. Demo pages added to the
config: "Codex Voice (face demo)" and "Copilot Voice (face demo)"; the Claude Code page is left on Side + Rocky.

Branch: `rocky-face` (off `main`). Agent room `AM-AT37LVS2HVXBHCDM6LHV6UKUDC` (Fable chair, Codex UI, Sonnet QA).
Source of the face and personality: `D:\Github\desk-robot` (`firmware/src/face.cpp`, `server/brain/personality.py`), read-only reference.
Replaces the previous round's charter (Macro Deck preview), which lives in git history.

## Charter

1. **The one thing this must do:** an animated face inside the existing **AI Voice** page that
   visibly **tracks the live session**: listening (VAD active), thinking (turn in flight), speaking
   with the mouth driven by the level of the audio actually playing in the page (a WebAudio analyser
   on the playback element, so pause, cancel and end are honest), idle blinking and dozing when
   ignored, and an emotion the model chose. Selectable **per page** as **Off / Side / Creature**, on the backends,
   Whisper and Piper the page already uses.

2. **What would be wrong if shipped "working" without it:**
   - A face that plays canned loops instead of reacting to the session (mouth moving while silent, blank while speaking).
   - A second AI connection, speech pipeline, VAD or process started to drive the face.
   - A page with face **Off** that renders or behaves differently than today.
   - Creature mode that strands a CLI approval, hides a real error, or leaves no way to mute or stop.
   - A face hard-wired to Rocky's geometry so a second personality means new code.

3. **Off-limits as a workaround:**
   - Running the desk-robot Python server, Docker, or any extra process. The face is a view of the existing `voicepanel-host`.
   - A second Whisper, Piper or VAD instance, or a new AI connection. Reuse the page's configured ones.
   - A separate webview or window for the face. It is a layout mode of the AI Voice page.
   - Executable personality plugins. Personalities are versioned JSON data only, and never carry provider credentials.
   - Parsing the emotion tag only in the page, or leaving it in the spoken or transcript text.
   - Hand-drawn SVG path data for the face. It is Canvas, parameterized by the persona.

4. **Deployment target and backup:** `TeeJS/open-quake` (Bedrock Panel) `main`, via branch `rocky-face`.
   Files: new `app/face/` (Canvas renderer, persona schema, Rocky persona), `app/claudevoiceview.html`
   and `.js` (layouts, reveal overlay, playback analyser), `app/voicepanel-host.js` (emotion tag strip +
   broadcast; turn and emotion state only, no audio), `app/voiceConfig.js` (persona list, per-page `face`
   option), `app/config.js` (editor option).
   Backup: the git branch. `desk-robot` is not modified.

5. **How we verify it is done:**
   - **Unit (`npm test`, the repo's required suite):** the tag parser strips a tag split across stream chunks, before both speech and transcript, only on face-enabled sessions, with a bounded prefix buffer; untagged, malformed, code and markdown replies pass untouched; structured-output profiles (Panel Builder) are never parsed; persona JSON validates and rejects credentials; existing pages migrate with `face` = Off.
   - **Renderer harness:** a test page feeds host events (`assistant-start/delta/final`, `turn-complete`, `turn-speech`, `approval-request`, `error`) and VAD state; the face reaches the matching expression within one frame, and the mouth follows a fed playback signal. Covers cancellation and barge-in, playback failure, backend switch and page switch mid-turn.
   - **Electron flow, both themes, on the 1920×480 panel, by T.J.:** a page with face Off is unchanged; Side gives the face ~1/4 of the width with transcript and controls beside it; Creature shows only the face, and the reveal overlay handles one approval, one mute, one stop and one error without leaving the page.
   - **Backends:** all five (Claude Code, Codex, Copilot, Open WebUI, API) pass the state and parser checks; Rocky answers in character live on Open WebUI or API and on at least one CLI backend, using the panel's default Whisper and Piper, and again on a page with an audio override set.
   - **Cost when hidden:** with face Off or the page hidden there is no animation loop, canvas or analyser listener (checked in DevTools); incremental CPU and memory of the face on an idle page are measured and reported, not assumed.

## Phase 3 — persona repositories (approved by T.J. 2026-10-20, "give personas the same repository model as apps")

**Status:** shipped and verified live in the editor against the private `TeeJS/bedrock-personas` repo
through the existing GitHub connection: Browse listed it (marked private), Install added Rocky with
`source` {url, version}, a catalog bump showed in Check for updates (1.0.0 → 1.0.1) and Update replaced it,
Replace asked before overwriting the folder-imported Norm, and the catalog re-opens after each install.
App repositories without a `personas/` folder show a muted note, not an error.

1. **The one thing this must do:** personas install and update from GitHub repositories the way drop-in
   apps do: Settings → Personas → **Browse repositories…** lists the personas every configured source
   offers, **Install** adds one to the library, **Update** replaces it when the catalog's version is newer,
   and private repositories work through the connected GitHub account.
2. **Wrong if shipped without it:** a browser that only reads public repos; an install that bypasses
   `validatePersona` (credentials, size, shape); an update that silently overwrites a persona the user
   edited without saying so; a catalog host other than GitHub.
3. **Off-limits:** a second token flow (the GitHub app connection under Settings → Auth is the only
   credential); executable content in a persona catalog; fetching through the public-URL importer (that
   path stays public-only and credential-free).
4. **Target and backup:** branch `rocky-face`, same repo. Reuses `app/appRepo.js` (URL rules, Contents
   API coordinates, `cmpVersion`) and `fetchRepoIndex` in `main.js` with a catalog parser parameter. New
   pure module `app/face/persona-repo.js`. Backup is the git branch.
5. **Verify:** unit tests for the catalog parser, source URL derivation, state annotation (available /
   installed / update) and the `source` field round trip; `npm test`; live: Browse lists the private
   `TeeJS/bedrock-personas` catalog through the token, Install adds Rocky, a version bump in the repo
   shows as Update, Update replaces it, an edited persona asks before being replaced.

**Repository layout (answering "same repos as apps?"):** yes. A source is any GitHub folder URL that
serves an `index.json`. For every configured app repository the app also looks at `<repo>/personas/`
(so one repo can carry `index.json` + zips for apps and `personas/index.json` + `*.persona.json` for
personas), and extra persona-only repositories can be listed under Settings → Personas. The catalog shape:
`{ "personas": [ { "id", "name", "version", "file": "<id>.persona.json", "description" } ] }`.

## Decisions T.J. made in the room

- Hardware, servos, the V2 neck, Docker and the Python server are deferred. Focus is the Bedrock Panel angle, as core functionality.
- STT and TTS: the panel's default Whisper and Piper endpoints as already configured in Bedrock Panel settings, with the same per-page override other pages have (`resolveVoiceEndpoints` + the page's `voiceOverride`). No host, port or voice hardcoded for the face, no second Whisper instance, no new connection settings. The Fish cloned voice is dropped.
- The face is a per-page option that can be turned off; a graphics-only "creature" mode exists; personalities are swappable.

## Proposed design (agents' proposals, approved only with the charter)

- Camera tools, Smart Turn and the wake word are not carried over; Bedrock's VAD and push-to-talk drive the turns.
- Emotion: the persona prompt asks for one short tag at the start of each reply, e.g. `[happy]`. The host strips it, buffered across chunks, and broadcasts it. Backends that ignore the instruction get a neutral face that still listens, thinks and talks.
- Persona is optional and additive to the existing Smart Profiles: Rocky is one persona, not a default. A persona's prompt is **appended** to the selected profile's prompt, never replacing it. A structured-output profile (Panel Builder) takes precedence and suppresses the emotion instruction and the tag parser.
- Lifecycle: changing the layout (Off / Side / Creature) or a cosmetic persona field never restarts the session. Changing a persona prompt restarts that backend's session (one host per backend), deferred until the live turn or approval ends. Hiding or disposing the page stops the canvas and analyser; on reconnect stale speech and emotion are cleared while transcript, real errors and approvals are kept. That the session is shared per backend is stated in settings.
- The expression is a cue, never the control: approvals, mute, stop and errors keep actionable UI in every layout.

## Phases

- **Phase 1 (this charter):** Canvas face ported from `face.cpp` (7 emotions, blink, doze, talking), Off / Side / Creature layouts with the reveal overlay, host wiring, persona schema with name + prompt + face, and the Rocky persona ported from `personality.py`.
- **Phase 2 (separate charter):** per-persona Piper voice (the Wyoming `synthesize` event's `voice` field; the client sends text only today), persona pack import/export, and packs via the drop-in catalog.

## Open before sign-off

- Default layout for a new AI Voice page: Off (proposed, so nothing changes for existing users).
- Where the per-page face option lives in the editor: beside Profile and Model (proposed).
