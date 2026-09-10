# oMLX Monitor

A Bedrock Panel drop-in that watches one or more [oMLX](https://omlx.ai) servers — the MLX inference
server for Apple silicon — on the 1920×480 panel. Built for arm's-length reading: the numbers you
look at most are the biggest things on the screen, and nothing moves around when work starts or the
server drops.

## What the panel shows

Three columns; with a single server the **Models** column runs the full height of the panel and the
header keeps to the two outer columns (with two or three servers the header spans the middle so the
server tabs have room):

- **Header** — the server (tabs when more than one is configured), the connection state
  (Connecting · Starting · Connected · Stale · Offline) with how long ago the last good answer came,
  and a **Details** button (server, version, uptime, chip, unified memory, GPU cores, access level,
  last error).
- **Left** — **Model memory** used against its ceiling with the memory-pressure level, and the
  **Server average** throughput: generation and prefill tokens per second as oMLX reports them
  (averages over the server's session, not the last request).
- **Middle** — **Models**: loaded models first with a one-word state (Loading · Generating ·
  Prefilling · Busy · Waiting · Idle · Unloading, or plain Loaded when only the status endpoint is
  readable), the live detail (requests, tok/s, time left, unload countdown), size, Pinned/Default,
  and the action button; then **Available** models with Load. Every row has an **i** button that
  opens the model's Details: the full identifier, its state, and — after a failed Load or Unload — the
  complete error text with a Dismiss button.
- **Right** — **Activity**: what is running right now (each generating request with its live tok/s
  and generated tokens, prefilling requests, and queued requests with their position), or a plain
  Idle / Loading / No model loaded state; below it **Session totals**: requests, cache efficiency,
  prompt tokens, generated tokens.

Load and Unload are one tap plus a confirming tap (**Confirm load** / **Confirm unload**, four
seconds to confirm). While a command is in flight the button says Loading… / Unloading… and stays
that way until the next poll confirms the result. A failed command shows its error in the row; tap
it to dismiss, or open the row's Details for the full text.

When a server stops answering, the header says **Stale** (after 45 s without a good answer) and then
**Offline** once a request fails; the last good numbers stay on screen marked **Last known**, and
the Load / Unload buttons are hidden until the server is back. Polling never rebuilds the screen: a
focused button, a scrolled list, and an open Details dialog all survive a refresh.

## Setup

1. Install from **Settings → Drop-In Apps → Browse** and add an *oMLX Monitor* page.
2. In the page's options set the **Server URL** (the dashboard address without `/admin`, e.g.
   `http://127.0.0.1:8000`) and the **API key** — the server's main key from its Admin → Settings.
   **Add another server** reveals the next one; up to three, each a tab named after its host.
3. Save. The page polls every 15 s (and right after a Load / Unload).

The main API key unlocks the admin data (per-model activity, memory pressure, the model list, Load /
Unload). A sub key only reads oMLX's public status endpoint: the page then says **Activity details
unavailable**, keeps the server-wide active/waiting counts and the loaded model names (marked Loaded,
never Idle, because per-model activity is unknown), and hides Load / Unload.

Keys are `serverOnly` options: they stay in Bedrock Panel's host process and never reach the page.
The server module contacts only the URLs you configured.

## Knob

Rotate switches servers when more than one is configured, otherwise scrolls the model list; press
refreshes. While a Details dialog is open the knob works the dialog instead: rotate scrolls it, press
closes it. Escape and the Close button also close it.
