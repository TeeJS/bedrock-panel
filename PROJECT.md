# Wake word for AI Voice pages (charter and plan)

Branch: `wakeword-plan` (worktree, off `main` at v1.0.0-beta.4). Planning only, per T.J.'s rule: no change
to the main checkout and no app launch while he works in it. Research inputs: Sonnet's brief (engine matrix,
risk register) and Codex's UX/state contract, both in the agent room `AM-AT37LVS2HVXBHCDM6LHV6UKUDC`.

## Charter

1. **The one thing this must do:** an AI Voice page with **Wake word: on** keeps its microphone open but
   sends nothing to the AI until it hears its persona's wake phrase ("hey Jarvis"); the request that follows
   the phrase, in the same breath or within a short window, becomes the turn. Pages with the option off
   behave exactly as today.
2. **Wrong if shipped "working" without it:**
   - unaddressed speech reaching the model (or the transcript) while the page is waiting;
   - a page that looks asleep while the mic is really off, or looks off while it is listening;
   - a wake phrase that cannot be detected for the chosen persona name but the toggle still says "on";
   - the persona's own speech, or its echo, waking it;
   - a wake phrase treated as permission: approvals and permission modes exactly as today.
3. **Off-limits as a workaround:**
   - a trained-model engine whose models are non-commercial (openWakeWord's shipped models) or need an
     account key per name (Porcupine) for the base feature;
   - a second microphone stream, a new process, a listening socket, or audio shipped off the LAN;
   - auto-deriving a spoken name from a display name without showing it ("CRT Terminal" is not a phrase);
   - rewriting the page's permission mode when wake word is turned on;
   - logging or storing the speech that was discarded while waiting.
4. **Target and backup:** `TeeJS/bedrock-panel`, a feature branch off `main` when implementation is
   approved. Files: new pure `app/face/wakeword.js`; `app/voicepanel-host.js` (wake state, gate, events);
   `app/claudevoiceview.js/.html` (states, labels, badge, playback reset); `app/face/persona.js` (`wakeName`,
   `aliases`); `apps/apps.json` + `app/config.js` (page option, phrase preview, warnings); docs. Backup is
   the branch.
5. **How we verify it is done:**
   - unit: the matcher on recorded STT outputs for every built-in persona and the aliases (true wakes,
     near-misses, the phrase mid-sentence, phrase alone); the state machine on a fake clock (waiting →
     listening → thinking → speaking → cooldown → waiting; mic off; persona switch; page hidden);
   - measured, not assumed: p95 time from end of the phrase to "listening" (VAD hangover + STT), reported
     by a fixture test using Piper-synthesized phrases; false accepts per hour on an ambient-speech fixture;
   - `npm test`, plus the editor harness for the option and the phrase preview;
   - by T.J. at the mic, with the app in software mode: wake Jarvis by name, a same-breath request
     ("hey Jarvis, what time is it"), a phrase-alone wake then a request, a reply that does not re-wake the
     page, mic off from the bar in Creature, a TV saying the name does nothing when the mic is off.

## Decisions already made (consensus in the room)

- **Phase 1 engine = transcript gate in the host.** Every utterance is transcribed by the configured STT
  exactly as today's open-mic mode does, then the host keeps only text that starts with the wake phrase.
  Works for any persona name including imported packs, no new dependency, every STT backend, fully
  unit-testable. Honest wording in the UI: *the mic is on and speech is transcribed before filtering*.
- **Phase 2 (gated, separate charter) = on-device keyword spotter** (sherpa-onnx, Apache-2.0, open-vocabulary
  keywords from text, WASM in the renderer): no STT until the phrase, instant cue, ring-buffer pre-roll.
  Needs a spike first: WASM inside the Electron webview on the served origin, CPU/RAM, accuracy on the
  built-in names, pre-roll loss measured. openWakeWord and Porcupine are out for the reasons above.
- **Phrase = "hey " + persona `wakeName`.** `wakeName` is an explicit spoken alias on the persona, with
  `aliases` for what STT tends to hear ("hey ricky"). Auto-fill only for a one-word pronounceable name;
  the editor always shows the exact resolved phrase; the page can override it. A page with no persona
  uses a page phrase (proposed default "hey panel").
- **One wake, one request.** Phrase plus request in one breath is the request. Phrase alone opens a
  listening window to start speaking (proposed 8 s); after the reply the page goes back to waiting. No
  inherited 60 s window; a follow-up window is a later option.
- **States visible everywhere:** mic off / waiting for "Hey Jarvis" / listening / thinking / speaking,
  as text on the status line, as a badge in Creature, and for screen readers. The face's doze look is a
  cue, never the only signal (the cartoon style cannot close its eyes).
- **Echo and self-wake:** today `suppressVAD` only discards results while playback runs; the capture keeps
  going, so an utterance that spans the end of playback can carry the reply's tail. The gate resets on
  playback end and holds a short cooldown before it will wake again. Residual risk (room echo, a TV saying
  the name) is accepted and stated.
- **Wake is not authentication.** The editor warns when wake word is on with a Full auto mode; nothing is
  rewritten.
- **Generation tokens** guard every async step (STT result, wake decision, turn send) against a mic
  toggle, persona switch, page switch or layout change that happened in between.

## Architecture (Phase 1)

Detector interface, shared by both phases so Phase 2 slots in without touching the host's state machine:

```
wakeDetector.consider({ text, startedAt, endedAt, gen })
  -> { wake: false }                                       // discard; nothing logged, nothing queued
  -> { wake: true, commandText: 'what time is it', phrase: 'hey jarvis' }
  -> { wake: true, commandText: '' }                      // phrase alone: open the listening window
```

Phase 1 implements it in `app/face/wakeword.js` (pure): normalize (lowercase, strip punctuation, collapse
spaces), anchored match at the start of the text against the phrase and its aliases, strip it, return the
rest. A Phase 2 audio detector emits the same event from a keyword hit plus the VAD utterance that follows
(phrase end time estimated, pre-roll preserved; Codex #278).

Host (`voicepanel-host.js`): per page, `wake = { enabled, phrase, aliases, state: 'off'|'waiting'|'listening'|
'active', windowUntil, cooldownUntil, gen }`. `transcribe()` keeps its contract; a new `onUtterance(pcm, gen)`
runs STT, then: if wake is off → today's path; if waiting → detector; on wake with command → `onTurn`; phrase
alone → `listening` with a window timer; while `active` (thinking/speaking) unaddressed speech is dropped
(Codex #278: nothing unaddressed is ever queued in wake mode; addressed speech during thinking keeps today's
queue semantics). Playback end (`turn-complete` + the page's audio `ended`) → cooldown → waiting. Events:
`wake-state {state, phrase, until}` over SSE and in `/state`.

Page (`claudevoiceview.js`): sends utterances to the new route with its generation token; renders the state
label and the Creature badge; on playback end tells the host (it already knows `ended`); the mic icon is the
hard off; the mic-off badge stays. The face gets `setState('waiting')` (renderer: dozing look where the style
allows, otherwise idle).

Data: page option `wakeWord` (off | on) and `wakePhrase` (override, optional); persona fields `wakeName`
(string) and `aliases` (string[]); both normalized in `persona.js` and carried by packs; the editor shows
"Wake phrase: Hey Jarvis" next to the persona pick and the warning for Full auto.

## Phase 1 work breakdown (owners proposed; estimates are guesses to be measured)

| # | Piece | Owner | Notes |
|---|---|---|---|
| 1 | `app/face/wakeword.js` matcher + state helpers, tests on recorded STT strings | Fable | pure |
| 2 | Persona `wakeName` / `aliases`, pack template and validator, docs | Fable + Sonnet | data |
| 3 | Host gate, states, events, cooldown, generation tokens, tests with the fake adapter | Fable | host |
| 4 | Page states/labels/badge, playback-end reset, face state | Fable, Codex rules the UI | page |
| 5 | Editor option, phrase preview, Full-auto warning, harness cases | Fable, Sonnet harness | editor |
| 6 | Fixture set (Piper-synthesized phrases, negatives), p95 and false-accept measurements | Sonnet | test |
| 7 | T.J.'s mic acceptance script | Codex | manual |

## Decisions needed from T.J. before implementation

1. Phase 1 (transcript gate) first, Phase 2 (on-device spotter) only after a spike: agree?
2. Phrase pattern "hey <name>" with per-persona `wakeName`; default for pages without a persona: "hey panel"?
3. Phrase-alone listening window: 8 s to start speaking, then back to waiting?
4. A spoken "go to sleep" command: in or out of v1?
5. Who does the spike for Phase 2, and is it worth doing before Phase 1 ships?

## Risks (from Sonnet's register, kept)

Short names mishear (aliases + tester); Whisper hallucinations on silence (`isVoiceChatNoise`, higher
minimum voiced time while waiting, rate limit); self-wake after playback (reset + cooldown); privacy is "LAN
STT, discarded after", not "local" (say so); persona switch while listening (restart resets to waiting);
hidden page must not listen; barge-in ("Jarvis, stop") is out of scope until echo cancellation exists.
