Kitten Cannon — drop-in app for Bedrock Panel
==========================================

A remake of the classic Kitten Cannon flash game, ported from
https://github.com/TeeJS/kitten-cannon-remake to run on the panel.

Play: aiming and firing are separate. Touch and drag anywhere to point the
barrel at your finger, or hold the round arrow buttons to sweep it; tap the
big FIRE button to launch (power oscillates on the meter, so timing matters).
The speaker button in the top-right corner mutes/unmutes all sound, on every
screen, and remembers its state. On a PC keyboard, W/S or Up/Down aim and
Space fires. Land on trampolines and TNT to keep flying; spikes end the run.
Distance in feet is your score.

Options (editor > App)
----------------------
- Initials           Your 3-letter arcade initials — scores are recorded
                     under them (uppercased, letters only; same initials =
                     same player).
- Server URL (advanced)  Base URL of the shared score server
                     (default https://scores.doofenshmirtzevil.com). Clear it
                     to play offline: high scores and the leaderboard then
                     come from this PC's localStorage only.

Score server contract
---------------------
Speaks the shared arcade score API — the authoritative spec is
community-apps/SCORE-API.md in this repo. Every call
carries the game slug ("kitten-cannon"); scores are integer feet:

  GET  <base>/get_high_score.php?game=kitten-cannon&score=<int>
       -> {"success":true,"highScore":<int>,"percentile":<0-100>,"totalScores":<int>}
  GET  <base>/get_personal_high_score.php?game=kitten-cannon&userId=<initials>
       -> {"success":true,"personalHighScore":<int|null>}
  GET  <base>/get_leaderboard.php?game=kitten-cannon&limit=8&runs=1
       -> {"success":true,"leaderboard":[{"rank":1,"userid":"TJS","score":42},...]}
       runs=1 = top individual runs, arcade style (same initials can hold
       several ranks); without it the server sends best-per-player instead.
  POST <base>/save_score.php   (FormData: userId, score, game)
       -> {"success":true,...}
       Called once per run (every death), not just on new personal bests --
       that history is what the percentile calculation needs.

The score board shows a "Top Kittens" leaderboard beside the results:
best score per player from the server, or built from this PC's local
bests when offline. CORS must be open on the server (it is, per the spec).
