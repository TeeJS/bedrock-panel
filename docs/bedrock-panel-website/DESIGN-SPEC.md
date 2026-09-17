# Bedrock Panel — responsive WordPress theme design

Designer: Picasso. Phase 2 review draft, 7 September 2026.
Companion: `design-preview.html`, `demos-preview.html`, `docs-preview.html`, `download-preview.html`.
These are review prototypes, not deployed pages. Implementation follows explicit design consensus from Picasso, Claude, and BT-1, as authorized by T.J.

## Direction

A capable, welcoming software platform with room to grow. Lead with useful workflows on a compatible Windows PC or touchscreen. Hardware is an optional extension. Keep the QUAKE origin in project history and compatibility/legal details, away from the hero. Bedrock Console is a built DIY console with an optional knob, per T.J.; he is updating its repository license. Website copy follows his approved MIT-except-QUAKE-driver framing.

Light surfaces and generous spacing make docs and product explanations easy to read. Dark slate media stages give screenshots and videos a consistent frame. No decorative gradients, auto-rotating carousel, autoplay requirement, or fabricated testimonials. Actual product imagery does the explaining. The prototype uses existing editor captures, clearly labeled as earlier UI where necessary; new desktop/touchscreen footage replaces these for launch.

## Visual system

| Role | Specification |
| --- | --- |
| Main background | #F5F7FA |
| Reading surfaces | #FFFFFF |
| Primary action / inline link | #285A87 with white button label |
| Primary text | #202C3A |
| Supporting text | #54657B |
| Media / community stage | #202C3A; inset surfaces #2B394B |
| Dark-stage text / secondary text | #F5F7FA / #C3CDD9 |
| Dark-stage action | #99C8F0 with #202C3A label |
| Meaningful border | #718298 |
| Font | Segoe UI, -apple-system, BlinkMacSystemFont, Roboto, Arial, sans-serif |
| Body | 18px desktop, 16px mobile; line height 1.55 |
| H1 | fluid 36–48px, weight 700, line height 1.08 |
| H2 | fluid 28–40px, weight 600–700, line height 1.15 |
| H3 | 24px, weight 600 |
| Labels | 14px; no essential text below 14px |
| Widths | 1200px wide; prose 720px; gutters 20px mobile / 32px tablet / 48px desktop |
| Spacing | 8px base; 16 / 24 / 32 / 48 / 64 / 96px scale |
| Section spacing | 48px mobile; 80–96px desktop |
| Corners | 8px buttons; 12px media/surfaces, no ubiquitous pills |

Use supplied horizontal SVG at 240–260px desktop and 200px mobile, preserving viewBox and clear space. Use reversed/dark asset on dark footer. Never reconstruct the wordmark in text. No font downloads required.

Launch with one intentional light appearance including dark media sections. The full dark brand palette is available for a later WordPress style variation; a visitor theme switch is not needed for the first release. Do not confuse this website choice with the application's light/dark features.

## Responsive rules

- Work at 320px, 390px, 768px, 1024px, 1440px and wider. No horizontal page scrolling.
- Header: 200px minimum logo + 44px native navigation toggle on small screens. Expand navigation only when it fits (approximately 1100px); no seven cramped labels on tablets. In the theme use the core Navigation block and test its mobile overlay, focus return, Escape, and keyboard navigation. Prototype uses an ordinary disclosure.
- Hero: two columns above 960px; copy then visual on smaller screens. Do not reduce the screenshot into illegible decorative slivers. Caption/link lets readers open a larger view.
- Home demo grid: three columns above 960px, two above 640px, one below. At two columns the third remains full card width, not artificially stretched.
- Capability rows: text/media split on desktop, consistent text-before-media DOM order on mobile. Two secondary link lists may wrap; avoid tabs hiding the core pitch.
- Compatibility: three equal desktop columns, stack on mobile. Optional controllers are a note below, not another run mode.
- Docs: 240px sidebar plus 720px article on wide screens; a collapsible topic list before content on mobile. Tables scroll only within a labeled wrapper when genuinely necessary.
- Download: primary installer information plus setup/help sidebar on desktop; stack on mobile. Release identifiers and requirements must come from verified release data.
- Media: preserve native ratio, `object-fit: contain`; thumbnails use a neutral media stage and never crop controls. Portrait clips stay centered at a comfortable maximum width. No fixed-height text containers.
- Buttons and controls have at least 44px touch targets. Visible focus, underlined inline links, semantic headings, skip link, reduced-motion behavior. All content remains usable at 200% zoom.

## Home

