//! The state actor: the sole owner of the terminal map and the client list.
//! Every other thread talks to it over a channel; no shared state is held
//! while writing to a socket.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crossbeam_channel::{Receiver, Sender, TrySendError};
use tracing::{info, warn};

use crate::config::Config;
use crate::proto::{
    encode_frame, AgentBrief, AgentInfo, ClientMsg, MemInfo, ProjectInfo, SavedInfo, ServerMsg,
    SessionInfo, TerminalInfo,
};
use crate::pty::{Pty, PtyEvent};
use crate::registry;
use crate::ring::Ring;
use crate::typed::TypedLine;

pub type ClientId = u64;

/// Queue capacity per client. When full, the oldest chunk is dropped — the PTY
/// reader must never stall because one client is slow.
pub const CLIENT_QUEUE: usize = 256;

/// How much output history is kept per terminal for replay on attach.
pub const RING_CAP: usize = 2 * 1024 * 1024;

pub enum Cmd {
    ClientUp { id: ClientId, tx: Sender<Out>, rx: Receiver<Out> },
    ClientDown { id: ClientId },
    ClientMsg { id: ClientId, msg: ClientMsg },
    ClientInput { term: u32, data: Vec<u8> },
    /// A file dragged from the browser. `term` only decides which terminal the
    /// path is later offered back to.
    ClientDrop { id: ClientId, term: u32, name: String, data: Vec<u8> },
    Pty { term: u32, event: PtyEvent },
    /// The latest registry scan from the registry thread.
    Registry(Vec<ProjectInfo>),
    /// Answer with (live terminals, total terminals) for `sessionhubd status`.
    Stats { reply: Sender<(usize, usize)> },
    /// Answer with the remote entry of this name. The actor holds the live
    /// config; the HTTP layer's snapshot is taken once at start and is already
    /// stale the moment a new machine is paired.
    Remote { name: String, reply: Sender<Option<crate::config::Remote>> },
    /// Kill every terminal, then end the actor.
    Shutdown,
}

#[derive(Debug, Clone)]
pub enum Out {
    Text(String),
    Binary(Vec<u8>),
    Pong(Vec<u8>),
}

struct Client {
    tx: Sender<Out>,
    /// A copy of the receiving end, used only to drop the oldest chunk when the
    /// queue is full. Never used to read ordinary messages.
    rx: Receiver<Out>,
}

struct Terminal {
    id: u32,
    project: String,
    agent: String,
    /// The PTY size in effect — the negotiated one, not any single client's
    /// request.
    cols: u16,
    rows: u16,
    alive: bool,
    /// The session this terminal runs. Set straight away when resuming; on a
    /// fresh spawn it is filled in later, once the session shows up in the
    /// registry.
    session_id: Option<String>,
    started_ms: u64,
    /// Attached clients and the size each one asks for.
    viewers: HashMap<ClientId, (u16, u16)>,
    ring: Ring,
    /// Released as soon as the child ends; dropping it closes the ConPTY so the
    /// reader thread finishes too. The terminal entry itself stays, with
    /// `alive: false`.
    pty: Option<Pty>,
    /// The saved name this terminal runs under, when it has one.
    name: Option<String>,
    /// The colour its tab is tagged with, one of `config::TAB_COLORS`.
    color: Option<String>,
    /// What is being typed at the prompt, so naming this terminal can offer the
    /// command it is running.
    typed: TypedLine,
    /// A command to run once the shell is up. Held rather than written at spawn
    /// time: the shell has not opened its input yet, and what is sent before it
    /// does is echoed into the banner or lost outright.
    pending_run: Option<String>,
}

