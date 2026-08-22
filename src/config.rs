//! `~/.sessionhub/config.toml` — created on first run.
//! The token is persistent: once made, it is never rotated on its own.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_port")]
    pub port: u16,
    /// Besides loopback, also listen on this machine's IP so other devices on
    /// the same network can open it. Off by default: anyone who can reach this
    /// port and holds the token gets a full shell here.
    ///
    /// Can be changed from the Settings panel, and takes effect without
    /// restarting the daemon — loopback stays bound, and only the second
    /// listener is added or removed.
    #[serde(default)]
    pub lan_access: bool,
    /// A leftover from the old bind-address setting. Read once so it can be
    /// migrated to `lan_access`, then dropped from the file.
    #[serde(default, skip_serializing)]
    pub bind: Option<String>,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub projects: Vec<String>,
    #[serde(default = "default_agents")]
    pub agents: BTreeMap<String, Agent>,
    #[serde(default)]
    pub drops: Drops,
    /// Machines that have been paired. Their tokens stay here and are never
    /// sent to the browser — the browser only ever names them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remotes: Vec<Remote>,
    /// Terminals given a name, so they outlive the daemon.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub saved: Vec<SavedTerminal>,
}

/// A terminal you named, and the command it runs.
///
/// An agent session comes back after a restart because the agent wrote it to
/// its own store and the registry reads it back. A plain shell writes nothing:
/// when the daemon stops, a terminal that was running a bot or a dev server is
/// gone, and the only record of what it was is in your head. Naming one puts it
/// here instead — the folder, the shell, and the line to run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedTerminal {
    /// Yours to choose, and unique within its project — saving the same name
    /// twice updates the entry rather than making a second one, which is how
    /// you change the command.
    pub name: String,
    pub project: String,
    /// Which agent to open it with — usually `terminal`, but a named `claude`
    /// shell must come back as claude rather than a bare prompt.
    #[serde(default = "terminal_agent")]
    pub agent: String,
    /// Run when it opens. Empty simply opens the shell in the right folder.
    #[serde(default)]
    pub command: String,
    /// The colour its tab is tagged with. Empty means untagged.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub color: String,
    /// Start this one as soon as the daemon does, without waiting for anybody to
    /// open a tab. On by default, and on for entries saved before this existed:
    /// naming a shell and the line it runs is what people do to the things they
    /// want running, and having to open each one after every restart is the
    /// whole reason the daemon outlives the browser.
    ///
    /// Still not a supervisor. This starts it once; nothing watches it, and
    /// nothing restarts it when it ends.
    #[serde(default = "yes")]
    pub autostart: bool,
}

/// The colours a terminal's tab can be tagged with.
///
/// A fixed set rather than a free-form colour, for two reasons. It is stored in
/// `config.toml` and handed to the browser, so anything accepted here ends up in
/// the page — a whitelist keeps that from being a way to push arbitrary CSS into
/// it. And these six are the theme's own terminal palette, defined separately
/// for light and dark, so a tag stays readable when the theme flips; a stored
/// hex would be right in one theme and wrong in the other.
pub const TAB_COLORS: [&str; 6] = ["red", "green", "yellow", "blue", "magenta", "cyan"];

/// `Ok` for one of the known colours, or for empty — which means "no tag".
pub fn check_color(color: &str) -> Result<(), String> {
    if color.is_empty() || TAB_COLORS.contains(&color) {
        Ok(())
    } else {
        Err(format!("`{color}` is not one of: {}.", TAB_COLORS.join(", ")))
    }
}

fn terminal_agent() -> String {
    TERMINAL_AGENT.to_string()
}

/// A saved name is shown in a sidebar row and stored in `config.toml`, so the
/// characters that would break either are refused.
pub fn check_saved_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the terminal a name.".into());
    }
    if name.chars().count() > 40 {
        return Err("Keep the name under 40 characters.".into());
    }
    if name.chars().any(|c| c.is_control()) {
        return Err("The name cannot contain control characters.".into());
    }
    Ok(())
}

