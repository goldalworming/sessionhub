# sessionhub

One place to open a terminal into a coding agent (Claude Code, opencode, pi) for each project. The session stays alive even when the UI is closed. You can pick it up from another computer through a browser. Several computers at once can be used from a single window, each in its own tab — see [CONFIG.md](CONFIG.md#many-machines-in-one-window).

No chat UI, no diff viewer, no worktree manager. Only a project/session sidebar on the left and a terminal in the middle.

There is one principle: **the UI and the engine are two different processes.** The agent process is never a child of a window or a tab. Closing the browser does not touch the agent process at all.

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
- Installs as an app — its own window, no tab strip, no address bar, nothing compiled
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

Needs stable Rust. The frontend has no build step — no npm, no bundler.

```
cargo build --release
```

The result is a single file, `target/release/sessionhubd.exe`. The `web/` folder is
embedded inside it, so there are no companion files to carry around.

`build.rs` puts the logo into that file as a Windows icon resource, read from
`assets/sessionhub.ico` — the only place Explorer looks, and a PNG in `web/` is
invisible to it. It needs no resource compiler and no crate, and a missing
`.ico` costs a warning rather than a build. `assets/make-icons.py` rebuilds that
`.ico` and the matching `.icns` from `web/icon-512.webp` when the artwork
changes; `cargo build` never runs it.

One thing does want a tool: `sessionhubd bundle-web FILE`, which packs the frontend
for a release, uses [bun](https://bun.sh) to squash the twenty-one ES modules into a
single `app.js` — 261 KB and twenty-one round trips on first load become 114 KB and
one. That is a release-time step, not a build-time one; `cargo build` still needs
nothing but Rust, a debug build still serves `web/` straight off disk, and
`bundle-web --raw` packs the modules unbundled on a machine without bun.

## Run

```
sessionhubd start          # detaches from this terminal, then exits
sessionhubd status         # port, uptime, number of live terminals
sessionhubd stop
sessionhubd restart        # stop and start again, to load a new build
```

`start` shows the full address with the token, and opens it in your browser:

```
http://127.0.0.1:7717/?token=…
```

Pass `--no-open` if you would rather it did not. Running `start` while the daemon is already up is not an error — it prints the address again and opens it again, which is the shortest way to get the link back when you have lost it.

Double-clicking `sessionhubd.exe` does the same thing as `start`, and the window it opens waits for Enter before closing, so the address stays readable. On macOS, Finder runs it in Terminal.app, whose window stays on its own.

`start` also leaves an icon behind — the notification area on Windows, the menu bar on macOS. It carries what the console window used to: the port, how many terminals are live, the address to open or copy, the log, and a way to stop the daemon that first says how many terminals go with it. It is its own process, `sessionhubd tray`, for the same reason the browser is: a daemon installed as a service or a launchd job runs where nothing can draw an icon, and the icon has to be where you are. Hiding it does not touch the daemon, and `--no-tray` skips it entirely.

Open the address once with the token in the URL. After that, `http://127.0.0.1:7717/` is enough. The token is stored in the browser in a cookie that survives closing the browser. So this is once per device, not once per session.

`restart` exists because a running process cannot load a new binary. `token rotate` can reach a live daemon to re-read its config. But changed Rust, or the `web/` assets baked into a release build, needs the process replaced. It **ends every live terminal**, because shells and agents are children of the daemon and cannot outlive it. So it refuses while any are running:

```
$ sessionhubd restart
1 live terminal(s) would be killed: they are children of the daemon
and cannot outlive it. Nothing has been stopped.

Run `sessionhubd restart --force` to go ahead anyway.
```

> On Windows, the running `.exe` is locked. So a rebuild cannot replace it while the daemon is up. There, the order is `stop`, then build, then `start`. `restart` is for a binary that is already in place.

Close the launching terminal whenever you like. The daemon does not die with it. That is the whole reason this project exists.

For development, `sessionhubd start --foreground` keeps the process in the terminal, so its log is visible right away.

## Its own window

**⋮ → Install page as app** in Chrome or Edge — or the install icon that appears
in the address bar. You get a window with no tab strip and no address bar, an
entry in the Start menu, its own icon, and a window whose size and position are
remembered.

Nothing is compiled to get it. [Pake](https://github.com/tw93/pake) builds a
small native shell around each site, which gives a lovely 5 MB app — and a
toolchain, a build, and a separate binary for every URL you want a window for.
A [web app manifest](web/manifest.json) asks the browser for the same window
using the mechanism it has shipped for years, and costs one JSON file and four
icons — 70 KB, against Pake's 5 MB per site.

One detail that is easy to get wrong here: a manifest is fetched with
credentials **omitted** by default, and every file this daemon serves needs the
token cookie. Without `crossorigin="use-credentials"` on the `<link>`, that
fetch is a 401 and no browser offers to install anything.

On a phone, **Share → Add to Home Screen** does the same job; on iOS that is the
whole mechanism, since Safari has no install prompt.

Firefox is the exception: it removed site-specific browsers in 2021, and its
desktop builds cannot install a web app at all. Firefox on Android can.

## Coming back after a reboot

```
sessionhubd install --account "DOMAIN\name" --password "…"
sessionhubd uninstall
```

You need an Administrator terminal. Without `--account`, the service runs as
LocalSystem and **the agents run as SYSTEM too** — you likely cannot read your
own credentials and agent config. For daily use, install it under your own
account.

On Linux/macOS, `install` writes a systemd user unit or a launchd plist and then
tells you the command that enables it.

## Access from outside

Off by default: the daemon listens on loopback only. **⚙ Settings → Network
access** opens it to the LAN, and `sessionhubd tunnel` puts it on the internet
through `cloudflared` — or point a Cloudflare tunnel of your own at
`localhost:7717` for an address that stays put.

> **Either one exposes a shell.** Anyone with the address and the token can run
> any command on that computer, as you. The token is not authentication — put
> **Cloudflare Access** in front of a tunnel hostname, close the tunnel when it
> is not in use, and run `sessionhubd token rotate` if the URL ever leaked. The
> traffic is not encrypted on the LAN either.

Setup, pairing a second machine, and what is stored where: [CONFIG.md](CONFIG.md).

## Known limits

- The history kept is the last 2 MB per terminal. It is lost when the daemon stops. It is a ring buffer, not terminal grid state.
- A client that is too slow will lose chunks of output in the middle. Re-attaching restores its screen. The PTY reader is never held up with it. That is a deliberate trade-off.
- pi sessions have not been tested against real data. Their parser is generic.

## Other documents

- [CONFIG.md](CONFIG.md) — config.toml, agents, network access, pairing.
- [PROTOCOL.md](PROTOCOL.md) — the WebSocket protocol, enough to write your own client.
- [TESTING.md](TESTING.md) — the acceptance criteria results, along with what is not tested.
