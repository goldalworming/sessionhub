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
    /// Which of this machine's addresses network access uses. Empty means all
    /// of them, which is the default and nearly always right.
    ///
    /// It exists because "all" is not always right: a machine with VMware or
    /// Docker installed carries private addresses that reach nothing outside
    /// itself, and someone who knows which network they mean should be able to
    /// say so and have the links agree. An address that is no longer on this
    /// machine is ignored rather than obeyed — a laptop that moved must not
    /// come back unreachable.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub lan_addr: String,
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
    /// Giving a local port a hostname of its own through the Cloudflare tunnel
    /// this machine is already reached by.
    #[serde(default)]
    pub cloudflare: Cloudflare,
    /// Corrections to guesses earlier versions made, once each.
    ///
    /// An empty `picker_args` cannot be told apart from one emptied on purpose,
    /// so a wrong guess written into thousands of config files can never be put
    /// right by the filling rule alone — that only touches fields never written.
    /// Recording which corrections have run lets one be applied once and then
    /// respected if it is undone by hand.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub applied: Vec<String>,
    /// Whether a paired machine may run commands here without a person
    /// watching — `/api/exec` and `/api/put`.
    ///
    /// On by default, because it grants nothing the token did not already
    /// grant: anyone who can open a terminal here can type anything into it.
    /// What it changes is that the same power becomes scriptable and
    /// unattended, and a machine deserves a way to say no to that — so it is a
    /// switch, and every command that runs is written to the log.
    #[serde(default = "yes")]
    pub remote_commands: bool,
    /// A local record of what is done with sessionhub — see `telemetry.rs`.
    #[serde(default)]
    pub telemetry: Telemetry,
}

/// The behaviour log: one line per thing done, in `~/.sessionhub/telemetry.jsonl`.
///
/// On by default because it leaves the machine as surely as the config does —
/// never — and because it is what turns "claude is slow to take a keystroke"
/// from a feeling into a number. Read at start-up.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Telemetry {
    #[serde(default = "yes")]
    pub enabled: bool,
}

impl Default for Telemetry {
    fn default() -> Self {
        Telemetry { enabled: true }
    }
}

/// Reaching a dev server from outside, at a hostname of its own.
///
/// A dev server believes it owns the root of its host — Vite asks for
/// `/@vite/client` and `/src/main.tsx` — so a path prefix cannot carry one and a
/// subdomain has to. Everything here exists to arrange that subdomain and then
/// stand in front of it, because a dev server is not a hardened thing and this
/// puts it on the internet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cloudflare {
    /// A Cloudflare API token: Account → Cloudflare Tunnel → Edit, and Zone →
    /// DNS → Edit. Kept here beside the machine tokens and never sent to a
    /// browser.
    ///
    /// Empty is a working state, not an unfinished one: without a token each
    /// address comes from a throwaway trycloudflare tunnel instead. What that
    /// costs is a name that changes every time.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub api_token: String,
    /// The domain chosen from the ones that token can see. A name sits directly
    /// under it — `a3f9c1e480b2.example.com` — which is one level deep and so
    /// inside what Cloudflare's free certificate covers.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub zone_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub zone_name: String,
    /// Found from the token rather than asked for.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub account_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub account_name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tunnel_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tunnel_name: String,
    /// Makes each name unguessable while keeping it the same every time.
    ///
    /// Without it a name is just a hash of `localhost:5173`, which anyone can
    /// compute. That is not a way in — the token still stands in front — but it
    /// announces what exists and invites trying. Written once, on first use.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub salt: String,
    /// The first loopback port the per-target listeners are taken from.
    #[serde(default = "default_forward_port")]
    pub forward_port: u16,
    /// What is reachable, and nothing else.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub forwards: Vec<Forward>,
}

/// One address given a way in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Forward {
    /// Loopback unless it is something on the network that cannot run a tunnel
    /// of its own — a machine behind a VPN, say. The tunnel runs here; only the
    /// last hop crosses the network.
    pub host: String,
    pub port: u16,
    /// The label in front of the domain, derived from the address so that the
    /// same address always comes back to the same name.
    pub name: String,
    /// The loopback port its own listener answers on. Stored so a restart puts
    /// everything back exactly where the tunnel already expects it.
    pub local: u16,
}

