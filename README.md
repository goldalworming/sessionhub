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

## Updating

**⚙ Settings → Update**. It asks this repo's releases for the newest version,
shows the notes, and installs it on the machine whose tab you are looking at —
including a remote one.

What it does not do is hide the cost. Installing restarts the daemon, and every
live terminal is a child of it, so the panel counts them before you commit and
asks twice. Agent sessions come back from the sidebar with their context; a
plain shell does not.

The swap itself cannot happen from inside a running process — Windows locks a
running `.exe`, and unix refuses to write a busy one. So the new build is
downloaded next to the old binary and a small script does the exchange once the
daemon has exited, then starts it again. The binary it replaced is kept beside
it as `sessionhubd.old`, so an update that will not run can be undone by hand.
If the daemon somehow has not exited, the script leaves everything untouched
rather than installing something that cannot take the port.

Releases carry a build per platform. A release with nothing for your platform is
reported as such, and no button is offered.

## Saved terminals

An agent session comes back on its own after a restart, because the agent wrote
it to its own store and sessionhub reads it back. A plain shell writes nothing.
So the terminal running your bot, your dev server, or a long `tail -f` is simply
gone once the daemon stops — and the only record of what it was running is in
your head.

Naming one fixes that. Press the save icon on a running terminal's row, give it
a name and the line to run:

```
telegram bot     .\@run-telegram-bot.bat
dev server       npm run dev -- --host 0.0.0.0
```

It is written to `config.toml`, so it survives a daemon restart, a reboot, and a
machine crash. Afterwards the sidebar keeps a row for it under its project: a
hollow dot and the command it will run. One click opens the shell in the right
folder and runs that line.

The command box arrives already filled in with what you last typed in that
terminal, so naming it does not mean typing the command out a second time. It
comes back empty when sessionhub cannot answer honestly — a command recalled
with the up arrow or finished with Tab never passed through the daemon, and
guessing there would put a line you never ran into something that runs on every
open. Type it yourself in that case; the box is editable either way.

Details worth knowing:

- **A name belongs to one terminal at a time.** Saving a second terminal under a
  name already in use takes the name off the first one.
- **Opening one that is already running attaches to it** rather than starting a
  second copy — which matters when the thing holds a port.
- **Forgetting takes two clicks** on the ✕, so a mis-tap on a phone does not
  delete the one note saying how a service is started. It removes the note only;
  anything running under that name keeps running.
- They live in `config.toml` under `[[saved]]` and can be written by hand:

  ```toml
  [[saved]]
  name = "telegram bot"
  project = 'C:\data\code\firefox-ext\mcp'
  agent = "terminal"
  command = '.\@run-telegram-bot.bat'
  ```

A folder you are working in rises to the top of the project list. The list is
ordered by the newest agent session, and a plain shell is not a session — so a
folder with no agent history used to sink to the bottom the moment you opened a
terminal in it. What is running there counts as the most recent thing that
happened there; a saved-but-idle terminal keeps it above folders with nothing
set up in them.

This is a note about how to start something, not a supervisor: sessionhub does
not restart a saved terminal by itself, and does not start one when the daemon
boots. It makes starting it one click instead of a folder hunt and a
half-remembered filename.

## Tab colours

Four terminals in one project give you four tabs reading `mcp · terminal`.
Right-click a tab (long-press on a phone) and pick a colour, and that one is
findable at a glance.

The palette is six colours, not a colour picker: red, green, yellow, blue,
magenta, cyan. They are the theme's own terminal palette, defined separately for
light and dark, so a tag stays readable when the theme flips — a stored hex
would have been right in one theme and muddy in the other. The daemon refuses
anything outside that list.

The tag lives on the daemon, not in one browser's storage. That is the point:
the same terminal is looked at from the phone and from the laptop, and a mark
only one of them can see is not a mark. Tag it on the laptop and the phone shows
it on the next update, and so does a paired machine's tab.

It shows everywhere the terminal appears: on its tab, on its sidebar row, and
as a bar down the left edge of the terminal panel itself — because a mark that
exists in only some of those places is one you stop trusting. The panel bar
matters most in grid mode, where there is no active tab to read at all.

The bar sits in the small gap every panel leaves on its left, so it never paints
over the terminal. An overlay would sit on the leftmost pixels of column one,
which is exactly where box-drawing characters live.

