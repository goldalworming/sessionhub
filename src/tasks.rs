//! Background work an agent started and has not reported finished.
//!
//! Two signals answer two different questions, and neither one answers both.
//!
//! **Is anything running?** The process tree, sampled in `memory`. A background
//! command is a real child of the agent — under a `claude.exe` running a
//! download sits `bash → bash → node scripts/detour/download.js`, and when it
//! ends those processes are gone. That works for every harness because it is a
//! fact about the operating system, not about the agent.
//!
//! **What is it called?** The transcript, read here. Claude Code records both
//! ends: a `tool_use` opens the job with a human-written `description`, and a
//! `<task-notification>` closes it by `tool-use-id`. The name is what makes the
//! sidebar worth looking at — "Download Detour final film · 12m" says something
//! that "1 background job" does not.
//!
//! Why both: the transcript alone lies. Measured on a real session, four jobs
//! had been opened and never closed while only one was still running — a
//! notification is written when the agent is told, and it is not always told.
//! The process tree is what decides running from finished; the transcript only
//! supplies the words. So a job named here is dropped the moment the tree says
//! the work is over, reported or not.
//!
//! Only Claude Code is read. opencode keeps no transcript this side can open —
//! `log/`, `repos/`, `snapshot/`, and a CLI that takes ~1.5 s per call — so
//! there the tree signal stands alone and the job goes unnamed. That is the
//! honest shape of it, and better than inventing a name.

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

/// A transcript line is one JSON object. A very long one is skipped rather than
/// read into memory — a tool result can carry a whole file.
const MAX_LINE: u64 = 1 << 20;

/// One background job, as the agent described it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    /// The `tool_use` id it was opened under; what a notification closes.
    pub id: String,
    /// What the agent called it. Never empty — the command stands in when there
    /// is no description.
    pub label: String,
    /// `agent` for a subagent, `shell` for a background command.
    pub kind: &'static str,
    /// When it started, in milliseconds since the epoch. 0 when unreadable.
    pub since_ms: u64,
}

/// Quiet samples a job may survive before it counts as finished.
///
/// It exists for one race: the transcript line and the child process appear at
/// the same instant, and a sample can land between them. Retiring the job on
/// that sample would lose it for good — the read offset has already passed the
/// record, so it can never be seen again. Three samples is about six seconds,
/// which no such gap reaches and no waiting person notices.
const QUIET_LIMIT: u8 = 3;

#[derive(Default)]
struct FileState {
    /// How far this file has been read. Only the new bytes are parsed on each
    /// poll: a session transcript reaches tens of megabytes, and re-reading it
    /// every couple of seconds for two fields is plainly wrong.
    offset: u64,
    /// Each open job, with how many consecutive samples have found nothing
    /// running under the terminal it belongs to.
    open: BTreeMap<String, (Job, u8)>,
}

/// Remembers where each transcript was left off and what is open in it.
#[derive(Default)]
pub struct Watcher {
    files: HashMap<PathBuf, FileState>,
    /// Session id to transcript path. Finding the file means listing every
    /// project directory, so it is done once per session.
    found: HashMap<String, Option<PathBuf>>,
}

impl Watcher {
    /// The jobs open in this session's transcript, oldest first.
    ///
    /// `running` is what the process tree says. It is the authority: a job the
    /// transcript never closed — because the notification is written when the
    /// agent is told, and it is not always told — is retired here rather than
    /// left in the sidebar for the rest of the day. The transcript supplies the
    /// words; the tree decides whether they still describe anything.
    ///
    /// The file is read either way, so the offset keeps up with a transcript
    /// that grows while nothing runs under it.
    ///
    /// A session with no transcript — a shell, an agent that keeps none —
    /// simply has none, which is not an error.
    pub fn poll(&mut self, session_id: &str, running: bool) -> Vec<Job> {
        let Some(path) = self.path_of(session_id) else { return Vec::new() };
        let state = self.files.entry(path.clone()).or_default();
        read_since(&path, state);
        sweep(state, running)
    }