pub fn run(cfg: Config, rx: Receiver<Cmd>, tx: Sender<Cmd>, registry_cfg: Sender<Config>) {
    let mut cfg = cfg;
    let mut clients: HashMap<ClientId, Client> = HashMap::new();
    let mut terminals: HashMap<u32, Terminal> = HashMap::new();
    let mut next_term: u32 = 1;
    // The last registry snapshot; `live_terminal_id` is deliberately not stored
    // here but filled in at send time, so "changed or not" is only about the
    // registry's own contents.
    let mut projects: Vec<ProjectInfo> = Vec::new();
    // Only enabled agents are offered; recomputed every time settings change.
    let mut agent_names: Vec<AgentBrief> = enabled_agents(&cfg);
    // The first scan takes a few seconds. Until it finishes, an empty sidebar
    // means "not known yet", not "there are no projects".
    let mut scanned = false;

    // Ends by itself once every Sender is gone — no polled flag.
    for cmd in rx.iter() {
        match cmd {
            Cmd::ClientUp { id, tx, rx } => {
                clients.insert(id, Client { tx, rx });
                info!(client = id, "client connected");
                send_state(&cfg, &projects, &agent_names, scanned, &clients, &terminals, Some(id));
            }

            Cmd::ClientDown { id } => {
                clients.remove(&id);
                for t in terminals.values_mut() {
                    if t.viewers.remove(&id).is_some() && renegotiate(t) {
                        broadcast_size(&clients, t);
                    }
                }
                info!(client = id, "client disconnected");
            }

            Cmd::ClientMsg { id, msg } => match msg {
                ClientMsg::List => send_state(&cfg, &projects, &agent_names, scanned, &clients, &terminals, Some(id)),

                ClientMsg::Spawn { project, agent, resume, cols, rows } => {
                    let (cols, rows) = sane_size(cols, rows);
                    match spawn_terminal(&cfg, next_term, &project, &agent, resume, cols, rows, &tx)
                    {
                        Ok(mut term) => {
                            let tid = term.id;
                            term.viewers.insert(id, (cols, rows));
                            terminals.insert(tid, term);
                            next_term += 1;
                            info!(terminal = tid, %project, %agent, "terminal created");
                            send_state(&cfg, &projects, &agent_names, scanned, &clients, &terminals, None);
                            send_to(&clients, id, json(&ServerMsg::Attached { id: tid, cols, rows }));
                        }
                        Err((code, message)) => {
                            warn!(%project, %agent, %message, "spawn failed");
                            send_to(&clients, id, json(&ServerMsg::Error { code, message }));
                        }
                    }
                }

                ClientMsg::Fork { project, agent, session_id, name, cols, rows } => {
                    let (cols, rows) = sane_size(cols, rows);
                    match fork_terminal(
                        &cfg, next_term, &project, &agent, &session_id, &name, cols, rows, &tx,
                    ) {
                        Ok(mut term) => {
                            let tid = term.id;
                            term.viewers.insert(id, (cols, rows));
                            terminals.insert(tid, term);
                            next_term += 1;
                            info!(terminal = tid, %project, %agent, %session_id, "session forked");
                            send_state(&cfg, &projects, &agent_names, scanned, &clients, &terminals, None);
                            send_to(&clients, id, json(&ServerMsg::Attached { id: tid, cols, rows }));
                        }
                        Err((code, message)) => {
                            warn!(%project, %agent, %message, "fork failed");
                            send_to(&clients, id, json(&ServerMsg::Error { code, message }));
                        }
                    }
                }

                ClientMsg::Attach { id: tid, cols, rows } => {
                    let (cols, rows) = sane_size(cols, rows);
                    match terminals.get_mut(&tid) {
                        Some(t) => {
                            t.viewers.insert(id, (cols, rows));
                            let resized = renegotiate(t);

                            // The order is binding: the ring buffer first, then
                            // `attached`, then the live stream. Without it, opening
                            // from another device shows a blank screen until new
                            // output arrives — which is the main use case.
                            if !t.ring.is_empty() {
                                let snap = t.ring.snapshot();
                                send_to(&clients, id, Out::Binary(encode_frame(tid, &snap)));
                            }
                            send_to(
                                &clients,
                                id,
                                json(&ServerMsg::Attached { id: tid, cols: t.cols, rows: t.rows }),
                            );
                            info!(
                                terminal = tid,
                                client = id,
                                replay = t.ring.len(),
                                "client attached"
                            );
                            if resized {
                                broadcast_size(&clients, t);
                            }
                        }
                        None => send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "no_such_terminal".into(),
                                message: format!("Terminal {tid} does not exist."),
                            }),
                        ),
                    }
                }

                ClientMsg::Detach { id: tid } => {
                    if let Some(t) = terminals.get_mut(&tid) {
                        if t.viewers.remove(&id).is_some() && renegotiate(t) {
                            broadcast_size(&clients, t);
                        }
                    }
                }

                ClientMsg::Resize { id: tid, cols, rows } => {
                    let (cols, rows) = sane_size(cols, rows);
                    if let Some(t) = terminals.get_mut(&tid) {
                        // A resize from a client that is not attached is ignored —
                        // its size must not pull on the PTY.
                        if t.viewers.contains_key(&id) {
                            t.viewers.insert(id, (cols, rows));
                            if renegotiate(t) {
                                broadcast_size(&clients, t);
                            }
                        }
                    }
                }

                ClientMsg::Mem => {
                    let roots: Vec<(u32, u32)> = terminals
                        .values()
                        .filter(|t| t.alive)
                        .filter_map(|t| t.pty.as_ref()?.pid().map(|p| (t.id, p)))
                        .collect();
                    let Some(out) = clients.get(&id).map(|c| c.tx.clone()) else { continue };
                    // Reading the process table takes tens of milliseconds; the
                    // actor must not wait for it.
                    std::thread::spawn(move || {
                        let rows = crate::memory::sample(&roots);
                        let msg = ServerMsg::Mem {
                            terminals: rows
                                .into_iter()
                                .map(|m| MemInfo {
                                    id: m.id,
                                    rss_bytes: m.rss_bytes,
                                    processes: m.processes,
                                })
                                .collect(),
                        };
                        if let Ok(text) = serde_json::to_string(&msg) {
                            let _ = out.try_send(Out::Text(text));
                        }
                    });
                }

                ClientMsg::Config => {
                    let Some(out) = clients.get(&id).map(|c| c.tx.clone()) else { continue };
                    let agents: Vec<(String, crate::config::Agent)> =
                        cfg.agents.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                    let lan_access = cfg.lan_access;
                    let token = cfg.token.clone();
                    let limits = cfg.drops.clone();
                    // Counted here while the terminal list is still in hand; the
                    // thread below must not touch it.
                    let live: Vec<(String, usize)> = cfg
                        .agents
                        .keys()
                        .map(|name| {
                            let n = terminals
                                .values()
                                .filter(|t| t.alive && &t.agent == name)
                                .count();
                            (name.clone(), n)
                        })
                        .collect();
                    // Resolving a command on PATH calls `where.exe` once per
                    // agent; the actor must not wait on that.
                    std::thread::spawn(move || {
                        let live: std::collections::HashMap<String, usize> =
                            live.into_iter().collect();
                        let list: Vec<AgentInfo> = agents
                            .into_iter()
                            .map(|(name, a)| AgentInfo {
                                resolved: crate::pty::resolve_command(&a.command)
                                    .map(|p| p.display().to_string()),
                                is_terminal: a.resume_args.is_empty(),
                                fork_args: a.fork_args.unwrap_or_default(),
                                removable: name != crate::config::TERMINAL_AGENT,
                                live: live.get(&name).copied().unwrap_or(0),
                                name,
                                command: a.command,
                                resume_args: a.resume_args,
                                enabled: a.enabled,
                            })
                            .collect();
                        let shells = crate::config::shell_presets()
                            .into_iter()
                            .filter(|(_, cmd)| crate::pty::resolve_command(cmd).is_some())
                            .map(|(label, command)| crate::proto::ShellPreset {
                                label: label.to_string(),
                                command,
                            })
                            .collect();
                        // The address comes from the listener that is actually
                        // alive, not from the setting — if opening it failed, the
                        // panel must not promise a dead URL.
                        let listening = crate::http::lan_listening();
                        let lan_url = listening.map(|a| format!("http://{a}/?token={token}"));
                        // The pairing link: one line to paste on another machine.
                        // Four input boxes are four chances to get it wrong.
                        let pair_url = listening
                            .map(|a| crate::remote::pair_link(&a.ip().to_string(), a.port(), &token));
                        let (files, bytes) = crate::drops::usage();
                        let msg = ServerMsg::Config {
                            agents: list,
                            config_path: crate::config::config_path().display().to_string(),
                            shells,
                            drops: crate::proto::DropInfo {
                                dir: crate::config::dropped_dir().display().to_string(),
                                max_age_hours: limits.max_age_hours,
                                max_total_mb: limits.max_total_mb,
                                max_file_mb: limits.max_file_mb,
                                files,
                                bytes,
                            },
                            lan_access,
                            lan_url,
                            pair_url,
                        };
                        if let Ok(text) = serde_json::to_string(&msg) {
                            let _ = out.try_send(Out::Text(text));
                        }
                    });
                }

                ClientMsg::SetAgent { name, command, resume_args, enabled, fork_args } => {
                    let name = name.trim().to_lowercase();
                    let command = command.trim().to_string();
                    // New names are filtered; ones already in the config are left
                    // alone, so editing an old agent is not suddenly refused by a
                    // rule that only came into force now.
                    let fresh = !cfg.agents.contains_key(&name);
                    if let Err(why) = check_agent_name(&name, fresh) {
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error { code: "bad_agent".into(), message: why }),
                        );
                        continue;
                    }
                    if command.is_empty() {
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "bad_agent".into(),
                                message: "The command must not be empty.".into(),
                            }),
                        );
                        continue;
                    }
                    let entry = cfg.agents.entry(name.clone()).or_insert_with(|| {
                        crate::config::Agent {
                            command: command.clone(),
                            resume_args: Vec::new(),
                            env: Default::default(),
                            enabled,
                            // A new agent is assumed unable to fork until the user
                            // says otherwise; guessing the fork flag of a foreign
                            // harness would only build a button that destroys
                            // someone's session.
                            fork_args: Some(Vec::new()),
                        }
                    });
                    entry.command = command;
                    entry.resume_args = resume_args;
                    entry.enabled = enabled;
                    if let Some(f) = fork_args {
                        entry.fork_args = Some(f);
                    }

                    if let Err(e) = crate::config::save(&cfg) {
                        warn!(error = %e, "could not save config");
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "config_write_failed".into(),
                                message: format!("Could not write config.toml: {e}"),
                            }),
                        );
                        continue;
                    }
                    info!(agent = %name, enabled, "agent settings saved");

                    agent_names = enabled_agents(&cfg);
                    // The registry needs to know which agents are still scanned.
                    let _ = registry_cfg.try_send(cfg.clone());
                    send_state(&cfg, &projects, &agent_names, scanned, &clients, &terminals, None);
                    // Answer with the latest contents so the settings panel never
                    // has to guess what was actually stored.
                    if tx.send(Cmd::ClientMsg { id, msg: ClientMsg::Config }).is_err() {
                        return;
                    }
                }

                ClientMsg::RemoveAgent { name } => {
                    let name = name.trim().to_lowercase();
                    if name == crate::config::TERMINAL_AGENT {
                        // Removing it would appear to work until the next restart,
                        // because `load_or_create` builds it again.
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "bad_agent".into(),
                                message: format!(
                                    "`{name}` is rebuilt every time the daemon starts. \
                                     Disable it instead of removing it."
                                ),
                            }),
                        );
                        continue;
                    }
                    if cfg.agents.remove(&name).is_none() {
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "unknown_agent".into(),
                                message: format!("There is no agent called `{name}`."),
                            }),
                        );
                        continue;
                    }
                    if let Err(e) = crate::config::save(&cfg) {
                        warn!(error = %e, "could not save config");
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "config_write_failed".into(),
                                message: format!("Could not write config.toml: {e}"),
                            }),
                        );
                        continue;
                    }
                    // Running terminals are deliberately left alive: removing a
                    // setting must not kill work in progress. What is lost is only
                    // the ability to make new ones, and the scanning of its
                    // sessions.
                    info!(agent = %name, "agent removed");
                    agent_names = enabled_agents(&cfg);
                    let _ = registry_cfg.try_send(cfg.clone());
                    send_state(&cfg, &projects, &agent_names, scanned, &clients, &terminals, None);
                    if tx.send(Cmd::ClientMsg { id, msg: ClientMsg::Config }).is_err() {
                        return;
                    }
                }

                ClientMsg::Browse { path } => {
                    let Some(out) = clients.get(&id).map(|c| c.tx.clone()) else { continue };
                    let known = cfg.projects.clone();
                    // Reading a directory can take time — one sluggish network
                    // drive is enough to freeze every terminal if it were waited
                    // on inside the actor.
                    std::thread::spawn(move || {
                        let msg = match crate::browse::list(&path, &known) {
                            Ok(d) => ServerMsg::Dir(d),
                            Err(e) => ServerMsg::Error { code: "browse_failed".into(), message: e },
                        };
                        if let Ok(text) = serde_json::to_string(&msg) {
                            let _ = out.try_send(Out::Text(text));
                        }
                    });
                }

                ClientMsg::MakeDir { parent, name } => {
                    let Some(out) = clients.get(&id).map(|c| c.tx.clone()) else { continue };
                    let known = cfg.projects.clone();
                    std::thread::spawn(move || {
                        // Once created, what is sent back is the new folder's
                        // contents — so "create then step in" is one step.
                        let msg = match crate::browse::make_dir(&parent, &name) {
                            Ok(p) => match crate::browse::list(&p.to_string_lossy(), &known) {
                                Ok(d) => ServerMsg::Dir(d),
                                Err(e) => {
                                    ServerMsg::Error { code: "browse_failed".into(), message: e }
                                }
                            },
                            Err(e) => ServerMsg::Error { code: "mkdir_failed".into(), message: e },
                        };
                        if let Ok(text) = serde_json::to_string(&msg) {
                            let _ = out.try_send(Out::Text(text));
                        }
                    });
                }

                ClientMsg::AddProject { path } => {
                    let path = path.trim().to_string();
                    match std::fs::metadata(&path) {
                        Ok(m) if m.is_dir() => {}
                        Ok(_) => {
                            send_to(
                                &clients,
                                id,
                                json(&ServerMsg::Error {
                                    code: "bad_project".into(),
                                    message: format!("{path} is not a folder."),
                                }),
                            );
                            continue;
                        }
                        Err(e) => {
                            send_to(
                                &clients,
                                id,
                                json(&ServerMsg::Error {
                                    code: "bad_project".into(),
                                    message: format!("Cannot open {path}: {e}"),
                                }),
                            );
                            continue;
                        }
                    }
                    // A case-insensitive comparison: Windows writes the same
                    // folder with different spellings, and a duplicate project
                    // would simply appear twice in the sidebar.
                    if cfg.projects.iter().any(|p| p.eq_ignore_ascii_case(&path)) {
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "duplicate_project".into(),
                                message: format!("{path} is already a project."),
                            }),
                        );
                        continue;
                    }
                    cfg.projects.push(path.clone());
                    if let Err(e) = crate::config::save(&cfg) {
                        cfg.projects.pop();
                        warn!(error = %e, "could not save config");
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "config_write_failed".into(),
                                message: format!("Could not write config.toml: {e}"),
                            }),
                        );
                        continue;
                    }
                    info!(%path, "project added");
                    // Shown right away, without waiting for the registry. A full
                    // scan can take seconds on a machine with many sessions, and a
                    // "Use this folder" that produces nothing for that long feels
                    // like a failure. The next scan overwrites it, complete with
                    // any sessions already in that folder.
                    if !projects.iter().any(|p| p.path.eq_ignore_ascii_case(&path)) {
                        projects.push(ProjectInfo {
                            name: crate::registry::project_name(&path),
                            path: path.clone(),
                            exists: true,
                            sessions: Vec::new(),
                        });
                    }
                    let _ = registry_cfg.try_send(cfg.clone());
                    send_state(&cfg, &projects, &agent_names, scanned, &clients, &terminals, None);
                }

                // The file panel. All three touch the disk, so none of them run
                // inside the actor: one folder on a sluggish network drive must
                // not freeze every terminal.
                ClientMsg::Tree { path } => {
                    let Some(out) = clients.get(&id).map(|c| c.tx.clone()) else { continue };
                    std::thread::spawn(move || {
                        let msg = match crate::files::list(&path) {
                            Ok(t) => ServerMsg::Tree(t),
                            Err(e) => ServerMsg::Error { code: "tree_failed".into(), message: e },
                        };
                        if let Ok(text) = serde_json::to_string(&msg) {
                            let _ = out.try_send(Out::Text(text));
                        }
                    });
                }

                ClientMsg::OpenFile { path } => {
                    let Some(out) = clients.get(&id).map(|c| c.tx.clone()) else { continue };
                    std::thread::spawn(move || {
                        let msg = match crate::files::read(&path) {
                            Ok(b) => ServerMsg::File(b),
                            Err(e) => ServerMsg::Error { code: "open_failed".into(), message: e },
                        };
                        if let Ok(text) = serde_json::to_string(&msg) {
                            let _ = out.try_send(Out::Text(text));
                        }
                    });
                }

                ClientMsg::SaveFile { path, text } => {
                    let Some(out) = clients.get(&id).map(|c| c.tx.clone()) else { continue };
                    std::thread::spawn(move || {
                        let msg = match crate::files::write(&path, &text) {
                            Ok(modified_ms) => {
                                info!(%path, bytes = text.len(), "file saved");
                                ServerMsg::Saved { path, modified_ms }
                            }
                            Err(e) => {
                                warn!(error = %e, "could not save file");
                                ServerMsg::Error { code: "save_failed".into(), message: e }
                            }
                        };
                        if let Ok(t) = serde_json::to_string(&msg) {
                            let _ = out.try_send(Out::Text(t));
                        }
                    });
                }

                ClientMsg::RemoveProject { path } => {
                    let path = path.trim().to_string();
                    let before = cfg.projects.len();
                    cfg.projects.retain(|p| !p.eq_ignore_ascii_case(&path));
                    if cfg.projects.len() == before {
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "unknown_project".into(),
                                message: "That project was found from an existing agent session, \
                                          so it is not listed in config.toml and will come back \
                                          on its own."
                                    .into(),
                            }),
                        );
                        continue;
                    }
                    if let Err(e) = crate::config::save(&cfg) {
                        warn!(error = %e, "could not save config");
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "config_write_failed".into(),
                                message: format!("Could not write config.toml: {e}"),
                            }),
                        );
                        continue;
                    }
                    info!(%path, "project removed");
                    // One without sessions only exists because of the config, so it
                    // may go right now. One with sessions is left alone: the
                    // registry will find it again, and making it vanish for a
                    // moment would only look like a flicker.
                    projects.retain(|p| !p.path.eq_ignore_ascii_case(&path) || !p.sessions.is_empty());
                    let _ = registry_cfg.try_send(cfg.clone());
                    send_state(&cfg, &projects, &agent_names, scanned, &clients, &terminals, None);
                }

                ClientMsg::SetDrops { max_age_hours, max_total_mb, max_file_mb } => {
                    // Limits are clamped into a sensible range rather than refused:
                    // zero has its own meaning (no limit), and a giant number from
                    // a client must not become policy.
                    cfg.drops.max_age_hours = max_age_hours.min(24 * 365);
                    cfg.drops.max_total_mb = max_total_mb.min(1024 * 1024);
                    cfg.drops.max_file_mb = max_file_mb.min(256);
                    if let Err(e) = crate::config::save(&cfg) {
                        warn!(error = %e, "could not save config");
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "config_write_failed".into(),
                                message: format!("Could not write config.toml: {e}"),
                            }),
                        );
                        continue;
                    }
                    crate::drops::sweep(&cfg.drops);
                    if tx.send(Cmd::ClientMsg { id, msg: ClientMsg::Config }).is_err() {
                        return;
                    }
                }

                ClientMsg::Remotes => {
                    send_to(&clients, id, json(&remotes_msg(&cfg)));
                }

                ClientMsg::Pair { link, name } => {
                    let Some(out) = clients.get(&id).map(|c| c.tx.clone()) else { continue };
                    let our_port = cfg.port;
                    let have = cfg.remotes.clone();
                    let wanted = name.trim().to_lowercase();
                    // Pairing means calling another machine; that must not happen
                    // inside the actor.
                    let (done, wait) = crossbeam_channel::bounded(1);
                    std::thread::spawn(move || {
                        let _ = done.send(pair_remote(&link, &wanted, &have, our_port));
                    });
                    let outcome = wait
                        .recv_timeout(std::time::Duration::from_secs(20))
                        .unwrap_or_else(|_| Err("The other machine did not answer in time.".into()));

                    match outcome {
                        Ok(r) => {
                            info!(name = %r.name, addr = %r.addr, "paired with another machine");
                            // Re-pairing the same address updates its token rather
                            // than adding a second row: a token changed over there
                            // is precisely why someone pastes a new link.
                            let addr = r.addr.clone();
                            if let Some(slot) =
                                cfg.remotes.iter_mut().find(|x| x.addr == addr)
                            {
                                slot.token = r.token;
                                slot.version = r.version;
                            } else {
                                cfg.remotes.push(r);
                            }
                            if let Err(e) = crate::config::save(&cfg) {
                                warn!(error = %e, "could not save config");
                                send_to(
                                    &clients,
                                    id,
                                    json(&ServerMsg::Error {
                                        code: "config_write_failed".into(),
                                        message: format!("Could not write config.toml: {e}"),
                                    }),
                                );
                                continue;
                            }
                            send_to(&clients, id, json(&remotes_msg(&cfg)));
                        }
                        Err(message) => {
                            warn!(%message, "pairing refused");
                            let _ = out.try_send(json(&ServerMsg::Error {
                                code: "pair_failed".into(),
                                message,
                            }));
                        }
                    }
                }

                ClientMsg::Forget { name } => {
                    let before = cfg.remotes.len();
                    cfg.remotes.retain(|r| r.name != name);
                    if cfg.remotes.len() == before {
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "unknown_remote".into(),
                                message: format!("There is no paired machine called `{name}`."),
                            }),
                        );
                        continue;
                    }
                    if let Err(e) = crate::config::save(&cfg) {
                        warn!(error = %e, "could not save config");
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "config_write_failed".into(),
                                message: format!("Could not write config.toml: {e}"),
                            }),
                        );
                        continue;
                    }
                    info!(%name, "forgot a paired machine");
                    send_to(&clients, id, json(&remotes_msg(&cfg)));
                }

                ClientMsg::UpdateCheck => {
                    // Straight on this thread: one HTTPS request, only when a
                    // person clicks Check, and the panel is waiting for it.
                    let msg = match crate::update::check() {
                        Ok(rel) => ServerMsg::Update {
                            current: crate::update::current().to_string(),
                            newer: crate::update::is_newer(&rel.version, crate::update::current()),
                            installable: rel.asset_url.is_some(),
                            latest: rel.version,
                            notes: rel.notes,
                            applying: false,
                        },
                        Err(why) => {
                            warn!(error = %why, "update check failed");
                            ServerMsg::Error { code: "update_check".into(), message: why }
                        }
                    };
                    send_to(&clients, id, json(&msg));
                }

                ClientMsg::UpdateApply => {
                    let rel = match crate::update::check() {
                        Ok(r) => r,
                        Err(why) => {
                            send_to(
                                &clients,
                                id,
                                json(&ServerMsg::Error { code: "update_check".into(), message: why }),
                            );
                            continue;
                        }
                    };
                    if !crate::update::is_newer(&rel.version, crate::update::current()) {
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "update_none".into(),
                                message: format!("{} is already the newest release.", rel.tag),
                            }),
                        );
                        continue;
                    }
                    if let Err(why) = crate::update::apply(&rel) {
                        warn!(error = %why, "update failed");
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error { code: "update_failed".into(), message: why }),
                        );
                        continue;
                    }
                    // Told before the lights go out: the socket dies with the
                    // daemon, so a message sent afterwards would never arrive.
                    send_to(
                        &clients,
                        id,
                        json(&ServerMsg::Update {
                            current: crate::update::current().to_string(),
                            latest: rel.version,
                            newer: true,
                            installable: true,
                            notes: rel.notes,
                            applying: true,
                        }),
                    );
                    // Exactly the road `sessionhubd stop` takes, and for a
                    // reason learned the hard way: `Cmd::Shutdown` alone ends
                    // the terminals but leaves this process alive holding the
                    // port, so the swapped-in binary came back and died on
                    // "address already in use" while the old one kept running.
                    // The swapper is waiting on this pid to disappear.
                    info!("restarting into the new build");
                    let tx = tx.clone();
                    std::thread::spawn(move || {
                        let _ = tx.send(Cmd::Shutdown);
                        std::thread::sleep(std::time::Duration::from_millis(400));
                        crate::daemon::remove_pid_file();
                        std::process::exit(0);
                    });
                    continue;
                }

                ClientMsg::SweepDrops => {
                    crate::drops::sweep(&cfg.drops);
                    if tx.send(Cmd::ClientMsg { id, msg: ClientMsg::Config }).is_err() {
                        return;
                    }
                }

                ClientMsg::SetLanAccess { enabled } => {
                    match crate::http::set_lan_access(enabled) {
                        Ok(Some(addr)) => info!(%addr, "network access opened"),
                        Ok(None) if enabled => {
                            // No LAN address at all: the machine is off the network.
                            // The setting is not saved, so the panel does not show
                            // a switch that is on while listening to nothing.
                            send_to(
                                &clients,
                                id,
                                json(&ServerMsg::Error {
                                    code: "no_network".into(),
                                    message: "No local network address found on this machine."
                                        .into(),
                                }),
                            );
                            let _ = tx.send(Cmd::ClientMsg { id, msg: ClientMsg::Config });
                            continue;
                        }
                        Ok(None) => info!("network access closed"),
                        Err(e) => {
                            warn!(error = %e, "could not change network access");
                            send_to(
                                &clients,
                                id,
                                json(&ServerMsg::Error {
                                    code: "lan_failed".into(),
                                    message: format!("Could not change network access: {e}"),
                                }),
                            );
                            let _ = tx.send(Cmd::ClientMsg { id, msg: ClientMsg::Config });
                            continue;
                        }
                    }

                    cfg.lan_access = enabled;
                    if let Err(e) = crate::config::save(&cfg) {
                        // The listener already changed; what failed is only making
                        // that change survive a restart.
                        warn!(error = %e, "could not save config");
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "config_write_failed".into(),
                                message: format!(
                                    "Network access changed, but config.toml could not be \
                                     written, so it will reset on restart: {e}"
                                ),
                            }),
                        );
                    }
                    if tx.send(Cmd::ClientMsg { id, msg: ClientMsg::Config }).is_err() {
                        return;
                    }
                }

                ClientMsg::Kill { id: tid } => {
                    if let Some(t) = terminals.get_mut(&tid) {
                        info!(terminal = tid, "kill requested by client");
                        if let Some(p) = t.pty.as_mut() {
                            p.kill();
                        }
                    }
                }

                ClientMsg::LastCommand { id: tid } => {
                    let command =
                        terminals.get(&tid).map(|t| t.typed.last().to_string()).unwrap_or_default();
                    send_to(&clients, id, json(&ServerMsg::LastCommand { id: tid, command }));
                }

                ClientMsg::SetColor { id: tid, color } => {
                    if let Err(message) = crate::config::check_color(&color) {
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error { code: "bad_color".into(), message }),
                        );
                        continue;
                    }
                    let Some(t) = terminals.get_mut(&tid) else { continue };
                    t.color = if color.is_empty() { None } else { Some(color.clone()) };

                    // On a named terminal the tag belongs with the name, so it is
                    // there again the next time it is opened — and on every other
                    // device, which is the point of keeping it here rather than
                    // in one browser's storage.
                    if let Some(name) = t.name.clone() {
                        let project = t.project.clone();
                        if let Some(entry) = cfg
                            .saved
                            .iter_mut()
                            .find(|s| s.name == name && same_path(&s.project, &project))
                        {
                            entry.color = color.clone();
                            if let Err(e) = crate::config::save(&cfg) {
                                warn!(error = %e, "could not save config");
                            }
                        }
                    }
                    info!(terminal = tid, %color, "tab colour set");
                    send_state(&cfg, &projects, &agent_names, scanned, &clients, &terminals, None);
                }

                ClientMsg::SaveTerminal { id: tid, name, command } => {
                    let name = name.trim().to_string();
                    if let Err(message) = crate::config::check_saved_name(&name) {
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error { code: "bad_name".into(), message }),
                        );
                        continue;
                    }
                    let Some(t) = terminals.get(&tid) else {
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "no_such_terminal".into(),
                                message: format!("Terminal {tid} does not exist."),
                            }),
                        );
                        continue;
                    };
                    let entry = crate::config::SavedTerminal {
                        name: name.clone(),
                        project: t.project.clone(),
                        agent: t.agent.clone(),
                        command: crate::typed::clean_command(&command),
                        // Naming a terminal never changes its tag.
                        color: t.color.clone().unwrap_or_default(),
                    };

                    let before = cfg.saved.clone();
                    // A terminal can only be under one name at a time, so an
                    // earlier name for this same one is replaced rather than
                    // left behind as a second row nobody meant to keep.
                    if let Some(old) = t.name.clone() {
                        cfg.saved.retain(|s| !(same_path(&s.project, &t.project) && s.name == old));
                    }
                    // Saving a name that already exists in this project updates
                    // it. That is how the command gets changed.
                    cfg.saved
                        .retain(|s| !(same_path(&s.project, &entry.project) && s.name == entry.name));
                    cfg.saved.push(entry.clone());

                    if let Err(e) = crate::config::save(&cfg) {
                        cfg.saved = before;
                        warn!(error = %e, "could not save config");
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "config_write_failed".into(),
                                message: format!("Could not write config.toml: {e}"),
                            }),
                        );
                        continue;
                    }

                    // Its project has to be a project, or the row would be saved
                    // into a folder the sidebar never draws.
                    if !cfg.projects.iter().any(|p| same_path(p, &entry.project)) {
                        cfg.projects.push(entry.project.clone());
                        if let Err(e) = crate::config::save(&cfg) {
                            warn!(error = %e, "could not save config");
                        }
                        if !projects.iter().any(|p| same_path(&p.path, &entry.project)) {
                            projects.push(ProjectInfo {
                                name: crate::registry::project_name(&entry.project),
                                path: entry.project.clone(),
                                exists: true,
                                sessions: Vec::new(),
                            });
                        }
                        let _ = registry_cfg.try_send(cfg.clone());
                    }

                    // A name belongs to one terminal at a time. Without this,
                    // saving a second terminal under a name an older one already
                    // wears leaves both claiming it: the sidebar draws the same
                    // row twice and `live_terminal_id` picks whichever the map
                    // happens to yield first.
                    for t in terminals.values_mut() {
                        if t.id != tid
                            && t.name.as_deref() == Some(name.as_str())
                            && same_path(&t.project, &entry.project)
                        {
                            t.name = None;
                        }
                    }
                    if let Some(t) = terminals.get_mut(&tid) {
                        t.name = Some(name.clone());
                    }
                    info!(terminal = tid, %name, "terminal saved");
                    send_state(&cfg, &projects, &agent_names, scanned, &clients, &terminals, None);
                }

                ClientMsg::ForgetTerminal { project, name } => {
                    let before = cfg.saved.len();
                    cfg.saved.retain(|s| !(same_path(&s.project, &project) && s.name == name));
                    if cfg.saved.len() == before {
                        continue;
                    }
                    if let Err(e) = crate::config::save(&cfg) {
                        warn!(error = %e, "could not save config");
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "config_write_failed".into(),
                                message: format!("Could not write config.toml: {e}"),
                            }),
                        );
                        continue;
                    }
                    // A terminal running under that name keeps running; only the
                    // note is gone, so its row goes back to being a plain one.
                    for t in terminals.values_mut() {
                        if t.name.as_deref() == Some(name.as_str()) && same_path(&t.project, &project)
                        {
                            t.name = None;
                        }
                    }
                    info!(%project, %name, "saved terminal forgotten");
                    send_state(&cfg, &projects, &agent_names, scanned, &clients, &terminals, None);
                }

                ClientMsg::OpenSaved { project, name, cols, rows } => {
                    let (cols, rows) = sane_size(cols, rows);
                    let Some(saved) = cfg
                        .saved
                        .iter()
                        .find(|s| same_path(&s.project, &project) && s.name == name)
                        .cloned()
                    else {
                        send_to(
                            &clients,
                            id,
                            json(&ServerMsg::Error {
                                code: "no_such_saved".into(),
                                message: format!("`{name}` is not a saved terminal any more."),
                            }),
                        );
                        continue;
                    };

                    // Already running: show that one rather than starting the
                    // same bot a second time on the same port.
                    if let Some(t) = terminals
                        .values()
                        .find(|t| t.alive && t.name.as_deref() == Some(name.as_str())
                            && same_path(&t.project, &saved.project))
                    {
                        let tid = t.id;
                        if let Some(t) = terminals.get_mut(&tid) {
                            t.viewers.insert(id, (cols, rows));
                            let resized = renegotiate(t);
                            if !t.ring.is_empty() {
                                let snap = t.ring.snapshot();
                                send_to(&clients, id, Out::Binary(encode_frame(tid, &snap)));
                            }
                            let (c, r) = (t.cols, t.rows);
                            send_to(
                                &clients,
                                id,
                                json(&ServerMsg::Attached { id: tid, cols: c, rows: r }),
                            );
                            if resized {
                                let t = &terminals[&tid];
                                broadcast_size(&clients, t);
                            }
                        }
                        continue;
                    }

                    match spawn_terminal(
                        &cfg, next_term, &saved.project, &saved.agent, None, cols, rows, &tx,
                    ) {
                        Ok(mut term) => {
                            let tid = term.id;
                            term.viewers.insert(id, (cols, rows));
                            term.name = Some(saved.name.clone());
                            if !saved.color.is_empty() {
                                term.color = Some(saved.color.clone());
                            }
                            if !saved.command.is_empty() {
                                term.pending_run = Some(saved.command.clone());
                            }
                            terminals.insert(tid, term);
                            next_term += 1;
                            info!(terminal = tid, name = %saved.name, "saved terminal opened");
                            send_state(
                                &cfg, &projects, &agent_names, scanned, &clients, &terminals, None,
                            );
                            send_to(&clients, id, json(&ServerMsg::Attached { id: tid, cols, rows }));
                        }
                        Err((code, message)) => {
                            warn!(name = %saved.name, %message, "opening saved terminal failed");
                            send_to(&clients, id, json(&ServerMsg::Error { code, message }));
                        }
                    }
                }
            },

            Cmd::ClientInput { term, data } => {
                if let Some(t) = terminals.get_mut(&term) {
                    if let Some(p) = t.pty.as_ref() {
                        p.write_input(&data);
                    }
                    // Only for a plain shell. An agent's TUI reads keys for its
                    // own prompt, and "the last line typed into claude" is a
                    // sentence of English, not a command worth saving.
                    if t.agent == crate::config::TERMINAL_AGENT {
                        t.typed.feed(&data);
                    }
                }
            }

            Cmd::ClientDrop { id, term, name, data } => {
                let Some(out) = clients.get(&id).map(|c| c.tx.clone()) else { continue };
                let bytes = data.len() as u64;
                let limits = cfg.drops.clone();
                // Writing tens of megabytes to disk must not hold the actor —
                // every other terminal would freeze along with it.
                std::thread::spawn(move || {
                    let msg = match crate::drops::save(&limits, &name, &data) {
                        Ok(path) => {
                            crate::drops::sweep(&limits);
                            ServerMsg::Dropped {
                                id: term,
                                path: path.display().to_string(),
                                name: path
                                    .file_name()
                                    .map(|n| n.to_string_lossy().into_owned())
                                    .unwrap_or_default(),
                                bytes,
                            }
                        }
                        Err(e) => ServerMsg::Error { code: "drop_failed".into(), message: e },
                    };
                    if let Ok(text) = serde_json::to_string(&msg) {
                        let _ = out.try_send(Out::Text(text));
                    }
                });
            }

            Cmd::Pty { term, event } => match event {
                PtyEvent::Output(data) => {
                    if let Some(t) = terminals.get_mut(&term) {
                        t.ring.push(&data);
                        let frame = encode_frame(term, &data);
                        for cid in t.viewers.keys() {
                            send_to(&clients, *cid, Out::Binary(frame.clone()));
                        }
                        // The shell has spoken, so it is running and reading.
                        // This is the signal a fixed delay could only guess at:
                        // a PowerShell profile can take a second to load, and a
                        // command sent before that is swallowed.
                        if let Some(cmd) = t.pending_run.take() {
                            let tx = tx.clone();
                            std::thread::spawn(move || {
                                // A breath more, so the prompt is drawn before
                                // the command lands on it. Typing into a
                                // half-drawn prompt works but reads as a mess.
                                std::thread::sleep(std::time::Duration::from_millis(400));
                                let mut data = cmd.into_bytes();
                                data.push(b'\r');
                                let _ = tx.send(Cmd::ClientInput { term, data });
                            });
                        }
                    }
                }
                PtyEvent::Eof { code } => {
                    if let Some(t) = terminals.get_mut(&term) {
                        t.alive = false;
                        // Closes the ConPTY; without this the reader thread hangs
                        // forever in read() even though its child is dead.
                        t.pty = None;
                        info!(terminal = term, code, "terminal ended");
                        let msg = json(&ServerMsg::Exit { id: term, code });
                        for cid in t.viewers.keys().copied().collect::<Vec<_>>() {
                            send_to(&clients, cid, msg.clone());
                        }
                    }
                    send_state(&cfg, &projects, &agent_names, scanned, &clients, &terminals, None);
                }
            },

            Cmd::Registry(fresh) => {
                let first = !scanned;
                scanned = true;
                if fresh == projects && !first {
                    continue; // a rescan that changed nothing
                }
                projects = fresh;

                // A terminal spawned without resume can only have its session
                // recognised once the agent has written it.
                let mut claimed: HashSet<String> =
                    terminals.values().filter_map(|t| t.session_id.clone()).collect();
                for t in terminals.values_mut().filter(|t| t.alive && t.session_id.is_none()) {
                    if let Some(sid) = registry::pick_adoption(
                        &projects,
                        &t.project,
                        &t.agent,
                        t.started_ms,
                        &claimed,
                    ) {
                        info!(terminal = t.id, session = %sid, "session matched to terminal");
                        claimed.insert(sid.clone());
                        t.session_id = Some(sid);
                    }
                }
                send_state(&cfg, &projects, &agent_names, scanned, &clients, &terminals, None);
            }

            Cmd::Remote { name, reply } => {
                let _ = reply.send(crate::remote::find(&cfg.remotes, &name).cloned());
            }

            Cmd::Stats { reply } => {
                let total = terminals.len();
                let alive = terminals.values().filter(|t| t.alive).count();
                let _ = reply.send((alive, total));
            }

            Cmd::Shutdown => {
                info!(terminals = terminals.len(), "shutdown requested");
                for t in terminals.values_mut() {
                    if let Some(p) = t.pty.as_mut() {
                        p.kill();
                    }
                }
                return;
            }
        }
    }
}

