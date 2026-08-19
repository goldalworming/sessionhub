//! The session registry: merging stored sessions from three agents.
//!
//! The rule that must never be broken: **never reconstruct a cwd from an
//! encoded directory name.** The encoding differs per agent and has changed
//! before. For JSONL, `cwd` is read from the file's contents; for opencode, its
//! CLI is asked.
//!
//! Scanning runs on its own thread, never on the state actor: it reads hundreds
//! of files and calls external CLIs.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crossbeam_channel::{bounded, Sender};
use tracing::{debug, info, warn};

use crate::config::{self, Config};
use crate::proto::{ProjectInfo, SessionInfo};
use crate::state::Cmd;

/// Upper bound when reading a file head. A session file can be tens of MB —
/// reading it whole for two fields is plainly wrong.
const HEAD_BYTES: usize = 64 * 1024;

/// The first attempt. Nearly every file already carries `cwd` and the first
/// prompt in its opening lines; reading 64 KB from 800 files for that means
/// 50 MB of wasted I/O.
const HEAD_FIRST_TRY: usize = 8 * 1024;

/// The opencode CLI takes ~1.5 s per call, and that dominates the cost of a
/// rescan. Its result is reused for this window.
const OPENCODE_TTL: Duration = Duration::from_secs(5);

/// Debounce after a file event. An agent writes to its JSONL on every message;
/// without this, one active conversation triggers rescans many times a second.
const DEBOUNCE: Duration = Duration::from_millis(600);

/// A safety net for events that never arrive (a watcher can miss changes on
/// some filesystems).
const SWEEP: Duration = Duration::from_secs(60);

const TITLE_MAX: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub agent: String,
    pub session_id: String,
    pub cwd: String,
    pub title: String,
    pub updated_ms: u64,
}

// ------------------------------------------------------------------- thread

/// Run the registry thread and its file watcher. The returned sender is what the
/// state actor uses to push the latest config after settings change.
pub fn spawn(cfg: Config, tx: Sender<Cmd>) -> Sender<Config> {
    let (trig_tx, trig_rx) = bounded::<()>(64);
    let (cfg_tx, cfg_rx) = bounded::<Config>(4);

    start_watcher(trig_tx.clone());

    std::thread::spawn(move || {
        let mut cfg = cfg;
        let mut cache = Cache::default();
        let mut last: Option<Vec<ProjectInfo>> = None;
        loop {
            // Settings can change while the daemon is alive; a disabled agent
            // stops being scanned from the next round.
            let mut changed = false;
            while let Ok(fresh) = cfg_rx.try_recv() {
                // Only the opencode cache is dropped, and only when that agent
                // itself changed: filling it again means calling an external CLI,
                // which costs seconds. Adding a project must not carry that cost.
                // The file cache is safe to keep because its key is mtime + size.
                if opencode_changed(&cfg, &fresh) {
                    cache.opencode = None;
                }
                cfg = fresh;
                changed = true;
            }
            if changed {
                last = None;
            }

            let started = Instant::now();
            let projects = scan_all(&cfg, &mut cache);
            let ms = started.elapsed().as_millis() as u64;

            // Send only when the contents changed; a periodic scan that finds
            // nothing need not wake the actor or fill the log.
            if last.as_ref() != Some(&projects) {
                let sessions: usize = projects.iter().map(|p| p.sessions.len()).sum();
                info!(projects = projects.len(), sessions, ms, "registry changed");
                last = Some(projects.clone());
                if tx.send(Cmd::Registry(projects)).is_err() {
                    return;
                }
            } else {
                debug!(ms, "registry scanned, unchanged");
            }

            // Wait for the next trigger. A config change wakes us too: adding a
            // project has to show up now, not when the next periodic sweep
            // happens to arrive.
            let mut from_cfg = false;
            crossbeam_channel::select! {
                recv(trig_rx) -> m => if m.is_err() { return },
                recv(cfg_rx) -> m => match m {
                    Ok(fresh) => {
                        if opencode_changed(&cfg, &fresh) {
                            cache.opencode = None;
                        }
                        cfg = fresh;
                        last = None;
                        from_cfg = true;
                    }
                    Err(_) => return,
                },
                default(SWEEP) => {}
            }
            // Debounce file changes only: filesystem events arrive in crowds,
            // while settings arrive once, from a user waiting for the answer.
            if !from_cfg {
                std::thread::sleep(DEBOUNCE);
            }
            while trig_rx.try_recv().is_ok() {}
        }
    });

    cfg_tx
}

