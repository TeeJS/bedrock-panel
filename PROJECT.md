# Wake word for AI Voice pages (charter and plan)

**Signed off by T.J. 2026-10-20: option B (transcript gate first), with three added criteria.**

1. With wake word on, speech still goes to the configured STT, but **nothing is shown on the panel until
   the wake phrase is identified**: no bubble, no status text echo, nothing in the transcript.
2. An **optional chime** when the wake phrase is detected: a page option, off by default.
3. **Ending the conversation must be efficient and user-tunable:** one wake must never leave the page
   awake for the rest of the day. Default: one wake, one request, back to waiting. A **follow-up window**
   (seconds after the reply during which the human can speak without the phrase; 0 = off) is a page
   setting, counted only while waiting for the human (paused during generation, speech and approvals),
   and the page shows "Listening for a follow-up (n s)" while it runs so the end is visible.

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
   - as the BASE engine, anything that needs a step per phrase: a model trained per name (openWakeWord) or
     a console-made keyword plus an account key (Porcupine). The feature is "any persona name, no setup".
     Both remain welcome as optional engines behind the shared detector interface (for example a self-trained
     openWakeWord model for one favourite name on a Wyoming server). Licensing is not the reason: it is a
     purpose test on use, not a bar to using Bedrock Panel at work;
   - a second microphone stream, a new process, a listening socket, or audio sent anywhere but the STT
     destination the page is already configured to use;
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
     near-misses, the phrase mid-sentence, phrase alone, phrase-start boundaries such as "Norm" vs
     "normal" and "Jarvis" vs "jarvis's"); the state machine on a fake clock (waiting → listening →
     thinking → speaking → cooldown → waiting; mic off; a late STT result after mute; persona switch; page
     hidden; not-ready);
   - measured, not assumed: p95 time from end of the phrase to "listening" (VAD hangover + STT) and false
     accepts per hour, from a fixture set that is NOT only Piper: several real speakers, both sexes, a
     non-native accent, room noise and TV speech, plus Piper phrases for coverage of every built-in name;
   - a phrase-alone clip of about one second survives the whole chain: the STT server's own VAD filter
     options, the app's minimum voiced time and `isVoiceChatNoise`;
   - `npm test`, plus the editor harness for the option and the phrase preview;
   - by T.J. at the mic, with the app in software mode: wake Jarvis by name, a same-breath request
     ("hey Jarvis, what time is it"), a phrase-alone wake then a request, a reply that does not re-wake the
     page, mic off from the bar in Creature, a TV saying the name does nothing when the mic is off.

## Decisions already made (consensus in the room)

