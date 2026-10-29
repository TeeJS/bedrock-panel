# Personas for the AI Voice face

A persona is who the animated face on an **AI Voice** page is: a name, a prompt, and how the face looks.
Bedrock Panel ships a starter set (**Mimi**, **Jarvis**, **CRT Terminal**, **Startup Intern** and **Pixie** (a dust sprite)); characters that belong to someone else are not built in and come as packs instead (see the [persona packs repository](https://github.com/TeeJS/bedrock-personas), currently private: clone it and use **Choose file…** or the personas folder, since **From a URL** fetches only public links). Any number more can be added by importing a
small JSON file, so you never need a new build of the app to make your own.

A persona is **data only**. It cannot contain code, and it can never carry credentials: API keys stay in
your Connections.

## Add, share and remove personas

All of this is in **Settings → AI Profiles → Personas**.

- **Import:** **Import persona…**, then paste the JSON or choose a `*.persona.json` file. The file is checked
  first and its name and id are shown; a file that fails shows the reason and nothing is changed.
- **Import from a URL:** in the **Import persona…** box, paste a link into **From a URL** and click **Fetch**. It
  fetches a persona someone hosts online, for example a raw file in a GitHub repo or a gist, and shows its
  name and id in the box; nothing is added until you click **Add to library**, and the usual replace prompt
  applies. The link must be `https://`, must not contain a user name or password, and must not point at your own
  machine or local network (for a file there, paste it or choose the file instead). The whole download has 15
  seconds, follows at most 3 redirects (each one is checked again), is limited to 64 KB, and is validated exactly
  like a pasted file. Limit: a public name that secretly points at a private address after the check is not
  detected, but the downloaded text is only ever read as a persona and never run.
- **Drop in:** copy `*.persona.json` files into the `personas` folder of the Bedrock Panel data folder
  (`%APPDATA%\bedrock-panel\personas`) and restart. They get the same checks; a file is only added when its
  id is not already in your library, so it never overwrites a persona you have edited. Files that fail
  are skipped and the reason is written to the log.
- **Export:** each persona row has **Export**, which copies the JSON and shows it on screen, and
  **Export file…**, which saves `<id>.persona.json`.
- **Same id as an existing persona:** you are asked whether to replace it. Nothing is replaced silently.
- **Edit or remove:** the built-in personas are in your library like any other, so you can edit or remove
  them; removing one does not bring it back on update.
- **Share:** a persona is one small text file. Put it in a GitHub repo or gist, or send it as is.

## Make your own

1. Copy [`personas/template.persona.json`](personas/template.persona.json) and rename it `<id>.persona.json`.
2. Edit it (fields below), then import it (or paste it into **Import persona…**).

| Field | Meaning |
|---|---|
| `id` | Letters, digits, `-` and `_`, up to 64 characters. Stored lowercase. Required. |
| `name` | Shown in the pickers (max 80 characters). |
| `version` | Schema version. Leave at `1`. |
| `prompt` | The personality. **Appended** to the page's Smart Profile, never replacing it (max 20,000 characters). |
| `voice` | The Piper voice this persona speaks with, for example `en_US-ryan-high`. Empty = use the page's default voice. See *Voices* below. |
| `wakeName` | The spoken name a page with the **wake word** on listens for, as "hey *wakeName*" (letters, digits, spaces; max 40 characters). Left out, it is the persona's `name` ("Rocky" wakes to "Hey Rocky"); set it when the name is awkward to say. See *Wake word* in [ai-voice.md](ai-voice.md). |
| `aliases` | Up to 10 other full phrases that also wake the page, for example `["okay jarvis", "hi jarvis"]`. Useful when the STT server keeps writing the name a particular way. |
| `face.style` | The drawing style: `oled` (rounded-rect eyes, bar mouth), `cartoon` (a detached, tall 2D cartoon head: outlined flat colours, with eyes and grin that are fixed shapes; it never blinks, closes its eyes or moves its jaw, expressing emotion with its pupils and eyebrows only, and the grin lights up green while it speaks), `kawaii` (soft sparkling eyes, cheeks), `crt` (amber phosphor face in a retro monitor bezel) or `sprite` (a round soot body with two big white eyes). An unknown value becomes `oled`. |
| `face.color` / `face.cheekColor` | `#rrggbb`, or empty to use the page accent. `color` is the ink of the face's features (eyes, mouth); for the `sprite` style it is the colour of the round body instead (its eyes stay white). `cheekColor` is the blush. |
| `face.eyeGap` | 0–60 (virtual pixels between the eyes). |
| `face.dozeAfterSeconds` | Seconds of inactivity before the face falls asleep; 0 = never. |
| `face.blinkMinMs` / `face.blinkMaxMs` | 300–60000. If min is larger than max they are swapped. |
| `face.emotions` | Optional per-emotion tuning for `neutral`, `happy`, `sad`, `angry`, `surprised`, `sleepy`, `thinking`. Each takes `eyeW` 4–60, `eyeH` 2–60, `radius` 0–30, `browSlant` −20–20, `lowerLid` 0–40, `upperLid` 0–40. Anything left out falls back to the built-in preset. |

### Voices

Each persona row has a **Voice** field. Leave it blank and the persona uses whatever voice the page's
text-to-speech server is set to. To give a persona its own voice, type a Piper voice name, or click
**Load available voices** (one button above the list) to fill the field's suggestions from the
text-to-speech server in **Settings → TTS/STT**.

- The built-in personas name stock Piper voices (for example Jarvis uses `en_GB-alan-medium`).
- Some Piper voices hold several speakers (`en_GB-semaine-medium` has prudence, spike, obadiah and poppy;
  `en_US-libritts_r-medium` has hundreds, listed on the [Piper samples page](https://rhasspy.github.io/piper-samples/)).
  Add the speaker after a `#`: `en_GB-semaine-medium#poppy`, or its number, `en_GB-semaine-medium#3`. The plain
  name plays the first speaker. **Load available voices** lists every speaker as its own `name#speaker`
  entry. A misspelled speaker is not an error on the server: Piper quietly uses the first speaker, so pick
  from the list where you can.
- The names must be voices your Piper server has. The server itself does **not** substitute its default voice
  for a name it does not know: it may try to download it or refuse the request. So when the server rejects a
  persona's voice before any audio has played, Bedrock Panel asks once more with the page's default voice and
  shows a notice that the voice is not available; the reply is still spoken. Once audio has started, a failure
  is never retried (nothing is spoken twice). Prefer picking from **Load available voices**.
- A page can override the text-to-speech server in its Advanced settings. The list shows the app-wide
  server's voices; a page that points elsewhere may offer different ones.
- Loading voices never chooses one for you and never blocks Save; if the server cannot be reached you can
  still type the name.
- Sharing a persona shares its voice *name* only. If the receiver does not have that voice, they hear their
  page's default voice (and the notice above).

### Writing the prompt

- Your words are **spoken aloud**: keep replies to one to three sentences, no lists, markdown or emoji.
- Do **not** write emotion tags such as `[happy]` or example lines that start with one. The app adds the
  tag instruction itself, only when the face is on. (If a reply does start with a known tag, the app
  removes it before it is spoken or shown, whenever a persona is picked.)
- Do not put keys, tokens or passwords anywhere in the file. Any field whose name looks like a credential
  makes the import fail.
- The persona prompt is ignored on pages using a structured-output profile (for example Panel Builder).

### Limits

A persona file is limited to 64 KB. Unknown fields are ignored. Files that are not valid JSON, have no
usable `id`, or contain credential-like keys are refused.

## Persona repositories

Personas can be installed and updated from GitHub repositories, the same way drop-in apps are:

- **Sources.** Every app repository (Settings → Drop-in apps) is also searched for a `personas/` folder
  that holds an `index.json` and the `<id>.persona.json` files. Persona-only repositories can be added under
  Settings → AI Profiles → Personas → **Persona repositories**. Only `github.com` repositories are accepted.
- **Private repositories** work once the GitHub app is connected (Settings → Auth): the catalog and the
  files are read through GitHub's API with that connection. Public repositories need no account.
- **Browse repositories…** lists every source with Install, Update (the catalog's version is newer than
  the one you installed) or Installed. A persona you wrote or imported by hand is never replaced without
  asking. **Check for updates** compares everything installed from a repository with its catalog.
- Each installed file is validated exactly like a pasted persona (size, shape, no credentials). Nothing in
  a persona repository is ever executed.

The catalog is a small JSON file:

```json
{
  "personas": [
    { "id": "rocky", "name": "Rocky", "version": "1.0.0", "file": "rocky.persona.json", "description": "…" }
  ]
}
```

`file` is a bare file name beside `index.json`; bump `version` when you change a persona so installs can be
updated.

## Making a persona with Claude

The [`bedrock-panel-persona-pack`](../community-apps/skills/bedrock-panel-persona-pack/SKILL.md) skill in
`community-apps/skills/` guides Claude through writing a persona: the interview, a prompt that works when
spoken aloud, the face style, colours and Piper voice, an `index.json` catalog for a repository, and a
validator (`validate-pack.js`) you can also run by hand: `node community-apps/skills/bedrock-panel-persona-pack/validate-pack.js <file or folder>`.
Copy the skill folder into your project's `.claude/skills/` folder (or invoke it with `/skill`) and ask for a new persona.
