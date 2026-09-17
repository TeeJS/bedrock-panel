---
target: Macro Deck Surface UI review
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
target_identity: "file:D:\\Github\\open-quake\\repo\\community-apps\\macro-deck-surface\\index.html"
target_fingerprint: "sha256:b67ecc081df857b3d75003592b9813059259a8fe7967a7fbda80833903c0d895"
target_path: "D:\\Github\\open-quake\\repo\\community-apps\\macro-deck-surface\\index.html"
timestamp: 2026-09-16T20-39-08Z
slug: community-apps-macro-deck-surface-index-html
---
Method: dual-agent (A: /root/design_review; B: /root/evidence_review)

Macro Deck Surface — UI review

Verdict: coherent Macro Deck mirror, but the framing and inactive slots dominate the useful content. Preserve host coordinates and artwork. The best visual improvements are quieter empty slots and a host profile designed for the wide panel.

Assessment: 22/40, provisional screenshot/source quality score; 4 = excellent.
| Heuristic | Score |
|---|---:|
| System status | 3 |
| Match to real world | 3 |
| User control/freedom | 2 |
| Consistency/standards | 2 |
| Error prevention | 2 |
| Recognition over recall | 2 |
| Flexibility/efficiency | 1 |
| Aesthetic/minimalism | 2 |
| Error recovery | 2 |
| Help/documentation | 3 |

Strengths: stable host coordinates; large touch targets in the supplied profile; pressed feedback; clear first-approval instructions and automatic reconnect. The editor has only three app-specific options, so a major form redesign is unnecessary.

Priority findings:
1. P1 — Tiny host-rendered label. app.js:118-119,142-143 and style.css:66-74 render labels as bitmap layers. CSS font-size cannot fix the screenshot text. Compare with the official client at equivalent tile size and adjust host artwork/font settings. The square-fit layout in app.js:83-100 explains the approximately 700px deck; try a host profile with fewer rows/more columns before adding client fit options. Do not stretch/reorder automatically. Direction: impeccable adapt.
2. P2 — Empty slots look actionable. style.css:47-63 uses strong fill/edges for absent buttons. Preserve coordinates and soften only .empty slots; iconless assigned controls must remain active. Direction: impeccable quieter.
3. P2 — Keyboard and assistive access absent. app.js:114-122,178-181 uses divs with pointer handlers and empty-alt images. Use semantic buttons, deliberate keyboard press/release handling, visible focus and meaningful names where metadata permits. index.html status updates also need live-region semantics. Direction: impeccable harden.
4. P2 — Ready state appears before buttons load. app.js:194-203 hides the overlay at GET_CONFIG, then requests GET_BUTTONS. Retain Loading buttons until a response arrives; distinguish successful empty response from delay/failure. Direction: impeccable harden.
5. P2 — Persistent reconnect lacks recovery advice. app.js:251-255 retries automatically but gives no next step. Add guidance to check host availability/address after sustained failure. Existing connecting/approval/reconnect overlays are useful and should be retained. Direction: impeccable clarify.

Cognitive load: one actual action visually competes with fourteen inactive controls. Three setup options are manageable. Approval instructions reassure; the sparse deck and repeated reconnect can create doubt.
Persona flags: first-timers may tap inactive slots; low-vision users cannot enlarge bitmap text with CSS font settings; keyboard users cannot focus or activate keys.
Minor: reduced-motion support is missing. The 48px minimum can overflow for dense grids, but the supplied 3x5 screenshot does not show that failure. Knob page navigation is documented as unsupported, not a verified regression.

Detector: successful scan, zero findings. Manual issues remain. Source and supplied screenshots only; no live browser or physical-device validation, no macro actions sent. Preview is a full 1920x480 iframe scaled by the editor, not an independently small viewport.

Decisions for a future implementation: preserve host mirroring and improve polish, or add optional client layout adaptation? Limit changes to the drop-in, or include editor preview/setup changes?