- **Two engines, both agreed; the ORDER is T.J.'s call (decision 1 below).**
  - *Transcript gate in the host:* every utterance is transcribed by the configured STT exactly as today's
    open-mic mode does, then the host keeps only text that starts with the wake phrase. Works for any persona
    name including imported packs, no new dependency, every STT backend, fully unit-testable. Honest wording
    in the UI: *the mic is on and speech goes to the configured STT (which may be a remote server) before it
    is filtered; nothing that is not addressed to the persona is kept*.
  - *On-device keyword spotter* (sherpa-onnx, Apache-2.0, open-vocabulary keywords from text, WASM in the
    renderer): no STT until the phrase, a low-latency cue (target to be measured, not "instant"), ring-buffer
    pre-roll. Unknowns to settle in an isolated spike: WASM inside the Electron webview on the served origin,
    CPU/RAM, accuracy on the built-in names, same-breath command-onset loss.
  - Room consensus (#272/#275): run the spike and a written decision gate first, with the transcript gate as
    the explicitly labelled v1 if the spotter proves unsuitable. Fable's alternative: ship the transcript
    gate first (smallest, no spike risk on the critical path) and spike afterwards. Both are below.
  - openWakeWord (a trained model per phrase, no browser port) and Porcupine (console keyword + account key
    per phrase) do not fit the base feature; both can be optional engine adapters later.
- **Phrase = "hey " + persona `wakeName`.** `wakeName` is an explicit spoken alias on the persona, with
  `aliases` for what STT tends to hear ("hey ricky"). Auto-fill only for a one-word pronounceable name;
  the editor always shows the exact resolved phrase; the page can override it. A page with no persona
  uses a page phrase (proposed default "hey panel").
- **One wake, one request.** Phrase plus request in one breath is the request. Phrase alone opens a
  window in which speech must START (proposed 8 s; the utterance and its transcription then take as long as
  they take). The page re-arms after the turn completes when the speaker is off, or after the actual playback
  end when it is on, then a short cooldown. No inherited 60 s window; a follow-up window is a later option.
- **Not ready is a visible state.** A phrase the active engine cannot detect (empty, unpronounceable, or an
  engine error) shows "Wake word not ready: <reason>" and keeps the gate CLOSED; there is never a silent fall
  back to open-mic listening.
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

Detector events are discriminated by kind; both feed ONE state machine in the host, so the engine can change
without touching it:

```
// text engine (transcript gate): decided after STT, carries the already-transcribed command
{ kind: 'text', gen, startedAt, endedAt, text, wake: false }
{ kind: 'text', gen, startedAt, endedAt, wake: true, phrase: 'hey jarvis', commandText: 'what time is it' }
{ kind: 'text', gen, startedAt, endedAt, wake: true, phrase: 'hey jarvis', commandText: '' }   // phrase alone

// audio engine (keyword spotter): decided early, before any STT; the command audio is still arriving
{ kind: 'keyword', gen, phrase: 'hey jarvis', detectedAtMs, phraseEndMs: null | estimate,
  audio: { preroll: PCM ring history, utterance: the VAD utterance that follows } }
```

`detectedAtMs` is when the spotter fired, not the exact end of the phrase (decoder latency, trailing blanks);
`phraseEndMs` is optional and estimated. The host keeps the VAD utterance start (or calibrated ring history)
and later strips only an anchored, recognized phrase from the STT text of that utterance; the pre-roll bound
is chosen from measured same-breath onset loss, not assumed. A `text` event never runs STT twice: it carries
the text it was decided on. Phase 1 implements the text engine in `app/face/wakeword.js` (pure): normalize
(lowercase, strip punctuation, collapse spaces), anchored match at the START of the text against the phrase
and its aliases, with a word boundary after it ("Norm" must not match "normal"), strip it and its trailing
punctuation, and return the rest **as the STT produced it**: normalization is only for matching; the command
text keeps its original case and punctuation (code and dictation depend on that). Only case, punctuation and
spacing are normalized for the match by default. Tolerated
leading fillers ("uh", "okay") and STT mishearings ("hey travis" for "hey jarvis") are **experimental, off by
default, enabled per persona after real recordings show they help**, because every broadening raises false
accepts and "okay" would change the displayed required phrase. A near-miss is discarded silently: no "did
you say…?" prompt.

Host (`voicepanel-host.js`): per page, `wake = { enabled, phrase, aliases, state: 'off'|'waiting'|'listening'|
'active'|'not-ready', windowUntil, cooldownUntil, gen }`. **The gate lives inside the existing `/audio`
path** (Sonnet #283, Codex #285): the page keeps POSTing each VAD utterance with its generation token; the
host's `transcribe()` runs STT as today and, when wake is on, applies the detector before answering:
`{ok:true, text: commandText}` for addressed speech (the page sends the turn exactly as now), `{ok:true,
text:'', wake:'listening'}` for phrase alone, `{ok:true, text:'', wake:'waiting'}` for everything else, and a
stale `gen` answers `{ok:true, text:''}`. Typed `/turn` is untouched and always addressed. While `active`
(thinking/speaking) unaddressed speech is dropped (Codex #278: nothing unaddressed is ever queued in wake
mode; addressed speech during thinking keeps today's queue semantics). New code never logs transcript text,
at any level (the existing noise-phrase drop log stays as is). Re-arm: `turn-complete` when the page's speaker is off, else the page's audio `ended`
(reported to the host) → cooldown → waiting. A late STT result that lands after the mic was muted, the
persona switched, or the page changed carries a stale `gen` and is dropped. Events: `wake-state {state,
phrase, until, reason}` over SSE and in `/state`, where `state` includes `not-ready`.

Page (`claudevoiceview.js`): keeps sending utterances to `/audio`, now with its generation token; renders the state
label and the Creature badge; on playback end tells the host (it already knows `ended`); the mic icon is the
hard off; the mic-off badge stays. The face gets `setState('waiting')` (renderer: dozing look where the style
allows, otherwise idle).

Data: page options `wakeWord` (off | on), `wakePhrase` (override, optional), `wakeChime` (off | on, default
off; a short built-in tone played by the page on the picked speaker when the phrase is identified), and
`wakeFollowUpSeconds` (0 = one wake one request, default 0; otherwise the follow-up window); persona fields
`wakeName` (string) and `aliases` (string[]); all normalized in `persona.js` / the page option validators and
carried by packs; the editor shows "Wake phrase: Hey Jarvis" next to the persona pick, the chime and
follow-up settings beside it, and the warning for Full auto. The panel's Settings overlay gets the same
three controls (wake on/off, chime, follow-up seconds) as pick rows, like Face and Persona.

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

1. Engine order: **B chosen** (transcript gate first; the on-device spotter is a later, separately gated
   phase behind the same detector interface).
2. Phrase pattern "hey <name>" with per-persona `wakeName`; default for pages without a persona: "hey panel"?
3. Phrase-alone listening window: 8 s to start speaking, then back to waiting?
4. A spoken "go to sleep" command: in or out of v1?
5. Who does the spike for Phase 2, and is it worth doing before Phase 1 ships?
6. Mic arming with wake word on: today the mic is off until tapped (the `micOnLaunch` setting is the only
   auto-arm). Proposed: unchanged. The mic icon in wake mode means tap = arm "waiting", second tap = hard off;
   a page rotated away and back comes back in the state it left (armed pages re-arm to "waiting", never to
   "listening"). Agree?
7. Measuring p95 and false accepts needs real STT runs against the configured Whisper server; that is a
   later step that needs your explicit OK for the agents to call it.

## Risks (from Sonnet's register, kept)

Short names mishear (aliases + tester); Whisper hallucinations on silence (`isVoiceChatNoise`, higher
minimum voiced time while waiting, rate limit); self-wake after playback (reset + cooldown); privacy is "LAN
STT, discarded after", not "local" (say so); persona switch while listening (restart resets to waiting);
hidden page must not listen; barge-in ("Jarvis, stop") is out of scope until echo cancellation exists; the
privacy promise is scoped to Bedrock Panel: unaddressed speech is not kept in its buffers, logs or transcript.
The configured STT may be a remote server that retains audio or text on its own terms; the UI says so.
