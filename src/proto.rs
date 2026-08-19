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
        /// `true` until the first registry scan finishes. Without it the UI
        /// cannot tell "not scanned yet" from "there really are no projects" and
        /// would give the wrong guidance for a few seconds.
        scanning: bool,
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