1. **Header:** logo; Features, Demos, Docs, Community, GitHub; primary Download action.
2. **Hero:** small Windows platform label; “Your tools. Your space. Your control.”; one paragraph explaining apps, media, dashboards and smart home; Download for Windows + Watch demos. A generously sized real software image/video stage to the right, showing software first; no vendor hardware silhouette as the primary identity. Tagline below the stage.
3. **See it in action:** three curated stories, with short outcome headings and one-line captions. Each links to its demo page. No invented duration: populate from actual media. Opening launch stories: desktop workflow, touchscreen/home dashboard, media/productivity. Portrait footage is supported but not mandatory for all three.
4. **Capabilities:** four spacious rows: Launch & control; Dashboards & smart home; Everyday apps; Customize & extend. One concise paragraph, 2–3 representative capabilities, one related demo/docs link, and one real media area per row. Reuse existing demos where appropriate. Build-your-own Console is a linked subsection of Customize & extend.
5. **Ways to make it yours:** Desktop software; Compatible touchscreen; DIY Bedrock Console. Note optional knobs beneath. Link detailed display/controller compatibility and run modes from here; do not promise that monitor mode works on every device.
6. **Get started:** download, choose setup, make your first page. One Download action and an installation-guide link.
7. **Community:** dark slate full-width section, tagline and Discord/GitHub actions. No invented activity/member statistics.
8. **FAQ:** native Details blocks, five approved questions. Follow with footer containing brand, navigation, project/license links and concise mixed-license/vendor disclaimer.

## Demos and editorial workflow

`/demos` is a curated library using WordPress Posts in the Demos category, with topic tags. Use a featured story followed by a consistent grid with native aspect ratios inside shared media stages. A row of topic links navigates to server-rendered archives; no JavaScript filter dependency. Native search can search the site; do not imply a demos-only search without implementing its scope.

Each demo post contains: descriptive title, short outcome/excerpt, featured poster, actual duration, publication date, category/topic, native YouTube Embed or video block, captions, readable transcript, requirements, related setup link and Download action. Use a post pattern so publishing a new short is an editorial task. Social links point to stable site demo URLs. Use one post per story; aspect-ratio variants can live inside that story.

Core embeds are not guaranteed to defer all third-party requests until playback. Implement a lightweight opt-in facade only if required: one small script replaces a poster button with the iframe after activation, preserves accessible naming/focus, with an ordinary external watch link as fallback. Otherwise use the native embed with its actual loading behavior documented. Never place empty players or fake Play buttons on the live site. Missing footage falls back to an honest screenshot + guide link, or an unpublished demo draft. Prototype sample media is visibly identified as pending footage.

## Docs and Download

`/docs`: topic index + search + quick-start routes; topic groups Getting started, Pages & layouts, Apps & integrations, Devices & hardware, Troubleshooting, Development. Article template includes breadcrumb, title, intro, topic navigation, heading anchors, related guides. Initial docs must be real, reviewed content; do not publish an empty shell. WordPress Pages maintain hierarchy and stable permalinks; no special docs plugin required.

`/download`: current verified release and date, portable/installer distinctions verified from that release, platform requirements, release notes, three-step setup, support link. Link GitHub release source; do not hard-code stale versions in theme files. Prototype deliberately links to the releases page instead of inventing asset URLs. Hardware compatibility distinguishes the 1920×480 page canvas from website responsiveness.

Source check: `app/runMode.js` confirms software/panel/monitor modes. `app/panes.js` supports 1–5 stacked pages and 1–2 columns in software mode with 1920×480 page units; this is evidence for flexible software layouts, not proof of universal touchscreen support. Actual device placement and scaling need runtime validation before detailed compatibility promises.

## WordPress handoff

Claude owns installable theme ZIP and content wiring after consensus. Picasso reviews rendering; BT-1 reviews copy. Structure:

- `style.css` metadata; `theme.json` settings/styles; focused `functions.php` for assets/pattern categories.
- `parts/header.html`, `parts/footer.html`.
- `templates/index.html`, `front-page.html`, `page.html`, `single.html`, `archive.html`, `search.html`, `404.html`.
- Registered custom templates for docs landing/article, downloads and demo library where needed.
- `patterns/`: hero, curated demos, capability row, setup choices, get started, community, FAQ, demo story, docs index, download panel.
- `assets/`: approved logos/favicon, CSS for responsive layout/media. Native blocks own editable text/content. No media URLs or secrets in theme code.
- Provide editor styles as well as front-end CSS so patterns retain their intended appearance in Gutenberg.
- Theme ZIP should be self-contained with one top-level theme directory. No npm/runtime dependencies required by WordPress. Theme activation must not overwrite content or settings silently.

Reference: [WordPress theme structure](https://developer.wordpress.org/themes/core-concepts/theme-structure/), [theme.json](https://developer.wordpress.org/themes/global-settings-and-styles/introduction-to-theme-json/), [custom templates](https://developer.wordpress.org/themes/global-settings-and-styles/custom-templates/).

## Review and release evidence

Review all four prototype pages at desktop and mobile, keyboard navigation/disclosures, logo aspect ratios, all link destinations, real media inventory and copy. Prototype visual approval does not replace WordPress testing: verify saved block content in the editor and frontend, navigation overlay, media playback, reduced motion, 200% zoom and cache purge on the installed theme. Run repository tests for files added here; app runtime is unchanged.

Consensus record: Claude approved direction/buildability in room #67; BT-1 approved copy and design in #68–69. Picasso completed prototype browser QA: all four pages at 320, 390, 768, 1024 and 1440px (20 checks), no horizontal overflow, missing image or missing local anchor; mobile navigation and FAQ disclosures passed. Desktop/mobile screenshots reviewed under `review/`. Repository tests: 714 passed, zero failures. Picasso signs off this design for implementation under T.J.'s room #51 authorization. Native WordPress navigation and actual media playback remain implementation QA, not claimed by the prototype checks.
