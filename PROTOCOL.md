# sessionhub protocol

Enough to write your own client. Everything goes over a single WebSocket
connection.

## Connecting

```
GET /ws?token=<token> HTTP/1.1
Upgrade: websocket
```

The token is checked **before** the upgrade. A wrong token gets a plain `401` —
there is never an upgrade followed by a close, so a client can tell "wrong token"
apart from "connection dropped".

One connection per client tab/application. Several clients may attach to the same
terminal at the same time.

### Via another machine

```
GET /ws?token=<local token>&via=<machine name>
```

The local daemon connects to the machine with that name using the token stored in
its own `config.toml`, and then **pumps the frames through as they are** in both
directions. Not a single frame is interpreted, so the entire protocol on this page
applies exactly the same through `via=` as it does without it — including binary
frames, ring buffer replay, and file drops.

What a client needs to know:

- `via=` only accepts **registered names**, not addresses. An arbitrary address
  gets a `404`; otherwise your daemon would be an open proxy.
- An unregistered name gets a `404` that **names the name**.
- There is no chaining: the relay never forwards `via=` any further.
- The token the client carries is still the **local** token. The remote machine's
  token never leaves the local daemon.
- If the local daemon dies, every remote connection goes down with it. This is the
  bet that was deliberately taken so that the browser holds only one token.

## Two kinds of frame

| Frame | Contents |
|---|---|
| **text** | Control, JSON, always has a `t` field |
| **binary** | Terminal data |

Binary frames, in both directions, have the same shape:

```
byte 0..4   terminal id, u32 little-endian
byte 4..    raw bytes (keyboard input to the PTY, or PTY output to the client)
```

There is no other framing. The bytes really are raw, ANSI escape sequences
included.

One exception, from client to server only: the id `0xFFFFFFFF` marks a dropped
file rather than keystrokes. That id can never be a real terminal, so the two can
share a single frame kind — and the file needs no base64, which would inflate a
3 MB screenshot into 4 MB.

```
byte 0..4    0xFFFFFFFF
byte 4..8    terminal id, u32 LE — only to decide where the path is answered to
byte 8..10   name length, u16 LE
byte 10..    UTF-8 file name, then the file contents
```

The name is filtered again on the daemon side; directory separators and `..`
cannot possibly survive, so the file always lands inside `~/.sessionhub/dropped/`.
The answer is `{"t":"dropped",…}`, or `error` with the code `drop_failed`.

## Client → server

```jsonc
{"t":"list"}
{"t":"spawn","project":"C:\\data\\code\\notex","agent":"claude",
 "resume":"<session-id>|null","cols":120,"rows":32}
{"t":"attach","id":3,"cols":120,"rows":32}
{"t":"detach","id":3}
{"t":"resize","id":3,"cols":120,"rows":32}
{"t":"kill","id":3}
{"t":"mem"}
{"t":"config"}
{"t":"set_agent","name":"claude","command":"claude",
 "resume_args":["--resume","{session_id}"],
 "fork_args":["--resume","{session_id}","--fork-session"],"enabled":true}
{"t":"remove_agent","name":"pi"}
{"t":"browse","path":"C:\\data\\code"}
{"t":"make_dir","parent":"C:\\data\\code","name":"new-project"}
{"t":"add_project","path":"C:\\data\\code\\new-project"}
{"t":"remove_project","path":"C:\\data\\code\\new-project"}
{"t":"tree","path":"C:\\data\\code\\notex"}
{"t":"open_file","path":"C:\\data\\code\\notex\\src\\main.rs"}
{"t":"save_file","path":"C:\\data\\code\\notex\\src\\main.rs","text":"fn main() {}\n"}
{"t":"set_lan_access","enabled":true}
{"t":"set_drops","max_age_hours":24,"max_total_mb":100,"max_file_mb":20}
{"t":"sweep_drops"}
{"t":"remotes"}
{"t":"pair","link":"sessionhub://10.8.0.4:7717/pair#token=…","name":"office"}
{"t":"forget","name":"office"}
```

- `resume` may be omitted; that means the same as `null` (a new session).
- `cols`/`rows` of 0 are raised to 1 — clients often report 0 while their layout
  is not finished yet, and that must not drag the PTY down with it.
- `resize` from a client that is not attached is ignored.
- `spawn` attaches the sender straight away, so no follow-up `attach` is needed.
- `set_agent` and `set_lan_access` write to `config.toml` and are then always
  answered with the latest `config`, so a client never has to guess what was
  stored.
- `set_agent` with a name that does not exist yet **creates** a new agent — this is
  how you add your own harness. New names are filtered (`[a-z][a-z0-9_-]*`, at most
  24 letters); names that already exist in the config are not filtered, so that a
  newly introduced rule does not lock up an old setup.
- An omitted `fork_args` means "do not touch what is stored"; an empty list means
  that agent genuinely cannot fork. A new agent starts from an empty list, not from
  a guess.