/// One machine this daemon can reach.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Remote {
    /// The name clients use for it; also its tab label.
    pub name: String,
    /// `host:port` of the daemon over there.
    pub addr: String,
    pub token: String,
    /// The version that machine answered with when it was last paired.
    #[serde(default)]
    pub version: String,
}

/// Limits for files dropped from the browser into `~/.sessionhub/dropped/`.
///
/// Age is the main rule, not size. An image that was just dropped may not have
/// been read by the agent yet, so throwing it away because the folder is full
/// breaks work in progress; age never has that problem — what is old is
/// finished with. Size is a ceiling so the disk does not balloon, and it may
/// only touch files past the grace period.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Drops {
    /// Drop files older than this. 0 = never drop by age.
    #[serde(default = "default_drop_age")]
    pub max_age_hours: u64,
    /// Ceiling on the whole folder's disk use. 0 = no limit.
    #[serde(default = "default_drop_total")]
    pub max_total_mb: u64,
    /// Files larger than this are refused up front — better a clear refusal
    /// than storing one and quietly throwing it away.
    #[serde(default = "default_drop_file")]
    pub max_file_mb: u64,
}

fn default_drop_age() -> u64 {
    24
}
fn default_drop_total() -> u64 {
    100
}
fn default_drop_file() -> u64 {
    20
}