impl Forward {
    /// Where the last hop goes.
    pub fn target(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    /// How it is written in the panel and in the field that made it.
    pub fn shown(&self) -> String {
        if self.host == "127.0.0.1" {
            format!("localhost:{}", self.port)
        } else {
            self.target()
        }
    }
}

fn default_forward_port() -> u16 {
    7801
}

/// Written by hand rather than derived: a derived one would leave
/// `forward_port` at zero, and a listener bound to port zero is whatever the
/// operating system felt like giving it — different after every restart, while
/// the tunnel still points at yesterday's number.
impl Default for Cloudflare {
    fn default() -> Self {
        Cloudflare {
            api_token: String::new(),
            zone_id: String::new(),
            zone_name: String::new(),
            account_id: String::new(),
            account_name: String::new(),
            tunnel_id: String::new(),
            tunnel_name: String::new(),
            salt: String::new(),
            forward_port: default_forward_port(),
            forwards: Vec::new(),
        }
    }
}

impl Cloudflare {
    /// Whether hostnames can be arranged on a domain of your own. Without this
    /// everything still works, through throwaway tunnels.
    pub fn ready(&self) -> bool {
        !self.api_token.is_empty()
            && !self.zone_id.is_empty()
            && !self.account_id.is_empty()
            && !self.tunnel_id.is_empty()
    }

    /// The address one forward answers at, when there is a domain for it.
    pub fn host_for(&self, f: &Forward) -> String {
        format!("{}.{}", f.name, self.zone_name)
    }

    /// A name for an address: the same one every time, and derivable by nobody
    /// who does not hold this machine's salt.
    ///
    /// FNV-1a rather than a hash from a crate. Nothing is ever verified with
    /// this — it names a door, it does not guard one, and what makes it
    /// unguessable is the salt rather than the mixing.
    pub fn name_for(&self, host: &str, port: u16) -> String {
        let seed = format!("{}|{host}:{port}", self.salt);
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in seed.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
        // A second pass over the digest, so two addresses differing in one byte
        // do not land next to each other in the alphabet.
        let mut out = String::with_capacity(12);
        for i in 0..12 {
            let nibble = ((h >> ((i * 5) % 60)) ^ (h >> (i * 3))) & 0xf;
            out.push(char::from_digit(nibble as u32, 16).unwrap_or('0'));
        }
        out
    }

    /// The next free loopback port for a listener.
    ///
    /// Zero would mean "whatever the operating system feels like", which is a
    /// different number after every restart while the tunnel still points at
    /// the old one. A config written before this had a default falls back here.
    pub fn next_local(&self) -> u16 {
        let mut port = if self.forward_port == 0 { default_forward_port() } else { self.forward_port };
        while self.forwards.iter().any(|f| f.local == port) {
            port = port.saturating_add(1);
        }
        port
    }

