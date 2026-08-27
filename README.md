# sessionhub

<img src="icon.png" alt="" width="96" />

One place to open a terminal into a coding agent (Claude Code, opencode, pi) for
each project. The session stays alive even when the UI is closed. You can pick
it up from another computer — or a phone — through a browser, and several
computers share one window, each in its own tab.

No chat UI, no diff viewer, no worktree manager. Only a project/session sidebar
on the left and a terminal in the middle.

There is one principle: **the UI and the engine are two different processes.**
The agent process is never a child of a window or a tab. Closing the browser
does not touch the agent process at all.

![The three panes: projects and sessions on the left, an agent running in the middle, the file explorer and an image open on the right](screenshot.png)

## Why

Two things kept hurting: an agent that worked for an hour died because a laptop
lid closed, and half the time I check on an agent from a phone — no Esc, no
arrows, no clipboard. sessionhub is the smallest thing that fixes both: a
daemon that owns the PTYs, and a plain browser page that only *looks at* them.

Similar tools, and where the line runs: [T3 Code](https://betterstack.com/community/guides/ai/t3-code/)
is a task/chat UI first, with the terminal as a drawer — the fuller product if
you want your agent work organised as tasks. [herdr](https://herdr.dev/) keeps
sessions alive behind a terminal TUI you SSH into — the better fit if you live
in tmux. sessionhub only makes sense if the agent's own raw terminal is the
thing you want to reach, from any screen: it passes PTY bytes through
unchanged, injects nothing into your prompts, and its sidebar is the CLI's own
on-disk session registry (`~/.claude`, `~/.pi`, opencode), so every session
your agents ever made is one click from `--resume`.

## Features

- Sessions survive the UI closing — the daemon owns the PTY
- Raw passthrough: what the agent reads is exactly what you typed
- Resumes and forks the CLI's own sessions, whether or not they were born here
- Saved terminals: name a shell and the line it runs, and it starts with the daemon
- Several machines in one window; remote tokens never reach the browser
- Phone: key bar (Esc, ⏎, ⇧Tab, Ctrl, arrows), Paste, image upload, touch scrollback
- Busy/finished colours, a finish chime, tab colours stored on the daemon
- File panel with Monaco; drag or paste a file and it lands on the agent's machine
- CPU and RAM on the tab bar, RAM per terminal behind a button
- Self-update from Settings, and a way in from outside through Cloudflare
- One binary — no npm, no build step

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+K` | command palette |
| `Ctrl/Cmd+B` | hide/show the sidebar |
| `Ctrl/Cmd+1..9` | switch to the nth terminal |
| `Ctrl/Cmd+W` | close the tab; the terminal keeps running |
| `Ctrl/Cmd+Shift+W` | kill the terminal, with confirmation |

Every other key goes to the agent untouched.

## Install and run

Download the binary for your machine from
[Releases](https://github.com/goldalworming/sessionhub/releases/latest) and run
it. One file — the interface is inside it. On macOS there is a `.app` for
Applications; it is unsigned, so open it the first time with right-click → Open.
To build it yourself: stable Rust, `cargo build --release`, nothing else.

```
sessionhubd start          # detaches from this terminal, then exits
sessionhubd status         # port, uptime, number of live terminals
sessionhubd stop
sessionhubd restart        # stop and start again, to load a new build
```

`start` prints the address with the token and opens it. A cookie carries the
token after the first open, once per device. Running `start` again when it is
already up just prints the address again — the shortest way back to a link you
lost. There is an icon in the tray, or the menu bar on macOS, with the address,
the log, and a way to stop it.

`restart` **ends every live terminal** — they are children of the daemon — so
it refuses while any are running unless told `--force`.

## Access from outside

Use Cloudflare: **⚙ Settings → Cloudflare** gives an address a way in — a dev
server here, or something on your network — and it comes back as a hostname you
can open from anywhere, still behind the sessionhub token.

> **This exposes a shell.** Anyone with the address and the token can run any
> command on that computer, as you. Put **Cloudflare Access** in front of it if
> it is more than a moment, and run `sessionhubd token rotate` if a URL leaked.

## Known limits

- The history kept is the last 2 MB per terminal. It is lost when the daemon stops. It is a ring buffer, not terminal grid state.
- A client that is too slow will lose chunks of output in the middle. Re-attaching restores its screen. The PTY reader is never held up with it. That is a deliberate trade-off.
- pi sessions have not been tested against real data. Their parser is generic.

## Other documents

- [CONFIG.md](CONFIG.md) — config.toml, agents, network access, pairing.
- [PROTOCOL.md](PROTOCOL.md) — the WebSocket protocol, enough to write your own client.
- [TESTING.md](TESTING.md) — the acceptance criteria results, along with what is not tested.