- `remove_agent` removes it from the config only: terminals currently running with
  that agent stay alive. `terminal` is rejected, because it is rebuilt on every
  start.
- `browse` with an empty `path` starts from the home directory. Only directories
  are reported — this is a folder picker, not a file explorer — and `.`/`..` are
  cleaned up before the disk is touched.
- `make_dir` takes **a single name**, not a path: directory separators, `..`, and
  characters forbidden on Windows are rejected. The answer is the contents of the
  newly created folder, so "create then enter" takes just one message.
- `add_project` writes to `config.toml` and then wakes the registry, so the new
  project appears in the next `state` without waiting for the periodic sweep.
- `remove_project` only applies to entries recorded in `projects`; ones discovered
  from agent sessions are answered with `unknown_project` because they would come
  back on their own.
- `tree` returns **one level**: folders and then files, both sorted
  case-insensitively. Subfolder contents are not included — the client asks again
  when that folder is opened. Above 5,000 entries the list is cut and `truncated`
  is set.
- `open_file` rejects folders, marks binary files without sending their bytes, and
  cuts files over 2 MB at a line boundary (`truncated`). Images are marked `image`
  as well; the client fetches their contents from `GET /api/file`, not over this
  connection.
- `save_file` only overwrites files that **already exist**; a path that does not
  exist is answered with `save_failed` instead of quietly creating it.
- `set_lan_access` takes effect immediately: loopback is untouched, what is opened
  or closed is only the second listener, and live terminals are not disturbed.
- `pair` calls that machine's `/api/status` **first**, so a wrong token or a
  differing version is caught before anything is stored. The link forms accepted
  are: `sessionhub://host:port/pair#token=…`, `http(s)://`, `ws(s)://`, or
  `host:port#token=…`; `?token=` may also stand in for `#token=`. Half-finished
  ones — no token, no port, port 0 — are rejected before any connection is made.
- An empty `name` means the name is taken from the address (`10.8.0.4` →
  `10-8-0-4`). A name already used by another machine gets a suffix, never a silent
  overwrite. Pairing **the same address** twice updates its token and keeps the old
  name, so that an open tab does not move.
- Pairing this daemon's own address is rejected, with the reason given.
- `forget` is the only thing that removes that machine's token from the config.
- All three are answered with `remotes`, which **never contains tokens** — only the
  name, the address, and the version that machine reported when it was paired.

## Server → client

```jsonc
{"t":"state","scanning":false,"agents":["claude","opencode","pi"],
 "projects":[
   {"path":"C:\\data\\code\\notex","name":"notex","exists":true,"sessions":[
     {"agent":"claude","session_id":"a1b2…","title":"study the existing sessi…",
      "updated_at":"2026-08-07T09:12:00Z","live_terminal_id":3}
   ]}
 ],
 "terminals":[{"id":3,"project":"C:\\data\\code\\notex","agent":"claude",
               "alive":true,"cols":120,"rows":32,"session_id":"a1b2…"}]}

{"t":"attached","id":3,"cols":120,"rows":32}
{"t":"size","id":3,"cols":100,"rows":30}
{"t":"exit","id":3,"code":0}
{"t":"error","code":"spawn_failed","message":"…"}
{"t":"mem","terminals":[{"id":3,"rss_bytes":420000000,"processes":4}]}

{"t":"dropped","id":3,"path":"C:\\Users\\…\\.sessionhub\\dropped\\1786…-shot.png",
 "name":"1786…-shot.png","bytes":184320}

{"t":"config","config_path":"C:\\Users\\…\\.sessionhub\\config.toml",
 "agents":[{"name":"claude","command":"claude","resume_args":["--resume","{session_id}"],
            "fork_args":["--resume","{session_id}","--fork-session"],
            "enabled":true,"is_terminal":false,"resolved":"C:\\…\\claude.exe",
            "removable":true,"live":1}],
 "shells":[{"label":"Windows PowerShell","command":"powershell.exe"}],
 "lan_access":true,"lan_url":"http://192.0.2.10:7717/?token=…"}

{"t":"tree","path":"C:\\data\\code\\notex","truncated":false,
 "entries":[{"name":"src","path":"C:\\data\\code\\notex\\src","is_dir":true,"size":0},
            {"name":"main.rs","path":"C:\\data\\code\\notex\\main.rs","is_dir":false,"size":412}]}

{"t":"file","path":"C:\\…\\main.rs","name":"main.rs","text":"fn main() {}\n",
 "binary":false,"image":false,"truncated":false,"size":412,"modified_ms":1786694118700}

{"t":"saved","path":"C:\\…\\main.rs","modified_ms":1786694119020}

{"t":"remotes","remotes":[{"name":"office","addr":"10.8.0.4:7717","version":"0.1.0"}]}

{"t":"dir","path":"C:\\data\\code","name":"code","parent":"C:\\data",
 "is_repo":false,"is_project":false,"truncated":false,
 "entries":[{"name":"notex","path":"C:\\data\\code\\notex","is_repo":true,"is_project":true}],
 "roots":[{"name":"Home","path":"C:\\Users\\name","is_repo":false,"is_project":false},
          {"name":"C:","path":"C:\\\\","is_repo":false,"is_project":false}]}
```

