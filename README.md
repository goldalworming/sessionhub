# sessionhub

One place to open a terminal into a coding agent (Claude Code, opencode, pi) for each project. The session stays alive even when the UI is closed. You can pick it up from another computer through a browser. Several computers at once can be used from a single window, each in its own tab — see [Many machines](#many-machines-in-one-window).

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

As I found them in **August 2026**. All three projects move fast, so file an issue if a cell has gone stale.

| | sessionhub | T3 Code | herdr |
|---|---|---|---|
| Primary interface | the agent's own terminal, in a browser | task/chat UI, terminal drawer | terminal TUI (tmux-like) |
| Sessions survive the UI closing | yes — daemon owns the PTY | yes (app-managed tasks) | yes — server/client split |
| Resumes the CLI's own on-disk sessions | yes (`~/.claude`, `~/.pi`, opencode) | own task history | attaches to its own panes |
| Prompt/token overhead added | none — raw PTY passthrough | task harness around each thread | none — raw terminal |
| Phone support | key bar, clipboard Paste, image upload, touch scrollback | browser UI (desktop-shaped) | via SSH client apps |
| Several machines in one window | tabs via daemon relay; remote tokens never reach the browser | — | SSH per machine |
| Agent activity signal | busy/finished colours + finish chime | task status in UI | blocked/working/done/idle sidebar |
| Install | one binary, no npm, no build step | desktop/web app | one Rust binary |

## Features

- **Sessions outlive the UI** — the daemon owns the PTY, so a closed tab, a shut lid, or a crashed browser leaves the agent running.
- **Resume what your CLI already has** — the sidebar *is* the agent's own on-disk registry (`~/.claude`, `~/.pi`, opencode), so any session you ever made is one click from `--resume`.
- **Raw passthrough** — PTY bytes go through unchanged, so the agent's own TUI is the interface and nothing is injected into your prompts.
- **Saved terminals** — give a plain shell a name and the line it runs, and it comes back after a restart as a one-click row instead of a half-remembered filename.
- **Tab colours** — right-click a tab (long-press on a phone) to tag it from the theme's six terminal colours, stored on the daemon so every device sees the same mark.
- **Many machines, one window** — a tab per paired machine, relayed by your local daemon so the remote token never reaches the browser.
- **Made for a phone** — a key bar with Esc, Tab, ⇧Tab, sticky Ctrl/Alt and arrows, plus **Paste** and **Img** buttons and touch scrollback.
- **Tabs or grid** — one terminal at full size, or every live terminal at once in a grid that stays as square as it can.
- **File panel** — a folder tree per project with Monaco beside the terminal, for the edits too small to ask an agent for.
- **Drop or paste a file** — it uploads to the machine where the agent runs, not the one you are holding, and its path is typed at the prompt without pressing Enter.
- **Fork a session** — continue an old conversation into a new one and leave the original untouched.
- **Activity at a glance** — each terminal shows busy or finished, with a chime when a run ends while you were looking elsewhere.
- **RAM per terminal** — measured across each terminal's whole process tree, not just its root process.
- **Self-update** — **⚙ Settings → Update** fetches the newest release and restarts into it, after saying how many live terminals that will cost.
- **Search that includes parent folders** — typing `telkom` finds projects inside `…\telkom\…` even when no project is named that.
- **One binary** — no npm, no build step, no runtime to install.

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+K` | command palette |
| `Ctrl/Cmd+B` | hide/show the sidebar |
| `Ctrl/Cmd+1..9` | switch to the nth terminal |
| `Ctrl/Cmd+W` | close the terminal view (not kill it) |
| `Ctrl/Cmd+Shift+W` | kill the terminal, with confirmation |

Every other key goes to the agent untouched; `Ctrl+C`, `Ctrl+D`, `Ctrl+P` and `Ctrl+R` are never hijacked. Chrome keeps `Ctrl+W` and `Ctrl+1..9` for itself, so those reach the app only in an installed window (PWA).

Two things sessionhub deliberately does not do: it is **not a supervisor** — nothing restarts a saved terminal for you, and nothing starts one when the daemon boots — and it adds **no chat, diff or task UI**, because the agent already has one.

## Install

Needs stable Rust. The frontend has no build step — no npm, no bundler.

```
cargo build --release
```

The result is a single file, `target/release/sessionhubd.exe`. The `web/` folder is
embedded inside it, so there are no companion files to carry around.

## Run

```
sessionhubd start          # detaches from this terminal, then exits
sessionhubd status         # port, uptime, number of live terminals
sessionhubd stop
sessionhubd restart        # stop and start again, to load a new build
```

`start` shows the full address with the token:

```
http://127.0.0.1:7717/?token=…
```

Open it once with the token in the URL. After that, `http://127.0.0.1:7717/` is enough. The token is stored in the browser in a cookie that survives closing the browser. So this is once per device, not once per session.

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

## Config

`~/.sessionhub/config.toml` (Windows: `%USERPROFILE%\.sessionhub\config.toml`), created automatically on first run.

```toml
port = 7717
lan_access = false   # true opens it to the local network — see the warning below
token = "…"

projects = [
  "C:\\data\\code\\notex",
]

[agents.claude]
command = "claude"
resume_args = ["--resume", "{session_id}"]

[agents.opencode]
command = "opencode"
resume_args = ["-s", "{session_id}"]

[agents.pi]
command = "pi"
resume_args = ["--session", "{session_id}"]

# Added on its own on first run: "New terminal" in the `+` menu, for opening a
# plain shell in the project folder without any agent. Change `command` if you
# want a different shell.
[agents.terminal]
command = "powershell.exe"
```

The **⚙ Settings** button at the bottom left of the sidebar edits this file from the browser. You can add an agent, remove it, enable or disable it, change its command, and edit resume and fork arguments. The panel also checks each command on PATH and shows the result. So an agent that is not installed yet is caught right there — not only when a spawn fails.

A disabled agent disappears from the `+` menu. It is rejected when spawned. Its sessions stop being scanned, so they no longer fill up the sidebar.

### PATH on macOS and Linux

This daemon is designed **not** to run from a terminal. It detaches itself on `start`, and it can be run by launchd or systemd. All three inherit a nearly empty PATH. On the Mac used for testing, it was `/usr/bin:/bin:/usr/sbin:/sbin`. The result: every agent installed in `~/.local/bin`, Homebrew, bun, or nvm gets reported as **not found on PATH** even though it is plainly there in your terminal. Spawning it fails too.

That is why, on unix, the daemon asks your login shell for its PATH once at start and puts it in front of the inherited PATH. The shell is invoked **interactively** (`$SHELL -lic`), not just as a login shell. On macOS with zsh, the user's PATH is normally written in `.zshrc`, and `-l` alone does not read it. Tested on a real machine: `-l` missed `~/.local/bin` while `-i` loaded it.

If the shell does not answer within 4 seconds, the inherited PATH is used anyway. A less complete list is better than a daemon that never finishes starting. Windows does not do this, and does not need to. Its PATH belongs to the user's environment and is inherited as-is, including by services.

`command` is looked up on PATH. If an agent is installed outside PATH — for example under an nvm version that is not currently active — put an absolute path there:

```toml
[agents.opencode]
command = "C:\\Users\\name\\AppData\\Roaming\\nvm\\v22.17.0\\opencode.cmd"
```

### Adding your own harness

**Settings → Add an agent**, below the agent list. Only the name and the command are required. The other two fields can follow later.

| Field | Contents |
|---|---|
| Name | lowercase letters, digits, `-` and `_`; must start with a letter |
| Command | a name on PATH, or an absolute path |
| Resume args | use `{session_id}`. Left empty means this agent has no stored sessions — it just opens a shell |
| Fork args | use `{session_id}`, and `{name}` if the agent accepts a session name. Left empty means it cannot fork, and the button is not offered |

A new agent's fork capability is **not** guessed. Guessing the fork flag of an unfamiliar harness would only install a button that destroys someone's session. So the field is left empty until you fill it in yourself.

Whatever you add shows up in the `+` menu immediately, without a reload. It is looked up on PATH right away, so a typo is visible then and there.

Removing takes two clicks on the **Remove** button in the agent's row. Terminals already running with that agent **stay alive**. Removing a setting must not kill work in progress. What stops is only the ability to create new ones and the scanning of its sessions.

Built-in agents you do not use — `pi`, for instance — can simply be removed. The only one that cannot be removed is `terminal`. It is rebuilt every time the daemon starts. So the panel offers to disable it instead of removing it.

### Saved terminals

A terminal you named is stored here, so it survives a restart. Written by the
save icon on a terminal's row, and editable by hand:

```toml
[[saved]]
name = "telegram bot"
project = 'C:\data\code\firefox-ext\mcp'
agent = "terminal"
command = '.\@run-telegram-bot.bat'
color = "cyan"
```

`command` is run when the terminal is opened. A bare filename that exists in
`project` is run the way the shell needs it (`.\name`) — neither PowerShell nor
`sh` will run a file from the current directory otherwise, and stored as-is it
fails silently into a panel nobody has open. Anything else is left exactly as
written, because a name that is not a file there is meant for the PATH.

A name belongs to one terminal at a time, opening one that is already running
attaches to it rather than starting a second copy, and forgetting one takes two
clicks so a mis-tap on a phone does not delete the note. `color` is one of red,
green, yellow, blue, magenta, cyan.

### Fork session

`fork_args` is filled in on first run for the agents known to support it, and is
editable in **⚙ Settings**. `{session_id}` and `{name}` are substituted.

```toml
[agents.claude]
fork_args = ["--resume", "{session_id}", "--fork-session", "--name", "{name}"]

[agents.opencode]
fork_args = ["-s", "{session_id}", "--fork"]   # takes no name
```

An empty list means the agent cannot fork, and the `⑂` button is not offered.

### Agent environment

The daemon is the terminal emulator for its child processes. So it is the one that announces the terminal's capabilities — not the environment of whichever process happened to run `sessionhubd start`. Every agent is started with:

```
TERM=xterm-256color
COLORTERM=truecolor
NO_COLOR   removed
```

`NO_COLOR` is dropped deliberately. If it sneaks in from the launcher's environment — easy to happen, since the daemon is usually detached from a terminal or run as a service — every agent would render in black and white even though the frontend supports truecolor.

To override any of it, including bringing `NO_COLOR` back:

```toml
[agents.claude.env]
NO_COLOR = "1"
```

### Dropped files

```toml
[drops]
max_age_hours = 24    # 0 = never discard because of age
max_total_mb = 100    # 0 = no limit
max_file_mb = 20      # 0 = no limit
```

All three can be changed from **⚙ Settings → Dropped files**. The panel also shows current disk usage and has a manual cleanup button.

**Age is the main rule, not size.** An image that was just dropped may not have been read by the agent yet. Discarding it because the folder is full is exactly what breaks work in progress. Age does not have that problem — a file that old is genuinely done with. The size limits are used as a ceiling so the disk does not balloon. They may only touch files older than 10 minutes. If the folder is still too large after that, it is written to the log and left alone, rather than eating a file that might be being read.

Files larger than `max_file_mb` are rejected up front with a message that names the number — not stored and then quietly discarded.

### New project

`projects` is filled in by the **＋** folder picker in the sidebar, and can still
be edited by hand. Everything else is discovered from existing agent sessions by
reading `cwd` **out of the session file** — not by guessing it from an encoded
directory name.

What you browse is the disk of **the machine the daemon runs on**, not the device
holding the browser; that is where the agent works, so even from a phone you are
picking a folder on your computer. It opens up nothing new — anyone who can talk
to the daemon already has a shell there.

Only projects you added yourself can be removed. Ones discovered from agent
sessions are not in `config.toml` and come back on their own, and the panel says
so rather than appearing to fail.

## Token

A random 32-byte token is created once and then saved. It does not change on every restart.

```
sessionhubd token rotate
```

The old token stops working right away. The new one takes effect without closing running terminals. Browser tabs that are still open will be rejected. They will be told their token has expired.

### How a browser stays signed in

Opening `/?token=…` once sets a cookie. Every later request — the page, the scripts, the images the editor loads through `/api/file` — is allowed by that cookie. A `<script>` tag cannot carry a token. That is why the cookie exists.

The cookie is `HttpOnly`, `SameSite=Lax`, and lasts 400 days. Each of these choices is worth knowing:

- **400 days**, not no expiry at all. Without one, it is a *session* cookie. The browser throws it away on close. The token in `localStorage` cannot save the next visit, because the only code that reads `localStorage` is `app.js`. That code is itself behind the same gate and never loads. The result was retyping the token after every browser restart. This adds no new risk: the same secret was already saved in `localStorage` on that origin. Of the two, the cookie is safer because script cannot read it.
- **`Lax`**, not `Strict`. Strict withholds the cookie on a cross-site top-level navigation. Opening the app from a link in a chat is exactly that. The sign-in page appeared with a perfectly good cookie in the jar.
- **No `Secure`**, because the daemon is reached over plain HTTP on a LAN. It cannot see through a tunnel to know otherwise. Marking it Secure would stop it being sent at all.

A rotated token invalidates the cookie too. It stops matching, right away and everywhere. Each origin keeps its own cookie. So a phone reaching the daemon through a tunnel signs in once for that address separately from `127.0.0.1`.

## Access from outside

The daemon binds `127.0.0.1` by default. That is on purpose.

### Local network

Open **⚙ Settings**, then turn on **Network access** in the top row. The full
address with its token shows up right there. You can copy it to another device
on the same Wi-Fi.

The switch works right away. Loopback stays bound and is never released. What
opens or closes is only the second listener. So turning it on and off does not
need a daemon restart, and no terminal dies with it. The choice is saved as
`lan_access` in `config.toml`. Both `sessionhubd start` and `status` show the
LAN address too.

Older configs that still use `bind` are moved once on first run. A non-loopback
address becomes `lan_access = true`. Everything else becomes `false`. Then the
`bind` line is removed. A value that cannot be read falls back to `false`. A
typo must never open the machine by accident.

> What you open is a **shell**, not a normal web page. Anyone on that network
> who has the URL with its token can run any command as you. The token also
> travels in the clear because this is plain HTTP. So anyone who can watch the
> network traffic can record it.
>
> Use it only on networks you trust. Turn it off when you are done. On Windows,
> the port also needs to be allowed through Windows Firewall. And check that the
> network's profile is Private, not Public.

### Internet

```
sessionhubd tunnel
```

This command runs `cloudflared` as a child and prints its public URL with the
token. If `cloudflared` is missing, the command to install it is printed too.

> **This exposes a shell to the internet.**
>
> Anyone with the URL and the token can run any command on this computer, as
> you. Not just read the terminal. Typing into it is the same as sitting in
> front of the machine.
>
> The token alone is not enough. Put **Cloudflare Access** in front of the
> tunnel hostname. That gives real authentication before a request reaches the
> daemon. Then treat the token as a second layer, not the only one. Close the
> tunnel when it is not in use. Run `token rotate` if the URL was ever leaked.

### Updates through caches and tunnels

Every app file the page references carries a version stamp. For example,
`/app.js?v=<hash>`. The hash covers the contents of every app file. The page
itself is served `no-cache`. An update changes the hash, which changes every
URL. So whatever a phone browser or a tunnel edge cached under the old URLs
simply stops being asked for. Nothing ever needs to be cleared for an update to
arrive. The stamped files are cached hard (`immutable`). That is what makes
opening from a phone fast. ES modules reach each other through an import map
injected into the page. So nested `import './x.js'` statements resolve to
stamped URLs too.

For a browser that cached the interface **before** this existed (it held old
copies on heuristics and never asks again), there is a one-time way out. You do
not need to know what a hard reload is. **⚙ Settings → Network → Refresh app**
refetches every file past the cache and reloads.

## Many machines in one window

One tab per paired machine. Switching tabs swaps the whole window — sidebar,
terminals, file panel, settings — and terminals on a machine that is not shown
are hidden, not closed, so going back is instant.

### Pairing

On the machine you want to reach: **⚙ Settings → Network access**, turn it on, then copy the **Pairing link** line:

```
sessionhub://192.168.0.115:7717/pair#token=3EKatpJC…
```

On the machine you work from: **＋** in the machine tab bar, paste that link. The box reads the clipboard when it opens and **has no Connect button** — a complete link is checked against that machine right away, and a half-finished one means you are still typing. The tab name comes from the address (`10.8.0.4` → `10-8-0-4`) unless you fill it in yourself. **✕** on a tab removes that machine along with its token.

The link also accepts `http(s)://`, `ws(s)://`, and `host:port#token=…` forms, because a link like this usually goes through a chat app that likes to change it.

### How it works

The browser **only talks to the local daemon**, and only holds the local token. The local daemon is the one that connects to the remote machine, using the token stored in its own `config.toml`, and then sends the bytes as they are. So:

- The remote machine's token never reaches the browser — not in `localStorage`, not in the DOM.
- Only the **local daemon** needs to be able to reach that machine. From a phone away from home, the office machine is still reachable as long as your laptop at home can reach it.
- The relay only serves registered names, not random addresses — your daemon does not become an open proxy.
- There is no chaining: a remote machine cannot be used to reach a third machine.
- If the local daemon stops, every remote connection goes down with it. That is the cost of a browser that holds only one token.

What is stored in the local daemon's `config.toml`:

```toml
[[remotes]]
name = "office"
addr = "10.8.0.4:7717"
token = "…"
version = "0.1.0"
```

> The traffic is **not encrypted**, exactly as with Network access. The token proves who is calling; it does not hide what is being said. A paired machine means **full access** to that machine — that daemon does hand out a shell. Use it only on networks you trust, or over a VPN — the pairing link accepts a VPN address just as it accepts a LAN address.
>
> **`https://` connections are not supported**: pairing speaks plain HTTP and requires `host:port`, so a `sessionhubd tunnel` URL cannot be paired. To cross the internet, run it over a VPN.

## Known limits

- The history kept is the last 2 MB per terminal. It is lost when the daemon stops. It is a ring buffer, not terminal grid state.
- A client that is too slow will lose chunks of output in the middle. Re-attaching restores its screen. The PTY reader is never held up with it. That is a deliberate trade-off.
- pi sessions have not been tested against real data. Their parser is generic.

## Other documents

- [PROTOCOL.md](PROTOCOL.md) — the WebSocket protocol, enough to write your own client.
- [TESTING.md](TESTING.md) — the acceptance criteria results, along with what is not tested.
