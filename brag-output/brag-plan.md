# Brag Plan: sessionhub

## What is this app?
A daemon that keeps coding-agent terminals (Claude Code, Codex CLI, opencode, Oh My Pi) alive and serves them to a browser, so you can close the laptop, switch computers, or check from a phone while the agent keeps running.

## The angle
The laptop lid closes and nothing stops. The joke is the agent's indifference: it keeps streaming output while its human walks away. sessionhub is shown as what it literally is: the agent's own raw terminal in a three-pane browser UI, then the same session on a phone. No chat layer, no dashboard fluff.

## Hook (first 2-3 seconds)
A dark terminal mid-task (agent reading files, printing bullets). A laptop-lid shadow sweeps down and the frame goes black on "You closed the laptop." A beat later the terminal is still scrolling in a small glowing window: "Your agent didn't even notice."

## Key moments (the middle)
- Wordmark reveal: the sessionhub icon + "sessionhub", then the README line "keeps coding-agent terminals alive in a daemon".
- The three-pane UI builds: sidebar rows land one by one under "LIVE & TODAY", each with a live dot; terminal in the middle keeps streaming; file explorer on the right.
- Machine tab switches from "This machine" to "mac" (resume from another machine), then a phone slides in showing the same terminal with the phone key bar (Esc, ⇧Tab, arrows, ⏎). A simulated tap on Enter.
- Three facts, one card each: "Raw terminal", "No chat layer", "One binary", each with README copy underneath.

## Outro / punchline
"Close the browser." → "The agent keeps running." sessionhub wordmark with `sessionhubd start` in a terminal pill.

## User flow worth showing
1. Start the daemon, open the browser: sidebar of live sessions, agent terminal in the middle.
2. Switch machine / walk away: the session is still there on another device.
3. Phone: same terminal, key bar for Esc / Shift+Tab / arrows / Enter, tap Enter.

## Tone
- Preset: polished
- Creative direction: quiet late-night dev film where the laptop closes and the terminal doesn't
- Interpretation: dark, calm, confident; few scenes with generous holds, soft crossfades and slides, one dry joke in the hook, restrained SFX.

## Format: landscape — 1920x1080
## Duration: 21.5s

## Visual identity (from the project)
- Background: #0F1113 (dark theme `--bg`)
- Surface: #16191C, border #24282C
- Accent: #4C9A8A (`--accent`)
- Text: #D6D9DC, muted #7C858D
- Terminal colors: green #98C379, blue #61AFEF, yellow #E5C07B
- Display font: Inter (stand-in for the app's `ui-sans-serif, system-ui` stack)
- Body / terminal font: JetBrains Mono (the app's `--mono`)
- Strongest visual element: the three-pane layout from `screenshot.png` (sidebar / agent terminal / file explorer)

Session and project names in the recreated UI are fictional stand-ins (api-server, docs-site, etc.), not the names from the real screenshot.

## Share copy (draft)
I built sessionhub: close the laptop, and your coding agent keeps running. Raw terminal in the browser, resumable from any machine or your phone. One binary.

## Audio direction
- Role: cinematic support, restrained, under narration
- Music: happy-beats-business-moves-vol-12 (steady and clean; fits polished)
- Music treatment: fade in over 0.6s, ducked to 0.13 under the voiceover, lifts back to 0.32 after the last line, fades out over the final second
- Music cue guidance: bundled preset `assets/music/cues/happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json`, ~110 BPM. Strong cues to target: 9.29s (machine switch), 13.11s (first fact card), 18.56s (outro command lands). Fact cards on every other beat: 13.11 / 14.20 / 15.29. Sidebar rows may ride consecutive beats 5.34 / 6.00 / 6.56 / 7.09 since they stay on screen afterwards.
- Audio-reactive treatment: subtle; music bass makes the accent glow behind the wordmark and the terminal window breathe. No waveform/equalizer visuals.
- SFX posture: sparse, low-HF-risk files
- Audio-coupled moments: lid close (soft impact), wordmark (soft drop), machine switch (switch), phone Enter tap (click), first and last fact card (drop), outro land (soft bell)
- Restraint rule: nothing competes with the narration; no SFX on every sidebar row.

## Voiceover script
(Kokoro, voice af_heart, starts at 0.5s, 18.6s long)

> You closed the laptop. Your agent didn't even notice.
>
> This is session hub. A daemon keeps every agent terminal alive, and your browser just plugs in.
>
> Resume it from another machine. Or check in from your phone.
>
> Raw terminal. No chat layer. One binary.
>
> Close the browser. The agent keeps running.

## Storyboard

### Scene 1 — Hook — 0.0–3.5s (3.5s)
Terminal window streaming agent output (fictional task). At 0.5 a lid-shadow wipes down, screen goes black; "You closed the laptop." fades in (held to 1.9). At 2.0 a small terminal window glows back in, still printing lines; "Your agent didn't even notice." under it, held to 3.4.
Sequential/interaction: terminal lines type in one by one.
Audio intent: quiet start, soft thud on the lid close.
Audio-coupled idea: lid close → soft impact.
Transition mood: soft → Scene 2

### Scene 2 — Reveal — 3.5–5.1s (1.6s)
App icon + "sessionhub" wordmark scale up on accent glow; subline "keeps coding-agent terminals alive in a daemon".
Sequential/interaction: none
Audio intent: gentle arrival.
Audio-coupled idea: soft drop on wordmark.
Transition mood: slide → Scene 3

### Scene 3 — The app — 5.1–9.3s (4.2s)
Recreated three-pane UI: sidebar (search box, "LIVE & TODAY" with rows landing one by one), center agent terminal streaming, right file explorer. Caption: "Terminals live in a daemon. The browser just attaches."
Sequential/interaction: four sidebar rows land on beats.
Audio intent: steady, let narration carry.
Transition mood: clean → Scene 4

### Scene 4 — Anywhere — 9.3–12.9s (3.6s)
Machine tab switches "This machine" → "mac" (beat-locked 9.29). At ~10.8 a phone slides in from the right showing the same terminal and the key bar; a finger tap lands on ⏎ at ~12.0 and a new line appears.
Sequential/interaction: machine switch, simulated tap.
Audio intent: tactile.
Audio-coupled idea: switch sound on machine tab, click on tap.
Transition mood: soft → Scene 5

### Scene 5 — Three facts — 12.9–16.4s (3.5s)
Three cards on every other beat: "Raw terminal" / "Raw PTY passthrough with no prompt injection"; "No chat layer" / "The main interface is the agent's own terminal"; "One binary" / "One binary with no frontend build step". All three held together after the last lands.
Audio intent: measured.
Audio-coupled idea: drop on first and last card.
Transition mood: crossfade → Scene 6

### Scene 6 — Outro — 16.4–21.5s (5.1s)
"Close the browser." then "The agent keeps running." (terminal cursor still blinking beside it). At 18.56 the wordmark and a `sessionhubd start` pill land. Hold to end; music rises and fades.
Audio intent: resolve.
Audio-coupled idea: soft bell on the land.

**Music mood for this video:** steady, polished
**Audio summary:** a clean bed that sits under the narration, a few soft tactile hits on real actions, and a short musical lift to close.