`state` is sent unprompted every time the registry or the terminal list changes;
a client never has to poll. `scanning: true` means the first session scan has not
finished — an empty project list at that moment means "not known yet", not "there
are none".

`exists: false` marks a project whose directory has disappeared. Its sessions stay
listed; only spawning into it will be rejected.

`live_terminal_id` holds a terminal id if that session is currently live — this is
the difference between "just attach" and "respawn with the resume flag".

### Error codes

| `code` | Meaning |
|---|---|
| `unknown_agent` | No such agent name in `config.toml` |
| `bad_project` | The project directory does not exist |
| `command_not_found` | The agent's command was not found on PATH |
| `spawn_failed` | The PTY could not be opened |
| `no_such_terminal` | Unknown terminal id |
| `bad_agent` | The agent name or command is empty |
| `config_write_failed` | `config.toml` cannot be written |
| `no_network` | Network access was requested, but this machine has no LAN address |
| `lan_failed` | The network listener could not be opened (e.g. the port is taken) |
| `browse_failed` | The folder cannot be opened, or is not a folder |
| `mkdir_failed` | Invalid folder name, or it already exists |
| `duplicate_project` | That folder is already registered as a project |
| `unknown_project` | Not in `projects`; discovered from an agent session |
| `tree_failed` | The folder cannot be read |
| `open_failed` | The file cannot be opened, or turned out to be a folder |
| `save_failed` | The file does not exist, is read-only, or could not be written |
| `pair_failed` | Invalid link, the machine did not answer, its token was rejected, its version differs, or it is this machine itself |
| `unknown_remote` | There is no machine by that name |

`message` is always a sentence a user can read, never a raw code.

## Attach rules

The order is binding, and clients may rely on it:

1. The client sends `attach`.
2. The server sends **the ring buffer contents as a single binary frame** — before
   anything new.
3. The server sends `{"t":"attached"}` with the effective size at that moment.
4. Only after that does the live stream begin.

Without step 2, opening from another device would show nothing but a blank screen
until new output arrived — which is precisely the main use case. A client that
re-attaches after a drop should clear its screen first, because the ring buffer
contents will be drawn again in full.

The ring buffer keeps **the last 2 MB** per terminal. A replay frame can be that
large in a single message.

## Size rules

Every client has its own size. The PTY size that applies is the **smallest cols
and the smallest rows** across all attached clients — computed per axis, so the
result may be nobody's size in particular (client A at 120×24 and B at 80×40
produce 80×24).

After a recomputation, `{"t":"size"}` is broadcast to every attached client, but
only if the size actually changed. Larger clients show the remainder as empty
space — do **not** stretch the terminal, because the reflow would then differ from
device to device.

When the last client detaches, the last size is kept; the terminal does not shrink
to zero.

## Backpressure

The send queue per client is capped at 256 chunks. When it is full, **the oldest
chunk is dropped**, not the newest, and the PTY reader is never held up along with
it. For a terminal this is correct: what matters is the latest screen, and the
history is still held by the ring buffer. The consequence is that a slow client
can lose chunks of output in the middle — re-attaching restores them.

## Queries the daemon answers itself

ConPTY sends `ESC[6n` (device status report) at start and **waits for an answer**
before drawing anything. The daemon answers it itself and **strips that sequence
out of the stream to the client**, so that a terminal with no client attached keeps
running and the child does not receive two answers. Clients do not need to handle
it.

## HTTP endpoints

All of them require the token, either via the `?token=` query or the `sh_token`
cookie.

| Route | Purpose |
|---|---|
| `GET /` and assets | The frontend, embedded in the binary |
| `GET /api/status` | `{pid, port, uptime_secs, terminals_alive, terminals_total, protocol, version}` |
| `POST /api/stop` | Answers 200, then the daemon stops |
| `POST /api/reload` | Re-reads the config; used by `token rotate` |
| `GET /api/file?path=…` | The raw bytes of a file, for `<img src>` in the file panel. 25 MB maximum; folders get a 404 |

The cookie exists because a `<script>` tag cannot carry a token from localStorage;
the cookie is set when `/?token=…` is opened once.

`protocol` in `/api/status` is the pairing protocol version, not the application
version; that is the number matched during `pair`. `version` is included so that a
rejection message can name **both** sides.

`/api/file` also accepts `&via=<name>` and forwards it to that machine — this is
how an image on a remote machine shows up in the file panel. Other routes **cannot**
be relayed; attempts get an explanation, not a bare 404.
