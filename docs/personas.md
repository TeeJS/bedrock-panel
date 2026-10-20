# Personas for the AI Voice face

A persona is who the animated face on an **AI Voice** page is: a name, a prompt, and how the face looks.
Bedrock Panel ships a starter set (**Rocky**, **Norm**, **Mimi**, **Jarvis**, **CRT Terminal**, **Startup Intern** and **Dust Sprite**). Any number more can be added by importing a
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
| `face.style` | The drawing style: `oled` (rounded-rect eyes, bar mouth), `cartoon` (round eyes with pupils, wide grin), `kawaii` (soft sparkling eyes, cheeks), `crt` (amber phosphor face in a retro monitor bezel) or `sprite` (a round soot body with two big white eyes). An unknown value becomes `oled`. |
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

- The built-in personas name stock Piper voices (for example Rocky uses `en_US-joe-medium`).
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
