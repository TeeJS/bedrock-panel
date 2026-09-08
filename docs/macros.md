# Macros & keystrokes

Two tile types turn Bedrock Panel into a keyboard macro pad. Both run on your PC via the
bundled keystroke backend (`@jitsi/robotjs`) — no extra software required for the basics.

## Send keystroke

A one-shot **key combo** sent to whatever window is focused on your PC. Set a tile's
**Type → Send keystroke**, then either type the combo (e.g. `control+shift+esc`) or click
**Record** and press the keys.

- Modifiers: `control` (`ctrl`), `shift`, `alt`, `win` (`cmd`/`command`).
- Keys: letters/digits, `enter`, `escape`, `tab`, `space`, `backspace`, `delete`, arrows
  (`up`/`down`/`left`/`right`), `home`/`end`, `pageup`/`pagedown`, `f1`–`f12`, and media keys.
- Examples: `alt+F4`, `win+l`, `control+shift+t`, `f5`.

## Macro (steps)

An ordered list of **steps** run top to bottom on tap. Set **Type → Macro / Steps**, then
**+ add step**. Step kinds:

| Kind | Does |
|---|---|
| **Keystroke** | Send a key combo (same as above; ⌨ records it) |
| **Type text** | Type literal text into the active window (doesn't touch the clipboard) |
| **Delay (ms)** | Wait before the next step (0–60000 ms) |
| **App / Program** | Launch a program (Browse to pick) |
| **Open file/folder** | Open a file or folder |
| **Website (URL)** | Open a URL in your default browser |
| **Shell command** | Run a shell command |
| **Go to page** | Switch the panel to another page |
| **System** | `lock` / `mic` / `monitor` / `config` |
| **AutoHotkey** | Run an AutoHotkey script — see below |

Steps run sequentially; a long macro won't overlap itself if you tap again mid-run.

Example — open Notepad and write a note: `App: notepad` → `Delay: 2000` →
`Type text: Meeting notes` → `Keystroke: control+s`.

> **Launch-then-type timing:** keystroke/text steps go to whatever window currently has
> focus, so after an **App** step you need a **Delay** long enough for the app to open and
> take focus before you type. Cold starts are slowest (Windows 11's Notepad is a slow-to-launch
> Store app — give it ~2000–2500 ms); a snappier app needs less.

## AutoHotkey steps (optional, Windows)

For automation beyond keystrokes (window targeting, remapping, logic), an **AutoHotkey**
step runs an [AutoHotkey v2](https://www.autohotkey.com/) script. Bedrock Panel only *runs* an
installed `AutoHotkey.exe` (it doesn't bundle it), so install AutoHotkey v2 first.

- **Value** = a path to a `.ahk` file (Browse to pick), **or** a short inline v2 snippet
  (e.g. `MsgBox "hi"`) that's written to a temp script and run.
- Bedrock Panel auto-detects `AutoHotkey.exe` from the standard install locations and your PATH.
- An AutoHotkey (or Shell command) step runs arbitrary code — only use scripts you trust.