On a [saved terminal](#saved-terminals) the colour is stored with the name and
comes back the next time you open it. On an unnamed one it lasts as long as the
terminal does, which is exactly as long as the terminal itself is worth
identifying.

Picking the colour a tab already has takes the tag off, and `No colour` does the
same; it only appears once there is something to clear.

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

### Fork session

`fork_args` decides how an agent continues a conversation into a new session. Its contents are verified against each agent's `--help` and filled in automatically on first run:

```toml
[agents.claude]
fork_args = ["--resume", "{session_id}", "--fork-session", "--name", "{name}"]

[agents.opencode]
fork_args = ["-s", "{session_id}", "--fork"]
```

Both can be edited in **Settings**, in each agent's row. An empty list means that agent cannot fork, and the button is not offered. The `{name}` placeholder is only used by agents that accept a session name from the CLI. opencode has `--fork` but no name flag, and the dialog says so instead of promising a name that would be ignored.

A note about Claude Code: a forked session **is only written to disk after the first message**. Until that happens, the fork lives in a terminal tab but does not yet have a row in the sidebar. That is agent behaviour, not a failed fork.

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

The **＋** button in the sidebar toolbar opens a folder picker. The flow is a single path:

1. Start from the folder you opened last — including after closing the browser. If there is no such folder yet, start from the home directory. Jump around with the drive shortcuts (`Home`, `C:`, `D:`…), or paste a path straight into the box at the top and press Enter.
2. Click a folder to enter it, `↑` to go up. Folders containing `.git` are marked with ◆ — usually that is what you are looking for.
3. **New folder** if the project does not exist yet. As soon as it is created, the picker moves into it.
4. **Use this folder** makes it a project. It appears in the sidebar immediately, with no reload and no daemon restart.

What you browse is the disk of **the machine the daemon runs on**, not the device running the browser. That is exactly right, because that is where the agent works. Even from a phone you are picking a folder on your computer.

This does not open up any new capability. Anyone who can talk to the daemon already has a full shell on that machine. Listing directories is just a shorter route than typing `ls`.

Folders that are already projects are marked in the list, and the button changes to **Remove from sidebar**. Only the ones you added yourself can be removed. Projects discovered from agent sessions are not recorded in `config.toml`, so they will come back on their own — and the panel says so instead of failing silently.

`projects` in the config is filled in by this flow, and can still be edited by hand. Everything else is discovered on its own from existing agent sessions, by reading `cwd` **from the contents of the session file** — not by guessing it from an encoded directory name.

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

The tab bar above the terminal has one tab per machine: **This machine**, then each machine you have paired. Switching tabs swaps **all the contents of the window** — sidebar, terminals, file panel, settings — so nothing gets mixed up.

Terminals on a machine that is not currently shown are **not closed**, only hidden. Going back to its tab is instant, with no re-connect and no replay.

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

## Usage

- **＋** above the sidebar opens the folder picker. You can look through the daemon machine's disk. You can create a new folder if you need one. Then **Use this folder** makes it a project. The new project shows up in the sidebar right away. You do not need to reload. See [New project](#new-project).
- The **Files** button at the top right opens the file panel. It sits to the right of the terminal. It has a folder tree for each project. It has Monaco for opening files. See [File panel](#file-panel).
- The **Tabs / Grid** button in the top bar swaps the stage layout. One terminal fills the screen. Or all terminals show at once in a grid. See [Tabs or grid](#tabs-or-grid).
- Clicking a **project name** moves the file panel to that project. To collapse or expand its session list, use the **arrow on the left**. These are two different actions on two different targets. So they never fight over each other.
- Click a session in the sidebar. If its terminal is alive, it attaches. If not, it respawns with the resume flag. One click. No dialog.
- Filled dot means live terminal. Empty circle means stored session.
- Some terminals have no stored session yet. This includes a plain shell. It also includes agents whose session has not been written to disk. These still get their own row under their project. They stay there as long as they live. The row is labelled with the agent name and terminal number. Without this, both would only exist in the tab bar at the top. The row disappears on its own when the terminal dies.
- `+` in a project row creates a new terminal. You pick the agent.
- The `⑂` button in a session row **forks** it. The old conversation continues into a **new** session. The original is left untouched. You are asked for the name first. The button only shows for agents that have a fork command.
- **Drag a file onto the terminal** to upload it. You can also paste an image with `Ctrl/Cmd+V`. The file lands in `~/.sessionhub/dropped/` **on the machine where the agent runs**. Then its path is typed into the prompt. No Enter is pressed. You can still write a sentence in front of it. You can also delete it. This is useful from a phone. The image reaches the computer where the agent works. It does not stop at the phone.
- The **key bar** shows on its own on narrow screens. It appears as soon as a terminal is open. It sticks to the bottom just above the on-screen keyboard. Phone keyboards have no Esc, no Tab, and no arrows. These are the three keys used most in a terminal. See [From a phone](#from-a-phone).
- The bookmark marker in a project row marks it as a focus. Marked ones move up into the top group. Ones already marked are filled in and always visible. Unmarked ones are only an outline. They appear when the cursor touches their row.
- The search box above the sidebar filters projects and session titles. It also filters **their parent folders**. Typing `telkom` surfaces projects inside `…\telkom\…`. This works even if the project name itself does not contain the word. The full path is never shown. All that appears is the folder name that caused the row to match. So there are no results without a reason.

  Folders are matched as a **substring**. Names are matched as a subsequence. If folders were matched as a subsequence, a path as long as `C:\Users\…\data\code\…` would make almost every project match. The filter would stop filtering anything. Folders that *every* project passes through are also excluded. They do not distinguish anything.

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+K` | command palette |
| `Ctrl/Cmd+B` | hide/show the sidebar |
| `Ctrl/Cmd+1..9` | switch to the nth terminal |
| `Ctrl/Cmd+W` | close the terminal view (not kill it) |
| `Ctrl/Cmd+Shift+W` | kill the terminal, with confirmation |

Every other key is sent raw to the agent. `Ctrl+C`, `Ctrl+D`, `Ctrl+P`, and `Ctrl+R` are never hijacked.

Note: Chrome uses `Ctrl+W` and `Ctrl+1..9` to close and switch tabs at the browser level. A page cannot prevent this. Those three shortcuts only reach the application in an installed window (PWA) or in a browser that hands them over. `Ctrl+K` and `Ctrl+B` always work.

The `RAM` button at the top right shows the memory usage of each terminal. It is computed for **its entire process tree**. An agent's root process is usually the smallest one of all.

Narrow screens are handled. The sidebar becomes a drawer that overlays the screen. It is opened with the ☰ button.

## From a phone

The key bar's **Paste** button puts the clipboard wherever the cursor is. With a
dialog open — naming a terminal, say — that is the field you are typing in, not
the terminal behind it. On a phone this button is the only way to paste at all,
so aiming it at the terminal made those fields unfillable.

Narrow screens hide the sidebar into a drawer and show a **key bar** below the stage.

The bar is there because on-screen keyboards lack Esc, Tab, and arrow keys. In a terminal, those keys are used the most.

```
Esc  Tab  Ctrl  Alt  ←  ↑  ↓  →  ⋯
```

`⋯` opens a second row:

```
^C  ^D  ^Z  ^R  ^L  ⇧Tab  Home  End  PgUp  PgDn  Del  ⏎
```

The list is **not a copy** of the bar in a remote desktop app. `Win`, `PrtScr`, `ScrollLock`, and `Menu` mean nothing to a PTY. The daemon sends bytes, and those keys make no bytes that reach the shell.

Instead, the bar has what such bars lack and what people use daily: interrupt, EOF, suspend, history search, clear, and the `⇧Tab` that Claude Code uses to switch modes.

**Ctrl and Alt are sticky.** Pressing one sends nothing. It waits for the next keystroke — from a bar key **or from the on-screen keyboard** — then turns it into a control code and releases itself.

While sticky, the key is lit. The next letter changing meaning must not surprise you.

The `⌨` button in the top bar turns the bar on or off, even on wide screens. The choice is saved. If no choice is made, the default follows the screen width.

From a phone, you can also: **paste an image with `Ctrl/Cmd+V`**, or drag a file onto the terminal. It uploads to the machine where the agent runs, not to the phone — see [Dropped files](#dropped-files).

## Tabs or grid

The **Tabs / Grid** button is in the top bar. Tab mode gives one terminal the whole screen. Grid mode shows every live terminal at once. The number of columns follows the number of terminals — two side by side, four as 2×2, nine as 3×3. Each panel stays as square as possible, instead of becoming a thin, unreadable ribbon.

Switching to grid also opens live terminals that have never been opened. Swapping the layout and then seeing only one panel is not what "grid" means. The limit is 9 panels. Beyond that, each panel is too small to read. Each panel also means one attach plus a replay of its ring buffer.

Each panel has a small header with the project and agent name, plus `✕` to close its view. The process keeps running. The active panel gets an accent line. That is where the application shortcuts are aimed.

The PTY size is still negotiated per terminal. So each panel reports the size of its own cell, not one size forced on all of them.

The layout choice is stored in the browser.

## File panel

The **Files** button is in the top bar.

**Only one project is shown: the one you are working on.** The explorer follows the active terminal. Switching terminal tabs to another project moves its contents too. The contents of other projects are not shown alongside. If you are in one project, the rest only lengthen the list without ever being opened. To move it by hand: click the **project name in the left sidebar**, or the `▾` button in the **Explorer** title. The last action wins. Picking a project beats the active terminal, and switching terminal tabs brings it back again. The project currently in focus is marked with an accent line at the left edge of its row.

The project root is open from the start. Making you click one level just to see the contents of the project you are working on is a step with no purpose. Open files use a folder trail relative to the project (`src › main.rs`), not the full path. A prefix that is the same on every row tells you nothing.

The panel is two columns: **Explorer** stays on the left, the editor to its right. Explorer is not a tab. It is always visible, so the tree and the file never hide each other. The tab bar above the editor holds only the files that are open. `✕` closes just that file. The boundary between the two can be dragged, and its width is remembered.

`Ctrl/Cmd+S` or the **Save** button writes it back to disk. Files with unsaved changes are marked with a dot on their tab.

**The editor theme is separate from the application theme**, and its default is dark. Code is read for long stretches, and that is a different preference from the preference for the rest of the interface. The theme button in the editor bar cycles `dark → light → auto`. `auto` follows the application theme.

**Images are displayed, not merely called a "binary file".** PNG, JPEG, GIF, WebP, AVIF, BMP, and ICO are drawn as they are on top of a checkerboard. That way transparent ones can be told apart from ones with a white background. They show their pixel size too. The bytes are fetched over `GET /api/file`, not over the WebSocket. The browser can cache them, and there is no one-third bloat from base64 inside JSON. SVG is deliberately still opened as text. In a tool like this it is more often something you want to edit than to look at.

A tree like this is usually heavy. Three things keep this one from being so:

**One folder per request.** A folder's contents are only read when that folder is opened. There is no whole-repo index built up front. An index like that scans tens of thousands of files just to draw the twenty rows that are visible, and has to be rebuilt every time something changes.

**Virtualisation.** Only the rows inside the viewport plus a small reserve become DOM elements. Opening a folder with 2,000 files produces ~50 elements, not 2,000. Scrolling it stays at ~50.

**Monaco is loaded lazily.** Those 4.9 MB are only requested when the first file is opened. As long as you only use the terminal, not a single byte is downloaded. What is bundled has been trimmed too: `editor` + `basic-languages`, without `language/` (7 MB of TypeScript/HTML/CSS language services along with their workers). Syntax highlighting is still complete — that comes from `basic-languages`, not from `language/`.

The limits that apply:

| | |
|---|---|
| Files per folder | 5,000; the rest is noted on the last row |
| File size | 2 MB; above that only the head, cut at a line boundary, and the editor becomes read-only |
| Binary files | contents are not sent at all — the panel only states the size |
| Images via `/api/file` | 25 MB |

**Save** only overwrites files that already exist. Saving to a mistyped name is rejected, not quietly turned into a new file. This panel is an editor, not a file manager.

The **Filter** box filters the files in the folder that is open. Folders are not filtered along with them. Hiding them would cut off the route to matching files inside.

## Multiple terminals, one session

Several browsers may open the same terminal. Their screen contents are the same,  
and typing in one shows up in all of them.

The PTY size used is the **smallest cols and the smallest rows** across all  
attached clients, worked out per axis — the same way as tmux. Opening a terminal  
from a phone will make its view narrower on the desktop while the phone is still  
attached. Close the view (do not kill it) when you are done.

## Known limits

- The history kept is the last 2 MB per terminal. It is lost when the daemon stops. It is a ring buffer, not terminal grid state.
- A client that is too slow will lose chunks of output in the middle. Re-attaching restores its screen. The PTY reader is never held up with it. That is a deliberate trade-off.
- pi sessions have not been tested against real data. Their parser is generic.

## Other documents

- [PROTOCOL.md](PROTOCOL.md) — the WebSocket protocol, enough to write your own client.
- [TESTING.md](TESTING.md) — the acceptance criteria results, along with what is not tested.
