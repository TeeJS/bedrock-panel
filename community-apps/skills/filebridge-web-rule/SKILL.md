---
name: filebridge-web-rule
description: Author a FileBridge web-drop rule file for a subscription download site. Use whenever the user wants FileBridge (the Bedrock Panel drop-in, id file-bridge, formerly Folder Sync) to download new releases from a members' site it doesn't yet support — "add a rule for <site>", "make FileBridge download from <url>", "set up <site> in FileBridge", "why is my web-drop job finding nothing". Guides live recon (structure, selectors, download trigger) and produces a validated <site>.json in %APPDATA%\bedrock-panel\file-bridge\rules\. Do NOT ship any site-specific rule in the app itself — rules are per-user data.
---

# Author a FileBridge web-drop rule

FileBridge's web-drop jobs download new releases from a subscription site into a local
folder. A **job** is just a pasted listing URL + a destination; a **rule file** (matched
to the job by hostname) teaches FileBridge how that site is laid out and how a download is
triggered. The app ships **zero** rules — each user brings a rule per site they subscribe
to. Your job with this skill is to write one correct rule for a site the user names.

**Hard rule (non-negotiable):** never add a site-specific rule, selector, or hostname to
the app's code (`community-apps/file-bridge/*`). Rules are user data. They live only in
`%APPDATA%\bedrock-panel\file-bridge\rules\<site>.json`. If you find yourself editing `web.js`
to make one site work, stop — either the rule schema genuinely lacks a capability (extend
it generically, for all sites) or the rule is wrong.

## What you produce

One file: `%APPDATA%\bedrock-panel\file-bridge\rules\<site>.json`. You can write it directly,
or paste it into the app's **Rules** view (which validates on Save). Either way the runner
validates it with `web.validateRule` before every run.

## The rule schema (exact — from web.js `validateRule`)

```jsonc
{
  "site": "example",                 // short lowercase id [a-z0-9-]{2,40}; also the rule's filename
  "name": "Example Site",            // display label (session chip, logs)
  "match": ["example.com"],          // hostname(s) this rule handles; suffix-matched (covers www.example.com)
  "auth": {
    "loginUrl": "https://www.example.com/login",   // where "Open sign-in window" sends the user
    "probeSel": "a[href*='/account']",             // a selector present ONLY when signed in (verifies the session)
    "loggedOutUrlIncludes": ["/login"]             // URL fragment(s) that mean "signed out" — a run seeing one stops with needs-sign-in
  },
  "sources": [                       // one or more; each is a way to enumerate collections
    {
      "id": "releases",              // short lowercase id
      "mode": "listing",             // "listing" OR "sequential" (see below)
      "collectionHrefIncludes": "/release/",   // listing mode: substring identifying a collection link
      "listUrl": "/releases"         // optional; defaults to the page path of the URL pasted into the job
      // sequential mode instead: "pattern": "/drops/drop-{n}"   ({n} is the incrementing number)
    }
  ],
  "collection": {
    "itemSel": "a[href*='/item/']"   // selector for item links ON a collection page
    // OR "selfItem": true           // single-level site: each collection page IS the downloadable item
  },
  "item": {
    "nameSel": "h1",                 // optional; selector for the item's title (used to name its folder)
    "downloadClickText": "download", // the download control's visible text (see "Download triggers")
    "downloadAllSel": null,          // optional; selector for a multi-file chooser's rows
    "downloadTimeoutMs": 180000      // optional; how long to wait for a download to start (default 600000 = 10 min)
  },
  "delayMs": 4000,                   // optional; polite pause between items (min 500)
  "pathPattern": "{collection}\\{item}"  // optional; folder layout per item. Tokens: {site} {collection} {item} {yyyy} {mm} {dd}
}
```

## Recon procedure

Work with the **live site**, signed in. Use the browser tools (`mcp__Claude_Browser__*`, or
`mcp__claude-in-chrome__*` if the user is already logged in there) to read the DOM — never
guess selectors. Prefer `read_page` / `get_page_text` / `find` over screenshots for
selector work.

1. **Confirm auth + probe.** Load a members-only page. Find an element that appears **only
   when signed in** (account link, avatar, a "Log out" control) → that's `probeSel`. Note
   the login page URL (`loginUrl`) and any URL fragment the site redirects to when signed
   out (`loggedOutUrlIncludes`, e.g. `/login`, `/sign-in`).

2. **Classify the structure.** Two questions decide the whole rule:
   - **How are collections enumerated?**
     - A **listing** page of many collections (a vault, a library grid) → `mode: "listing"`,
       and find the `collectionHrefIncludes` substring shared by every collection link
       (inspect the hrefs: `/projects/<slug>` → `/projects/`).
     - A **sequential** series with an incrementing number (`/drops/drop-360`,
       `/drops/drop-359`…) → `mode: "sequential"`, `pattern: "/drops/drop-{n}"`. FileBridge
       reads the numbers present on the list page and counts down from the highest.
   - **One level or two?**
     - Collection page lists **several items**, each its own download → `collection.itemSel`
       (selector matching those item links).
     - Each collection page **is itself the single downloadable thing** → `collection.selfItem: true`.

