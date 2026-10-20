---
name: bedrock-panel-persona-pack
description: Create, edit, validate, package, or troubleshoot Bedrock Panel AI persona packs (the characters behind the AI Voice face). Use when the user wants a new persona, a *.persona.json file, an index.json persona catalog or a persona repository, help choosing a face style, colours or Piper voice, a persona prompt that works when spoken aloud, or a pack that will not import, install, or update.
---

# Bedrock Panel Persona Pack

A **persona** is who the animated face on an AI Voice page is: a name, a prompt, a Piper voice and how the face is drawn. It is **data only** (one JSON file). A **pack** is one or more persona files, optionally with an `index.json` catalog so a GitHub repository can offer them in **Settings → AI Profiles → Personas → Browse repositories…**.

Use `validate-pack.js` next to this file for every pack you write: `node validate-pack.js <file | pack folder>`. It uses the app's own schema code, then lints what bites in practice. Fix every ERROR; read every WARN.

## Contract

- One file per persona, named `<id>.persona.json`; `id` is lowercase letters, digits, `-` and `_`, up to 64 characters, unique in the user's library.
- Never put credentials in a pack (no key, token, secret, password, bearer, authorization fields). Importing refuses them. API keys stay in the user's Connections.
- Max 64 KB per file. Unknown fields are ignored.
- The persona prompt is **appended** to the page's Smart Profile, never replacing it, and is ignored on structured-output profiles (Panel Builder).
- Changing a page's persona starts a **new conversation** (the backend session restarts; the old character's history is not kept).
- Do not edit the app to add a persona. Packs are installed by the user, not built in.

## Fields

```json
{
  "id": "my-persona",
  "name": "My Persona",
  "version": 1,
  "prompt": "…how this character talks…",
  "voice": "en_US-ryan-high",
  "face": {
    "style": "kawaii",
    "color": "#7ad0ff",
    "cheekColor": "#ff9ec0",
    "eyeGap": 18,
    "dozeAfterSeconds": 60,
    "blinkMinMs": 2500,
    "blinkMaxMs": 6500,
    "emotions": { "happy": { "eyeW": 36, "eyeH": 36, "radius": 14, "lowerLid": 16 } }
  }
}
```

- `version` is the **schema** version, leave it `1`. The pack's own version lives in `index.json`.
- `voice`: a Piper voice name the user's server has (`xx_XX-name-quality`, for example `en_US-ryan-high`), or `""` for the page default. The list of real names comes from **Load available voices** in the editor. A name the server does not have makes the server refuse; the app then retries once with the page's default voice and shows a notice, so a wrong name costs a notice, not silence. A pack shares only the voice **name**, never audio.
- `face.style`: the authoritative list is `FACE_STYLES` in `app/face/persona.js` (seven at the time of writing). Today: `oled` (rounded-rect eyes, bar mouth), `cartoon` (a detached tall 2D head with fixed eyes and grin; expression only from pupils and eyebrows; the grin lights green while speaking), `kawaii` (soft round eyes, cheeks), `crt` (amber face in a retro monitor), `sprite` (a round soot body with big white eyes), `butler` (an original older human head: swept side hair, mustache, heavy brows and lids), `intern` (an angular young human head: cowlick, big glasses, headset, darting pupils). An unknown style becomes `oled`. If no style fits, a new one is renderer work in `app/face/renderer.js`, which is outside a pack.
- `face.color`: the ink of the face's features (eyes, mouth); for `sprite` it is the body colour. `cheekColor` is the blush. Both `#rrggbb` or empty for the page accent. Look at the result on a dark and a light theme.
- `face.emotions`: optional tuning for `neutral`, `happy`, `sad`, `angry`, `surprised`, `sleepy`, `thinking` (`eyeW` 4–60, `eyeH` 2–60, `radius` 0–30, `browSlant` −20–20, `lowerLid` 0–40, `upperLid` 0–40). Leave it out unless a style needs it.

Full reference: `docs/personas.md`. Starting file: `docs/personas/template.persona.json`.

## Choosing the face

Pick by the character's silhouette, not just a colour. Rough map (use only styles the checkout lists; `node -e "console.log(require('<app>/app/face/persona.js').FACE_STYLES)"` prints them):

| Character | Style |
| --- | --- |
| older, dignified human (butler, keeper, professor) | `butler` if listed, else `oled` or `cartoon` |
| friendly cartoon human | `cartoon` (fixed eyes and grin, so expression comes from brows and pupils) |
| young, energetic human | `intern` if listed, else `cartoon` or `kawaii` |
| machine, terminal, robot | `oled` or `crt` |
| cute, soft | `kawaii` |
| creature, spirit | `sprite` |