    pub fn find(&self, name: &str) -> Option<&Forward> {
        self.forwards.iter().find(|f| f.name == name)
    }
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
    /// Where the daemon over there is: `host:port` on a local network, or
    /// `https://box.example.com` for one behind a tunnel.
    pub addr: String,
    pub token: String,
    /// The version that machine answered with when it was last paired.
    #[serde(default)]
    pub version: String,
    /// A Cloudflare Access service token, for a machine whose hostname sits
    /// behind an Access policy. Both halves or neither — half a token is
    /// answered with a login page, which reads like a broken daemon.
    ///
    /// Per machine rather than global: two machines behind two Access
    /// applications have two different service tokens.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub access_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub access_secret: String,
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
    /// Arguments this agent always takes, before every other kind.
    ///
    /// `command` is a program, not a command line: it goes to `CreateProcessW`
    /// as the name of a file to run, so `omp --autoapprove` there is looked up
    /// as one file with a space and a dash in its name, and of course never
    /// found. An agent that must always be started with a flag had nowhere to
    /// put it — this is that place.
    ///
    /// Prefixed to resuming, forking and the agent's own picker alike, since it
    /// is part of how the command is invoked at all. Not to `update_args`: an
    /// updater is a different job, and a flag meant for a session has no
    /// business in it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
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
/// How each agent carries on without being told which session, verified against
/// its own `--help`:
///   claude    `-r, --resume [value]` — "Resume a conversation by session ID, or
///             open interactive picker with optional search term". With no value
///             it is the picker.
///   opencode  `-c, --continue` — "continue the last session". Not a picker: it
///             asks nothing and takes the most recent one. That is still the
///             answer to "carry on here", which is what the button means.
/// Left empty for the rest. pi is not installed on either machine this was
/// written on, and a guessed flag that turns out wrong does not fail quietly —
/// it starts the agent with an argument it will complain about.
/// One-time corrections: `(id, agent, picker_args)`.
///
/// `opencode-continue` exists because earlier versions wrote `picker_args = []`
/// for opencode — the honest choice at the time, since it was installed on
/// neither machine and a guessed flag does not fail quietly. Its `--help` since
/// showed `-c, --continue`, and an empty list is never refilled by the rule
/// above, so every config already written would have kept a dead Resume button
/// for ever.
/// One-time corrections, by agent: `(id, agent, picker_args, resume_args)`.
///
/// An empty `resume_args` here means "leave it alone". A non-empty one is only
/// written over a field that cannot resume anything — see `resumes_a_session`.
const MIGRATIONS: &[(&str, &str, &[&str], &[&str])] = &[
    ("opencode-continue", "opencode", &["--continue"], &[]),
    // Both read off the CLI's own `--help` on this machine:
    //   codex resume [SESSION_ID]  "picker by default; use --last to continue
    //                               the most recent"
    //   omp -r, --resume=<value>   "by ID prefix, path, or picker if omitted"
    // Neither had a picker recorded, and that is why their Resume button was
    // dead however many sessions they had: sessionhub cannot read their session
    // lists, so it knew of none, and without a picker it had nothing else to
    // offer.
    ("codex-resume", "codex", &["resume"], &["resume", "{session_id}"]),
    ("omp-resume", "omp", &["--resume"], &["--resume", "{session_id}"]),
];

/// Can these arguments resume one particular session?
///
/// Only if the session is named in them. `resume_args` without `{session_id}`
/// builds the same command for every session there is — which is not a resume.
/// It is the agent's picker sitting in the wrong field, and it makes clicking
/// one session in the sidebar open whichever the agent feels like.
fn resumes_a_session(args: &[String]) -> bool {
    args.iter().any(|a| a.contains("{session_id}"))
}

/// Run each correction that has not been run yet, and say whether it wrote
/// anything.
///
/// Its own function because the test for it used to be a second copy of the
/// same loop, which is a test of the copy.
fn apply_migrations(cfg: &mut Config) -> bool {
    let mut changed = false;
    for (id, agent, picker, resume) in MIGRATIONS {
        if cfg.applied.iter().any(|a| a == id) {
            continue;
        }
        if let Some(a) = cfg.agents.get_mut(*agent) {
            // Only an empty one is corrected. Anything already filled in is a
            // decision, whoever made it.
            if a.picker_args.as_ref().is_some_and(|p| p.is_empty()) {
                a.picker_args = Some(picker.iter().map(|s| (*s).to_string()).collect());
            }
            // Resume is different: a field that names no session cannot resume
            // one, so there is no decision there to respect — only a setting
            // that never did anything.
            if !resume.is_empty() && !resumes_a_session(&a.resume_args) {
                a.resume_args = resume.iter().map(|s| (*s).to_string()).collect();
            }
        }
        // Recorded even when the agent is not configured here, so it is never
        // reconsidered — the point is that it happens exactly once.
        cfg.applied.push((*id).to_string());
        changed = true;
    }
    changed
}

fn known_picker_args(name: &str) -> Vec<String> {
    match name {
        "claude" => vec!["--resume".into()],
        "opencode" => vec!["--continue".into()],
        // `codex resume` with no id opens its own picker, and `omp --resume`
        // with no value does the same.
        "codex" => vec!["resume".into()],
        "omp" => vec!["--resume".into()],
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
        // `codex fork [SESSION_ID]` — no flag for naming the new session, so
        // `{name}` is absent and the panel will not promise a name.
        "codex" => vec!["fork".into(), "{session_id}".into()],
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
    lan_ips_named().into_iter().map(|(_, ip)| ip).collect()
}

/// The same list with the adapter each address belongs to.
///
/// The name is what makes the list readable: `192.168.88.1` and
/// `192.168.0.108` say nothing about which one a phone can reach, while
/// "VMware Network Adapter VMnet8" and "Wi-Fi" say everything. It also decides
/// the order — see `reach_rank`.
pub fn lan_ips_named() -> Vec<(String, std::net::IpAddr)> {
    let mut out: Vec<(String, std::net::IpAddr)> = Vec::new();
    for (name, data) in &sysinfo::Networks::new_with_refreshed_list() {
        for net in data.ip_networks() {
            // IPv4 only: the rest of the pairing path speaks `host:port`, and a
            // bare IPv6 address in there would be read as a port separator.
            let std::net::IpAddr::V4(v4) = net.addr else { continue };
            // Link-local means DHCP never answered; nothing is reachable there.
            if v4.is_loopback() || v4.is_unspecified() || v4.is_link_local() {
                continue;
            }
            let ip = std::net::IpAddr::V4(v4);
            if !out.iter().any(|(_, seen)| *seen == ip) {
                out.push((name.to_string(), ip));
            }
        }
    }
    out.sort_by_key(|(name, ip)| reach_rank(name, *ip));
    out
}

/// Adapters that exist for software rather than for a network: the host side of
/// a virtual machine's private switch, a container bridge, a tunnel.
///
/// They carry a perfectly ordinary private address, so nothing about the number
/// gives them away — and on a machine with VMware installed, one of them was
/// being offered as *the* address to reach this computer at while the real
/// Wi-Fi went unmentioned. Nobody outside this machine can reach them.
fn is_virtual_adapter(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    [
        "vmware", "vmnet", "virtualbox", "vboxnet", "hyper-v", "vethernet", "docker", "wsl",
        "npcap", "loopback", "bridge", "utun", "tailscale", "zerotier", "hamachi", "radmin",
    ]
    .iter()
    .any(|k| n.contains(k))
}

/// How useful an address is to somebody trying to reach this machine. Lower
/// sorts first, and first is what the pairing link shows.
fn reach_rank(name: &str, ip: std::net::IpAddr) -> u8 {
    let std::net::IpAddr::V4(v4) = ip else { return 3 };
    let [a, b, ..] = v4.octets();
    let base = if v4.is_private() {
        0 // the Wi-Fi or Ethernet address a phone in the same room can use
    } else if a == 100 && (64..128).contains(&b) {
        // Carrier-grade NAT — Tailscale and its kin. Real, but only reachable
        // by someone already inside that tunnel, so never the first suggestion.
        2
    } else {
        1
    };
    // Never a first suggestion, never in front of a real one — but still listed,
    // because a VM on that private switch is a device that can genuinely use it.
    if is_virtual_adapter(name) { base + 4 } else { base }
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
pub fn default_shell() -> String {
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
            args: Vec::new(),
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
            args: Vec::new(),
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
            args: Vec::new(),
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
            lan_addr: String::new(),
            lan_access: false,
            bind: None,
            token: String::new(),
            projects: Vec::new(),
            agents: default_agents(),
            drops: Drops::default(),
            remotes: Vec::new(),
            saved: Vec::new(),
            cloudflare: Cloudflare::default(),
            applied: Vec::new(),
            remote_commands: true,
            telemetry: Telemetry::default(),
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
                args: Vec::new(),
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

    // A command line written where a program was wanted.
    //
    // `command = "omp --autoapprove"` is the natural thing to type and it can
    // never work: the string is handed to the OS as a file name, so it is looked
    // for as one file called `omp --autoapprove`. Before `args` existed there
    // was nowhere else to put the flag, so the config on disk may well hold one.
    // Rather than leave the agent permanently broken with only a red line to
    // explain it, the flags are moved across.
    //
    // Deliberately narrow, because a path with a space in it must never be cut
    // in two: only when the whole string does not resolve, the first word does,
    // every remaining word begins with `-`, and `args` is still empty.
    for (name, agent) in cfg.agents.iter_mut() {
        if !agent.args.is_empty() || !agent.command.contains(' ') {
            continue;
        }
        let mut words = agent.command.split_whitespace();
        let Some(program) = words.next() else { continue };
        let rest: Vec<String> = words.map(|w| w.to_string()).collect();
        if rest.is_empty() || !rest.iter().all(|w| w.starts_with('-')) {
            continue;
        }
        if crate::pty::resolve_command(&agent.command).is_some()
            || crate::pty::resolve_command(program).is_none()
        {
            continue;
        }
        tracing::info!(
            agent = %name,
            command = %agent.command,
            "the command held flags; moving them into `args`"
        );
        agent.command = program.to_string();
        agent.args = rest;
        filled_fork = true;
    }

    // Then the corrections, once each. See `Config::applied`.
    if apply_migrations(&mut cfg) {
        filled_fork = true;
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

pub fn generate_token() -> io::Result<String> {
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

        assert!(reach_rank("Wi-Fi", lan) < reach_rank("Tailscale", tailscale));
        // A routable address still beats one that only works inside a tunnel.
        assert!(reach_rank("Ethernet", public) < reach_rank("Tailscale", tailscale));

        let mut all = vec![tailscale, public, lan];
        all.sort_by_key(|ip| reach_rank("Ethernet", *ip));
        assert_eq!(all, vec![lan, public, tailscale]);
    }

    /// The bug on a laptop with VMware installed: `192.168.88.1` on VMnet8 was
    /// offered as the address to reach the machine at, while the Wi-Fi it was
    /// actually on went unmentioned. Both are private, so only the adapter's
    /// name can tell them apart.
    #[test]
    fn a_virtual_adapter_never_outranks_a_real_one() {
        let vmnet: std::net::IpAddr = "192.168.88.1".parse().unwrap();
        let wifi: std::net::IpAddr = "192.168.0.108".parse().unwrap();

        assert!(
            reach_rank("Wi-Fi", wifi) < reach_rank("VMware Network Adapter VMnet8", vmnet),
            "the real network must come first"
        );
        for fake in [
            "VMware Network Adapter VMnet1",
            "VirtualBox Host-Only Network",
            "vEthernet (Default Switch)",
            "Docker Desktop bridge",
            "utun3",
        ] {
            assert!(is_virtual_adapter(fake), "{fake} seharusnya dikenali virtual");
        }
        for real in ["Wi-Fi", "Ethernet", "Ethernet 2", "en0", "wlan0"] {
            assert!(!is_virtual_adapter(real), "{real} bukan adapter virtual");
        }
    }

    #[test]
    fn carrier_grade_nat_is_recognised_by_its_whole_range() {
        // 100.64.0.0/10, not "anything starting with 100": 100.63 and 100.128
        // are ordinary public addresses.
        let cgnat = |s: &str| reach_rank("Ethernet", s.parse().unwrap()) == 2;
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
            args: Vec::new(),
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

    fn cf() -> Cloudflare {
        Cloudflare { salt: "pepper".into(), zone_name: "example.com".into(), ..Cloudflare::default() }
    }

    #[test]
    fn the_same_address_always_comes_back_to_the_same_name() {
        let cf = cf();
        assert_eq!(cf.name_for("127.0.0.1", 5173), cf.name_for("127.0.0.1", 5173));
        // And two addresses do not share one.
        assert_ne!(cf.name_for("127.0.0.1", 5173), cf.name_for("127.0.0.1", 5174));
        assert_ne!(cf.name_for("127.0.0.1", 3100), cf.name_for("192.168.0.104", 3100));
    }

    #[test]
    fn a_name_cannot_be_worked_out_without_this_machines_salt() {
        // The whole point of the salt: `localhost:5173` is a guess anyone can
        // make, and without this the name would be a guess too.
        let mine = cf();
        let yours = Cloudflare { salt: "other".into(), ..cf() };
        assert_ne!(mine.name_for("127.0.0.1", 5173), yours.name_for("127.0.0.1", 5173));
    }

    #[test]
    fn a_name_is_something_a_hostname_can_hold() {
        let name = cf().name_for("127.0.0.1", 5173);
        assert_eq!(name.len(), 12);
        assert!(name.chars().all(|c| c.is_ascii_hexdigit()), "{name}");
    }

    #[test]
    fn an_address_sits_one_level_under_the_domain() {
        // One level, so the free certificate covers it.
        let cf = cf();
        let f = Forward { host: "127.0.0.1".into(), port: 5173, name: "abc123".into(), local: 7801 };
        assert_eq!(cf.host_for(&f), "abc123.example.com");
        assert_eq!(f.target(), "127.0.0.1:5173");
        assert_eq!(f.shown(), "localhost:5173");
    }

    #[test]
    fn a_target_on_another_machine_says_so() {
        let f = Forward { host: "192.168.0.104".into(), port: 3100, name: "d".into(), local: 7802 };
        assert_eq!(f.target(), "192.168.0.104:3100");
        assert_eq!(f.shown(), "192.168.0.104:3100");
    }

    #[test]
    fn listeners_do_not_land_on_each_other() {
        let mut cf = cf();
        assert_eq!(cf.next_local(), 7801);
        cf.forwards.push(Forward { host: "127.0.0.1".into(), port: 1, name: "a".into(), local: 7801 });
        assert_eq!(cf.next_local(), 7802);
        cf.forwards.push(Forward { host: "127.0.0.1".into(), port: 2, name: "b".into(), local: 7802 });
        assert_eq!(cf.next_local(), 7803);
    }

    #[test]
    fn a_domain_of_your_own_needs_every_piece() {
        let mut cf = cf();
        assert!(!cf.ready(), "tanpa token, tunnel sekali pakai");
        cf.api_token = "t".into();
        cf.zone_id = "z".into();
        assert!(!cf.ready());
        cf.account_id = "a".into();
        cf.tunnel_id = "u".into();
        assert!(cf.ready());
    }

    /// `command` is a program, not a command line — a flag written into it is
    /// looked up as part of the file name and never found. `args` is where it
    /// goes, and an older config that has never heard of the field must still
    /// load.
    #[test]
    fn start_arguments_survive_a_write_and_an_older_config_still_loads() {
        let toml = r#"
port = 7777
token = "t"

[agents.omp]
command = "omp"
args = ["--autoapprove"]
resume_args = ["--resume"]
"#;
        let cfg: Config = toml::from_str(toml).expect("config parses");
        assert_eq!(cfg.agents["omp"].args, vec!["--autoapprove".to_string()]);

        let written = toml::to_string(&cfg).expect("config serialises");
        let again: Config = toml::from_str(&written).expect("what was written parses back");
        assert_eq!(again.agents["omp"].args, vec!["--autoapprove".to_string()]);

        // The field is skipped when empty, so a config written before it existed
        // is not rewritten with noise — and one still loads.
        let older = r#"
port = 7777
token = "t"

[agents.claude]
command = "claude"
resume_args = ["--resume", "{session_id}"]
"#;
        let cfg: Config = toml::from_str(older).expect("a config without `args` parses");
        assert!(cfg.agents["claude"].args.is_empty());
        assert!(
            !toml::to_string(&cfg).unwrap().contains("args = []"),
            "an empty list must not be written out"
        );
    }

    /// The narrowness of the command-line split. A path with a space in it is
    /// the case that must never be cut, and it is common on Windows.
    #[test]
    fn a_path_with_a_space_is_not_mistaken_for_a_command_line() {
        let looks_splittable = |command: &str| {
            let mut words = command.split_whitespace();
            let program = words.next().unwrap_or_default();
            let rest: Vec<&str> = words.collect();
            !rest.is_empty()
                && rest.iter().all(|w| w.starts_with('-'))
                && !program.is_empty()
        };
        assert!(looks_splittable("omp --autoapprove"));
        assert!(looks_splittable("claude --dangerously-skip-permissions"));
        assert!(!looks_splittable(r"C:\Program Files\thing\agent.exe"));
        assert!(!looks_splittable("agent serve"));
        assert!(!looks_splittable("claude"));
    }

    #[test]
    fn fork_capability_comes_from_the_arguments_themselves() {
        let mut a = Agent {
            command: "x".into(),
            args: Vec::new(),
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

#[cfg(test)]
mod migration_tests {
    use super::*;

    /// A config as earlier versions wrote it: opencode with an empty picker.
    fn old_config() -> String {
        [
            "port = 7717",
            "token = \"x\"",
            "",
            "[agents.opencode]",
            "command = \"opencode\"",
            "resume_args = [\"-s\", \"{session_id}\"]",
            "enabled = true",
            "fork_args = [\"-s\", \"{session_id}\", \"--fork\"]",
            "update_args = [\"upgrade\"]",
            "picker_args = []",
            "",
        ]
        .join("\n")
    }

    fn picker_of(cfg: &Config) -> Vec<String> {
        cfg.agents.get("opencode").unwrap().picker_args.clone().unwrap_or_default()
    }

    /// The whole point: an empty list written by an older version is corrected.
    fn apply(text: &str) -> Config {
        let mut cfg: Config = toml::from_str(text).expect("config parses");
        apply_migrations(&mut cfg);
        cfg
    }

    #[test]
    fn an_old_empty_picker_is_corrected_once() {
        let cfg = apply(&old_config());
        assert_eq!(picker_of(&cfg), vec!["--continue".to_string()]);
        assert!(cfg.applied.iter().any(|a| a == "opencode-continue"));
    }

    /// An agent added by hand, with what the Settings panel writes for one: a
    /// picker nobody filled in, and a resume that names no session. Both are
    /// why its Resume button did nothing.
    fn hand_added_codex() -> String {
        [
            "port = 7717",
            "token = \"x\"",
            "",
            "[agents.codex]",
            "command = \"codex\"",
            "resume_args = [\"resume\"]",
            "enabled = true",
            "fork_args = []",
            "update_args = []",
            "picker_args = []",
            "",
        ]
        .join("\n")
    }

    #[test]
    fn an_agent_with_no_picker_and_a_resume_that_names_nothing_is_corrected() {
        let cfg = apply(&hand_added_codex());
        let a = cfg.agents.get("codex").expect("codex is still there");
        // The picker is what makes Resume clickable at all: sessionhub cannot
        // read codex's session list, so without this there is nothing to offer.
        assert_eq!(a.picker_args.clone().unwrap_or_default(), vec!["resume".to_string()]);
        // And `["resume"]` alone opened the picker whichever session was asked
        // for, which is not what clicking a session in the sidebar means.
        assert_eq!(a.resume_args, vec!["resume".to_string(), "{session_id}".to_string()]);
    }

    #[test]
    fn a_resume_that_does_name_a_session_is_left_alone() {
        // Somebody's own spelling of the same idea. It works, so it stays.
        let text = hand_added_codex()
            .replace("resume_args = [\"resume\"]", "resume_args = [\"resume\", \"{session_id}\"]");
        let cfg = apply(&text);
        assert_eq!(
            cfg.agents["codex"].resume_args,
            vec!["resume".to_string(), "{session_id}".to_string()],
            "a working resume was rewritten"
        );
    }

    #[test]
    fn resuming_needs_the_session_named_in_the_arguments() {
        let words = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(resumes_a_session(&words(&["--resume", "{session_id}"])));
        assert!(resumes_a_session(&words(&["--resume={session_id}"])));
        // These build the same command for every session there is.
        assert!(!resumes_a_session(&words(&["resume"])));
        assert!(!resumes_a_session(&words(&["--continue"])));
        assert!(!resumes_a_session(&[]));
    }

    #[test]
    fn the_pickers_match_what_each_agent_actually_accepts() {
        // Read off each CLI's own `--help` on this machine.
        assert_eq!(known_picker_args("codex"), vec!["resume"]);
        assert_eq!(known_picker_args("omp"), vec!["--resume"]);
        assert_eq!(known_fork_args("codex"), vec!["fork", "{session_id}"]);
        // omp's help lists no fork and no updater, so neither is guessed at.
        assert!(known_fork_args("omp").is_empty());
        assert!(known_update_args("omp").is_empty());
    }

    #[test]
    fn emptying_it_again_by_hand_is_respected() {
        // Run once, then empty it deliberately, then run again: the marker is
        // already recorded, so nothing touches it. A correction that came back
        // every restart would not be a correction, it would be an argument.
        let once = apply(&old_config());
        let mut text = toml::to_string(&once).unwrap();
        text = text.replace("picker_args = [\"--continue\"]", "picker_args = []");
        let twice = apply(&text);
        assert!(picker_of(&twice).is_empty(), "a deliberate choice was overwritten");
    }

    #[test]
    fn a_picker_someone_set_is_never_replaced() {
        let text = old_config().replace("picker_args = []", "picker_args = [\"--mine\"]");
        assert_eq!(picker_of(&apply(&text)), vec!["--mine".to_string()]);
    }

    #[test]
    fn a_new_config_gets_it_from_the_known_list() {
        assert_eq!(known_picker_args("opencode"), vec!["--continue".to_string()]);
        assert_eq!(known_picker_args("claude"), vec!["--resume".to_string()]);
        assert!(known_picker_args("pi").is_empty());
    }
}
