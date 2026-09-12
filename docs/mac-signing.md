# Signing and notarizing on the build Mac — handoff for an agent

You are on T.J.'s Mac and you have been asked to build, sign and notarize Bedrock Panel. Before you
tell anyone you lack an Apple ID, developer tools, or credentials: **this Mac has already produced a
signed, notarized, stapled release.** v0.9.5 and v0.9.6 both shipped from it. The credentials exist,
they are stored where you do not have to see them, and you do not need to ask T.J. for an Apple ID,
a password, or a team ID.

Nothing here asks you to handle a secret. The design deliberately keeps them out of your hands: the
certificate lives in the login keychain, and the notarization password lives in a `notarytool`
credential profile. You reference them by name.

## Start by discovering what is already configured

Run these four, in the repo root, before concluding anything is missing.

```bash
security find-identity -v -p codesigning
cat .signing/mac-identity 2>/dev/null
cat .signing/notary-profile 2>/dev/null
xcrun notarytool history --keychain-profile "$(cat .signing/notary-profile)" 2>&1 | head -20
```

What you should see, and what it means:

- `find-identity` lists a line beginning `Developer ID Application:` with a team ID in parentheses.
  That is the certificate, already installed and trusted.
- `.signing/mac-identity` is a one-line file naming the identity to sign with. The folder is
  gitignored, so it is per machine and never travels with the repo. Its absence is not proof of
  absence — check the environment variable `BEDROCK_MAC_IDENTITY` too.
- `.signing/notary-profile` names a `notarytool` credential profile stored in the keychain. The
  Apple ID and app-specific password went into that profile once, long ago, and neither you nor the
  build ever sees them again.
- `notarytool history` proves the profile actually authenticates. If it returns past submissions,
  everything you need works.

If Xcode command line tools were genuinely missing, `xcrun` itself would fail with a message saying
so. `xcrun --find notarytool` answers the question directly.

## How the build picks its identity and credentials

`npm run dist:mac` runs `build-mac.js`, which resolves both before calling electron-builder. You do
not pass anything on the command line.

Identity, first match wins: the `BEDROCK_MAC_IDENTITY` environment variable, then
`.signing/mac-identity`, then `-` meaning ad-hoc. Notarization credentials, first match wins: the
`APPLE_KEYCHAIN_PROFILE` environment variable, then `.signing/notary-profile`, then the
`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` trio, then the App Store Connect API key
trio.

Notarization runs only when the identity is a Developer ID **and** credentials were found. The script
says which it chose in its first two lines of output. Read those lines rather than guessing:

```
[build:mac] signing identity: "Developer ID Application: …" [.signing/mac-identity]
[build:mac] notarization: on, via .signing/notary-profile
```

If the first line says `ad-hoc`, stop and fix the identity rather than shipping — an ad-hoc signature
is different on every build, so macOS treats each build as a new app and every privacy grant the user
made goes stale.

## Build

```bash
npm run dist:mac
```

That is the whole command. electron-builder signs the app with the hardened runtime and the
entitlements in `packaging/mac/`, notarizes and staples the `.app`, and then `build-mac.js` submits
the DMG separately and staples that too, because a downloaded disk image is what Gatekeeper assesses
first. Apple usually answers within minutes and the build waits for it. Expect roughly ten minutes
overall; two round trips to Apple is the slow part, not your machine.

Delete any earlier dry-run `dist/*.dmg` and `dist/*.zip` before you start, so a stale artifact cannot
be uploaded by mistake.

## Verify before you hand anything over

Never report success from the build's exit code alone.

```bash
spctl -a -t exec -vv "dist/mac-arm64/Bedrock Panel.app"
xcrun stapler validate dist/bedrock-panel-arm64.dmg
codesign -dvv "dist/mac-arm64/Bedrock Panel.app" 2>&1 | grep -E 'Authority|flags'
```

You want `source=Notarized Developer ID` and `accepted` from `spctl`, a passing `stapler validate`,
and an `Authority=Developer ID Application:` line with `flags=…(runtime)`. Also confirm the version
actually reached the artifact rather than only the tree, by reading the packaged
`Contents/Info.plist` for `CFBundleShortVersionString`.

## What to do if something really is missing

Say precisely which of the four discovery commands failed and what it printed. That is a useful
report. "I don't have an Apple ID" is not, because the Apple ID is not something you were ever meant
to have.

The one-time setup, if it genuinely has to be redone, is written out step by step in
[building.md](building.md) under *Signing with a Developer ID and notarizing*: the certificate
request, the app-specific password, and `xcrun notarytool store-credentials`. That procedure needs
T.J. at the keyboard for the Apple website and the keychain password. Do not attempt it unattended
and do not ask him to paste a password to you — ask him to run `store-credentials` himself, and tell
him the profile name to use.

## Things that have actually gone wrong here

- **electron-builder refuses the certificate-type prefix.** `.signing/mac-identity` holds the full
  name as the keychain shows it, and `build-mac.js` strips the leading `Developer ID Application: `
  before passing it on. Do not strip it in the file.
- **The keychain prompts once after a certificate change** and then never again. Click Always Allow.
- **Privacy grants are tied to the signature**, so the first build with a new certificate asks for
  Input Monitoring, Accessibility, Calendars and Automation one final time.
- **`minimumSystemVersion` is 14.2** because Chromium captures system audio through a CoreAudio tap
  from that version. A failure there is silent — you get no error and no audio.
