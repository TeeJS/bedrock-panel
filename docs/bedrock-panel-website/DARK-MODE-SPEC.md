# Bedrock Panel website — Dark mode design spec

Design lead: C3PO. Companion to `DESIGN-SPEC.md`. Grounded in the brand kit dark
tokens (`docs/bedrock-panel-branding/tokens.json`), verified against the built
theme (`theme.json`, `assets/css/theme.css`, patterns).

## Intent

The site launched light with intentional dark media/community/footer stages. Dark
mode is the second appearance, not a recolor. The hard problem: in the light design
those dark sections earn their prominence by contrasting with a light body. Flip the
body to dark and they vanish into it and the page flattens. So dark mode **re-layers**
depth with surfaces and hairlines instead of "darker-than-body" stages.

## Mechanism (recommended)

Ship as a native FSE **style variation**: `styles/dark.json` (theme.json v3 shape:
`settings`/`styles` + a scoped `css` block). Admin switches the whole site in
Site Editor > Styles. No JavaScript. A visitor auto/manual toggle
(`prefers-color-scheme` + remembered choice) is an optional fast-follow, not a launch
gate. Do not fabricate a toggle UI until the JS + persistence exist.

## Depth model — two surfaces, not many shades

The brand gives two dark greys; keep the system to two levels plus the existing near-black
media backing. Do not invent a palette of tints.

| Level | Token | Hex | Used for |
| --- | --- | --- | --- |
| Base (page) | darkBackground | #202C3A | body, header, footer |
| Raised surface | darkSurface | #2B394B | cards, hero media-stage, feature-media, community band, download box, notices |
| Media backing | (existing) | #0E141A | inside `.screen` behind screenshots — unchanged, works in both modes |
| Hairline divider | (derived) | #384657 | replaces light dividers #c3cdd9 / #dbe1e8 / #718298-as-line |

Separation comes from **surface + 1px #384657 border**, not from making a section darker
than the page.

## Colour role map (light -> dark)

| Role | Light | Dark |
| --- | --- | --- |
| Page background | #F5F7FA | #202C3A |
| Reading surface / card | #FFFFFF (and #e7edf3) | #2B394B |
| Primary text | #202C3A | #F5F7FA |
| Supporting / muted text | #54657B | #C3CDD9 |
| Eyebrow / section label | #285A87 | #99C8F0 |
| Inline link | #285A87 | #99C8F0 |
| Primary action (button) | bg #285A87 / #FFF | bg #99C8F0 / #202C3A |
| Secondary action | text #285A87, border #718298, transparent | text #99C8F0, border #718298, transparent |
| Divider / hairline | #c3cdd9 / #dbe1e8 | #384657 |
| Meaningful border | #718298 | #718298 (keep) |
| Focus ring | #285A87 | #99C8F0 |

Primary buttons go **pale on dark** everywhere in dark mode (a #285A87 button on a
#202C3A page barely separates — blue-on-blue). #99C8F0 is the brand's `primaryDark`,
so this is on-brand, not a workaround.

## Section re-layering (the actual work)

- **Header:** background #202C3A, bottom border #384657. **Swap the logo** to the
  reversed/dark asset (`bedrock-panel-logo-horizontal-dark.svg`, the one the footer
  already uses) so the wordmark stays legible. Nav item text -> #F5F7FA; hover ->
  #99C8F0. Download CTA pill -> #99C8F0 bg / #202C3A text.
- **Hero media-stage:** currently #202C3A — now that equals the body, so give it
  background #2B394B + 1px #384657 border so the screenshot frame reads as a stage.
  `.screen` backing stays #0E141A. `.media-top`/figcaption text #C3CDD9; figcaption
  link #99C8F0. Tagline #C3CDD9.
- **Capabilities `.feature-media`:** light #e7edf3 panel -> #2B394B + #384657 border;
  `.feature-row` top divider #c3cdd9 -> #384657. `.empty-media` stays a deep panel but
  bordered #384657 so it doesn't merge into the body.
- **Demos posters:** `.poster` already dark; add #384657 border so cards separate from
  the page; `.pending` chip stays legible on #2B394B.
- **Ways `.way`:** top accent stays primary; on dark use #99C8F0 for the 3px accent so
  it reads. `.hardware-note` divider -> #384657.
- **Community `.section.dark`:** make it a **raised band** #2B394B (not #202C3A) with a
  top+bottom #384657 hairline, so the "build together" invitation keeps prominence
  instead of dissolving into the body. Buttons pale per the map.
- **FAQ:** `.faq-list` borders #c3cdd9 -> #384657; summary text #F5F7FA; answer #C3CDD9.
- **Footer `.dark site-footer`:** stays base #202C3A (footers may sit flush with body),
  separated by its existing top hairline -> #384657. Logo already the dark asset. Keep
  the licensing/non-affiliation legibility (#C3CDD9).
- **Docs / Download templates:** `.doc-nav` right border, `.doc-topic`/`.release-options`/
  `.download-box` borders and surfaces all move to #2B394B surface + #384657 dividers;
  `.notice` left-accent stays primary but on a #2B394B panel; `.topic-nav`
  `[aria-current]` active chip -> #99C8F0 bg / #202C3A text.

## Contrast (AA verified against tokens)

- #F5F7FA on #202C3A ~15:1; on #2B394B ~12:1 — body text passes AAA.
- #C3CDD9 on #202C3A ~9:1; on #2B394B ~6.5:1 — muted passes AA.
- #99C8F0 on #202C3A ~8:1; on #2B394B ~6:1 — links/eyebrow pass AA.
- #202C3A on #99C8F0 (button label) ~8:1 — passes.

## Guardrails (unchanged from light)

- Honest media only — no fabricated screenshots, no fake Play buttons; dark mode reuses
  the same real/labeled captures.
- Primary controls stay pixel-stable between light and dark; only colour/surface changes,
  never layout, size, or position.
- 44-48px touch targets, visible focus, reduced-motion, underlined links, 200% zoom,
  no horizontal scroll — all carry over.

## Handoff to Claude (build)

- Add `styles/dark.json` mapping the global roles above (background, text, link, button,
  heading, eyebrow) + a scoped `css` block re-treating `.media-stage`, `.section.dark`
  (community), `.feature-media`, `.empty-media`, `.poster`, `.faq-list`, dividers, and
  the docs/download surfaces to #2B394B / #384657.
- Header logo swap for dark: template/CSS approach (e.g. a dark-variation body scope
  showing the `-dark` logo) — keep the light header unchanged.
- Then render both appearances at 1920x480-class desktop + 390px mobile for C3PO review
  and T.J. evaluation. Live-QA the dark variation the same as light (nav overlay,
  buttons, zoom, no overflow).