/// A fork makes a NEW session out of an old conversation; the original is left
/// untouched. That is why the resulting terminal gets no `session_id` — the new
/// id is created by the agent, and recognised later when it shows up in the
/// registry.
#[allow(clippy::too_many_arguments)]
fn fork_terminal(
    cfg: &Config,
    id: u32,
    project: &str,
    agent: &str,
    session_id: &str,
    name: &str,
    cols: u16,
    rows: u16,
    tx: &Sender<Cmd>,
) -> Result<Terminal, (String, String)> {
    let agent_cfg = cfg.agents.get(agent).ok_or_else(|| {
        ("unknown_agent".to_string(), format!("Agent `{agent}` is not in config.toml."))
    })?;
    let Some(pattern) = agent_cfg.fork_args.as_ref().filter(|a| !a.is_empty()) else {
        return Err((
            "fork_unsupported".to_string(),
            format!("Agent `{agent}` has no fork command in config.toml."),
        ));
    };

    // An empty name must not turn into an empty argument the agent swallows as
    // something else.
    let fallback = format!("fork {}", &session_id[..session_id.len().min(8)]);
    let name = if name.trim().is_empty() { fallback.as_str() } else { name.trim() };

    let args: Vec<String> = pattern
        .iter()
        .map(|a| a.replace("{session_id}", session_id).replace("{name}", name))
        .collect();

    build_terminal(cfg, id, project, agent, args, None, cols, rows, tx)
}

