# sessionhub — configuration and network

Everything in `~/.sessionhub/config.toml`, plus how to reach the daemon from
another device. See [README.md](README.md) for what sessionhub is.

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
autostart = true
```

`command` is run when the terminal is opened. A bare filename that exists in
`project` is run the way the shell needs it (`.\name`) — neither PowerShell nor
`sh` will run a file from the current directory otherwise, and stored as-is it
fails silently into a panel nobody has open. Anything else is left exactly as
written, because a name that is not a file there is meant for the PATH.

`autostart` starts it when the daemon does, without waiting for anybody to open
a tab — which is the point of naming a bot or a dev server in the first place.
It defaults to on, including for entries written before the key existed, and the
⏻ mark on the sidebar row turns it off; a row that will not come up says so
without being hovered. The daemon starts each one once and then leaves it alone:
nothing watches it, and nothing restarts it when it ends.

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

The URL it prints is a throwaway one that changes every run. For an address that
stays put, point a **Cloudflare tunnel of your own** at `localhost:7717` and use
its hostname instead — nothing in sessionhub needs to change, and a stable
hostname is what makes it worth adding to a phone's home screen. Either way the
warning below applies, and so does
[Updates through caches and tunnels](#updates-through-caches-and-tunnels).

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