3. **Find the download trigger** on an item page — the fiddliest part. Inspect what a real
   download click does:
   - **One button/link:** `downloadClickText: "download"` (its visible text).
   - **A menu, then a button:** a list of texts clicked in order —
     `downloadClickText: ["download files", "download"]`.
   - **A chooser of several files** (STL / renders / media, labels varying per product): set
     `downloadAllSel` to a selector matching the chooser's **rows**; FileBridge clicks the
     control inside **every visible row** (so per-product label differences don't matter).
     With `downloadAllSel` set, `downloadClickText` steps are treated as drill-in clicks only
     (e.g. `downloadClickText: "download files"` to open the chooser, then `downloadAllSel`
     grabs every row). The last `downloadClickText` step may itself be a **list** to click
     several named controls: `["download files", ["stl", "renders"]]`.
   - **Name selector:** find a stable title element for `nameSel` (usually `h1`).

4. **Write `pathPattern`** if the default `{collection}\{item}` isn't what the user wants.
   Tokens: `{site} {collection} {item} {yyyy} {mm} {dd}`. For a single-level site (`selfItem`),
   `{item}` and `{collection}` are the same name, so `"{item}"` is common.

## Gotchas learned the hard way — check every one

- **Membership-gated render.** Some listings render the collection links only *after* a
  third-party check (e.g. a "Checking Patreon access…" phase). FileBridge waits up to 20 s
  for the links to appear; if your `collectionHrefIncludes`/`pattern` or `probeSel` is
  wrong, it times out. Verify the selector matches the **real, rendered** links while signed
  in — not a login-wall placeholder.
- **Empty listing is an ERROR, never success.** A run that scans the listing and finds zero
  collections fails loudly (wrong selector / not signed in / not rendered) rather than
  reporting "nothing new". If a first run errors with "no collections found", the listing
  selector or the session is the problem.
- **Icon-only buttons with inert text labels.** Many sites pair an icon `<button>` with a
  separate text label. `downloadClickText` matches the visible **text**; FileBridge resolves
  the real clickable control near it (a clickable ancestor, or the single control in the
  row). So the label text works even when it isn't itself the button.
- **A click that navigates away kills the download.** Download prep often runs in-page
  (spinner, file starts later). If a `downloadClickText` step navigates off the item page,
  FileBridge errors immediately (that broke prep). Trigger texts must stay on the item page.
- **Server-side prep is slow but handled.** Some sites take **minutes** to prepare a file
  after the click. FileBridge fires an item's downloads in parallel and waits up to
  `downloadTimeoutMs` (default 10 min). Raise it for slow sites; don't lower it below the
  real prep time.
- **The app session is separate from the user's browser.** The user must sign in **once per
  site inside FileBridge** via the session chip's "Open sign-in window" (their password goes
  to the site's own page, never through the app). Being logged in in Chrome is not enough.
- **The seen-ledger keys collections by NAME** (the last path segment), not the full URL —
  so a changed `listUrl` doesn't re-crawl everything. Keep collection names stable.
- **Only rendered collections are reachable.** FileBridge scrolls the listing to load more,
  but a site behind a "Load more" button or an inner scroll container may hide the deep tail
  until newer items are consumed. Note this to the user if their vault is huge.

## Test it

1. Write the rule to `%APPDATA%\bedrock-panel\file-bridge\rules\<site>.json` (or paste into the
   Rules view and Save — Save runs the same validation the runner uses).
2. In FileBridge, add a **web-drop** job: paste the site's listing URL as the source, pick a
   scratch destination, set **Per run** to `1`.
3. Sign in once via the site's session chip ("Open sign-in window").
4. **Run.** Expect one collection's files to land under `<dest>\{collection}\{item}\`. Watch
   the run bar: it should reach "listing" then "collection" then download, not error.
5. **Run again** → expect `0 downloaded, N already seen`. That proves the ledger works.
6. If it errors "no collections found" or downloads nothing: recheck `probeSel` (is the
   session live?), `collectionHrefIncludes`/`pattern` (does it match rendered links?), and
   whether the site gates render behind a membership check.

## Two annotated skeletons

**Listing, single-level** (each listed page is the item — like a project vault with one
"Download" button per project):

```json
{
  "site": "myvault",
  "name": "My Vault",
  "match": ["myvault.example"],
  "auth": { "loginUrl": "https://myvault.example/login", "probeSel": "a[href*='/profile']", "loggedOutUrlIncludes": ["/login"] },
  "sources": [{ "id": "vault", "mode": "listing", "collectionHrefIncludes": "/projects/", "listUrl": "/projects" }],
  "collection": { "selfItem": true },
  "item": { "nameSel": "h1", "downloadClickText": "download model files", "downloadTimeoutMs": 300000 },
  "pathPattern": "{item}"
}
```

**Sequential, two-level with a multi-file chooser** (numbered drops, each with several
download rows):

```json
{
  "site": "mydrops",
  "name": "My Drops",
  "match": ["drops.example"],
  "auth": { "loginUrl": "https://drops.example/login", "probeSel": "a[href*='/account']", "loggedOutUrlIncludes": ["/login"] },
  "sources": [
    { "id": "main", "mode": "sequential", "pattern": "/drops/drop-{n}", "listUrl": "/drops" }
  ],
  "collection": { "itemSel": "a[href*='/product/']" },
  "item": { "downloadClickText": "download files", "downloadAllSel": "[class*=FileRow]", "downloadTimeoutMs": 600000 },
  "delayMs": 4000,
  "pathPattern": "{collection}\\{item}"
}
```

Adjust every selector to what you actually observe on the live site. When done, hand the
user the finished rule path and tell them to sign in via the session chip and do a
`Per run = 1` test run.