#[allow(clippy::too_many_arguments)]
fn spawn_terminal(
    cfg: &Config,
    id: u32,
    project: &str,
    agent: &str,
    resume: Option<String>,
    cols: u16,
    rows: u16,
    tx: &Sender<Cmd>,
) -> Result<Terminal, (String, String)> {
    let agent_cfg = cfg.agents.get(agent).ok_or_else(|| {
        ("unknown_agent".to_string(), format!("Agent `{agent}` is not in config.toml."))
    })?;
    if !agent_cfg.enabled {
        return Err((
            "agent_disabled".to_string(),
            format!("Agent `{agent}` is disabled. Enable it in settings."),
        ));
    }

    let args: Vec<String> = match &resume {
        Some(sid) => agent_cfg
            .resume_args
            .iter()
            .map(|a| a.replace("{session_id}", sid))
            .collect(),
        None => Vec::new(),
    };

    build_terminal(cfg, id, project, agent, args, resume, cols, rows, tx)
}

/// The part shared by spawn and fork: only the arguments differ.
#[allow(clippy::too_many_arguments)]
fn build_terminal(
    cfg: &Config,
    id: u32,
    project: &str,
    agent: &str,
    args: Vec<String>,
    session_id: Option<String>,
    cols: u16,
    rows: u16,
    tx: &Sender<Cmd>,
) -> Result<Terminal, (String, String)> {
    let agent_cfg = cfg.agents.get(agent).ok_or_else(|| {
        ("unknown_agent".to_string(), format!("Agent `{agent}` is not in config.toml."))
    })?;
    if !agent_cfg.enabled {
        return Err((
            "agent_disabled".to_string(),
            format!("Agent `{agent}` is disabled. Enable it in settings."),
        ));
    }

    // cwd is set explicitly to the project path. Never rely on the default —
    // `opencode -s` resumes a session in whatever directory the command ran in.
    let cwd = PathBuf::from(project);
    let sink_tx = tx.clone();
    let pty = Pty::spawn(
        &agent_cfg.command,
        &args,
        &cwd,
        cols,
        rows,
        &agent_cfg.env,
        Arc::new(move |event| {
            let _ = sink_tx.send(Cmd::Pty { term: id, event });
        }),
    )
    .map_err(|e| (e.code().to_string(), e.to_string()))?;

    Ok(Terminal {
        id,
        project: project.to_string(),
        agent: agent.to_string(),
        cols,
        rows,
        alive: true,
        session_id,
        started_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        viewers: HashMap::new(),
        ring: Ring::new(RING_CAP),
        pty: Some(pty),
        // Both are set by the caller when this terminal is a saved one; an
        // ordinary spawn leaves them alone.
        name: None,
        color: None,
        typed: TypedLine::default(),
        pending_run: None,
    })
}

