# Test results

Environment: Windows 11 Pro 26200, no WSL. Rust 1.96.0, Node 24.19 (only for the
test scripts), Chrome 151 headless over the DevTools Protocol.

**211 unit tests** on Windows and **213 on unix** (`cargo test`; two of them test the PATH merging, which only exists on unix) cover the ring buffer, size
negotiation, backpressure, JSONL parsing, cwd resolution, time formatting, process
tree summation, HTTP and token parsing, cloudflared URL extraction, agent name
filtering, dropped-file sweeping, folder-picker path cleanup, file tree reading,
truncation of large files, percent decoding in HTTP queries, pairing link parsing
along with machine name filtering, the login page shown when no token is present
yet, the path comparison rules that differ per system, release version comparison
and asset picking for self-update, and the shell-input tracker that decides when
it can honestly name the command a terminal is running.

Everything is green on **macOS 26.5.2 (arm64)** too — see
[Cross-platform](#cross-platform).

The acceptance scripts are in [`tests/manual/`](tests/manual). All of them are run
against real data on this machine — 805 Claude Code session files, a real opencode
database — through a read-only junction, so `~/.claude` is never touched.

### Running them

Two things silently turn a healthy script into what looks like a failure, and
both cost an afternoon to find once:

- **The junction has to exist.** The test home has `.claude` pointing at the real
  one; without it `registrycheck` sees no Claude sessions at all and `forktest`
  reports that there is nothing to fork. Recreate it with
  `New-Item -ItemType Junction -Path <testhome>\.claude -Target $HOME\.claude`.
- **Some scripts take the daemon on the command line** — `cwdtest <token>`,
  `forktest <port> <token>`, `newterminal <port> <token>`, and the two helpers
  `survive` and `envdump`. Started bare they wait on a socket that answers 401
  and then die without printing a summary, which reads exactly like a crash.
  (`agentcolor` and `colortest` take a *theme* there, and print only the name of
  the screenshot they wrote — they have no summary line by design.)

A script that drives the browser must also load the page **before** it writes to
`localStorage`: storage belongs to an origin, and the browser is still on
whatever page the previous script left behind. Written too early, the settings
land somewhere this page never reads, and the test then fails on a stored theme
or fold state that it thinks it just reset.

## Acceptance criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Close the tab, open it again → terminal contents intact | **pass** |
| 2 | Two browsers at once → same contents, typing appears in both | **pass** |
| 3 | Second browser is smaller → PTY shrinks to the minimum | **pass** |
| 4 | Close the launching terminal → the daemon stays alive | **pass** |
| 5 | Reboot → the daemon starts automatically via the service | **not tested** |
| 6 | Session from directory A, resumed → `pwd` shows A | **pass** |
| 7 | Wrong token → 401, no WS upgrade, no file leaked | **pass** |
| 8 | Network drops then comes back → reconnects on its own | **pass** |
| 9 | Runs on Windows without WSL | **pass** |

### 1. Sessions survive the client leaving

`multiclient.mjs` — client A creates a terminal and produces output, then its
connection is closed. A new client attaches 2 seconds later and receives the
sequence `bin(id=1,340B) → json(attached)`: the ring buffer contents first,
`attached` after, exactly as the protocol rule says. The marker from before the
drop reappears.

In a real browser (`uitest.mjs`), the Claude Code TUI is drawn intact in xterm
after the tab is clicked, including after the page is reloaded.

> Note: "closing the tab" was simulated by closing the WebSocket connection and by
> reloading the page, not by literally closing a browser tab. At the protocol level
> the two are identical.

### 2. Two clients at once

`multiclient.mjs` — B attaches to the same terminal and receives the same replay.
Typing from A appears on both screens. After B detaches, B stops receiving output.

### 3. Minimum size

`multiclient.mjs` — A at 100×30, B at 80×24 → the effective size drops to
**80×24** and is broadcast to both. The child was confirmed to actually see it,
not just a number in the protocol (`SIZE=80x24` from `$Host.UI.RawUI.WindowSize`).

The per-axis computation was tested too: A 100 columns, B 20 rows → **100×20**, a
size that belongs to neither client. After B detaches, it goes back to 100×30.

From the UI side (`uitest.mjs`): the browser window was made smaller → the grid
went from 21 to 16 rows because the server ordered it, not because xterm stretched
on its own.

> Note: display integrity was judged from the size reported by the child and from
> screenshots inspected by hand (TUI box borders intact). There was no pixel-by-glyph
> comparison.

### 4. The daemon detaches from its launching terminal

`acceptance4.ps1` — **12/12**. `sessionhubd start` was run from a `cmd.exe` with
its own console; the launcher was then killed.

```
[ok] daemon answers status (pid=4920)   its parent pid=23244 (the `start` process, already exited)
[ok] the cmd.exe launcher really is dead
[ok] daemon STILL ALIVE after its launcher died
[ok] sessionhubd status still answers -> terminals : 1 alive of 1 total
[ok] terminal intact, contents replayed, and still accepting new commands
[ok] stop -> process gone, pid file cleaned up, no orphaned PTY
```

The fifth point is what makes the test mean something: after the launcher died,
the terminal was not merely recorded as alive — it was re-attached, its contents
replayed, then given a new command, and it answered.

### 5. Automatic start after a reboot — **not tested**

Installing a Windows Service requires Administrator rights, which were not
available in this testing session. All that was tested is the refusal:

```
Could not install the service: access denied.
  Open a terminal as Administrator and try again.
```

Other parts of this criterion **have** been proven separately: a stored session
shows up as an empty circle, and clicking it runs the agent with the correct
resume flag so its context comes back (`step6.mjs`, via the command palette;
`cwdtest.mjs` for a real agent). What is missing: the service actually installed,
the machine rebooted, and the daemon alive on its own afterwards.

To close that gap, run this from an Administrator terminal:

```
sessionhubd install --account "DOMAIN\name" --password "…"
```

then reboot and check `sessionhubd status`.

### 6. cwd of a resumed session

`cwdtest.mjs` — **4/4**. The daemon runs in `C:\data\code\terminal-editor2`, and a
terminal was created for the project `C:\data\code\haji\2026`:

```
pwd inside the agent : C:\data\code\haji\2026
```

The working directory was asked of **the process itself** (`(Get-Location).Path`),
not inferred from the contents of a transcript — a path that happens to be written
in a conversation proves nothing about the cwd.

A real claude session is then resumed in the same project, and what that step
claims was corrected: it checks that resuming works — the agent starts, writes to
the screen, and the daemon holds it under the session it was asked to continue —
and it no longer claims to check the cwd. It used to scan the screen for the
project path, which passed only while the agent still printed a startup banner;
a resumed agent replays its conversation instead, so that assertion had quietly
become a test of what was in the old transcript.

This is what defuses the `opencode -s` landmine, which can resume a session in
whatever directory the command was run from: the daemon always sets the PTY's cwd
explicitly, for new sessions and resumes alike.

### 7. Token

`wsclient.mjs` and HTTP checks:

```
[ok] no token -> 401
[ok] wrong token -> 401
[ok] correct token -> 200
[ok] WS with a wrong token rejected before the upgrade
GET /app.js without a cookie -> 401
GET /../Cargo.toml           -> 404
```

The token is checked before the WebSocket handshake is upgraded, so a client can
tell a wrong token from a dropped connection. Static assets are protected by the
cookie that is set when `/?token=…` is opened, because a `<script>` tag cannot
carry a token from localStorage.

Rotation (`rotate.ps1`, **9/9**): the old token is rejected with 401 immediately,
the new one is accepted, and running terminals survive without a daemon restart.

`cookietest.mjs` — **18/18**, the sign-in cookie, which had **no test of any kind**
before: the header was written out twice by hand and never asserted, and the
cookie-only path — how every asset and every `/api/file` image really
authenticates once a page is open — was never exercised.

```
[ok] the cookie outlives the browser (Max-Age=34560000)
[ok] arriving by a link still carries it (SameSite=Lax)
[ok] an asset authenticates on the cookie alone (200)
[ok] and on nothing at all it is refused (401)
[ok] /api/status does not hand out a cookie (200)
[ok] and stored it as a persistent one, not a session one (session=false)
[ok] with a real expiry well in the future (2027-09-21)
```

The last three matter most. Only a page load should mint a credential — an API
call carrying a token in the query has no business leaving one in the jar. And
the header could say `Max-Age` while the browser still treated it as a session
cookie if the syntax were wrong, so the browser is asked what it actually
stored rather than trusted to have read it the way we meant.

> The bug this covers: the cookie had no expiry, so it died with the browser.
> The next visit was the sign-in page — and the token sitting in `localStorage`
> could not help, because `app.js` is behind the same gate and never ran. The
> stored token was unreachable by the only code able to read it.

### 8. Reconnect

`connlogic.mjs` — **9/9**, the reconnect module tested against a real daemon:

```
[ok] the drop is detected
[ok] reconnects on its own within 468ms, with no intervention
[ok] the server resends state after reconnecting
successive backoffs: 500, 1000, 2000, 4000   (stops at 8s, resets after a success)
```

`bannertest.mjs` — **9/9**, from the UI side: the daemon was genuinely stopped and
the "Connection lost, reconnecting…" strip appeared; the daemon was started again,
the strip disappeared on its own within 2.1 seconds and the sidebar filled back in
without a manual refresh.

`reconnect.mjs` — **8/8**, the same thing from the screen's side: a terminal is
opened and written to, its socket is closed underneath it, the strip appears, and
the screen comes back with its contents replayed once, not twice.

> Note: Chrome's offline emulation does **not** apply to loopback connections —
> the first attempt used that approach and it turned out not to break anything. So
> the disconnection was done for real: the socket was closed, and the daemon was
> stopped. No physical network cable was ever unplugged.
>
> This bites harder than it looks. `reconnect.mjs` kept the offline approach long
> after the note was written, and it did not fail: with nothing disconnected the
> banner never appeared, and "reconnects by itself" passed in 0.0 s because there
> was nothing to reconnect. The script now wraps `window.WebSocket` before the
> page loads so it can close the real socket — the client has no heartbeat and
> learns of a broken link from `onclose` alone, so nothing short of closing the
> transport reaches the code being tested.

### 8b. Reading back through a session on a phone

**Where the history actually is.** This was built once on a wrong premise, and
the correction is the most useful thing in this section. An agent runs on the
**alternate screen** — `?1049h`, read straight out of the raw PTY bytes — where a
terminal keeps **no scrollback at all**. `term.scrollLines()` has nothing to
move, and `baseY` never leaves 0, so a control keyed on scrollback would never
even appear in the one case it was written for.

The history belongs to the **program**, and the only way to ask for it is the way
a wheel does. That is precisely why a mouse works on a laptop and a finger did
not: xterm forwards wheel events to a mouse-reading program, and a phone has no
wheel. So both the drag and the buttons now send synthetic `wheel` events, which
xterm encodes in whichever mouse protocol the program asked for.

`agentscroll.mjs` — **8/8**, against a real resumed Claude Code session:

```
[ok] the agent takes the alternate screen (?1049h) — no terminal scrollback exists
[ok] and it turns mouse tracking on, which is what disables xterm's own touch scrolling
[ok] the terminal itself has nothing to scroll — the history is the agent's
[ok] tapping "back" makes the agent redraw — it scrolled its own history
[ok] holding "back" keeps moving through the history (4 distinct screens in 4)
```

The premise is asserted, not assumed: if an agent ever stops taking the alternate
screen, that test fails first and says so. What it deliberately does **not**
assert is that a screen back followed by a screen forward lands where it started
— where those land is Claude Code's decision, and pinning it here would be
testing somebody else's scrolling.

A plain shell is the other world: it leaves its history in the terminal's own
scrollback, so there the buttons move the view and the count of how far behind
you are can be exact. That case is `touchscroll.mjs` below.

`touchscroll.mjs` — **17/17**, driven with real touch events through
`Input.dispatchTouchEvent` against a terminal holding 300 lines of scrollback.

Two things do this job. The **scrollback control** (`web/scrollpad.js`) is the
part that can be tested properly, because it is driven from its own buttons
rather than from a gesture: at the live end it offers only "back"; a tap is a
**nudge of three rows** — a screen per tap was the first design, and in use it
tore the reader away from the passage they were following — while the **hold**
covers distance (measured: 64 rows in ~1.3 s, stopping the moment the finger
lifts); the pill counts how far behind you are and one tap on it returns to the
latest output. A tap on the terminal itself still scrolls nothing, and the page
never moves under any of it.

The **drag** (`web/touchscroll.js`) is deliberately not asserted there. It only
takes over from xterm while the program is tracking the mouse — which is exactly
when xterm gives up on touch itself:

```js
on('touchmove', e => { if (!coreMouseService.areMouseEventsActive) … })
```

That condition cannot be produced here. ConPTY does not forward `?1000h` from an
ordinary program — measured, from PowerShell and from `node -e` alike, and the
bytes never reach the client — and an agent resumed to set the mode redraws
inside the window without filling the scrollback, so there is nothing left to
scroll. Asserting a drag against a plain shell would only measure xterm's own
touch scrolling, which is flaky under synthetic touch events and says nothing
either way about the code here; an earlier version of this test did exactly that
and went green, then red, on the same unchanged code. Two halves were checked by
hand instead:

- a real Claude Code session reports `mouseTrackingMode: 'any'`, so the condition
  the module keys on is the one that occurs in practice, and a plain shell
  reports `none`, so it stays out of xterm's way there;
- with the gate forced open, the same checks passed against the module's own
  scrolling, including the fling decaying frame by frame
  (`-20.19 → -18.98 → -17.84 …`).

The window it runs in is **900×780 with touch**, not phone-sized, and that is on
purpose — a tablet in landscape is the same case, because the control keys on the
pointer and not on the width. Narrower than 720 px the sidebar becomes an overlay
and opens by itself while nothing is attached yet, and its backdrop then covers
the terminal: every tap landed on that instead of on the button, and the test
failed about half the time saying the button did nothing. Shrinking this window
brings that back.

Each tap also re-measures its target and checks `elementFromPoint` still returns
it before dispatching. The key bar settles its height shortly after the page
draws, which moves everything inside the terminal; coordinates measured a moment
earlier land on a line of output instead.

**The laptop case is not covered, and cannot be here.** This headless Chrome
reports `pointer: coarse` unconditionally — `navigator.maxTouchPoints` is 10 with
no emulation at all, and asking for `pointer: fine` through
`Emulation.setEmulatedMedia` changes nothing. Measured in all three states:

```
clean            coarse:true fine:false maxTouchPoints:10
forced coarse    coarse:true fine:false maxTouchPoints:10
forced fine      coarse:true fine:false maxTouchPoints:10
```

The obvious assertion is also a trap, and was briefly in the file passing for the
wrong reason: `!document.querySelector('.spad')` goes green whenever no terminal
is on screen, which is most of the time just after a reload. It said "no control
with a mouse" while proving only that nothing was attached. The test now prints
what it measured and skips, rather than reporting a green it did not earn.

**How the drag moves the program.** One `wheel` event per animation frame,
carrying the pixels the finger has travelled since the last one — not a whole
number of notches. Notches were the first attempt and are why it felt broken up:
a notch is three rows, about 63 px, so the first 63 px of every drag did nothing
and the screen then jumped three rows at once. Per-frame batching matters for the
other half of it — the agent redraws its whole screen for every wheel report it
receives, and a raw touchmove stream is 120 a second.

### 8c. Updating itself

`updateui.mjs` — **7/7**. The Update section asks the real releases API for this
repo and reports what it found. The assertion that matters is a negative one: a
daemon already on the newest release must NOT be offered an install button,
because pressing it restarts the daemon and kills every live terminal for
nothing.

The half that actually replaces the binary cannot be tested from inside the
suite — it ends the daemon the test is talking to. It was verified separately,
end to end, with a throwaway daemon built as **0.0.0** in its own folder and its
own home on port 7725:

```
[ok] the test daemon starts as 0.0.0
[ok] an older daemon is offered the newer release
[ok] the first click only arms it ("Click again to install")
[ok] and nothing has been installed yet
[ok] it restarts into the release: 0.0.0 -> 0.0.1
[ok] the binary it replaced is kept alongside, so a bad update can be undone
[ok] and the updater script cleans itself up
```

Nothing there is mocked: it downloaded the published 0.0.1 asset from GitHub,
swapped its own binary and came back answering as 0.0.1.

That run is also what caught the real bug. The first attempt swapped the binary
correctly and then failed to come back, with `error 10048` in the log: sending
`Cmd::Shutdown` ends the terminals but leaves the process alive holding the
port, so the new binary could not bind it. The handler now takes the same road
`sessionhubd stop` does — shutdown, remove the pid file, exit — and the swapper
script refuses to touch anything if the old pid is somehow still alive, rather
than installing a binary that cannot start.

> Note: `pty::resolving_never_shells_out` used to be
> `resolving_is_fast_enough_to_run_on_every_panel_open`, and measured the TOTAL
> time of twenty calls — which made it a measurement of the machine as much as of
> the code. It went red three times during unrelated work, always while a build
> ran in parallel, and always passed alone a moment later. It now takes the
> FASTEST of the twenty: load can make any single call slow, but it cannot make a
> call that spawns a process finish in microseconds, so the best case is the
> honest signal. Verified red-free with four busy cores.

### 8d. Terminals that outlive the daemon

`savedterm.mjs` — **29/29**. The feature is entirely about what survives a
restart, so the test restarts the daemon rather than approximating it: a real
shell is opened in a project, a real batch file typed into it by dispatching
keystrokes, the terminal named, the daemon stopped and started again, and then
the saved row is clicked and the script has to actually run — proven by the file
it writes on disk, not by what the screen says.

```
[ok] it already holds the command that was typed (".\@run-bot.bat")
[ok] it is written to config.toml, not just held in the page
[ok] only one terminal wears the name (1)
[ok] the daemon is stopped — every terminal in it dies
[ok] the saved terminal is still listed after the restart
[ok] clicking it opens the shell and runs the command by itself
[ok] the script really ran — it left its mark on disk
[ok] opening it again attaches instead of starting a second copy (1)
[ok] one click on ✕ forgets nothing — it only arms
```

Two things this run caught that unit tests could not.

**Focus reports poisoned the command capture.** The daemon watches PTY input so
that naming a terminal can offer the command it is running, and any escape
sequence marks the tracked line untrustworthy — an arrow key edits the line
where the daemon cannot see it. But xterm also sends `ESC[I` / `ESC[O` whenever
the browser tab gains or loses focus, so in a real browser the capture was
almost never trusted, and the command box kept arriving empty. The parser now
separates the terminal *reporting about itself* (focus, mouse, cursor position,
device attributes — ignored) from the user *editing the line* (arrows, Tab,
Delete — still poisons it). No unit test would have found this: they fed the
tracker exactly the bytes I believed a keyboard sends.

**A name stuck to two terminals at once.** Saving terminal B under a name
terminal A already wore left both claiming it, so the sidebar drew the same row
three times and `live_terminal_id` picked whichever the map yielded first. Found
by looking at a screenshot of the sidebar, not by a failing assertion — which is
why the test now asserts it.

The test also measures the row on a 390 px phone. A saved row carries more than
any other (name, agent badge, command), and the command is the part that grows
without limit; a settings panel once reached 1100 px inside a 420 px viewport
while every DOM-level assertion still passed, so this one checks geometry rather
than trusting a click.

One deliberate non-feature, worth stating so nobody looks for it: a saved
terminal is a note about how to start something, not a supervisor. Nothing
restarts it by itself and nothing starts it when the daemon boots.

### 8e. Colouring a tab

`tabcolor.mjs` — **24/24**. The test opens two terminals in the *same* project so
their tabs read identically, and asserts that they do before touching anything —
otherwise it would be proving a colour works on tabs that were already
distinguishable, which is not the case the feature exists for.

Four things beyond "the attribute is set":

```
[ok] the colour is actually painted, not just recorded in an attribute
[ok] a coloured bar is drawn down the panel's side (3px, rgb(31, 122, 133))
[ok] and the terminal starts after it, so column one is not clipped (3px)
[ok] the same terminal wears the tag in the sidebar too
[ok] a second client is told about it — so the phone and the laptop agree
[ok] a colour outside the palette is refused
[ok] the saved terminal still wears its colour after the restart
```

The paint check reads `getComputedStyle` rather than the attribute: the tag is
drawn through a `--tag` custom property that resolves per theme, and a typo in
the palette selectors would leave `data-color` set and nothing visible. The
second-client check opens its own WebSocket, which is what proves the tag lives
on the daemon rather than in one browser's `localStorage`.

The refusal test sends `red; background:url(x)`. The value is handed to the page
as an attribute, so the daemon whitelists it — `config::TAB_COLORS` — instead of
storing whatever arrives.

Two things this found:

**Named terminals still showed as `savedproj · terminal` on their tabs.** The
sidebar had been showing the name since saved terminals were added; the tab label
was still derived from project and agent alone. Caught by looking at a screenshot
of the tab strip — four tabs, two of them named, all four reading alike. The
label now prefers the name, and the test asserts it.

**A stray NUL byte in `sidebar.js`.** A scripted edit put `\0` where a space
belonged, inside `bucketKey` — which builds the key for remembering which day
groups are folded. Every key would have changed, silently resetting everyone's
folds. `grep` reporting the file as binary is what gave it away; the file is now
checked for control bytes after scripted edits.

### 8f. Pasting into a dialog, and where a working folder sits

Both of these came from the author using the features the day they were built,
not from a test suite.

`dialogpaste.mjs` — **11/11**. The Save-terminal dialog asks for a command, which
is exactly the kind of thing you paste rather than retype. The key bar's Paste
button always targeted the active terminal, so with the dialog open the clipboard
went into the shell behind it: invisible, and typed into a terminal nobody was
looking at. On a phone that button is the only way to paste at all, which made
the field unfillable.

```
[ok] nothing in the app swallows a paste aimed at the dialog
[ok] pressing it fills the focused field, not the terminal behind the dialog
[ok] and nothing was typed into the terminal behind it
[ok] with nothing focused but the terminal, Paste still goes to the terminal
```

The last one matters as much as the fix: aiming at the focused field must not
break the ordinary case, where the terminal is what has focus.

The clipboard read itself is stood in for. `readText()` needs a trusted user
gesture and a dispatched `pointerdown` is not one — the browser refuses, and the
app says so correctly. What changed, and what is checked here, is *where* the
text goes once it arrives.

Two things the run corrected in the test rather than in the app: the key bar
listens on `pointerdown`, not `click`, so `.click()` did nothing; and Ctrl+V was
never broken — the app's global key and paste handlers already stand aside while
a dialog is open.

`projorder.mjs` — **7/7**. Projects are ordered by their newest agent session,
and a plain shell is not a session, so a folder with no agent history sank to the
very bottom the moment a terminal was opened in it — the hardest place to find it
at exactly the moment it was being used.

```
    before:  alpha, beta, data
    running: data, alpha, beta
    saved:   data, alpha, beta
    forgot:  alpha, beta, data
```

The fixture registers the sessionless folder **last**, so registry order alone
would leave it last and the old behaviour fails loudly. The sort only decides a
band and is stable, so the registry's own ordering by date survives inside each
band — asserted, because a sort that also scrambled the rest would pass a naive
"is it first?" check.

While running the suite afterwards, `sidebarui` went red on "emptying it restores
the original title" — and the cause was neither flakiness nor the app: it runs
against the author's own daemon, which by then held two saved terminals, and a
named terminal wears the same marker a renamed session does. That is deliberate —
a name you chose has to look like a name wherever its row appears — so the
assertion was narrowed to the alias actually under test.

### 9. Windows without WSL

Every test above runs natively on Windows 11. The PTY uses ConPTY through
`portable-pty`; no unix path is executed.

## Other tests beyond the acceptance criteria

| Script | Result | Coverage |
|---|---|---|
| `bigreplay.mjs` | 5/5 | The ring buffer at its 2 MB limit: a replay of exactly 2.00 MB in a single frame, with the oldest lines discarded |
| `registrycheck.mjs` | 20/20 | The registry of three agents over real data, the file watcher, debouncing |
| `memtest.mjs` | 7/7 | Memory samples per terminal, dead terminals not reported |
| `memtree.mjs` | 2/2 | RSS includes the children: 1 → 7 processes, 70 MB → 277 MB |
| `uitest.mjs` | 18/18 | xterm, replay, size negotiation from the UI, the RAM button |
| `step6.mjs` | 23/23 | The command palette, the three-state theme, Ctrl+K/B/1..9 |
| `step6b.mjs` | 7/7 | Ctrl+W detaches (the process stays alive) vs Ctrl+Shift+W kills |
| `sidebartest.mjs` | 48/48 | Sidebar filtering, collapse/expand all, bookmarks, the left arrow collapsing while the project name moves the focus, searching by parent folder name along with the marker that says why, the narrow layout |
| `fuzzytest.mjs` | 15/15 | Fuzzy ranking |
| `lantoggle.mjs` | 13/13 | The network access switch over WS: the second listener really is opened and then closed, loopback untouched, live terminals not disconnected, `config.toml` changed along with it |
| `filestest.mjs` | 35/35 | The file tree over the protocol: one level per request, folders-then-files ordering, binary files with no contents sent, a 2 MB cut at a line boundary, saving refusing to create a new file, `GET /api/file` for images along with its refusals |
| `filesui.mjs` | 88/88 | The file panel in the browser: Monaco proven not to be downloaded before the first file is opened, 2,000 entries becoming ~50 DOM elements, icons per file type, a tab per file, a separate editor theme, images actually drawn, only one project shown along with its picker, Explorer as a fixed column left of the editor, clicking a project name in the sidebar moving the focus, relative folder trails, editing and then saving to disk |
| `gridtest.mjs` | 23/23 | Grid mode: every live terminal shown at once in a 2×2 without overlapping, each panel negotiating its own PTY size, the active panel marked, the choice surviving a reload; plus the sidebar row for terminals without a session |
| `tabstest.mjs` | 9/9 | The terminal tab bar when full: no tab overlapping its neighbour, long titles cut with an ellipsis, the right-hand button staying on screen, the active tab brought into view |
| `browsetest.mjs` | 40/40 | The folder picker over the protocol: directories only, `..` cleaned up, a folder name that cannot become a path, adding/removing projects and the effect in the sidebar |
| `pickerui.mjs` | 37/37 | The "New project" flow from the browser: browse, create a folder and enter it, make it a project and watch it appear in the sidebar, remove it again, and the last folder surviving a reload |
| `agentcrud.mjs` | 23/23 | Adding/removing agents over the protocol: a self-made agent can be spawned, nonsensical names rejected, `terminal` cannot be removed, removing does not kill running terminals |
| `agentui.mjs` | 28/28 | The add form in Settings, removal with a two-click confirmation, `pi` removed and then gone from the `+` menu and addable again |
| `droptest.mjs` | 24/24 | File upload over WS: bytes intact, names filtered (path traversal rejected), oversized files rejected without dropping the connection, sweeping by age, the grace period for the size limits, `0 = no limit` |
| `dropui.mjs` | 23/23 | The drop zone, dropping and pasting from the page, the path typed without Enter, a missed drop not navigating the page, the limits panel in Settings |
| `lanui.mjs` | 16/16 | The Network access row in the Settings panel: off/on states, a ready-to-copy URL that really does answer 200, the contents of its warning |
| `remotetest.mjs` | 34/34 | Two real daemons, the whole flow over `?via=`: half-finished links and wrong tokens rejected before anything is stored, pairing with itself rejected, then spawn/type/resize, the file tree and files that **exist only on the remote machine**, saves that really do change its disk, images over `/api/file`, the remote machine's settings; raw addresses rejected (not an open proxy), unregistered names rejected while naming the name, `forget` removing its token from the config |
| `keybarui.mjs` | 20/20 | The key bar on a 390×844 phone screen: appearing only when there is a terminal, stuck to the bottom, every key ≥32px, the arrows calling up real shell history, a sticky Ctrl turning the next letter from the on-screen keyboard and then releasing itself, and no keys that are meaningless to a PTY |
| `remoteui.mjs` | 31/31 | The machine tab bar in the browser: a paste dialog with no Connect button, the machine tab appearing on its own once connected, switching tabs swapping the entire window contents, remote-machine projects never leaking into the local machine's tab, terminals landing in their own machine's container, **the remote machine's token present in neither `localStorage` nor the DOM**, `✕` dropping it |

## Cross-platform

The macOS binary was built and tested on a real machine (Mac mini, Darwin arm64,
macOS 26.5.2): `cargo build --release` clean, `cargo test` **163/163**, and the
`start` → `status` → `stop` cycle ran through in full — the daemon detached,
reported correctly, then stopped cleanly in 0.4 seconds.

Real use there found a second bug, and this one would never show up on Windows: a
daemon detached from the terminal inherits the PATH `/usr/bin:/bin:/usr/sbin:/sbin`,
so `claude` and `opencode`, installed in `~/.local/bin` and nvm, were reported as
"not found on PATH". The login shell's PATH is now fetched once at start;
afterwards both are detected at the right path, and only `pi` — which genuinely is
not installed — is still reported missing.

Five tests went red there and **one of them found a real bug**: `path_key` only
folded case `if cfg!(windows)`, so on macOS one and the same folder appeared as two
projects as soon as the spelling differed — even though APFS is case-insensitive by
default. The rule is now split per system (folded on Windows and macOS, not on
Linux, which really is case-sensitive), and the test demands all three. The other
four were only Windows-style fixtures (`C:\..`) which on unix really are a single
file name; the code was already correct because `normalize` uses the
platform-aware `Path::components()`.

## What is not tested

- **The Windows service and starting after a reboot** (acceptance #5), as above.
- **`sessionhubd tunnel` directly.** Running it exposes this machine's shell to the
  internet, so it was not run without an explicit request. What was tested: URL
  extraction from cloudflared's output (7 unit tests, including ignoring the
  documentation URL in the log), the install message when cloudflared is missing,
  and the presence of `cloudflared 2026.7.3` on this machine's PATH.
- **The operating system's own drag layer.** Drops were tested with real
  `DragEvent` and `DataTransfer` objects generated inside the page, so the whole
  application path is exercised — handler, upload, storage, right up to the path
  arriving in the terminal. All that is untested is the handover of a file from
  Explorer/Finder to the browser window. The same goes for pasting: the
  `ClipboardEvent` was constructed by hand, it did not come from the system
  clipboard.
- **Two real machines over a network.** The relay was tested with two daemons on
  one machine (ports 7719 and 7721, separate `--home`), so all of its logic is
  exercised, but real latency, reconnecting when Wi-Fi drops, and the behaviour over
  a VPN have not been observed.
- **The key bar on a laptop.** The rule leans on `pointer: coarse`, and headless
  Chrome here reports a coarse pointer permanently — `mobile: false`,
  `clearDeviceMetricsOverride`, `setTouchEmulationEnabled(false)`, and
  `setEmulatedMedia` with the `pointer` feature all fail to change it (the last one
  is accepted but ignored). So every screen in the test environment looks like a
  touch screen, and "the bar and the ⌨ button disappear on a laptop" can only be
  checked by hand. What is tested automatically: the bar appears and works on a
  touch screen, and the rule really does read the pointer type, not just the width.
- **A real touch device.** The narrow layout was tested through Chrome's 390×844
  emulation. The on-screen keyboard, the `100vh` change when the keyboard appears,
  and iOS Safari gestures have not been touched.
- **The pi agent.** It is not installed on this machine; its session parser is
  generic and only tested against synthetic JSONL files.
- **Linux and macOS.** The `setsid` detach code and the systemd/launchd generators
  are only tested through unit tests on the functions that build the files, never
  executed.
- **Long-running load.** The longest test is a few minutes; memory leaks or thread
  build-up after days have not been observed.

## Findings that changed the design

Four things that only came to light because they were tested against real data and
real systems:

1. **ConPTY sends `ESC[6n` at start and waits for an answer.** Without a reply the
   shell draws nothing — a terminal with no client attached would hang forever. The
   daemon answers it itself and strips that sequence out of the stream to the
   client, so that xterm.js does not answer as well and the child does not receive
   two replies.

2. **Killing the child does not close the ConPTY.** The reader thread stays hung in
   `read()` even after the process is dead, so `kill` never produced an `exit`.
   Exit is now detected from the process through a separate waiter thread, with
   `ChildKiller` as a dead handle that does not need to wait.

3. **740 of the 805 files in `~/.claude/projects` are subagent transcripts.** Their
   file names are not valid session ids — the `sessionId` inside them points at the
   parent session — so `claude --resume <file-name>` will not work. Before they were
   filtered out, 88.5% of the sidebar rows were junk with fallback titles.

4. **The spec's assumption about `cwd` does not hold.** The spec says `cwd` is on
   the first line of the JSONL file; in Claude Code today the first line is only
   session metadata and `cwd` first appears on the fourth line. Following the spec
   literally left the registry completely empty.
