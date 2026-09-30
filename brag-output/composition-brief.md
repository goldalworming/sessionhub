# Hyperframes Composition Brief: sessionhub

## Objective
Create a short launch-style brag video for sessionhub, with narration (`--voice`).

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 21.5 seconds

## Source Material
- Project root: repository root (sessionhub)
- Primary files read: README.md, web/index.html, web/app.css, web/keybar.js, screenshot.png, web/icon-192.png
- Product name: sessionhub
- Tagline / strongest claim: "Close the browser, switch computers, or check from a phone; the agent keeps running."
- Key UI moment to recreate: the three-pane layout (sidebar with LIVE & TODAY sessions, agent terminal, file explorer) and the phone key bar
- Copy that must appear verbatim:
  - keeps coding-agent terminals alive in a daemon
  - Raw PTY passthrough with no prompt injection
  - the main interface is the agent's own terminal
  - One binary with no frontend build step
  - sessionhubd start

## Creative Direction
- Tone preset: polished
- Creative direction: quiet late-night dev film where the browser closes and the terminal doesn't
- Interpretation: dark, calm; soft crossfades and slides; generous holds; one dry joke in the hook
- Angle: the browser closes and the agent keeps working; show the real terminal UI, then the same session on a phone
- Hook: cursor closes the browser tab → black → "You closed the browser." → terminal still streaming in sessionhubd → "Your agent didn't even notice."
- Outro / punchline: "Close the browser." / "The agent keeps running." + wordmark + `sessionhubd start`
- Avoid: generic SaaS language, abstract filler, redesigning the app

## Visual Identity
- Background: #0F1113; surface #16191C; border #24282C
- Text: #D6D9DC; muted #7C858D
- Accent: #4C9A8A
- Display font: Inter (local woff2)
- Body font: JetBrains Mono (local woff2)
- Visual references: screenshot.png layout, app icon

## Storyboard
Use the storyboard in `brag-output/brag-plan.md`.

1. Hook — 3.5s — browser tab closes, "You closed the browser." / "Your agent didn't even notice."
2. Reveal — 1.6s — icon + wordmark + verbatim README line
3. The app — 4.2s — three-pane UI, sidebar rows land one by one
4. Anywhere — 3.6s — machine tab switch, phone with key bar, tap ⏎
5. Three facts — 3.5s — Raw terminal / No chat layer / One binary
6. Outro — 5.1s — closing lines, wordmark, `sessionhubd start`

## Audio
- Audio role: cinematic support under narration
- Music: `assets/music/happy-beats-business-moves-vol-12-by-ende-dot-app.mp3`, base 0.32, ducked to 0.13 while the voiceover plays (0.5–19.3s), fade out over the final second
- Voiceover: `assets/voiceover.wav` (Kokoro af_heart), starts at 0.5s, volume 1
- Music cue guidance: bundled preset (vol-12, ~110 BPM). Beat-locks: 9.29 machine switch, 13.11 first fact card, 18.56 outro land. Fact cards at 13.11 / 14.20 / 15.29 (every other beat).
- Audio-reactive treatment: subtle; bass drives the accent glow behind the wordmark / terminal. Data: `assets/audio-data.js` (extracted with hyperframes-creative `extract-audio-data.py`, 30fps, 8 bands).
- SFX: click_003 + impactSoft_medium_001 (tab close), drop_001 (wordmark, first card), switch7 (machine tab), click_003 (tap), drop_002 (last card), impactBell_heavy_000 (outro, soft)

## Hyperframes Instructions
Follow hyperframes-core / animation / creative / cli. Run `hyperframes check` before render. Local creation and render only.