`color` is the ink of the features on `oled`, `kawaii` and `crt` and the body on `sprite`; the human-style faces (`cartoon`, `butler`, `intern`) draw their own palettes, so `color` may change little there: render it and look rather than promise a colour.

## Process

1. **Interview** the user (ask only what you cannot infer): the character in a sentence; how they talk (formal, clipped, warm); what they should never do; the face style and a colour; whether it has a voice in mind (offer to list the server's voices, which needs the app); public or private (see *Packaging*).
2. **Mind ownership.** This project's rule: built-in personas are original (original characters and generic archetypes such as a dry butler, a retro terminal or a cheerful intern); a character taken from someone else's film, show or book is a separate, named **personal pack** that is never added to the app repository's built-ins. Choosing public or private hosting does not by itself give anyone the right to distribute someone else's material, so default such a pack to local or private and let the user decide where it goes. This skill makes no legal judgement.
3. **Write the prompt** (rules below).
4. **Write the file** and run `node validate-pack.js`.
5. **Deliver what was asked.** By default stop at validated local files: the pack file, an `index.json` if a repository was asked for, and the validator output. Install into the live library, push to a repository, publish, or run live test conversations only when the user asked for that. When it was asked, import it, pick it on a page, and ask the persona three ordinary questions: replies should be short, in character, and fit to be spoken.

Voices: use the **names of existing voices** only (from the user, or verified with **Load available voices**). Training or cloning a voice is outside this skill.

## Writing the prompt

Replies are **spoken aloud** by a speaker, so:

- Say so in the prompt, and ask for **one to three short sentences**, no lists, no markdown, no emoji, nothing that cannot be said. (This is about the model's replies: the prompt itself may use bullets to organize instructions, as the built-ins do.)
- Give the character concrete habits (favourite words, how they greet, what they fixate on, what they care about) rather than adjectives.
- End with a line like "Never break character. You are not an assistant; you are <Name>."
- Do **not** write emotion tags (`[happy]`) or example replies that start with one: the app adds its own tag instruction only when the face is on, and the host strips a leading known tag, but a tag in your own examples can be read aloud. Example dialogue without tags is fine.
- Do not mention tools, camera, or a body the app does not have.
- Keep it under about 1,500 words; long prompts dilute the character and cost tokens every turn.

Skeleton:

```text
You are <Name>, <one-line identity>, now living as a face on a desk panel. You talk through a speaker. Your human is <relationship>.

Who you are:
- <trait with a concrete habit>
- <trait>
- <what they care about>

How you talk (your words are spoken aloud, so this matters most):
- Short. One to three sentences, never more.
- <verbal habits: words they like, how they address the human>
- No lists, no markdown, no emoji, nothing that cannot be spoken.
- Never break character. You are not an assistant; you are <Name>.
```

## Packaging

- **Single file:** the user imports it with **Settings → AI Profiles → Personas → Import persona…** (paste, **Choose file…**, or **From a URL** for a public https link). Or copy it into `%APPDATA%\bedrock-panel\personas` and restart.
- **Repository:** put the `*.persona.json` files and an `index.json` in one folder of a GitHub repository:

  ```json
  { "personas": [
    { "id": "my-persona", "name": "My Persona", "version": "1.0.0", "file": "my-persona.persona.json", "description": "One line shown in the catalog." }
  ] }
  ```

  `file` is a bare lowercase file name beside `index.json` (no paths, no URLs). **Bump `version`** whenever the persona changes so installs show Update. An app repository's `personas/` subfolder is searched automatically; a persona-only repository is added under **Persona repositories** in the same settings block.
- **Adding a persona-only repository:** Settings → AI Profiles → Personas → **Persona repositories** → **+ Add persona repository**, with a URL like `https://github.com/<owner>/<repo>/tree/<branch>/<folder>`; then **Browse repositories…**. Save & apply the settings first; Browse reads the saved list.
- **Public** repositories need no account. **Private** repositories work once the GitHub app is connected (Settings → Auth); use private for personal or third-party-character packs.
- Install and update never silently overwrite: anything already in the library that was not an untouched copy from the same source asks first, and Install/Update are refused while the editor has unsaved changes (Save & apply first).

## Checklist before handing a pack over

- `node validate-pack.js <pack folder>` prints `0 errors` and every warning is understood.
- No credentials, no tagged example lines, no emoji, voice name real (or empty), `version` bumped in `index.json`.
- The authored file has no `source` field (the app records source and a content hash itself when it installs from a repository; copying one in can expose a private repository URL).
- Only if installing or testing was requested: imported, picked on a page, three replies read aloud sensibly, face readable on dark and light.
- If the character belongs to someone else, the pack is a separate personal pack, not part of the app repository's built-ins, and kept local or private unless the user decides otherwise.