/// An agent name becomes a key in `config.toml` and a label in the menu, so it
/// is filtered on the way in. This applies to new names only: a config that
/// already holds an odd name stays editable rather than being locked by a rule
/// that only appeared later.
fn check_agent_name(name: &str, fresh: bool) -> Result<(), String> {
    if name.is_empty() {
        return Err("Give the agent a name.".into());
    }
    if !fresh {
        return Ok(());
    }
    if name.len() > 24 {
        return Err("Keep the name under 24 characters.".into());
    }
    if !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_') {
        return Err("Use lowercase letters, digits, - and _ only.".into());
    }
    if !name.starts_with(|c: char| c.is_ascii_lowercase()) {
        return Err("Start the name with a letter.".into());
    }
    Ok(())
}

/// The list of paired machines, for clients. Tokens are deliberately left out:
/// a client only names a machine, and the relay matches it.
fn remotes_msg(cfg: &Config) -> ServerMsg {
    ServerMsg::Remotes {
        remotes: cfg
            .remotes
            .iter()
            .map(|r| crate::proto::RemoteInfo {
                name: r.name.clone(),
                addr: r.addr.clone(),
                version: r.version.clone(),
            })
            .collect(),
    }
}

/// Parse the link, prove the machine answers, and only then return an entry
/// worth storing. Storing what is unproven only defers the failure until you
/// actually need it.
fn pair_remote(
    link: &str,
    wanted: &str,
    have: &[crate::config::Remote],
    our_port: u16,
) -> Result<crate::config::Remote, String> {
    let parsed = crate::remote::parse_link(link)?;
    let addr = parsed.addr();
    if crate::remote::is_self(&addr, our_port) {
        return Err(format!("{addr} is this machine. Pair with a different one."));
    }
    let status = crate::remote::probe(&addr, &parsed.token)?;

    // Re-pairing the same address keeps the existing name, so tabs and stored
    // projects do not get renamed behind your back.
    let name = match have.iter().find(|r| r.addr == addr) {
        Some(existing) => existing.name.clone(),
        None => {
            let base = if wanted.is_empty() {
                crate::remote::name_from_addr(&addr)
            } else {
                wanted.to_string()
            };
            crate::remote::check_name(&base)?;
            crate::remote::unique_name(have, &base)
        }
    };

    Ok(crate::config::Remote { name, addr, token: parsed.token, version: status.version })
}

