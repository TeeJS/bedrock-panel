# Community drop-in apps

How to **install** a community drop-in app, and how to **submit** your own. The apps are
served from a GitHub **app repository** — the [`community-apps/`](../community-apps) folder —
that Bedrock Panel browses and installs from directly. This page is the documentation; that
folder is the catalog.

## Installing one

1. In Bedrock Panel: **Settings → Drop-In Apps**. The default app repository points at this
   `community-apps/` folder; **Browse…** lists every app in it.
2. Click **Install** on the app you want. If it bundles executable code you'll be asked to
   confirm you trust the repository first.

To install from your own fork instead, change the repository URL to your
`github.com/<owner>/<repo>/tree/<branch>/<path>` folder (only GitHub repositories are
supported). Installed apps land in your user-data folder (`%APPDATA%\open-quake\apps` by
default), so they survive app updates, and **Check for updates** compares each against its
repository. See [Apps & drop-ins](apps.md) for the full manager.

## Submitting one

Open a pull request that adds **both**:

- `community-apps/<your-app-id>/` — your app's source folder (an `app.json` or
  `manifest.json` manifest plus its files), so others can review the code; and
- `community-apps/<your-app-id>.zip` — the same folder zipped, which the panel downloads
  on install. Run `node tools/build-community-index.js` to regenerate `index.json`, and
  commit the zip + index together.

Rules:

- `id` must be unique and lowercase — letters, digits, `_`, `-`.
- Say what the app does, and whether it needs a `server` module or `proxy`, in the PR.
- No "Demo data" / mock-mode options — apps show real data or an honest empty/error state.
- See [`docs/app-template/`](app-template) for a minimal starting point and
  [Apps & drop-ins](apps.md) for the manifest schema.

## ⚠️ Safety

Community apps are **submitted by others and not vetted by the maintainers**. A drop-in app
can ship a **server module** or bundled programs that run on your PC with full access —
Bedrock Panel warns you on import when it does. **Only install apps from sources you trust, and
review the source folder before importing.**
