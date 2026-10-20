# Wake-word UI acceptance

Status: **future acceptance script, not a record of passing checks**. Implementation is in the
`wakeword-plan` worktree. Do not launch Bedrock, a harness, Piper, or STT measurements while
T.J.'s no-launch restriction is active. Pure matcher/state tests do not establish acoustic accuracy.

## Setup once runtime validation is permitted

Use two AI Voice pages with different spoken names; one requires a wake phrase, one stays
conversational. Record the exact displayed phrase, configured STT destination, microphone,
speaker, speaker volume, layout, theme, chime setting and follow-up seconds. Keep the existing
approval mode. Use a harmless request such as asking the time.

Run the visual cases at 1920x480 in both themes and Off, Side and Creature layouts. Repeat core
arming and settings operations with touch/keyboard and the knob. Record failures and any checks
not run; do not infer a pass from source inspection.

## Observable checks

| Action | Expected result |
|---|---|
| Enable Require wake phrase in page settings | Exact phrase is visible. Disclosure explains that speech goes to the configured STT before filtering; Bedrock discards unaddressed text, while STT retention follows that provider's terms. Chime defaults off; follow-up defaults 0. |
| Open or return to page | Existing mic-on-launch preference applies. Hard-off pages stay off; previously armed pages return to waiting for the phrase, never to an old open request window. Hidden pages release capture. |
| Tap mic while off, then tap again | First tap arms Waiting for Hey Jarvis; second tap is hard off and releases capture. Icon, accessible name and visible status agree. |
| Speak ordinary ambient speech before the phrase | No user bubble, echoed text, transcript entry or AI turn appears. No discarded-text-dependent face activity or status text. Static waiting/mic status stays visible. |
| Say the displayed phrase alone | Optional chime occurs once after detection; Listening appears with a finite request-start window. No empty user bubble or AI turn. |
| Start a request just before that window expires | Full request survives capture and STT even if they finish after the deadline. |
| Let phrase-alone window expire without speaking | Return visibly to Waiting for Hey Jarvis; no turn, stale countdown or chime. |
| Say Hey Jarvis, What does FooBar() return? in one breath | Exactly one request, preserving command case/punctuation. No lost first word, duplicate STT pass or chime-caused clipping. |
| Finish a reply with follow-up 0 | Return to waiting after actual playback end and echo cooldown; if speaker is off, after turn completion. No all-day open conversation. |
| Set a short nonzero follow-up window and complete a reply | Show Listening for a follow-up (n s) only when waiting for human speech; accept one follow-up without requiring the phrase. |
| Spend time generating, playing speech, or waiting on an approval | Human-listening countdown does not decrease during those states. Approval remains visible and its permission policy is unchanged. |
| Start a follow-up just before zero | Request is accepted even when capture/STT ends later; there is no timeout halfway through speech. New completed reply starts a fresh configured window. |
| Let follow-up reach zero | Waiting for Hey Jarvis appears immediately, remaining countdown clears, and later unaddressed speech is discarded. |
| Cancel an active turn or deny an approval | No stuck active state or indefinite window. Return/resume follows the documented timer policy; no automatic new full budget without a completed reply. |
| Enable chime, detect once, reconnect state/SSE | One short cue for the accepted detection; no cue from reconnect or ordinary follow-up utterances. Selected output, volume and speaker mute are respected. |
| Assistant says its own name | No self-wake after playback, including the reply tail. Repeat with room echo; record residual false accepts rather than assuming cancellation works. |
| Mute or change page/persona while STT is pending | Result is discarded; no late user bubble, chime, turn or reopening of the gate. |
| Change persona during a turn | Old active phrase and pending change are clear until the apply boundary; after apply the new exact phrase is displayed and old phrase no longer opens it. |
| Trigger invalid phrase or STT failure | Visible Not ready/error, gate stays closed, no silent fallback to conversational mode. |
| Use the page with wake disabled | Current conversational behavior and typed input remain intact. |

Countdown text may update once per second; screen readers announce state changes, not every tick.
A compact status label must remain legible without opening Settings or relying on eyes/face animation.
Settings should group the wake toggle, phrase preview, optional chime and follow-up seconds; dependent
controls are disabled when wake is off. Do not add three permanent voice-bar buttons.

## Measurements and limits

When approved, use real recordings from multiple speakers/accents, quiet/noisy/distant speech,
near words and TV/music negatives. Piper phrases supplement this set; synthetic speech alone is
insufficient. Report false accepts per hour, rejected true wakes, phrase-alone survival through all
VAD/noise filters, p95 wake-cue latency including STT, command-onset loss, and test conditions.
Do not claim instant detection or local-only audio for the transcript gate. A TV/guest using the
exact phrase can activate it while armed: wake is not authentication. Voice barge-in is outside v1.