    /// Drop everything not in this set. A terminal that ended is not coming
    /// back, and its offsets would otherwise be kept until the daemon stops.
    pub fn retain(&mut self, live: &[String]) {
        self.found.retain(|id, _| live.iter().any(|l| l == id));
        let keep: Vec<PathBuf> = self.found.values().flatten().cloned().collect();
        self.files.retain(|p, _| keep.contains(p));
    }

    fn path_of(&mut self, session_id: &str) -> Option<PathBuf> {
        if let Some(hit) = self.found.get(session_id) {
            return hit.clone();
        }
        let found = find_transcript(session_id);
        self.found.insert(session_id.to_string(), found.clone());
        found
    }
}

/// `~/.claude/projects/<encoded>/<session id>.jsonl`.
///
/// The directory name is never decoded — that rule holds here as everywhere
/// else. It is only walked, and the file is matched on its own name.
fn find_transcript(session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty() || session_id.contains(['/', '\\', ':']) {
        return None;
    }
    let root = crate::config::home().join(".claude").join("projects");
    let wanted = format!("{session_id}.jsonl");
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let candidate = entry.path().join(&wanted);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Age the open jobs against what the process tree just said, and report what
/// is left. Split out from `poll` so the grace period can be tested without a
/// transcript and a home directory to put it in.
fn sweep(state: &mut FileState, running: bool) -> Vec<Job> {
    if running {
        for (_, quiet) in state.open.values_mut() {
            *quiet = 0;
        }
        return state.open.values().map(|(j, _)| j.clone()).collect();
    }
    for (_, quiet) in state.open.values_mut() {
        *quiet = quiet.saturating_add(1);
    }
    state.open.retain(|_, (_, quiet)| *quiet < QUIET_LIMIT);
    Vec::new()
}

/// Parse only what has been appended since last time.
fn read_since(path: &Path, state: &mut FileState) {
    let Ok(file) = File::open(path) else { return };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    // A transcript only grows. Shorter than last time means a different file
    // under the same name, so it is read from the start.
    if len < state.offset {
        state.offset = 0;
        state.open.clear();
    }
    if len == state.offset {
        return;
    }
    let mut reader = BufReader::new(file);
    if reader.seek(SeekFrom::Start(state.offset)).is_err() {
        return;
    }
    let mut line = String::new();
    loop {
        line.clear();
        // `read_line` on a partly written last line would leave the offset in
        // the middle of a record; only whole lines advance it.
        let mut limited = (&mut reader).take(MAX_LINE);
        let read = match limited.read_line(&mut line) {
            Ok(0) => break,
            Ok(n) => n as u64,
            Err(_) => break,
        };
        if !line.ends_with('\n') {
            break;
        }
        state.offset += read;
        if let Ok(v) = serde_json::from_str::<Value>(line.trim_end()) {
            apply(&mut state.open, &v);
        }
    }
}

/// One transcript record, opening or closing jobs.
fn apply(open: &mut BTreeMap<String, (Job, u8)>, v: &Value) {
    let since_ms = v.get("timestamp").and_then(|t| t.as_str()).map(parse_iso).unwrap_or(0);
    let content = v.get("message").and_then(|m| m.get("content"));

    // A closing notification arrives as ordinary text, either a bare string or
    // a block, so both shapes are searched.
    for text in texts(content) {
        for id in notified(&text) {
            open.remove(&id);
        }
    }

    let Some(blocks) = content.and_then(|c| c.as_array()) else { return };
    for b in blocks {
        if b.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
            continue;
        }
        let Some(id) = b.get("id").and_then(|i| i.as_str()) else { continue };
        let name = b.get("name").and_then(|n| n.as_str()).unwrap_or_default();
        let input = b.get("input");
        let backgrounded = input
            .and_then(|i| i.get("run_in_background"))
            .and_then(|r| r.as_bool())
            .unwrap_or(false);

        // A foreground command is not background work: it holds the turn, and
        // the terminal is plainly busy while it runs.
        let kind = match name {
            "Task" => "agent",
            "Bash" if backgrounded => "shell",
            _ => continue,
        };
        let label = input
            .and_then(|i| i.get("description"))
            .and_then(|d| d.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(shorten)
            .or_else(|| {
                input
                    .and_then(|i| i.get("command"))
                    .and_then(|c| c.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(shorten)
            })
            .unwrap_or_else(|| if kind == "agent" { "subagent".into() } else { "background job".into() });

        open.insert(
            id.to_string(),
            (Job { id: id.to_string(), label, kind, since_ms }, 0),
        );
    }
}

/// Every `<tool-use-id>` named by a `<task-notification>` in this text.
fn notified(text: &str) -> Vec<String> {
    if !text.contains("<task-notification>") {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("<tool-use-id>") {
        rest = &rest[start + "<tool-use-id>".len()..];
        let Some(end) = rest.find("</tool-use-id>") else { break };
        let id = rest[..end].trim();
        if !id.is_empty() {
            out.push(id.to_string());
        }
        rest = &rest[end..];
    }
    out
}

/// A message body is a string, or an array of blocks with text in them.
fn texts(content: Option<&Value>) -> Vec<String> {
    match content {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()).map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

/// One line, short enough for a sidebar row.
fn shorten(s: &str) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= 48 {
        return one;
    }
    let cut: String = one.chars().take(47).collect();
    format!("{cut}…")
}

/// `2026-09-09T10:10:11.123Z` to milliseconds. Only the shape agents actually
/// write is handled; anything else is 0, which the panel reads as "no time".
fn parse_iso(s: &str) -> u64 {
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return 0;
    }
    let num = |a: usize, b: usize| s.get(a..b).and_then(|t| t.parse::<i64>().ok());
    let (Some(y), Some(mo), Some(d), Some(h), Some(mi), Some(sec)) = (
        num(0, 4),
        num(5, 7),
        num(8, 10),
        num(11, 13),
        num(14, 16),
        num(17, 19),
    ) else {
        return 0;
    };
    // Days since the epoch, by the civil-from-days algorithm — no calendar
    // crate for six fields.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec;
    if secs <= 0 {
        0
    } else {
        secs as u64 * 1000
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_from(lines: &str) -> BTreeMap<String, (Job, u8)> {
        let mut open = BTreeMap::new();
        for line in lines.lines() {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                apply(&mut open, &v);
            }
        }
        open
    }

    /// The two ends, exactly as a real transcript writes them.
    #[test]
    fn a_background_command_opens_and_its_notification_closes_it() {
        let open = state_from(
            r#"{"timestamp":"2026-09-09T10:10:11.000Z","message":{"content":[{"type":"tool_use","id":"toolu_A","name":"Bash","input":{"run_in_background":true,"description":"Download Detour final film","command":"node dl.js"}}]}}"#,
        );
        assert_eq!(open.len(), 1);
        let job = &open.values().next().unwrap().0;
        assert_eq!(job.label, "Download Detour final film");
        assert_eq!(job.kind, "shell");
        assert!(job.since_ms > 1_700_000_000_000, "waktunya terbaca: {}", job.since_ms);

        let closed = state_from(&format!(
            "{}\n{}",
            r#"{"timestamp":"2026-09-09T10:10:11.000Z","message":{"content":[{"type":"tool_use","id":"toolu_A","name":"Bash","input":{"run_in_background":true,"description":"x"}}]}}"#,
            r#"{"type":"user","message":{"content":"<task-notification> <task-id>bm0</task-id> <tool-use-id>toolu_A</tool-use-id> <status>completed</status> </task-notification>"}}"#,
        ));
        assert!(closed.is_empty(), "notifikasi harus menutupnya");
    }

    /// The immediate reply to a background command is not the end of it. This is
    /// the whole reason `tool_result` is ignored: it arrives at once, carrying
    /// the shell id, while the work runs for another hour.
    #[test]
    fn the_tool_result_does_not_close_a_background_job() {
        let open = state_from(&format!(
            "{}\n{}",
            r#"{"message":{"content":[{"type":"tool_use","id":"toolu_A","name":"Bash","input":{"run_in_background":true,"description":"long one"}}]}}"#,
            r#"{"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_A","content":"started b1234"}]}}"#,
        ));
        assert_eq!(open.len(), 1, "masih jalan");
    }

    /// A foreground command holds the turn; the terminal is visibly busy and
    /// there is nothing background about it.
    #[test]
    fn a_foreground_command_is_not_background_work() {
        let open = state_from(
            r#"{"message":{"content":[{"type":"tool_use","id":"toolu_B","name":"Bash","input":{"command":"ls","description":"list"}}]}}"#,
        );
        assert!(open.is_empty());
    }

    #[test]
    fn a_subagent_is_named_and_marked_as_one() {
        let open = state_from(
            r#"{"message":{"content":[{"type":"tool_use","id":"toolu_C","name":"Task","input":{"description":"Review the diff"}}]}}"#,
        );
        let (job, _) = open.values().next().expect("ada satu");
        assert_eq!(job.kind, "agent");
        assert_eq!(job.label, "Review the diff");
    }

    #[test]
    fn a_job_without_a_description_falls_back_to_its_command() {
        let open = state_from(
            r#"{"message":{"content":[{"type":"tool_use","id":"toolu_D","name":"Bash","input":{"run_in_background":true,"command":"npm   run\n  build"}}]}}"#,
        );
        assert_eq!(open.values().next().unwrap().0.label, "npm run build");
    }

    #[test]
    fn a_long_label_is_cut_to_one_line() {
        let long = "x".repeat(200);
        let open = state_from(&format!(
            r#"{{"message":{{"content":[{{"type":"tool_use","id":"t","name":"Task","input":{{"description":"{long}"}}}}]}}}}"#
        ));
        let label = &open.values().next().unwrap().0.label;
        assert_eq!(label.chars().count(), 48);
        assert!(label.ends_with('…'));
    }

    #[test]
    fn only_whole_lines_advance_the_offset() {
        let dir = std::env::temp_dir().join(format!("sh-tasks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        let whole = "{\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_A\",\"name\":\"Task\",\"input\":{\"description\":\"one\"}}]}}\n";
        std::fs::write(&path, format!("{whole}{{\"message\":{{\"cont")).unwrap();

        let mut state = FileState::default();
        read_since(&path, &mut state);
        assert_eq!(state.open.len(), 1);
        assert_eq!(state.offset, whole.len() as u64, "baris separuh tidak dihitung");

        // The rest of that line arrives, and it is read as one record.
        std::fs::write(
            &path,
            format!("{whole}{{\"message\":{{\"content\":[{{\"type\":\"tool_use\",\"id\":\"toolu_B\",\"name\":\"Task\",\"input\":{{\"description\":\"two\"}}}}]}}}}\n"),
        )
        .unwrap();
        read_since(&path, &mut state);
        assert_eq!(state.open.len(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The grace period, and the race it exists for.
    ///
    /// A job is written to the transcript at the same instant its process is
    /// spawned. A sample landing between the two sees the job with nothing
    /// running — and dropping it there would lose it for good, because the read
    /// offset has already passed the record.
    #[test]
    fn a_job_survives_a_quiet_sample_but_not_a_quiet_stretch() {
        let mut state = FileState {
            open: state_from(
                r#"{"message":{"content":[{"type":"tool_use","id":"t","name":"Task","input":{"description":"work"}}]}}"#,
            ),
            ..Default::default()
        };

        // The sample that lands in the gap: still quiet, job kept.
        assert!(sweep(&mut state, false).is_empty(), "quiet samples report nothing");
        assert_eq!(state.open.len(), 1, "but the job is not thrown away");

        // The process appears. The job is reported and its patience resets.
        let seen = sweep(&mut state, true);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].label, "work");
        assert_eq!(state.open.values().next().unwrap().1, 0);

        // It ends, and no notification ever comes. After the grace it is gone,
        // rather than sitting in the sidebar for the rest of the day.
        for _ in 0..QUIET_LIMIT {
            assert!(sweep(&mut state, false).is_empty());
        }
        assert!(state.open.is_empty(), "an unreported job is retired");
    }

    #[test]
    fn a_timestamp_becomes_the_right_instant() {
        // 2026-09-09T10:10:11Z. Checked against a known epoch rather than
        // against this function's own arithmetic.
        assert_eq!(parse_iso("2026-09-09T10:10:11.000Z"), 1_788_948_611_000);
        assert_eq!(parse_iso("1970-01-01T00:00:00.000Z"), 0);
        assert_eq!(parse_iso("bukan waktu"), 0);
        assert_eq!(parse_iso(""), 0);
    }
}