fn start_watcher(trig: Sender<()>) {
    use notify::{RecursiveMode, Watcher};

    let home = config::home();
    let roots = [home.join(".claude").join("projects"), home.join(".pi").join("agent")];

    std::thread::spawn(move || {
        let mut watchers = Vec::new();
        for root in roots {
            if !root.is_dir() {
                continue;
            }
            let trig = trig.clone();
            let handler = move |res: notify::Result<notify::Event>| {
                if res.is_ok() {
                    // Bounded channel: if a trigger is already waiting, this event
                    // adds nothing. Dropped, not queued.
                    let _ = trig.try_send(());
                }
            };
            match notify::recommended_watcher(handler) {
                Ok(mut w) => match w.watch(&root, RecursiveMode::Recursive) {
                    Ok(()) => {
                        info!(path = %root.display(), "watching session directory");
                        watchers.push(w);
                    }
                    Err(e) => warn!(path = %root.display(), error = %e, "could not watch"),
                },
                Err(e) => warn!(error = %e, "could not create watcher"),
            }
        }
        if watchers.is_empty() {
            return;
        }
        // A watcher stops working the moment it is dropped, so this thread holds it.
        loop {
            std::thread::park();
        }
    });
}

// ------------------------------------------------------------------ scanner

#[derive(Default)]
pub struct Cache {
    /// path -> (mtime_ms, size, parse result)
    files: HashMap<PathBuf, (u64, u64, Option<SessionRow>)>,
    opencode: Option<(Instant, Vec<SessionRow>)>,
}

/// Whether the part of the config that decides `opencode session list` changed.
fn opencode_changed(old: &Config, new: &Config) -> bool {
    let pick = |c: &Config| {
        c.agents.get("opencode").map(|a| (a.command.clone(), a.enabled))
    };
    pick(old) != pick(new)
}

fn scan_all(cfg: &Config, cache: &mut Cache) -> Vec<ProjectInfo> {
    // Disabled agents are not scanned: their sessions cannot be opened, so
    // showing them only fills the sidebar.
    let on = |name: &str| cfg.agents.get(name).map(|a| a.enabled).unwrap_or(false);

    let home = config::home();
    let mut rows = Vec::new();
    if on("claude") {
        rows.extend(scan_jsonl_tree(&home.join(".claude").join("projects"), "claude", cache));
    }
    if on("pi") {
        rows.extend(scan_pi(&home, cache));
    }
    if let Some(agent) = cfg.agents.get("opencode").filter(|a| a.enabled) {
        rows.extend(opencode_cached(&agent.command, cache));
    }
    build_projects(&cfg.projects, rows)
}

fn opencode_cached(command: &str, cache: &mut Cache) -> Vec<SessionRow> {
    if let Some((at, rows)) = &cache.opencode {
        if at.elapsed() < OPENCODE_TTL {
            return rows.clone();
        }
    }
    let rows = scan_opencode(command);
    cache.opencode = Some((Instant::now(), rows.clone()));
    rows
}

/// Every `*.jsonl` under `root`, deduped by session id.
fn scan_jsonl_tree(root: &Path, agent: &str, cache: &mut Cache) -> Vec<SessionRow> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for path in walk_jsonl(root, 0) {
        if let Some(row) = parse_file(&path, agent, cache) {
            if seen.insert(row.session_id.clone()) {
                out.push(row);
            }
        }
    }
    out
}

/// pi has a history of writing and reading sessions from different directories,
/// so all of `~/.pi/agent` is swept, not just `sessions/`. Deduping by session
/// id handles a file showing up in two places.
fn scan_pi(home: &Path, cache: &mut Cache) -> Vec<SessionRow> {
    scan_jsonl_tree(&home.join(".pi").join("agent"), "pi", cache)
}

fn walk_jsonl(dir: &Path, depth: usize) -> Vec<PathBuf> {
    const MAX_DEPTH: usize = 6;
    let mut out = Vec::new();
    if depth > MAX_DEPTH {
        return out;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => out.extend(walk_jsonl(&path, depth + 1)),
            Ok(t) if t.is_file() => {
                if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    out.push(path);
                }
            }
            _ => {}
        }
    }
    out
}