fn enabled_agents(cfg: &Config) -> Vec<AgentBrief> {
    cfg.agents
        .iter()
        .filter(|(_, a)| a.enabled)
        .map(|(name, a)| AgentBrief {
            name: name.clone(),
            can_fork: a.can_fork(),
            fork_takes_name: a.fork_takes_name(),
        })
        .collect()
}

/// The effective PTY size = the smallest cols and the smallest rows across every
/// attached client (the tmux pattern). Letting each client pull the PTY as it
/// likes makes the reflow diverge and two devices show different things.
fn effective_size(viewers: &HashMap<ClientId, (u16, u16)>) -> Option<(u16, u16)> {
    let mut it = viewers.values().copied();
    let first = it.next()?;
    Some(it.fold(first, |(c, r), (c2, r2)| (c.min(c2), r.min(r2))))
}

/// Recompute the effective size and apply it to the PTY. `true` when it changed.
fn renegotiate(t: &mut Terminal) -> bool {
    // With no client attached, the last size is kept — the terminal is still
    // alive and must not shrink to nothing.
    let Some((cols, rows)) = effective_size(&t.viewers) else { return false };
    if (cols, rows) == (t.cols, t.rows) {
        return false;
    }
    let Some(pty) = t.pty.as_ref() else { return false };
    if let Err(e) = pty.resize(cols, rows) {
        warn!(terminal = t.id, error = %e, "resize failed");
        return false;
    }
    info!(terminal = t.id, cols, rows, "effective size changed");
    t.cols = cols;
    t.rows = rows;
    true
}

