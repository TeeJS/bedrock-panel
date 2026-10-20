# Personas for the AI Voice face

A persona is who the animated face on an **AI Voice** page is: a name, a prompt, and how the face looks.
Bedrock Panel ships three (**Rocky**, **Norm**, **Mimi**). Any number more can be added by importing a
small JSON file, so you never need a new build of the app to make your own.

A persona is **data only**. It cannot contain code, and it can never carry credentials: API keys stay in
your Connections.

## Add, share and remove personas

All of this is in **Settings → AI Profiles → Personas**.

- **Import:** **Import persona JSON…**, then paste the JSON or choose a `*.persona.json` file. The file is checked
  first and its name and id are shown; a file that fails shows the reason and nothing is changed.
- **Drop in:** copy files into the `personas` folder inside the Bedrock Panel data folder
  (`%APPDATA%\bedrock-panel\personas`) and restart. Same checks. A dropped-in file is only added when its id
  is not already in your library, so it never overwrites a persona you have edited. Files that fail the
  checks are skipped and the reason is written to the log.
- **Export:** each persona row has **Export**, which copies the JSON and shows it on screen, and
  **Export file…**, which saves `<id>.persona.json`.
- **Same id as an existing persona:** you are asked whether to replace it. Nothing is replaced silently.
- **Edit or remove:** the built-in personas are in your library like any other, so you can edit or remove
  them; removing one does not bring it back on update.
- **Share:** a persona is one small text file. Put it in a GitHub repo or gist, or send it as is.

## Make your own

1. Copy [`personas/template.persona.json`](personas/template.persona.json) and rename it `<id>.persona.json`.
2. Edit it (fields below), then import it (or paste it into **Import persona JSON…**).

| Field | Meaning |
|---|---|
| `id` | Letters, digits, `-` and `_`, up to 64 characters. Stored lowercase. Required. |
| `name` | Shown in the pickers (max 80 characters). |
| `version` | Schema version. Leave at `1`. |
| `prompt` | The personality. **Appended** to the page's Smart Profile, never replacing it (max 20,000 characters). |
| `voice` | Reserved for a per-persona Piper voice. Leave empty. |
| `face.style` | `oled` (rounded-rect eyes, bar mouth), `cartoon` (round eyes with pupils, wide grin) or `kawaii` (soft sparkling eyes, cheeks). |
| `face.color` / `face.cheekColor` | `#rrggbb`, or empty to use the page accent. |
| `face.eyeGap` | 0–60 (virtual pixels between the eyes). |
| `face.dozeAfterSeconds` | Seconds of inactivity before the face falls asleep; 0 = never. |
| `face.blinkMinMs` / `face.blinkMaxMs` | 300–60000. If min is larger than max they are swapped. |
| `face.emotions` | Optional per-emotion tuning for `neutral`, `happy`, `sad`, `angry`, `surprised`, `sleepy`, `thinking`. Each takes `eyeW` 4–60, `eyeH` 2–60, `radius` 0–30, `browSlant` −20–20, `lowerLid` 0–40, `upperLid` 0–40. Anything left out falls back to the built-in preset. |

### Writing the prompt

- Your words are **spoken aloud**: keep replies to one to three sentences, no lists, markdown or emoji.
- Do **not** write emotion tags such as `[happy]` or example lines that start with one. The app adds the
  tag instruction itself, only when the face is on; a tag in your own prompt could be read aloud when
  the face is off.
- Do not put keys, tokens or passwords anywhere in the file. Any field whose name looks like a credential
  makes the import fail.
- The persona prompt is ignored on pages using a structured-output profile (for example Panel Builder).

### Limits

A persona file is limited to 64 KB. Unknown fields are ignored. Files that are not valid JSON, have no
usable `id`, or contain credential-like keys are refused.