fn parse_file(path: &Path, agent: &str, cache: &mut Cache) -> Option<SessionRow> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok().and_then(to_epoch_ms).unwrap_or(0);
    let len = meta.len();

    // Unchanged files are not re-read. Without this, every watcher event would
    // mean re-reading hundreds of files.
    if let Some((cached_mtime, cached_len, row)) = cache.files.get(path) {
        if *cached_mtime == mtime && *cached_len == len {
            return row.clone();
        }
    }

    // Try a little first; read more only when it really was not there.
    let mut meta = read_head(path, HEAD_FIRST_TRY).map(|t| parse_jsonl_head(&t));
    if !meta.as_ref().is_some_and(|m| m.cwd.is_some() && m.title.is_some()) && len > HEAD_FIRST_TRY as u64
    {
        meta = read_head(path, HEAD_BYTES).map(|t| parse_jsonl_head(&t));
    }

    let parsed = meta.and_then(|meta| {
        let cwd = meta.cwd?;
        let session_id = path.file_stem()?.to_string_lossy().into_owned();

        // Claude Code writes subagent transcripts as `agent-*.jsonl` in the same
        // directory, and the `sessionId` inside them points at the parent
        // session. Such a file is not a resumable session — its name is not a
        // valid session id — and there can be many times more of them than real
        // sessions, so the sidebar would drown if they were included.
        if meta.session_id.as_deref().is_some_and(|s| s != session_id) {
            return None;
        }

        Some(SessionRow {
            agent: agent.to_string(),
            title: title_or_fallback(meta.title.as_deref(), agent, mtime),
            session_id,
            cwd,
            updated_ms: mtime,
        })
    });

    cache.files.insert(path.to_path_buf(), (mtime, len, parsed.clone()));
    parsed
}

fn read_head(path: &Path, max: usize) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; max];
    let mut filled = 0;
    while filled < max {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => break,
        }
    }
    buf.truncate(filled);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// opencode keeps its sessions in a database, and its CLI already hands over a
/// finished `directory` and `title` — no reason to take the DB apart ourselves.
fn scan_opencode(command: &str) -> Vec<SessionRow> {
    let Some(exe) = crate::pty::resolve_command(command) else {
        debug!(%command, "opencode not on PATH; skipped");
        return Vec::new();
    };
    // Without the "no window" flag, a rescan flashes a console window on the
    // user's screen every time a session changes.
    let out = match crate::pty::quiet_command(&exe)
        .args(["session", "list", "--format", "json"])
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        Ok(o) => {
            warn!(status = ?o.status, "opencode session list failed");
            return Vec::new();
        }
        Err(e) => {
            warn!(error = %e, "could not run opencode");
            return Vec::new();
        }
    };

    let text = String::from_utf8_lossy(&out);
    if text.trim().is_empty() {
        // Having no sessions at all is a valid state, not a failure.
        return Vec::new();
    }
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&text) else {
        warn!(bytes = text.len(), "opencode session list output is not a JSON array");
        return Vec::new();
    };
    items.iter().filter_map(parse_opencode_item).collect()
}

fn parse_opencode_item(v: &serde_json::Value) -> Option<SessionRow> {
    let id = v.get("id")?.as_str()?.to_string();
    let cwd = v.get("directory")?.as_str()?.to_string();
    let updated_ms = v.get("updated").and_then(|u| u.as_u64()).unwrap_or(0);
    let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("");
    Some(SessionRow {
        agent: "opencode".into(),
        title: title_or_fallback(Some(title), "opencode", updated_ms),
        session_id: id,
        cwd,
        updated_ms,
    })
}

// -------------------------------------------------------------- JSONL parsing

#[derive(Debug, Default, PartialEq, Eq)]
pub struct JsonlMeta {
    pub cwd: Option<String>,
    pub title: Option<String>,
    /// The `sessionId` recorded inside the file. For a real session this equals
    /// its file name; when they differ, the file is not a session of its own.
    pub session_id: Option<String>,
}

/// Prompts injected by tooling rather than typed by the user. Used as a title
/// they produce junk like "<local-command-caveat>Caveat: The messages…".
const SYNTHETIC: &[&str] = &[
    "<local-command-",
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<system-reminder>",
    "<user-prompt-submit-hook>",
    "Caveat: The messages below",
];