/// A client can report 0 while its layout is still settling; that must never
/// drag the PTY to an invalid size.
fn sane_size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.max(1), rows.max(1))
}

fn broadcast_size(clients: &HashMap<ClientId, Client>, t: &Terminal) {
    let msg = json(&ServerMsg::Size { id: t.id, cols: t.cols, rows: t.rows });
    for cid in t.viewers.keys() {
        send_to(clients, *cid, msg.clone());
    }
}

/// Two paths naming the same folder, by the rule of this system: Windows and
/// macOS ignore case, Linux does not.
fn same_path(a: &str, b: &str) -> bool {
    registry::path_key(a) == registry::path_key(b)
}

fn send_state(
    cfg: &Config,
    registry: &[ProjectInfo],
    agents: &[AgentBrief],
    scanned: bool,
    clients: &HashMap<ClientId, Client>,
    terminals: &HashMap<u32, Terminal>,
    only: Option<ClientId>,
) {
    // Which sessions currently have a live terminal.
    let live: HashMap<&str, u32> = terminals
        .values()
        .filter(|t| t.alive)
        .filter_map(|t| t.session_id.as_deref().map(|s| (s, t.id)))
        .collect();

    let projects: Vec<ProjectInfo> = registry
        .iter()
        .map(|p| ProjectInfo {
            sessions: p
                .sessions
                .iter()
                .map(|s| SessionInfo {
                    live_terminal_id: live.get(s.session_id.as_str()).copied(),
                    ..s.clone()
                })
                .collect(),
            ..p.clone()
        })
        .collect();

    let mut list: Vec<TerminalInfo> = terminals
        .values()
        .map(|t| TerminalInfo {
            id: t.id,
            project: t.project.clone(),
            agent: t.agent.clone(),
            alive: t.alive,
            cols: t.cols,
            rows: t.rows,
            session_id: t.session_id.clone(),
            name: t.name.clone(),
            color: t.color.clone(),
        })
        .collect();
    list.sort_by_key(|t| t.id);

    let saved: Vec<SavedInfo> = cfg
        .saved
        .iter()
        .map(|s| SavedInfo {
            name: s.name.clone(),
            project: s.project.clone(),
            agent: s.agent.clone(),
            command: s.command.clone(),
            color: s.color.clone(),
            live_terminal_id: terminals
                .values()
                .find(|t| {
                    t.alive
                        && t.name.as_deref() == Some(s.name.as_str())
                        && same_path(&t.project, &s.project)
                })
                .map(|t| t.id),
        })
        .collect();

    let msg = json(&ServerMsg::State {
        projects,
        terminals: list,
        agents: agents.to_vec(),
        saved,
        scanning: !scanned,
    });
    match only {
        Some(id) => send_to(clients, id, msg),
        None => {
            for id in clients.keys() {
                send_to(clients, *id, msg.clone());
            }
        }
    }
}

