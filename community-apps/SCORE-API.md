# Community score server — shared high scores for your game

A free hosted high-score API used by the **kitten-cannon** and **quake-bird** community
apps. Community game authors are **welcome and explicitly permitted** to use it in their
own Bedrock Panel drop-in games.

- **Server URL:** `https://scores.doofenshmirtzevil.com`
- CORS is open, responses are JSON, no auth or API key. Plain `fetch` works from any
  origin; use `FormData` for POSTs (no preflight needed).
- Hosted as-is, no warranty or uptime promise; abusive traffic may be blocked and data may
  occasionally be reset. Prefer self-hosting? The server is open source (Docker Compose,
  PHP + MariaDB): [TeeJS/kitten-cannon-remake — `server/`](https://github.com/TeeJS/kitten-cannon-remake/tree/master/server).

## Conventions your game must follow

1. **`game` slug** — pick a unique one per game (`a-z`, `0-9`, `_`, `-`, max 32 chars;
   e.g. `quake-bird`). Send it on **every** call — scores from all games share one
   database, and the slug is what keeps your leaderboard separate.
2. **`userId` — player initials.** 1–3 letters, `A-Z`. The server normalizes whatever it
   receives: uppercases, strips non-letters, crops to the first 3 (`t2j.s!` → `TJS`), and
   rejects ids with no letters. Build your settings UI to collect up-to-3 letters so what
   the player types is what appears. Same initials = same player (arcade-style; collisions
   are accepted).
3. **Make the Server URL a user-editable app option** defaulting to the URL above, so
   players can point at a self-hosted instance. Player initials should be an app option
   too. Don't hardcode either in game logic.
4. Scores are **integers**, clamped server-side to 0–100000. Send whatever unit your game
   scores in, consistently.

## Endpoints

### Save a score (call at game over / new personal best)
```
POST /save_score.php          (FormData: userId, score, game)
→ {"success":true,"message":"Score saved successfully"}
```

### Global high score + percentile
```
GET /get_high_score.php?game=<slug>&score=<currentScore>
→ {"success":true,"highScore":310,"percentile":50,"totalScores":2}
```
`score` is optional; when sent, `percentile` = % of all recorded scores this run beat
(100 if it's the new high).

### Personal best
```
GET /get_personal_high_score.php?game=<slug>&userId=<initials>
→ {"success":true,"personalHighScore":310}
```
`personalHighScore` is `null` if the player has no scores yet — handle that.

### Leaderboard
```
GET /get_leaderboard.php?game=<slug>&limit=10      (limit optional, default 10, max 100)
→ {"success":true,"game":"quake-bird","leaderboard":[{"rank":1,"userid":"TJS","score":42}]}
```
Default is **best score per player** (one row per initials). Add **`&runs=1`** for arcade
style — the top individual runs, where the same initials can hold several ranks. Prefer
`runs=1` for on-screen leaderboards so the board fills up even with few players.

### Health
```
GET /health.php  → ok
```

## Error handling

- Bad `game` or `userId` → `{"success":false,"message":"..."}` (HTTP 400 for bad game).
  Always check `success`.
- Server down → HTTP 500 or network error. **Degrade gracefully** — play offline and skip
  the scoreboard; never block gameplay on the API.
- Be polite: rate-limit your fetches (the reference games use one high-score fetch per
  2 seconds) and only save on game over or a new personal best.

## Reference clients

The [`kitten-cannon`](kitten-cannon) and [`quake-bird`](quake-bird) apps in this folder
show working integrations, including the Server URL / initials app options.
