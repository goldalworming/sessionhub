# sessionhub

<img src="icon.png" alt="" width="96" />

One place to open a terminal into a coding agent (Claude Code, opencode, pi) for each project. The session stays alive even when the UI is closed. You can pick it up from another computer through a browser. Several computers at once can be used from a single window, each in its own tab — see [CONFIG.md](CONFIG.md#many-machines-in-one-window).

No chat UI, no diff viewer, no worktree manager. Only a project/session sidebar on the left and a terminal in the middle.

There is one principle: **the UI and the engine are two different processes.** The agent process is never a child of a window or a tab. Closing the browser does not touch the agent process at all.

![The three panes: projects and sessions on the left, an agent running in the middle, the file explorer and an image open on the right](screenshot.png)

## Why

I run coding agents all day. I mostly use Claude Code, sometimes opencode. Two things kept hurting:

1. **The session died with the window.** An agent that worked for an hour was gone because a laptop lid closed or a browser tab closed.
2. **The real work does not stay at the desk.** Half the time I check on an agent from a phone, through a tunnel, on a screen with no Esc, no arrows, no clipboard, and no way to scroll back.

sessionhub is the smallest thing that fixes both: a daemon that owns the PTYs, and a plain browser page that only *looks at* them. Everything else in this repo follows from that split.

### How it differs from T3 Code

[T3 Code](https://betterstack.com/community/guides/ai/t3-code/) is a good control plane, and a fuller product than this one. It is a **chat/task UI first**, with the terminal as a drawer at the bottom — a coherent shape, and the right one if you want your agent work organised as tasks. sessionhub takes the opposite bet, so three things come out differently:

- **The terminal is the whole surface.** The agent's own TUI — its prompts, its modes, its Shift+Tab cycling — is the interface I already know, so sessionhub passes PTY bytes through unchanged and shows nothing of its own. T3 Code gives you a curated view instead, which is what lets it surface task state that a raw PTY cannot.
- **Nothing sits between you and the agent.** A task harness earns its features by wrapping each thread in its own scaffolding, and that scaffolding travels with every request. sessionhub injects **nothing** — what the agent reads is exactly what you typed — which is the same reason it can offer none of what that scaffolding buys.
- **A different session registry.** T3 Code keeps its own task history, consistent with its task model. sessionhub's sidebar *is* the CLI's on-disk registry — `~/.claude`, `~/.pi`, the opencode store — so every session your agents ever made is one click from `--resume`, with its full context, whether or not it was born inside sessionhub.

If you want tasks, structure, and a history the app manages for you, T3 Code is the more complete answer. sessionhub only makes sense if the agent's raw terminal is the thing you actually want to reach.

### How it differs from herdr

[herdr](https://herdr.dev/) is the closest cousin. It also keeps agent sessions alive behind a client. Its agent-state sidebar is excellent. This repo borrowed the idea: busy/finished colours and a finish chime are built in. The difference is **where you can be when you use it**:

- herdr is a terminal-native TUI you attach to, remote via SSH. From a phone that means an SSH client, a real keyboard emulator, and no images.
- sessionhub is a **browser page**. From a phone through the tunnel you get a key bar (Esc, Tab, ⇧Tab, Ctrl, arrows), a **Paste** button (the clipboard API needs a browser), an **Img** button that uploads a photo and types its path at the agent, touch scrollback, and tabs for every paired machine — with each remote machine's token staying on the daemon, never in the browser.

If you live in tmux and SSH, herdr is probably the better fit. If your second screen is a phone, that is exactly the case sessionhub was built around.

### Feature comparison

As I found them in **August 2026**. All three projects move fast, so file an issue if a cell has gone stale — one already was: this table used to claim T3 Code had no multi-machine view, which is wrong, and it is a good feature there.

| | sessionhub | T3 Code | herdr |
|---|---|---|---|
| Primary interface | the agent's own terminal, in a browser | task/chat UI, terminal drawer | terminal TUI (tmux-like) |
| Sessions survive the UI closing | yes — daemon owns the PTY | yes (app-managed tasks) | yes — server/client split |
| Resumes the CLI's own on-disk sessions | yes (`~/.claude`, `~/.pi`, opencode) | own task history | attaches to its own panes |
| Prompt/token overhead added | none — raw PTY passthrough | task harness around each thread | none — raw terminal |
| Phone support | key bar, clipboard Paste, image upload, touch scrollback | browser UI (desktop-shaped) | via SSH client apps |
| Several machines in one window | yes — tabs via daemon relay; remote tokens never reach the browser | yes | SSH per machine |
| Agent activity signal | busy/finished colours + finish chime | task status in UI | blocked/working/done/idle sidebar |
| Install | one binary, no npm, no build step | desktop/web app | one Rust binary |

## Features

- Sessions survive the UI closing — the daemon owns the PTY
- Resumes the CLI's own sessions (`~/.claude`, `~/.pi`, opencode)
- Raw PTY passthrough — nothing injected into your prompts
- Saved terminals: name a shell and the line it runs, and it comes up with the daemon
- Tab colours, stored on the daemon so every device sees them
- Several machines in one window, remote tokens never reach the browser
- Phone: key bar, Paste, image upload, touch scrollback
- Tabs or grid, and drag a tab to reorder it
- File panel with Monaco
- Drag or paste a file — it uploads to the agent's machine
- Fork a session
- Busy/finished colours, a finish chime, and a notice saying which terminal on which machine — click it to go there
- RAM per terminal, whole process tree
- Self-update from Settings
- Give a port a way in from outside, through Cloudflare
- Search across projects, session titles and parent folders
- One binary — no npm, no build step

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+K` | command palette |
| `Ctrl/Cmd+B` | hide/show the sidebar |
| `Ctrl/Cmd+1..9` | switch to the nth terminal |
| `Ctrl/Cmd+W` | close the tab; the terminal keeps running |
| `Ctrl/Cmd+Shift+W` | kill the terminal, with confirmation |

Every other key goes to the agent untouched. Saved terminals start with the
daemon, before any browser connects — turn that off per terminal on its sidebar
row. Still not a supervisor: it starts each one once, and nothing restarts one
that ends.

## Install

Download the binary for your machine from
[Releases](https://github.com/goldalworming/sessionhub/releases/latest), and run
it. One file — the interface is inside it. On macOS there is a `.app` for
Applications; it is unsigned, so open it the first time with right-click → Open.

To build it yourself instead: stable Rust, `cargo build --release`, and nothing
else. The frontend has no build step.

## Run

Double-click it, or:

```
sessionhubd start          # detaches from this terminal, then exits
sessionhubd status         # port, uptime, number of live terminals
sessionhubd stop
sessionhubd restart        # stop and start again, to load a new build
```

`start` prints the address with the token and opens it:

```
http://127.0.0.1:7717/?token=…
```

Open it once with the token; a cookie carries it after that, once per device.
Running `start` again when it is already up prints the address and opens it
again — the shortest way back to a link you lost. `--no-open` skips the browser.

It leaves an icon in the notification area, or the menu bar on macOS: the port,
how many terminals are live, the address to copy, the log, and a way to stop it
that first says how many terminals go with it. `--no-tray` skips it.

Closing the terminal you started it from does nothing to it. That is the whole
reason this project exists.

`restart` **ends every live terminal** — they are children of the daemon — so it
refuses while any are running unless told `--force`.

## Access from outside

**⚙ Settings → Cloudflare.** Give an address a way in — a dev server here, or
something on your network that cannot run a tunnel of its own — and it comes
back as a hostname you can open from anywhere. With a Cloudflare API token the
names are yours and stay put; without one they are throwaway and change each
time. What is behind them stays behind the sessionhub token.

**⚙ Settings → Network access** opens the daemon itself to the LAN, and
`sessionhubd tunnel` puts it on the internet.

> **This exposes a shell.** Anyone with the address and the token can run any
> command on that computer, as you. Put **Cloudflare Access** in front of it if
> it is more than a moment, and run `sessionhubd token rotate` if a URL leaked.

How it fits together, from a phone inward: [ACCESS.md](ACCESS.md).

## Known limits

- The history kept is the last 2 MB per terminal. It is lost when the daemon stops. It is a ring buffer, not terminal grid state.
- A client that is too slow will lose chunks of output in the middle. Re-attaching restores its screen. The PTY reader is never held up with it. That is a deliberate trade-off.
- pi sessions have not been tested against real data. Their parser is generic.

## Other documents

- [CONFIG.md](CONFIG.md) — config.toml, agents, network access, pairing.
- [PROTOCOL.md](PROTOCOL.md) — the WebSocket protocol, enough to write your own client.
- [TESTING.md](TESTING.md) — the acceptance criteria results, along with what is not tested.
- [ACCESS.md](ACCESS.md) — reaching it from outside, drawn out.