/// Read the head of a JSONL file: take `cwd` and the first genuine user prompt.
///
/// `cwd` is deliberately searched across the whole head, not just the first
/// line — in current Claude Code the first line holds session meta and `cwd`
/// only appears on the fourth.
pub fn parse_jsonl_head(text: &str) -> JsonlMeta {
    let mut meta = JsonlMeta::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue; // the last line can be cut short because the head is capped
        };

        if meta.cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                if !c.is_empty() {
                    meta.cwd = Some(c.to_string());
                }
            }
        }
        if meta.session_id.is_none() {
            if let Some(s) = v.get("sessionId").and_then(|s| s.as_str()) {
                if !s.is_empty() {
                    meta.session_id = Some(s.to_string());
                }
            }
        }
        if meta.title.is_none() && is_user_line(&v) {
            if let Some(text) = user_text(&v) {
                let clean = collapse_ws(&text);
                if !clean.is_empty() && !SYNTHETIC.iter().any(|p| clean.starts_with(p)) {
                    meta.title = Some(clean);
                }
            }
        }
        if meta.cwd.is_some() && meta.title.is_some() {
            break;
        }
    }
    meta
}

fn is_user_line(v: &serde_json::Value) -> bool {
    if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false) {
        return false; // a subagent transcript, not a user prompt
    }
    if v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false) {
        return false;
    }
    v.get("type").and_then(|t| t.as_str()) == Some("user")
        || v.get("role").and_then(|t| t.as_str()) == Some("user")
        || v.get("message").and_then(|m| m.get("role")).and_then(|r| r.as_str()) == Some("user")
}