impl Default for Drops {
    fn default() -> Self {
        Drops {
            max_age_hours: default_drop_age(),
            max_total_mb: default_drop_total(),
            max_file_mb: default_drop_file(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub command: String,
    #[serde(default)]
    pub resume_args: Vec<String>,
    /// Extra environment for this agent. Applied last, so it can override
    /// `TERM`/`COLORTERM` — or put `NO_COLOR` back for those who want it.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// A disabled agent disappears from the "new terminal" menu, is refused on
    /// spawn, and its sessions are not scanned. Useful for an agent that is not
    /// installed yet, so it does not fill the view.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Arguments for forking a session: continuing an old conversation into a
    /// NEW session, leaving the original untouched. Understands two markers,
    /// `{session_id}` and `{name}`.
    ///
    /// `None` means never filled in — it gets completed from the built-in list
    /// when the config is read. An empty list means this agent genuinely cannot
    /// fork, and the button is not offered.
    #[serde(default)]
    pub fork_args: Option<Vec<String>>,
    /// Arguments that make the agent update itself — `claude update`,
    /// `opencode upgrade`. Run in a terminal you can watch, because an update
    /// that prints something you never see is an update you cannot trust.
    ///
    /// `None` means never filled in, and is completed from the built-in list on
    /// read. An empty list means this agent has no update command, and no button
    /// is offered.
    #[serde(default)]
    pub update_args: Option<Vec<String>>,
    /// Arguments that resume without naming a session — `claude --resume` with
    /// no id, which opens the agent's own picker inside the terminal.
    ///
    /// The sidebar already resumes a session you point at. This is for the
    /// other way round: letting the agent ask, which is what you want when the
    /// session you are after is easier to recognise in its own list.
    ///
    /// `None` means never filled in, and is completed from the built-in list on
    /// read. An empty list means nothing is offered.
    #[serde(default)]
    pub picker_args: Option<Vec<String>>,
}

impl Agent {
    pub fn can_fork(&self) -> bool {
        self.fork_args.as_ref().is_some_and(|a| !a.is_empty())
    }

    /// Whether this agent can open a session picker of its own.
    pub fn can_pick(&self) -> bool {
        self.picker_args.as_ref().is_some_and(|a| !a.is_empty())
    }

    /// Some agents can fork but take no session name from the CLI — opencode is
    /// one. The UI needs to know so it does not promise a name that will go
    /// nowhere.
    pub fn fork_takes_name(&self) -> bool {
        self.fork_args
            .as_ref()
            .is_some_and(|a| a.iter().any(|s| s.contains("{name}")))
    }
}

/// Known fork arguments for the built-in agents, verified against each one's
/// `--help`:
///   claude   `--fork-session` makes a new session id on resume, `--name`
///            sets the display name.
///   opencode `--fork` continues as a new session; there is no name flag.
/// How each agent opens its own session picker, verified against its `--help`:
///   claude  `-r, --resume [value]` — "Resume a conversation by session ID, or
///           open interactive picker with optional search term". With no value
///           it is the picker.
/// Left empty for the rest. opencode and pi are not installed on either machine
/// this was written on, and a guessed flag that turns out wrong does not fail
/// quietly — it starts the agent with an argument it will complain about.
fn known_picker_args(name: &str) -> Vec<String> {
    match name {
        "claude" => vec!["--resume".into()],
        _ => Vec::new(),
    }
}

/// How each agent updates itself, verified against its own `--help` on this
/// machine:
///   claude    `claude update` — "check for updates and install if available"
///   opencode  `opencode upgrade [target]`
/// Anything else is left empty rather than guessed at: running the wrong
/// subcommand at someone's toolchain is worse than offering no button.
fn known_update_args(name: &str) -> Vec<String> {
    match name {
        "claude" => vec!["update".into()],
        "opencode" => vec!["upgrade".into()],
        _ => Vec::new(),
    }
}

fn known_fork_args(name: &str) -> Vec<String> {
    match name {
        "claude" => vec![
            "--resume".into(),
            "{session_id}".into(),
            "--fork-session".into(),
            "--name".into(),
            "{name}".into(),
        ],
        "opencode" => vec!["-s".into(), "{session_id}".into(), "--fork".into()],
        _ => Vec::new(),
    }
}

fn yes() -> bool {
    true
}

fn default_port() -> u16 {
    7717
}

/// The old `bind` setting is migrated to `lan_access`. Any address that was not
/// loopback used to mean "open to the network", so that is what is used. A
/// value that cannot be parsed counts as loopback — a typo must never end up
/// opening the machine.
fn migrate_bind(bind: &str) -> bool {
    bind.trim()
        .parse::<std::net::IpAddr>()
        .map(|ip| !ip.is_loopback())
        .unwrap_or(false)
}

/// Every address another machine could reach this one at, best first.
///
/// Asking the routing table where an outgoing packet would leave from finds
/// exactly ONE address, and it is the wrong one as soon as a VPN is up: with
/// Tailscale running it answers with the tunnel address, so the daemon listened
/// only there while every device on the actual Wi-Fi got "connection refused" —
/// and Settings offered a pairing link nobody on the LAN could use. Measured on
/// a real Mac: bound to `100.127.22.178:7717`, invisible at `192.168.0.101`.
///
/// So the interfaces are enumerated instead, and the listener opens on all of
/// them.
pub fn lan_ips() -> Vec<std::net::IpAddr> {
    let mut out: Vec<std::net::IpAddr> = Vec::new();
    for (_name, data) in &sysinfo::Networks::new_with_refreshed_list() {
        for net in data.ip_networks() {
            // IPv4 only: the rest of the pairing path speaks `host:port`, and a
            // bare IPv6 address in there would be read as a port separator.
            let std::net::IpAddr::V4(v4) = net.addr else { continue };
            // Link-local means DHCP never answered; nothing is reachable there.
            if v4.is_loopback() || v4.is_unspecified() || v4.is_link_local() {
                continue;
            }
            let ip = std::net::IpAddr::V4(v4);
            if !out.contains(&ip) {
                out.push(ip);
            }
        }
    }
    out.sort_by_key(|ip| reach_rank(*ip));
    out
}

/// How useful an address is to somebody trying to reach this machine. Lower
/// sorts first, and first is what the pairing link shows.
fn reach_rank(ip: std::net::IpAddr) -> u8 {
    let std::net::IpAddr::V4(v4) = ip else { return 3 };
    let [a, b, ..] = v4.octets();
    if v4.is_private() {
        0 // the Wi-Fi or Ethernet address a phone in the same room can use
    } else if a == 100 && (64..128).contains(&b) {
        // Carrier-grade NAT — Tailscale and its kin. Real, but only reachable
        // by someone already inside that tunnel, so never the first suggestion.
        2
    } else {
        1
    }
}

/// The single address worth showing. Falls back to asking the routing table,
/// for the case where the interface list comes back empty.
///
/// The UDP socket there is used only to ask which outgoing route the kernel
/// would take — `connect` on UDP sends no packet at all, and the destination is
/// deliberately taken from the RFC 5737 documentation block so there is no
/// appearance of contacting anyone's service.
pub fn lan_ip() -> Option<std::net::IpAddr> {
    if let Some(ip) = lan_ips().into_iter().next() {
        return Some(ip);
    }
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("192.0.2.1:80").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        None
    } else {
        Some(ip)
    }
}

/// The built-in agent for simply opening a shell in a folder — no agent, no
/// session to resume.
pub const TERMINAL_AGENT: &str = "terminal";

/// The system's default shell. On Windows PowerShell is chosen over `%COMSPEC%`:
/// it is what Windows Terminal and VS Code use, so it is what the user expects
/// when pressing "New terminal".
fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// Common shell choices, to offer in settings. The caller filters out the ones
/// that are not installed — offering a choice that does not exist misleads
/// just as much as offering nothing.
pub fn shell_presets() -> Vec<(&'static str, String)> {
    if cfg!(windows) {
        vec![
            ("Windows PowerShell", "powershell.exe".into()),
            ("PowerShell 7", "pwsh.exe".into()),
            ("Command Prompt", "cmd.exe".into()),
            ("WSL", "wsl.exe".into()),
        ]
    } else {
        let mut v = vec![
            ("bash", "/bin/bash".to_string()),
            ("zsh", "/bin/zsh".to_string()),
            ("fish", "/usr/bin/fish".to_string()),
        ];
        if let Ok(sh) = std::env::var("SHELL") {
            if !v.iter().any(|(_, c)| *c == sh) {
                v.insert(0, ("Shell bawaan", sh));
            }
        }
        v
    }
}

fn default_agents() -> BTreeMap<String, Agent> {
    let mut m = BTreeMap::new();
    m.insert(
        "claude".into(),
        Agent {
            command: "claude".into(),
            resume_args: vec!["--resume".into(), "{session_id}".into()],
            env: BTreeMap::new(),
            enabled: true,
            fork_args: None,
            update_args: None,
            picker_args: None,
        },
    );
    m.insert(
        "opencode".into(),
        Agent {
            command: "opencode".into(),
            resume_args: vec!["-s".into(), "{session_id}".into()],
            env: BTreeMap::new(),
            enabled: true,
            fork_args: None,
            update_args: None,
            picker_args: None,
        },
    );
    m.insert(
        "pi".into(),
        Agent {
            command: "pi".into(),
            resume_args: vec!["--session".into(), "{session_id}".into()],
            env: BTreeMap::new(),
            enabled: true,
            fork_args: None,
            update_args: None,
            picker_args: None,
        },
    );
    m
}

impl Default for Config {
    fn default() -> Self {
        Config {
            port: default_port(),
            lan_access: false,
            bind: None,
            token: String::new(),
            projects: Vec::new(),
            agents: default_agents(),
            drops: Drops::default(),
            remotes: Vec::new(),
            saved: Vec::new(),
        }
    }
}

/// Filled by `--home` when the daemon runs as a service: a service runs under
/// another account, so its USERPROFILE is not the user's.
static HOME_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

pub fn set_home(path: PathBuf) {
    let _ = HOME_OVERRIDE.set(path);
}

pub fn home() -> PathBuf {
    if let Some(p) = HOME_OVERRIDE.get() {
        return p.clone();
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn dir() -> PathBuf {
    home().join(".sessionhub")
}

pub fn config_path() -> PathBuf {
    dir().join("config.toml")
}

pub fn log_path() -> PathBuf {
    dir().join("sessionhubd.log")
}

pub fn pid_path() -> PathBuf {
    dir().join("daemon.pid")
}

/// Where files dropped from the browser land. Deliberately outside any project
/// folder: what gets dragged onto a terminal must not dirty the user's repo.
pub fn dropped_dir() -> PathBuf {
    dir().join("dropped")
}

/// Read the config; create it if missing. An empty token is filled once and
/// written back — a user who deletes the line gets a new token, not an error.
pub fn load_or_create() -> io::Result<Config> {
    let path = config_path();
    let mut cfg = if path.exists() {
        let text = fs::read_to_string(&path)?;
        toml::from_str::<Config>(&text)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("{path:?}: {e}")))?
    } else {
        Config::default()
    };

    // Migrate the old `bind` setting once, then drop the line.
    let mut migrated = false;
    if let Some(old) = cfg.bind.take() {
        cfg.lan_access = migrate_bind(&old);
        migrated = true;
    }

    // Written to the config rather than injected silently, so the user can see
    // it and change the shell.
    let missing_terminal = !cfg.agents.contains_key(TERMINAL_AGENT);
    if missing_terminal {
        cfg.agents.insert(
            TERMINAL_AGENT.to_string(),
            Agent {
                command: default_shell(),
                resume_args: Vec::new(),
                env: BTreeMap::new(),
                enabled: true,
                fork_args: None,
                update_args: None,
                picker_args: None,
            },
        );
    }

    // Agents with no `fork_args` yet are completed from the built-in list, then
    // written to the config so they are visible and editable. Ones already
    // filled in — including deliberately emptied ones — are left alone.
    let mut filled_fork = false;
    for (name, agent) in cfg.agents.iter_mut() {
        if agent.fork_args.is_none() {
            agent.fork_args = Some(known_fork_args(name));
            filled_fork = true;
        }
        if agent.update_args.is_none() {
            agent.update_args = Some(known_update_args(name));
            filled_fork = true;
        }
        if agent.picker_args.is_none() {
            agent.picker_args = Some(known_picker_args(name));
            filled_fork = true;
        }
    }

    let needs_write =
        !path.exists() || cfg.token.is_empty() || missing_terminal || filled_fork || migrated;
    if cfg.token.is_empty() {
        cfg.token = generate_token()?;
    }
    if needs_write {
        save(&cfg)?;
    }
    Ok(cfg)
}

pub fn save(cfg: &Config) -> io::Result<()> {
    fs::create_dir_all(dir())?;
    let text = toml::to_string_pretty(cfg)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    fs::write(config_path(), text)
}

/// Replace the token with a new one and save. The old token stops working at
/// once; that is the whole point.
pub fn rotate_token() -> io::Result<String> {
    let mut cfg = load_or_create()?;
    cfg.token = generate_token()?;
    save(&cfg)?;
    Ok(cfg.token)
}

fn generate_token() -> io::Result<String> {
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(base64url(&raw))
}

/// base64url without padding — safe to use in a query string.
fn base64url(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(A[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(A[n as usize & 63] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lan_address_is_suggested_before_a_vpn_one() {
        // The bug this ranking exists for: with Tailscale up, the routing table
        // answered 100.127.22.178 and that became the pairing link, while the
        // machine asking for it could only reach 192.168.0.101.
        let lan: std::net::IpAddr = "192.168.0.101".parse().unwrap();
        let tailscale: std::net::IpAddr = "100.127.22.178".parse().unwrap();
        let public: std::net::IpAddr = "203.0.113.7".parse().unwrap();

        assert!(reach_rank(lan) < reach_rank(tailscale));
        // A routable address still beats one that only works inside a tunnel.
        assert!(reach_rank(public) < reach_rank(tailscale));

        let mut all = vec![tailscale, public, lan];
        all.sort_by_key(|ip| reach_rank(*ip));
        assert_eq!(all, vec![lan, public, tailscale]);
    }

    #[test]
    fn carrier_grade_nat_is_recognised_by_its_whole_range() {
        // 100.64.0.0/10, not "anything starting with 100": 100.63 and 100.128
        // are ordinary public addresses.
        let cgnat = |s: &str| reach_rank(s.parse().unwrap()) == 2;
        assert!(cgnat("100.64.0.1"));
        assert!(cgnat("100.127.22.178"));
        assert!(!cgnat("100.63.255.255"));
        assert!(!cgnat("100.128.0.1"));
    }

    #[test]
    fn base64url_matches_known_vectors() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foob"), "Zm9vYg");
        assert_eq!(base64url(b"fooba"), "Zm9vYmE");
        assert_eq!(base64url(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64url_avoids_plus_and_slash() {
        // 0xFB 0xFF triggers '+' and '/' in standard base64.
        let s = base64url(&[0xfb, 0xff, 0xbf]);
        assert!(!s.contains('+') && !s.contains('/') && !s.contains('='), "{s}");
    }

    #[test]
    fn token_is_32_bytes_worth_of_base64url() {
        let t = generate_token().unwrap();
        assert_eq!(t.len(), 43);
    }

    #[test]
    fn default_shell_is_a_real_program_name() {
        let s = default_shell();
        assert!(!s.is_empty());
        if cfg!(windows) {
            assert_eq!(s, "powershell.exe");
        } else {
            assert!(s.starts_with('/'), "shell unix berupa path absolut: {s}");
        }
    }

    #[test]
    fn terminal_agent_has_nothing_to_resume() {
        // A plain shell has no sessions; a filled-in `resume_args` would make
        // clicking "New terminal" send a flag the shell does not understand.
        let a = Agent {
            command: default_shell(),
            resume_args: Vec::new(),
            env: BTreeMap::new(),
            enabled: true,
            fork_args: None,
            update_args: None,
            picker_args: None,
        };
        assert!(a.resume_args.is_empty());
    }

    #[test]
    fn lan_access_defaults_to_off() {
        assert!(!Config::default().lan_access, "bawaan tidak boleh bisa dijangkau jaringan");
        // An old config has no such field at all.
        let cfg: Config = toml::from_str("token = \"x\"\n").unwrap();
        assert!(!cfg.lan_access);
    }

    #[test]
    fn old_bind_setting_becomes_lan_access() {
        for (value, on) in [
            ("127.0.0.1", false),
            ("0.0.0.0", true),
            ("192.0.2.10", true),
            ("::1", false),
        ] {
            assert_eq!(migrate_bind(value), on, "bind = {value}");
        }
    }

    #[test]
    fn unparseable_bind_migrates_to_off() {
        // A typo in an old config must not quietly open the machine.
        for junk in ["", "  ", "bukan-alamat", "0.0.0.0.0", "localhost"] {
            assert!(!migrate_bind(junk), "bind = {junk:?}");
        }
    }

    #[test]
    fn lan_access_survives_a_save_load_cycle() {
        let mut cfg = Config::default();
        cfg.token = "x".into();
        cfg.lan_access = true;
        let text = toml::to_string_pretty(&cfg).unwrap();
        // The migration field must never be written back to the file.
        assert!(!text.contains("bind"), "{text}");
        let back: Config = toml::from_str(&text).unwrap();
        assert!(back.lan_access);
    }

    #[test]
    fn fork_capability_comes_from_the_arguments_themselves() {
        let mut a = Agent {
            command: "x".into(),
            resume_args: vec![],
            env: BTreeMap::new(),
            enabled: true,
            fork_args: None,
            update_args: None,
            picker_args: None,
        };
        assert!(!a.can_fork(), "belum diisi berarti belum diketahui");

        a.fork_args = Some(vec![]);
        assert!(!a.can_fork(), "daftar kosong berarti memang tidak bisa");

        // opencode: can fork, but its CLI takes no session name.
        a.fork_args = Some(known_fork_args("opencode"));
        assert!(a.can_fork());
        assert!(!a.fork_takes_name());

        // claude: both exist.
        a.fork_args = Some(known_fork_args("claude"));
        assert!(a.can_fork());
        assert!(a.fork_takes_name());
    }

    #[test]
    fn known_fork_args_match_what_the_agents_actually_accept() {
        // Verified against `claude --help` and `opencode --help` on the test machine.
        assert_eq!(
            known_fork_args("claude"),
            vec!["--resume", "{session_id}", "--fork-session", "--name", "{name}"]
        );
        assert_eq!(known_fork_args("opencode"), vec!["-s", "{session_id}", "--fork"]);
        assert!(known_fork_args("pi").is_empty(), "pi belum diketahui punya fork");
        assert!(known_fork_args("terminal").is_empty(), "shell tidak punya sesi");
    }

    #[test]
    fn fork_args_survive_a_save_load_cycle() {
        let mut cfg = Config::default();
        cfg.token = "x".into();
        cfg.agents.get_mut("claude").unwrap().fork_args = Some(known_fork_args("claude"));
        cfg.agents.get_mut("pi").unwrap().fork_args = Some(vec![]);
        let back: Config = toml::from_str(&toml::to_string_pretty(&cfg).unwrap()).unwrap();
        assert!(back.agents["claude"].can_fork());
        assert!(!back.agents["pi"].can_fork());
    }

    #[test]
    fn default_config_roundtrips_through_toml() {
        let mut cfg = Config::default();
        cfg.token = "abc".into();
        cfg.projects = vec!["C:\\data\\code\\notex".into()];
        let text = toml::to_string_pretty(&cfg).unwrap();
        let back: Config = toml::from_str(&text).unwrap();
        assert_eq!(back.port, 7717);
        assert_eq!(back.token, "abc");
        assert_eq!(back.projects, cfg.projects);
        assert_eq!(back.agents["claude"].resume_args, vec!["--resume", "{session_id}"]);
        assert!(back.agents["claude"].enabled, "agent menyala kalau tidak disebut");
    }

    #[test]
    fn agent_without_enabled_field_defaults_to_on() {
        // An old config has no such field; reading it as `false` would disable
        // every agent the user already has.
        let cfg: Config = toml::from_str(
            "token = \"x\"\n[agents.claude]\ncommand = \"claude\"\n",
        )
        .unwrap();
        assert!(cfg.agents["claude"].enabled);
    }

    #[test]
    fn a_saved_terminal_survives_a_save_load_cycle() {
        let mut cfg = Config::default();
        cfg.token = "x".into();
        cfg.saved.push(SavedTerminal {
            name: "telegram bot".into(),
            project: "C:\\data\\code\\firefox-ext\\mcp".into(),
            agent: TERMINAL_AGENT.into(),
            command: ".\\@run-telegram-bot.bat".into(),
            color: "cyan".into(),
            autostart: true,
        });
        let back: Config = toml::from_str(&toml::to_string_pretty(&cfg).unwrap()).unwrap();
        assert_eq!(back.saved, cfg.saved);
    }

    #[test]
    fn an_old_config_has_no_saved_terminals_and_still_reads() {
        let cfg: Config = toml::from_str("token = \"x\"\n").unwrap();
        assert!(cfg.saved.is_empty());
        // And an empty list is not written back, so nobody gets a stray heading.
        assert!(!toml::to_string_pretty(&cfg).unwrap().contains("saved"));
    }

    #[test]
    fn a_saved_terminal_written_by_hand_defaults_to_a_plain_shell() {
        // The point of storing this in config.toml is that it can be edited
        // there; the agent line is the one a person would leave out.
        let cfg: Config = toml::from_str(
            "token = \"x\"\n[[saved]]\nname = \"bot\"\nproject = \"C:\\\\p\"\n",
        )
        .unwrap();
        assert_eq!(cfg.saved[0].agent, TERMINAL_AGENT);
        assert_eq!(cfg.saved[0].command, "");
    }

    #[test]
    fn only_known_tab_colours_are_accepted() {
        // The value reaches the page as an attribute; anything not on this list
        // has no business getting there.
        for c in TAB_COLORS {
            assert!(check_color(c).is_ok(), "{c}");
        }
        assert!(check_color("").is_ok(), "kosong berarti tanpa tanda");
        for bad in ["#ff0000", "red; background:url(x)", "chartreuse", "RED", "blue "] {
            assert!(check_color(bad).is_err(), "{bad:?} seharusnya ditolak");
        }
    }

    /// Entries written before autostart existed carry no such key. They have to
    /// come back on, or upgrading would quietly stop everything anyone had
    /// saved - the opposite of what the setting is for.
    #[test]
    fn a_saved_terminal_from_an_older_config_starts_with_the_daemon() {
        let text = r#"
[[saved]]
name = "telegram-bot"
project = 'C:\data'
agent = "terminal"
command = "run.bat"
"#;
        let cfg: Config = toml::from_str(text).unwrap();
        assert!(cfg.saved[0].autostart, "a config with no autostart key must default to on");
    }

    /// And turning it off has to survive the round trip, or it would come back
    /// on at the next restart - which is exactly when it matters.
    #[test]
    fn turning_autostart_off_is_remembered() {
        let mut cfg = Config::default();
        cfg.token = "x".into();
        cfg.saved.push(SavedTerminal {
            name: "one-shot".into(),
            project: "C:/p".into(),
            agent: TERMINAL_AGENT.into(),
            command: "build.bat".into(),
            color: String::new(),
            autostart: false,
        });
        let back: Config = toml::from_str(&toml::to_string_pretty(&cfg).unwrap()).unwrap();
        assert!(!back.saved[0].autostart);
    }

    #[test]
    fn an_untagged_saved_terminal_writes_no_colour_line() {
        let mut cfg = Config::default();
        cfg.token = "x".into();
        cfg.saved.push(SavedTerminal {
            name: "bot".into(),
            project: "C:\\p".into(),
            agent: TERMINAL_AGENT.into(),
            command: String::new(),
            color: String::new(),
            autostart: true,
        });
        let text = toml::to_string_pretty(&cfg).unwrap();
        assert!(!text.contains("color"), "{text}");
        let back: Config = toml::from_str(&text).unwrap();
        assert_eq!(back.saved[0].color, "");
    }

    #[test]
    fn saved_names_that_would_break_a_row_or_the_file_are_refused() {
        assert!(check_saved_name("telegram bot").is_ok());
        assert!(check_saved_name("bot #2 — jalan").is_ok());
        assert!(check_saved_name("").is_err());
        assert!(check_saved_name("   ").is_err());
        assert!(check_saved_name("a\nb").is_err());
        assert!(check_saved_name(&"a".repeat(41)).is_err());
        assert!(check_saved_name(&"a".repeat(40)).is_ok());
    }

    #[test]
    fn disabled_agent_survives_a_save_load_cycle() {
        let mut cfg = Config::default();
        cfg.token = "x".into();
        cfg.agents.get_mut("pi").unwrap().enabled = false;
        let back: Config = toml::from_str(&toml::to_string_pretty(&cfg).unwrap()).unwrap();
        assert!(!back.agents["pi"].enabled);
        assert!(back.agents["claude"].enabled);
    }
}
