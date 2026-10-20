# Rocky Face — a built-in animated face for AI Voice (charter)

Branch: `rocky-face` (off `main`). Agent room `AM-AT37LVS2HVXBHCDM6LHV6UKUDC` (Fable chair, Codex).
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