/// A message body can be a string, or an array of `{type:"text",text:…}` blocks.
fn user_text(v: &serde_json::Value) -> Option<String> {
    let content = v
        .get("message")
        .and_then(|m| m.get("content"))
        .or_else(|| v.get("content"))
        .or_else(|| v.get("text"))?;

    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = content.as_array() {
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(s) = block.get("text").and_then(|t| t.as_str()) {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn title_or_fallback(title: Option<&str>, agent: &str, updated_ms: u64) -> String {
    match title.map(collapse_ws) {
        Some(t) if !t.is_empty() => truncate_title(&t),
        _ => format!("{agent} · {}", &iso8601(updated_ms)[..10]),
    }
}

pub fn truncate_title(s: &str) -> String {
    if s.chars().count() <= TITLE_MAX {
        return s.to_string();
    }
    let cut: String = s.chars().take(TITLE_MAX).collect();
    format!("{}…", cut.trim_end())
}

// ------------------------------------------------------------------- project

/// The comparison key for a path. Two things differ per system, and both have
/// to follow that system — not the one this code was written on.
///
/// **Separators.** Windows treats `\` and `/` as the same thing, so both are
/// normalised. On unix `\` is an ordinary, legal character in a file name;
/// turning it into a separator would equate two genuinely different files.
///
/// **Case.** Windows is case-insensitive, and so is macOS on its default APFS
/// and HFS+. Linux is not. Folding case on Linux would merge two projects that
/// really are different; not folding it on macOS makes one and the same folder
/// appear twice as soon as the capitals differ.
///
/// macOS can be formatted case-sensitive, but that is not the default. Guessing
/// from the default beats asking the disk every time two paths are compared.
pub fn path_key(p: &str) -> String {
    let windows = cfg!(windows);
    let sep = if windows { '\\' } else { '/' };
    let mut s = if windows { p.replace('/', "\\") } else { p.to_string() };

    // The root must never be trimmed away: `C:\` on Windows, `/` on unix.
    let root_len = if windows { 3 } else { 1 };
    while s.len() > root_len && s.ends_with(sep) {
        s.pop();
    }

    if windows || cfg!(target_os = "macos") {
        s = s.to_lowercase();
    }
    s
}

pub fn project_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    let name = trimmed
        .rsplit(['\\', '/'])
        .find(|s| !s.is_empty())
        .unwrap_or(trimmed);
    if name.is_empty() { path.to_string() } else { name.to_string() }
}

/// The project list = the manual list in the config merged with every unique cwd
/// from the session files. A project whose directory is gone is marked, not
/// removed.
pub fn build_projects(config_projects: &[String], sessions: Vec<SessionRow>) -> Vec<ProjectInfo> {
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, (String, Vec<SessionRow>)> = HashMap::new();

    // The config's spelling wins, because that is what the user wrote themselves.
    for p in config_projects {
        let key = path_key(p);
        by_key.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            (p.clone(), Vec::new())
        });
    }
    for row in sessions {
        let key = path_key(&row.cwd);
        let entry = by_key.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            (row.cwd.clone(), Vec::new())
        });
        entry.1.push(row);
    }

    // (last touched, project) — used for the ordering below.
    let mut projects: Vec<(u64, ProjectInfo)> = order
        .into_iter()
        .filter_map(|key| by_key.remove(&key))
        .map(|(path, mut rows)| {
            rows.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then(a.title.cmp(&b.title)));
            let newest = rows.first().map(|r| r.updated_ms).unwrap_or(0);
            (newest, ProjectInfo {
                name: project_name(&path),
                exists: Path::new(&path).is_dir(),
                sessions: rows
                    .into_iter()
                    .map(|r| SessionInfo {
                        agent: r.agent,
                        session_id: r.session_id,
                        title: r.title,
                        updated_at: iso8601(r.updated_ms),
                        live_terminal_id: None,
                    })
                    .collect(),
                path,
            })
        })
        .collect();

    // Most recently touched on top. A project with no sessions at all — usually
    // one written by hand in the config — has no touch time, so it goes to the
    // bottom and is sorted by name.
    projects.sort_by(|(ta, a), (tb, b)| {
        tb.cmp(ta).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    projects.into_iter().map(|(_, p)| p).collect()
}

// ---------------------------------------------------------------------- time

fn to_epoch_ms(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

/// ISO 8601 UTC without dragging in a date crate for one function.
pub fn iso8601(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's civil_from_days algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ------------------------------------------------------------------ adoption

/// A terminal spawned without `resume` starts a new session whose id the daemon
/// does not know yet. As soon as that session shows up in the registry, it is
/// recognised as belonging to that terminal: the youngest session on the same
/// project+agent, touched after the terminal was born, and not yet claimed by
/// another terminal.
pub fn pick_adoption(
    projects: &[ProjectInfo],
    project: &str,
    agent: &str,
    started_ms: u64,
    claimed: &HashSet<String>,
) -> Option<String> {
    let key = path_key(project);
    let p = projects.iter().find(|p| path_key(&p.path) == key)?;
    p.sessions
        .iter()
        .filter(|s| s.agent == agent && !claimed.contains(&s.session_id))
        .find(|s| epoch_of(&s.updated_at) >= started_ms)
        .map(|s| s.session_id.clone())
}

/// Sessions are already sorted descending, so comparing timestamps is enough.
fn epoch_of(iso: &str) -> u64 {
    // Comparing in ISO string space only happens when parsing fails; here a
    // simple read back to milliseconds is enough.
    fn num(s: &str) -> i64 {
        s.parse().unwrap_or(0)
    }
    if iso.len() < 20 {
        return 0;
    }
    let (y, mo, d) = (num(&iso[0..4]), num(&iso[5..7]) as u32, num(&iso[8..10]) as u32);
    let (h, mi, s) = (num(&iso[11..13]), num(&iso[14..16]), num(&iso[17..19]));
    let days = days_from_civil(y, mo, d);
    ((days * 86_400 + h * 3600 + mi * 60 + s) * 1000).max(0) as u64
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(agent: &str, id: &str, cwd: &str, title: &str, ms: u64) -> SessionRow {
        SessionRow {
            agent: agent.into(),
            session_id: id.into(),
            cwd: cwd.into(),
            title: title.into(),
            updated_ms: ms,
        }
    }

    // ---------------------------------------------------------- time

    #[test]
    fn iso8601_matches_known_instants() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(86_400_000), "1970-01-02T00:00:00Z");
        assert_eq!(iso8601(1_000_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(iso8601(1_704_067_200_000), "2024-01-01T00:00:00Z");
        // Real data from `opencode session list` (UTC; WIB = +7).
        assert_eq!(iso8601(1_786_020_411_196), "2026-08-06T12:46:51Z");
    }

    #[test]
    fn iso8601_handles_leap_day() {
        assert_eq!(iso8601(1_709_164_800_000), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn epoch_roundtrips_through_iso() {
        for ms in [0u64, 1_704_067_200_000, 1_786_020_411_000] {
            assert_eq!(epoch_of(&iso8601(ms)), ms / 1000 * 1000);
        }
    }

    // ---------------------------------------------------------- JSONL

    #[test]
    fn finds_cwd_beyond_the_first_line() {
        // The real shape of Claude Code: meta on the first line, cwd on the 4th.
        let text = r#"{"type":"session","mode":"x","sessionId":"a"}
{"type":"snapshot","messageId":"m"}
{"type":"progress"}
{"type":"user","cwd":"C:\\data\\code","message":{"role":"user","content":"halo dunia"}}"#;
        let meta = parse_jsonl_head(text);
        assert_eq!(meta.cwd.as_deref(), Some("C:\\data\\code"));
        assert_eq!(meta.title.as_deref(), Some("halo dunia"));
    }

    #[test]
    fn skips_synthetic_prompts_when_picking_title() {
        let text = r#"{"type":"user","cwd":"/p","message":{"role":"user","content":"<local-command-caveat>Caveat: bla"}}
{"type":"user","message":{"role":"user","content":"<command-name>/init</command-name>"}}
{"type":"user","message":{"role":"user","content":"ini prompt asli"}}"#;
        assert_eq!(parse_jsonl_head(text).title.as_deref(), Some("ini prompt asli"));
    }

    #[test]
    fn skips_sidechain_and_meta_lines() {
        let text = r#"{"type":"user","cwd":"/p","isSidechain":true,"message":{"role":"user","content":"tugas subagent"}}
{"type":"user","isMeta":true,"message":{"role":"user","content":"catatan sistem"}}
{"type":"user","message":{"role":"user","content":"prompt manusia"}}"#;
        assert_eq!(parse_jsonl_head(text).title.as_deref(), Some("prompt manusia"));
    }

    #[test]
    fn reads_array_content_blocks() {
        let text = r#"{"type":"user","cwd":"/p","message":{"role":"user","content":[{"type":"text","text":"dari blok"}]}}"#;
        assert_eq!(parse_jsonl_head(text).title.as_deref(), Some("dari blok"));
    }

    #[test]
    fn tolerates_truncated_last_line() {
        let text = "{\"type\":\"user\",\"cwd\":\"/p\",\"message\":{\"role\":\"user\",\"content\":\"utuh\"}}\n{\"type\":\"user\",\"messa";
        let meta = parse_jsonl_head(text);
        assert_eq!(meta.cwd.as_deref(), Some("/p"));
        assert_eq!(meta.title.as_deref(), Some("utuh"));
    }

    #[test]
    fn collapses_newlines_in_title() {
        let text = r#"{"type":"user","cwd":"/p","message":{"role":"user","content":"baris satu\n  baris dua"}}"#;
        assert_eq!(parse_jsonl_head(text).title.as_deref(), Some("baris satu baris dua"));
    }

    #[test]
    fn reads_session_id_recorded_inside_the_file() {
        let text = r#"{"type":"user","cwd":"/p","sessionId":"49053a0d","isSidechain":true,"message":{"role":"user","content":"x"}}"#;
        assert_eq!(parse_jsonl_head(text).session_id.as_deref(), Some("49053a0d"));
    }

    #[test]
    fn subagent_transcript_records_the_parent_session_id() {
        // The real shape of `agent-*.jsonl`: its name is not a session id, and the
        // `sessionId` inside points at the parent session.
        let meta = parse_jsonl_head(
            r#"{"type":"user","isSidechain":true,"agentId":"a1","cwd":"/p","sessionId":"induk-uuid","message":{"role":"user","content":"tugas"}}"#,
        );
        assert_eq!(meta.session_id.as_deref(), Some("induk-uuid"));
        assert_ne!(meta.session_id.as_deref(), Some("agent-a2fb33e91b8408526"));
    }

    #[test]
    fn session_without_cwd_is_unusable() {
        let text = r#"{"type":"user","message":{"role":"user","content":"tanpa cwd"}}"#;
        assert_eq!(parse_jsonl_head(text).cwd, None);
    }

    // ---------------------------------------------------------- titles

    #[test]
    fn truncates_long_titles_at_sixty_chars() {
        let long = "a".repeat(80);
        let t = truncate_title(&long);
        assert_eq!(t.chars().count(), TITLE_MAX + 1, "60 karakter plus elipsis");
        assert!(t.ends_with('…'));
    }

    #[test]
    fn short_titles_are_left_alone() {
        assert_eq!(truncate_title("pendek"), "pendek");
        assert_eq!(truncate_title(&"b".repeat(60)), "b".repeat(60));
    }

    #[test]
    fn truncation_respects_multibyte_characters() {
        let s = "héllo wörld ".repeat(10);
        let t = truncate_title(&s);
        assert!(t.chars().count() <= TITLE_MAX + 1);
    }

    #[test]
    fn empty_title_falls_back_to_agent_and_date() {
        assert_eq!(title_or_fallback(None, "claude", 1_704_067_200_000), "claude · 2024-01-01");
        assert_eq!(title_or_fallback(Some("   "), "pi", 0), "pi · 1970-01-01");
    }

    // ---------------------------------------------------------- project

    /// A test path in the shape that suits the system running it. Writing
    /// `C:\...` everywhere makes the test exercise Windows rather than the rule.
    fn pk(segments: &[&str]) -> String {
        if cfg!(windows) {
            format!("C:\\{}", segments.join("\\"))
        } else {
            format!("/{}", segments.join("/"))
        }
    }

    #[test]
    fn path_key_ignores_trailing_separator() {
        let sep = if cfg!(windows) { "\\" } else { "/" };
        let base = pk(&["data", "code"]);
        assert_eq!(path_key(&format!("{base}{sep}")), path_key(&base));
    }

    #[test]
    fn path_key_follows_the_case_rule_of_this_system() {
        let lower = pk(&["data", "code", "notex"]);
        let upper = pk(&["Data", "Code", "Notex"]);
        // Windows and macOS: one project. Linux: two genuinely different ones,
        // and merging them would hide one of the two.
        if cfg!(windows) || cfg!(target_os = "macos") {
            assert_eq!(path_key(&lower), path_key(&upper));
        } else {
            assert_ne!(path_key(&lower), path_key(&upper));
        }
    }

    #[test]
    #[cfg(windows)]
    fn path_key_treats_both_separators_alike_on_windows() {
        assert_eq!(path_key("C:\\Data\\Code"), path_key("c:/data/code"));
    }

    #[test]
    #[cfg(not(windows))]
    fn backslash_is_an_ordinary_letter_off_windows() {
        // On unix `a\b` is ONE file named `a\b`, not `a` then `b`. Equating it
        // with `a/b` would treat two different files as one project.
        assert_ne!(path_key("/data/a\\b"), path_key("/data/a/b"));
    }

    #[test]
    fn project_name_is_the_last_segment() {
        assert_eq!(project_name("C:\\data\\code\\notex"), "notex");
        assert_eq!(project_name("C:\\data\\code\\notex\\"), "notex");
        assert_eq!(project_name("/home/user/brosql"), "brosql");
    }

    #[test]
    fn merges_config_projects_with_discovered_ones() {
        let notex_path = pk(&["data", "code", "notex"]);
        // This session was found with different capitalisation. On a
        // case-insensitive system it is the same project; on Linux it is not, so
        // the spelling follows the rules of the system running the test.
        let discovered = if cfg!(windows) || cfg!(target_os = "macos") {
            pk(&["DATA", "CODE", "NOTEX"])
        } else {
            notex_path.clone()
        };
        let projects = build_projects(
            &[notex_path.clone(), pk(&["tidak", "ada"])],
            vec![
                row("claude", "a", &discovered, "judul a", 200),
                row("opencode", "b", &pk(&["data", "code", "brosql"]), "judul b", 100),
            ],
        );
        let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["notex", "brosql", "ada"],
            "yang terbaru di atas; yang tanpa sesi paling bawah"
        );

        let notex = projects.iter().find(|p| p.name == "notex").unwrap();
        assert_eq!(notex.path, notex_path, "ejaan dari config yang dipakai");
        assert_eq!(notex.sessions.len(), 1, "cwd beda huruf besar tetap satu project");
    }

    #[test]
    fn missing_directories_are_flagged_not_dropped() {
        let projects = build_projects(&["C:\\benar\\benar\\tidak\\ada".into()], vec![]);
        assert_eq!(projects.len(), 1, "project hilang tidak dihapus");
        assert!(!projects[0].exists, "tapi ditandai tidak ada");
    }

    #[test]
    fn projects_are_ordered_by_their_newest_session() {
        let projects = build_projects(
            &[],
            vec![
                row("claude", "a", "/lama", "a", 100),
                row("claude", "b", "/baru", "b", 900),
                row("claude", "c", "/tengah", "c", 500),
                // An old session in a project that also has the newest one: what
                // decides is the newest, not the average or the oldest.
                row("claude", "d", "/baru", "d", 50),
            ],
        );
        let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["baru", "tengah", "lama"]);
    }

    #[test]
    fn projects_without_sessions_sink_to_the_bottom_by_name() {
        let projects = build_projects(
            &["/zebra".into(), "/alpha".into(), "/punya-sesi".into()],
            vec![row("claude", "a", "/punya-sesi", "a", 10)],
        );
        let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["punya-sesi", "alpha", "zebra"]);
    }

    #[test]
    fn sessions_are_newest_first() {
        let projects = build_projects(
            &[],
            vec![
                row("claude", "lama", "/p", "lama", 100),
                row("claude", "baru", "/p", "baru", 300),
                row("pi", "tengah", "/p", "tengah", 200),
            ],
        );
        let ids: Vec<&str> = projects[0].sessions.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(ids, vec!["baru", "tengah", "lama"]);
    }

    #[test]
    fn three_agents_share_one_project() {
        let projects = build_projects(
            &[],
            vec![
                row("claude", "c1", "/p", "c", 300),
                row("opencode", "o1", "/p", "o", 200),
                row("pi", "p1", "/p", "p", 100),
            ],
        );
        assert_eq!(projects.len(), 1);
        let agents: Vec<&str> = projects[0].sessions.iter().map(|s| s.agent.as_str()).collect();
        assert_eq!(agents, vec!["claude", "opencode", "pi"]);
    }

    // ---------------------------------------------------------- opencode

    #[test]
    fn parses_real_opencode_session_shape() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"id":"ses_029","title":"Tombol manual save","updated":1786020411196,
                "created":1786015066799,"projectId":"global","directory":"C:\\data\\code\\notex"}"#,
        )
        .unwrap();
        let r = parse_opencode_item(&v).unwrap();
        assert_eq!(r.session_id, "ses_029");
        assert_eq!(r.cwd, "C:\\data\\code\\notex");
        assert_eq!(r.title, "Tombol manual save");
        assert_eq!(r.agent, "opencode");
    }

    #[test]
    fn opencode_item_without_directory_is_skipped() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"id":"ses_1","title":"x","updated":1}"#).unwrap();
        assert!(parse_opencode_item(&v).is_none(), "tanpa cwd tidak bisa dipakai");
    }

    // ---------------------------------------------------------- adoption

    fn projects_for_adoption() -> Vec<ProjectInfo> {
        build_projects(
            &[],
            vec![
                row("claude", "baru", "/p", "baru", 5_000),
                row("claude", "lama", "/p", "lama", 1_000),
                row("opencode", "lain", "/p", "lain", 6_000),
            ],
        )
    }

    #[test]
    fn adopts_newest_session_created_after_terminal_started() {
        let p = projects_for_adoption();
        let got = pick_adoption(&p, "/p", "claude", 2_000, &HashSet::new());
        assert_eq!(got.as_deref(), Some("baru"));
    }

    #[test]
    fn does_not_adopt_sessions_older_than_the_terminal() {
        let p = projects_for_adoption();
        assert_eq!(pick_adoption(&p, "/p", "claude", 9_000, &HashSet::new()), None);
    }

    #[test]
    fn does_not_steal_a_session_another_terminal_claimed() {
        let p = projects_for_adoption();
        let claimed: HashSet<String> = ["baru".to_string()].into_iter().collect();
        assert_eq!(pick_adoption(&p, "/p", "claude", 500, &claimed).as_deref(), Some("lama"));
    }

    #[test]
    fn does_not_adopt_across_agents_or_projects() {
        let p = projects_for_adoption();
        assert_eq!(pick_adoption(&p, "/p", "pi", 0, &HashSet::new()), None);
        assert_eq!(pick_adoption(&p, "/lain", "claude", 0, &HashSet::new()), None);
    }
}
