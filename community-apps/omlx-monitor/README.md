# oMLX Monitor

A Bedrock Panel drop-in that watches one or more [oMLX](https://omlx.ai) servers — the MLX inference
server for Apple silicon — on the 1920×480 panel: model memory against its ceiling with the memory
pressure level, loaded models with what they are doing (requests generating with tokens per second,
waiting, prefilling, loading progress, idle time until unload), the models available to load, requests
in flight, session totals, and average throughput. Load and Unload are one tap plus a confirming tap.

## Setup

1. Install from **Settings → Drop-In Apps → Browse** and add an *oMLX Monitor* page.
2. In the page's options set the **Server URL** (the dashboard address without `/admin`, e.g.
   `http://127.0.0.1:8000`) and the **API key** — the server's main key from its Admin → Settings.
   **Add another server** reveals the next one; up to three, each a tab named after its host.
3. Save. The page polls every 2 s.

The main API key unlocks the admin data (per-model activity, memory pressure, the model list, Load /
Unload). A sub key only reads oMLX's public status endpoint; the page says so and shows the basics.

Keys are `serverOnly` options: they stay in Bedrock Panel's host process and never reach the page.
The server module contacts only the URLs you configured.

## Knob

Rotate switches servers when more than one is configured, otherwise scrolls the model list; press
refreshes.