fn json(msg: &ServerMsg) -> Out {
    Out::Text(serde_json::to_string(msg).expect("ServerMsg always serialises"))
}

/// Send to one client. A full queue means that client has fallen behind: drop
/// the oldest chunk and try again. What matters is the last screen, not the
/// full history — and the PTY reader must never stall.
fn send_to(clients: &HashMap<ClientId, Client>, id: ClientId, out: Out) {
    let Some(c) = clients.get(&id) else { return };
    match c.tx.try_send(out) {
        Ok(()) => {}
        Err(TrySendError::Full(out)) => {
            let _ = c.rx.try_recv();
            let _ = c.tx.try_send(out);
        }
        Err(TrySendError::Disconnected(_)) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossbeam_channel::bounded;

    fn client_pair() -> (HashMap<ClientId, Client>, Receiver<Out>) {
        let (tx, rx) = bounded(CLIENT_QUEUE);
        let mut m = HashMap::new();
        m.insert(1u64, Client { tx, rx: rx.clone() });
        (m, rx)
    }

    fn viewers(entries: &[(ClientId, u16, u16)]) -> HashMap<ClientId, (u16, u16)> {
        entries.iter().map(|&(id, c, r)| (id, (c, r))).collect()
    }

    fn terminal_with(entries: &[(ClientId, u16, u16)], cols: u16, rows: u16) -> Terminal {
        Terminal {
            id: 1,
            project: "p".into(),
            agent: "a".into(),
            cols,
            rows,
            alive: true,
            session_id: None,
            started_ms: 0,
            viewers: viewers(entries),
            ring: Ring::new(RING_CAP),
            pty: None,
            name: None,
            color: None,
            typed: TypedLine::default(),
            pending_run: None,
        }
    }

    #[test]
    fn full_queue_drops_oldest_not_newest() {
        let (clients, rx) = client_pair();
        for i in 0..CLIENT_QUEUE {
            send_to(&clients, 1, Out::Binary(vec![i as u8]));
        }
        send_to(&clients, 1, Out::Binary(vec![b'X']));

        let mut got = Vec::new();
        while let Ok(Out::Binary(b)) = rx.try_recv() {
            got.push(b[0]);
        }
        assert_eq!(got.len(), CLIENT_QUEUE, "kapasitas tetap terjaga");
        assert_eq!(got[0], 1, "chunk paling lama yang dibuang");
        assert_eq!(*got.last().unwrap(), b'X', "chunk terbaru tetap masuk");
    }

    #[test]
    fn send_to_unknown_client_is_ignored() {
        let (clients, _rx) = client_pair();
        send_to(&clients, 99, Out::Binary(vec![1]));
    }

    #[test]
    fn send_to_disconnected_client_does_not_panic() {
        let (tx, rx) = bounded(4);
        drop(rx);
        let mut clients = HashMap::new();
        let (_tx2, rx2) = bounded(4);
        clients.insert(1u64, Client { tx, rx: rx2 });
        send_to(&clients, 1, Out::Binary(vec![1]));
    }

    #[test]
    fn effective_size_is_none_without_viewers() {
        assert_eq!(effective_size(&viewers(&[])), None);
    }

    #[test]
    fn effective_size_follows_single_viewer() {
        assert_eq!(effective_size(&viewers(&[(1, 120, 32)])), Some((120, 32)));
    }

    #[test]
    fn effective_size_takes_minimum_of_each_axis_independently() {
        // Client A is wider but shorter, B the other way round: the result is the
        // combined minimum, not either client.
        let v = viewers(&[(1, 120, 24), (2, 80, 40)]);
        assert_eq!(effective_size(&v), Some((80, 24)));
    }

    #[test]
    fn effective_size_across_three_viewers() {
        let v = viewers(&[(1, 100, 30), (2, 90, 50), (3, 110, 20)]);
        assert_eq!(effective_size(&v), Some((90, 20)));
    }

    #[test]
    fn renegotiate_reports_no_change_when_size_matches() {
        let mut t = terminal_with(&[(1, 80, 24)], 80, 24);
        assert!(!renegotiate(&mut t));
        assert_eq!((t.cols, t.rows), (80, 24));
    }

    #[test]
    fn renegotiate_keeps_last_size_when_everyone_detaches() {
        let mut t = terminal_with(&[], 100, 30);
        assert!(!renegotiate(&mut t), "tanpa viewer tidak ada yang dinegosiasikan");
        assert_eq!((t.cols, t.rows), (100, 30), "terminal tidak mengecil jadi nol");
    }

    #[test]
    fn sane_size_clamps_zero_to_one() {
        assert_eq!(sane_size(0, 0), (1, 1));
        assert_eq!(sane_size(80, 0), (80, 1));
        assert_eq!(sane_size(120, 32), (120, 32));
    }

    #[test]
    fn ring_replays_what_was_broadcast() {
        let mut t = terminal_with(&[(1, 80, 24)], 80, 24);
        t.ring.push(b"baris satu\r\n");
        t.ring.push(b"baris dua\r\n");
        let frame = encode_frame(t.id, &t.ring.snapshot());
        let (id, data) = crate::proto::decode_frame(&frame).unwrap();
        assert_eq!(id, 1);
        assert_eq!(data, b"baris satu\r\nbaris dua\r\n");
    }

    #[test]
    fn new_agent_names_are_filtered() {
        for bad in ["", "My Agent", "agent!", "9lives", "-x", "UPPER", &"a".repeat(25)] {
            assert!(check_agent_name(bad, true).is_err(), "{bad:?} seharusnya ditolak");
        }
        for good in ["claude", "my-harness", "aider_v2", "gpt5"] {
            assert!(check_agent_name(good, true).is_ok(), "{good:?} seharusnya diterima");
        }
    }

    #[test]
    fn existing_agents_keep_their_old_names() {
        // A config that already holds an odd name stays editable; a new rule must
        // not lock down settings that already exist.
        assert!(check_agent_name("My Agent", false).is_ok());
        assert!(check_agent_name("", false).is_err(), "nama kosong tetap tidak masuk akal");
    }
}
