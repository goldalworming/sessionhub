//! The WS protocol. Control travels in text frames (JSON), terminal data in
//! binary frames prefixed with a 4-byte little-endian id.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    List,
    Spawn {
        project: String,
        agent: String,
        #[serde(default)]
        resume: Option<String>,
        cols: u16,
        rows: u16,
    },
    /// Continue a session into a NEW one, leaving the original untouched.
    Fork {
        project: String,
        agent: String,
        session_id: String,
        #[serde(default)]
        name: String,
        cols: u16,
        rows: u16,
    },
    Attach {
        id: u32,
        cols: u16,
        rows: u16,
    },
    Detach {
        id: u32,
    },
    Resize {
        id: u32,
        cols: u16,
        rows: u16,
    },
    Kill {
        id: u32,
    },
    /// Ask for a memory sample of every terminal. On request by design, not
    /// broadcast — reading the process table is not cheap.
    Mem,
    /// Ask for the agent settings plus where each command resolves on PATH.
    Config,
    /// Change one agent and save it to `config.toml`. A name that does not
    /// exist yet creates one — this is how you add your own harness.
    SetAgent {
        name: String,
        command: String,
        #[serde(default)]
        resume_args: Vec<String>,
        enabled: bool,
        /// Omitted means "leave what is stored alone". An empty list means this
        /// agent genuinely cannot fork.
        #[serde(default)]
        fork_args: Option<Vec<String>>,
    },
    /// Remove one agent from `config.toml`.
    RemoveAgent {
        name: String,
    },
    /// The contents of a folder on the daemon's machine. Empty starts at home.
    Browse {
        #[serde(default)]
        path: String,
    },
    /// Create a folder, then step into it.
    MakeDir {
        parent: String,
        name: String,
    },
    /// Make a folder a project, and save it to `config.toml`.
    AddProject {
        path: String,
    },
    /// Take it out of the project list. Only applies to ones added by hand;
    /// those discovered from agent sessions come back on their own, and that is
    /// the intended behaviour.
    RemoveProject {
        path: String,
    },
    /// The contents of one folder for the file panel: folders **and** files. One
    /// request per folder opened — no index is built up front, because a large
    /// repo makes that pointless.
    Tree {
        path: String,
    },
    /// Open one file in the editor.
    OpenFile {
        path: String,
    },
    /// Save the file currently open.
    SaveFile {
        path: String,
        text: String,
    },
    /// Open or close access from the local network. Takes effect at once;
    /// loopback is untouched, so no terminal is disconnected.
    /// Turn "start with the daemon" on or off for a saved terminal. Takes
    /// effect at the next start; nothing is started or stopped now.
    SetAutostart {
        project: String,
        name: String,
        on: bool,
    },
    /// Ask GitHub what the newest release is. Answered with `Update`.
    UpdateCheck,
    /// Install that release: download it, then restart into it. Every live
    /// terminal dies with the daemon, so the UI asks twice before sending this.
    UpdateApply,
    /// Install only the interface from that release. Costs no restart and kills
    /// no terminal — most releases change nothing else.
    UpdateApplyWeb,
    /// Run an agent's own updater — `claude update`, `opencode upgrade` — in a
    /// terminal, so what it says is visible rather than swallowed.
    UpdateAgentCli {
        name: String,
        cols: u16,
        rows: u16,
    },
    /// Restart a terminal in place: same tab, same folder, same session resumed.
    /// What you do after updating an agent, since a running process keeps the
    /// binary it started with.
    Relaunch {
        id: u32,
        cols: u16,
        rows: u16,
    },
    SetLanAccess {
        enabled: bool,
    },
    /// Change the storage limits for dropped files, then sweep right away.
    SetDrops {
        max_age_hours: u64,
        max_total_mb: u64,
        max_file_mb: u64,
    },
    /// Sweep the drop folder now, without changing its limits.
    SweepDrops,
    /// The list of paired machines. Their tokens are not included.
    Remotes,
    /// Pair a machine from its pairing link.
    Pair {
        link: String,
        /// A name of your own; empty takes one from the address.
        #[serde(default)]
        name: String,
    },
    /// Forget a machine. This is the only thing that deletes its token.
    Forget {
        name: String,
    },
    /// Remember a live terminal under a name, so it outlives the daemon. Saving
    /// the same name in the same project again updates it — that is how the
    /// command gets changed.
    SaveTerminal {
        /// The live terminal being named; its folder and agent come from it.
        id: u32,
        name: String,
        /// Run when it is opened later. Empty just opens the shell.
        #[serde(default)]
        command: String,
        /// Start it with the daemon. Absent means "leave it as it is" — which
        /// for a new entry is on, and for one being saved over is whatever it
        /// was already set to.
        #[serde(default)]
        autostart: Option<bool>,
    },
    /// Stop remembering one. A terminal running under that name right now is
    /// left alone — this forgets the note, not the process.
    ForgetTerminal {
        project: String,
        name: String,
    },
    /// Open a saved terminal: its shell, in its folder, running its command.
    OpenSaved {
        project: String,
        name: String,
        cols: u16,
        rows: u16,
    },
    /// What was last run in this terminal, to offer as the command when naming
    /// it. Asked for only when that dialog opens — typed input has no business
    /// riding along in every state broadcast.
    LastCommand {
        id: u32,
    },
    /// Is this connection still alive? Answered with `Pong`.
    ///
    /// A WebSocket that dies without a close frame — a tunnel idling it out, a
    /// phone changing network, a laptop waking up — leaves the browser believing
    /// it is still open. Sends vanish, nothing arrives, and the page looks frozen
    /// until it is reloaded by hand. The client cannot send a WebSocket-level
    /// ping (the browser API does not expose one), so it asks here instead.
    Ping,
    /// Tag this terminal's tab with a colour, so it can be picked out of a strip
    /// of tabs that otherwise read alike. Empty clears the tag. On a saved
    /// terminal the colour is stored with it and comes back on the next open.
    SetColor {
        id: u32,
        #[serde(default)]
        color: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    State {
        projects: Vec<ProjectInfo>,
        terminals: Vec<TerminalInfo>,
        /// Agents available per the config — the UI needs them for the "new
        /// terminal" menu, and a user can add agents through the config alone.
        /// Fork capability is included so the button only shows on sessions that
        /// can actually be forked.
        agents: Vec<AgentBrief>,
        /// Terminals that were given a name. Unlike sessions these are the
        /// daemon's own record — a plain shell leaves nothing on disk to read
        /// back — so they are listed here rather than under a project's
        /// sessions.
        saved: Vec<SavedInfo>,
        /// `true` until the first registry scan finishes. Without it the UI
        /// cannot tell "not scanned yet" from "there really are no projects" and
        /// would give the wrong guidance for a few seconds.
        scanning: bool,
    },
    /// The answer to `Ping`: proof the link is alive end to end, including the
    /// relay when this connection is going to another machine.
    Pong,
    /// The answer to `LastCommand`. Empty when nothing could be read honestly —
    /// a command recalled from shell history never passed through the daemon.
    LastCommand {
        id: u32,
        command: String,
    },
    Attached {
        id: u32,
        cols: u16,
        rows: u16,
    },
    Size {
        id: u32,
        cols: u16,
        rows: u16,
    },
    Exit {
        id: u32,
        code: i32,
    },
    Error {
        code: String,
        message: String,
    },
    /// What a release check found. Sent whenever the panel asks, and again
    /// right before the daemon restarts into a new build.
    Update {
        /// The version running right now.
        current: String,
        /// The newest tag published, or empty when the check failed.
        latest: String,
        /// Is `latest` actually newer than `current`?
        newer: bool,
        /// False when that release carries no build for this platform — an
        /// update that cannot be installed must not offer a button.
        installable: bool,
        /// The release notes, shown so nobody installs blind.
        notes: String,
        /// Set once the download is done and the swap is about to happen.
        #[serde(default)]
        applying: bool,
        /// The interface being served right now, and where it came from.
        web_current: String,
        /// True when that is the copy baked into the binary rather than one
        /// installed on top of it — worth saying, because "revert" only means
        /// something in the other case.
        web_builtin: bool,
        /// The interface that release offers, when it carries one.
        #[serde(default)]
        web_latest: String,
        /// Is it newer than what is being served, and installable by this
        /// daemon? A bundle that needs a newer daemon is reported, not offered.
        #[serde(default)]
        web_newer: bool,
        /// Why the interface cannot be updated, when it cannot.
        #[serde(default)]
        web_note: String,
    },
    Mem {
        terminals: Vec<MemInfo>,
    },
    /// The file has landed on this machine. The `path` sent back is the path on
    /// the daemon's side — that is what is useful to the agent, not the file
    /// name on the device that dropped it.
    Dropped {
        id: u32,
        path: String,
        name: String,
        bytes: u64,
    },
    /// Paired machines. **Without tokens** — a client only ever names them, and
    /// the token never leaves this daemon.
    Remotes {
        remotes: Vec<RemoteInfo>,
    },
    /// One folder's contents, for the folder picker in the "New project" panel.
    Dir(DirList),
    /// One folder's contents for the file panel.
    Tree(TreeList),
    /// One file's contents.
    File(FileBody),
    /// The file is saved; the new `modified_ms` is how a client knows its copy
    /// is in step with the disk again.
    Saved {
        path: String,
        modified_ms: u64,
    },
    Config {
        agents: Vec<AgentInfo>,
        config_path: String,
        /// Shells actually installed on this machine, to offer as choices for a
        /// terminal-type agent.
        shells: Vec<ShellPreset>,
        /// Drop folder limits, along with what is currently used.
        drops: DropInfo,
        /// The stored network access setting.
        lan_access: bool,
        /// The address actually being listened on, token included. `None` when
        /// access is off or this machine has no LAN address.
        #[serde(skip_serializing_if = "Option::is_none")]
        lan_url: Option<String>,
        /// A link to pair from another machine. Present only while network
        /// access is on — without it nothing could reach us anyway.
        #[serde(skip_serializing_if = "Option::is_none")]
        pair_url: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ShellPreset {
    pub label: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirList {
    /// The folder currently open.
    pub path: String,
    pub name: String,
    /// `None` at a drive root — the "up" button is disabled there.
    pub parent: Option<String>,
    pub is_repo: bool,
    pub is_project: bool,
    pub entries: Vec<DirEntry>,
    /// `true` when there was too much and the list was cut.
    pub truncated: bool,
    /// Starting points: home, then every drive that exists.
    pub roots: Vec<DirEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub addr: String,
    /// The version that machine answered with when last paired — useful when one
    /// machine falls behind and starts behaving oddly.
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeList {
    pub path: String,
    pub entries: Vec<FileEntry>,
    /// `true` when the folder was too full and the list was cut.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Bytes; always 0 for folders — a folder's size means walking its contents,
    /// and that is exactly the work this panel avoids.
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileBody {
    pub path: String,
    pub name: String,
    pub text: String,
    /// A binary file: `text` is deliberately empty.
    pub binary: bool,
    /// An image the browser can draw. Its bytes are not in this message — the
    /// client fetches them from `GET /api/file?path=…`, so they do not swell by a
    /// third as base64 inside JSON.
    pub image: bool,
    /// Only the head of the file was sent, because its size passed the limit.
    pub truncated: bool,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    /// Holds a `.git` — the most useful marker when hunting for a project folder.
    pub is_repo: bool,
    /// Already registered as a project, so there is nothing to add.
    pub is_project: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DropInfo {
    pub dir: String,
    pub max_age_hours: u64,
    pub max_total_mb: u64,
    pub max_file_mb: u64,
    /// What is really in that folder right now.
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub name: String,
    pub command: String,
    pub resume_args: Vec<String>,
    pub enabled: bool,
    /// The full path when the command resolves, `null` when it does not — so
    /// settings can say "not installed" instead of waiting for a spawn to fail.
    pub resolved: Option<String>,
    /// `true` for agents with no stored sessions (a plain shell).
    pub is_terminal: bool,
    pub fork_args: Vec<String>,
    /// Arguments that make this agent update itself; empty when it has none, and
    /// then no button is offered.
    pub update_args: Vec<String>,
    /// What `<command> --version` printed, when it could be asked. Shown so the
    /// panel says which build is installed rather than only where it is.
    pub version: String,
    /// `false` for agents rebuilt every time the daemon starts, where removing
    /// one would only appear to work until the next restart.
    pub removable: bool,
    /// How many terminals are alive using this agent. The UI uses it to warn
    /// before removing.
    pub live: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemInfo {
    pub id: u32,
    /// Resident set of this terminal's whole process tree.
    pub rss_bytes: u64,
    /// How many processes were counted — which makes the RSS number readable.
    pub processes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentBrief {
    pub name: String,
    pub can_fork: bool,
    /// `false` for agents that can fork but take no session name from the CLI —
    /// the dialog has to say so rather than promise a name that ends up ignored.
    pub fork_takes_name: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    /// `false` when the directory is gone. Such a project is marked, not removed
    /// — its sessions can still be looked at.
    pub exists: bool,
    pub sessions: Vec<SessionInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionInfo {
    pub agent: String,
    pub session_id: String,
    pub title: String,
    pub updated_at: String,
    /// Set when this session currently has a live terminal — this is the
    /// difference between a filled dot (attach instantly) and a hollow one
    /// (spawn again).
    pub live_terminal_id: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalInfo {
    pub id: u32,
    pub project: String,
    pub agent: String,
    pub alive: bool,
    pub cols: u16,
    pub rows: u16,
    pub session_id: Option<String>,
    /// The saved name this terminal is running under, when it has one. Without
    /// it the sidebar would show a saved terminal twice: once as the name, once
    /// as "terminal 7".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The colour its tab is tagged with, one of `config::TAB_COLORS`. Absent
    /// when untagged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SavedInfo {
    pub name: String,
    pub project: String,
    pub agent: String,
    pub command: String,
    pub color: String,
    /// Set when this saved terminal is running right now — the difference
    /// between attaching to it and starting it again.
    pub live_terminal_id: Option<u32>,
    /// Does it start with the daemon? The row says so, because a thing that
    /// comes up on its own and a thing you have to open are different things to
    /// live with, and nothing else on screen would tell them apart.
    pub autostart: bool,
}

/// Wrap a terminal payload into a binary frame: `id` (u32 LE) + raw bytes.
pub fn encode_frame(id: u32, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + data.len());
    out.extend_from_slice(&id.to_le_bytes());
    out.extend_from_slice(data);
    out
}

/// The inverse of `encode_frame`. `None` when the frame is shorter than the header.
pub fn decode_frame(buf: &[u8]) -> Option<(u32, &[u8])> {
    if buf.len() < 4 {
        return None;
    }
    let id = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
    Some((id, &buf[4..]))
}

/// A terminal id that will never be used for real, borrowed as a marker that
/// this binary frame is not typing but a dropped file. Chosen so uploads need
/// no base64 — a 3 MB screenshot would swell to 4 MB going through JSON.
pub const DROP_MARK: u32 = u32::MAX;

/// `DROP_MARK` + terminal id (u32 LE) + name length (u16 LE) + UTF-8 name +
/// file bytes.
pub struct DropFrame<'a> {
    pub term: u32,
    pub name: String,
    pub data: &'a [u8],
}

pub fn decode_drop(buf: &[u8]) -> Option<DropFrame<'_>> {
    if buf.len() < 10 || u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) != DROP_MARK {
        return None;
    }
    let term = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
    let n = u16::from_le_bytes([buf[8], buf[9]]) as usize;
    let rest = buf.get(10..)?;
    let name = rest.get(..n)?;
    // A broken name must not drop the connection; `save` filters it again.
    let name = String::from_utf8_lossy(name).into_owned();
    Some(DropFrame { term, name, data: rest.get(n..)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip() {
        let f = encode_frame(3, b"hai");
        assert_eq!(f, vec![3, 0, 0, 0, b'h', b'a', b'i']);
        let (id, data) = decode_frame(&f).unwrap();
        assert_eq!(id, 3);
        assert_eq!(data, b"hai");
    }

    #[test]
    fn frame_id_is_little_endian() {
        let f = encode_frame(0x0102_0304, b"");
        assert_eq!(&f[..4], &[0x04, 0x03, 0x02, 0x01]);
    }

    #[test]
    fn empty_payload_is_valid() {
        let frame = encode_frame(9, b"");
        let (id, data) = decode_frame(&frame).unwrap();
        assert_eq!(id, 9);
        assert!(data.is_empty());
    }

    #[test]
    fn short_frame_is_rejected() {
        assert!(decode_frame(&[1, 2, 3]).is_none());
        assert!(decode_frame(&[]).is_none());
    }

    #[test]
    fn parses_control_messages() {
        let m: ClientMsg = serde_json::from_str(r#"{"t":"list"}"#).unwrap();
        assert!(matches!(m, ClientMsg::List));

        let m: ClientMsg = serde_json::from_str(
            r#"{"t":"spawn","project":"C:\\data\\code\\notex","agent":"claude","resume":null,"cols":120,"rows":32}"#,
        )
        .unwrap();
        match m {
            ClientMsg::Spawn { project, agent, resume, cols, rows } => {
                assert_eq!(project, "C:\\data\\code\\notex");
                assert_eq!(agent, "claude");
                assert_eq!(resume, None);
                assert_eq!((cols, rows), (120, 32));
            }
            other => panic!("salah varian: {other:?}"),
        }

        let m: ClientMsg = serde_json::from_str(r#"{"t":"attach","id":3,"cols":80,"rows":24}"#).unwrap();
        assert!(matches!(m, ClientMsg::Attach { id: 3, cols: 80, rows: 24 }));
    }

    #[test]
    fn spawn_accepts_missing_resume_field() {
        let m: ClientMsg = serde_json::from_str(
            r#"{"t":"spawn","project":"p","agent":"claude","cols":80,"rows":24}"#,
        )
        .unwrap();
        assert!(matches!(m, ClientMsg::Spawn { resume: None, .. }));
    }

    #[test]
    fn serializes_server_messages_with_tag() {
        let s = serde_json::to_string(&ServerMsg::Attached { id: 3, cols: 120, rows: 32 }).unwrap();
        assert_eq!(s, r#"{"t":"attached","id":3,"cols":120,"rows":32}"#);

        let s = serde_json::to_string(&ServerMsg::Error {
            code: "spawn_failed".into(),
            message: "x".into(),
        })
        .unwrap();
        assert_eq!(s, r#"{"t":"error","code":"spawn_failed","message":"x"}"#);
    }
}

#[cfg(test)]
mod contract {
    /// Every `{ t: '…' }` the frontend sends must be a message this daemon
    /// understands.
    ///
    /// This is what makes shipping the frontend separately safe. A frontend that
    /// sends a message an older daemon has never heard of does not fail loudly:
    /// the daemon ignores it and the button simply does nothing — the exact
    /// shape of several bugs found by hand rather than by tests. Once the two
    /// can move independently, that mistake becomes easy to make and invisible
    /// to review, so it is caught here instead.
    ///
    /// Read from disk rather than `include_str!` so a new web file is covered
    /// the moment it exists, without anyone remembering to list it here.
    #[test]
    fn the_frontend_sends_nothing_the_daemon_cannot_read() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("web");
        let mut sent: Vec<(String, String)> = Vec::new();
        for entry in std::fs::read_dir(&root).expect("web/ is next to src/") {
            let path = entry.expect("readable entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("js") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("web files are utf-8");
            let file = path.file_name().unwrap().to_string_lossy().into_owned();
            for name in message_names(&text) {
                sent.push((file.clone(), name));
            }
        }
        assert!(sent.len() > 10, "found almost nothing to check — the scan is broken");

        let known = client_msg_variants();
        let mut unknown: Vec<String> = sent
            .into_iter()
            .filter(|(_, name)| !known.contains(&pascal(name)))
            .map(|(file, name)| format!("{file}: {{ t: '{name}' }}"))
            .collect();
        unknown.sort();
        unknown.dedup();
        assert!(
            unknown.is_empty(),
            "the frontend sends messages this daemon does not accept.\n\
             Add them to ClientMsg, or raise `needs_daemon` in web/version.json \
             so an older daemon refuses this frontend instead of ignoring it:\n  {}",
            unknown.join("\n  ")
        );
    }

    /// `{ t: 'name' }` and `{ t: "name" }`, however they are spaced.
    fn message_names(text: &str) -> Vec<String> {
        let mut out = Vec::new();
        let bytes = text.as_bytes();
        let mut i = 0;
        while let Some(found) = text[i..].find("t:") {
            let at = i + found;
            i = at + 2;
            // `t:` must start a key — the character before it is `{`, a comma or
            // whitespace, never part of a longer identifier like `format:`.
            let before = text[..at].chars().next_back().unwrap_or('{');
            if before.is_alphanumeric() || before == '_' || before == '.' {
                continue;
            }
            let rest = &text[i..];
            let rest = rest.trim_start();
            let quote = match rest.chars().next() {
                Some(q @ ('\'' | '"')) => q,
                _ => continue,
            };
            let body = &rest[1..];
            let Some(end) = body.find(quote) else { continue };
            let name = &body[..end];
            if !name.is_empty() && name.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
                out.push(name.to_string());
            }
            let _ = bytes;
        }
        out
    }

    /// The variant names of `ClientMsg`, read from this file.
    fn client_msg_variants() -> Vec<String> {
        let src = include_str!("proto.rs");
        let start = src.find("pub enum ClientMsg {").expect("ClientMsg is in this file");
        let body = &src[start..];
        let end = body.find("\n}\n").expect("its closing brace is at column 0");
        body[..end]
            .lines()
            .filter_map(|l| {
                let l = l.trim_end();
                let name = l.strip_prefix("    ")?;
                if name.starts_with(' ') || name.starts_with("//") || name.starts_with('#') {
                    return None;
                }
                let name = name.trim_end_matches([' ', '{', ',']);
                if name.chars().next()?.is_ascii_uppercase()
                    && name.chars().all(|c| c.is_ascii_alphanumeric())
                {
                    Some(name.to_string())
                } else {
                    None
                }
            })
            .collect()
    }

    fn pascal(snake: &str) -> String {
        snake
            .split('_')
            .map(|w| {
                let mut c = w.chars();
                match c.next() {
                    Some(f) => f.to_ascii_uppercase().to_string() + c.as_str(),
                    None => String::new(),
                }
            })
            .collect()
    }

    #[test]
    fn the_scan_finds_what_is_really_there() {
        // The scan is only worth having if it can be trusted, so it is checked
        // against hand-written input rather than only against the real files.
        let found = message_names(
            "conn.send({ t: 'spawn', project }); x.send({t:\"kill\", id}); const format: 'x';",
        );
        assert_eq!(found, vec!["spawn", "kill"], "a key called `format:` is not a message");

        assert_eq!(pascal("set_lan_access"), "SetLanAccess");
        assert_eq!(pascal("ping"), "Ping");

        let known = client_msg_variants();
        assert!(known.contains(&"Ping".to_string()), "{known:?}");
        assert!(known.contains(&"OpenSaved".to_string()));
        assert!(!known.contains(&"Pong".to_string()), "Pong is a server message");
    }
}
