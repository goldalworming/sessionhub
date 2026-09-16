//! A record of what is done with sessionhub, kept on this machine and sent
//! nowhere.
//!
//! One JSON object per line in `~/.sessionhub/telemetry.jsonl`: what was
//! done, when, and a few numbers about it — never what was typed, never a
//! path, never a title. It exists so that "claude takes a while before it
//! accepts a keystroke" or "the picker is used by typing more than by
//! clicking" can be read off a file instead of guessed at.
//!
//! Cheap by construction. Nothing on the actor or a PTY thread ever touches
//! the disk: an event is a small value pushed into a bounded channel, and a
//! thread of its own writes them out in batches — every few seconds, or
//! sooner when many arrive at once. A full channel drops the event rather
//! than wait; the file is rotated once at a fixed size and never grows past
//! twice that.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crossbeam_channel::{bounded, RecvTimeoutError, Sender};
use serde_json::{Map, Value};
use tracing::{debug, warn};

/// Events waiting to be written. Far more than a person produces in the
/// seconds between two flushes; past it the newest are dropped.
const QUEUE: usize = 1024;

/// A batch is written this long after its first event at the latest.
const FLUSH_EVERY: Duration = Duration::from_secs(5);

/// Or this many events, whichever comes first.
const FLUSH_AT: usize = 64;

/// The file is rotated past this. Two of them at most: the current one and
/// the one before it.
const ROTATE_BYTES: u64 = 2 * 1024 * 1024;

/// What is accepted from the browser, per event: a name of this shape, and
/// this many scalar fields, each string no longer than this. The page is our
/// own code, but a limit costs nothing and a stray object costs a line.
const NAME_MAX: usize = 32;
const FIELDS_MAX: usize = 12;
const STRING_MAX: usize = 64;
const BATCH_MAX: usize = 100;

static TX: OnceLock<Sender<Value>> = OnceLock::new();

pub fn path() -> PathBuf {
    crate::config::dir().join("telemetry.jsonl")
}

/// Start the writer. Called once, before the actor; `track` before this or
/// with `enabled = false` is a no-op.
pub fn start(enabled: bool) {
    if !enabled {
        debug!("telemetry off");
        return;
    }
    let (tx, rx) = bounded::<Value>(QUEUE);
    if TX.set(tx).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("telemetry".into())
        .spawn(move || {
            let mut file = open();
            let mut pending: Vec<u8> = Vec::new();
            let mut count = 0usize;
            // When the oldest waiting event arrived. The deadline is counted
            // from it, not from the newest — a steady trickle must not keep
            // pushing the write back.
            let mut since: Option<Instant> = None;
            loop {
                let timeout = match since {
                    Some(t) => FLUSH_EVERY.saturating_sub(t.elapsed()),
                    None => Duration::from_secs(3600),
                };
                match rx.recv_timeout(timeout) {
                    Ok(v) => {
                        // A line that cannot be serialised is a bug here, not
                        // a reason to stop writing the others.
                        if serde_json::to_writer(&mut pending, &v).is_ok() {
                            pending.push(b'\n');
                            count += 1;
                            since.get_or_insert_with(Instant::now);
                        }
                        if count < FLUSH_AT && since.is_some_and(|t| t.elapsed() < FLUSH_EVERY) {
                            continue;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        flush(&mut file, &mut pending);
                        return;
                    }
                }
                if count > 0 {
                    flush(&mut file, &mut pending);
                    count = 0;
                    since = None;
                    rotate(&mut file);
                }
            }
        })
        .ok();
}

/// Record one thing the daemon did. `fields` is a JSON object; anything
/// else is written as `{"v": …}`.
pub fn track(event: &str, fields: Value) {
    let Some(tx) = TX.get() else { return };
    let mut m = match fields {
        Value::Object(m) => m,
        Value::Null => Map::new(),
        other => {
            let mut m = Map::new();
            m.insert("v".into(), other);
            m
        }
    };
    m.insert("ts".into(), Value::from(now_ms()));
    m.insert("src".into(), Value::from("daemon"));
    m.insert("e".into(), Value::from(event));
    // Dropped, not queued, when the writer is behind: a record of behaviour
    // is not worth making the behaviour wait.
    let _ = tx.try_send(Value::Object(m));
}

/// Events from the page, as sent in one `track` message. Checked and
/// trimmed by `clean`, then written like any other, with the client they
/// came from.
pub fn track_web(client: u64, events: Vec<Value>) {
    let Some(tx) = TX.get() else { return };
    for v in events.into_iter().take(BATCH_MAX) {
        if let Some(v) = clean(client, v) {
            let _ = tx.try_send(v);
        }
    }
}

/// One event from the page, cut down to what is accepted — see the limits
/// above — or `None` when it has no usable name.
fn clean(client: u64, v: Value) -> Option<Value> {
    let Value::Object(raw) = v else { return None };
    let name = raw.get("e")?.as_str()?;
    if name.is_empty()
        || name.len() > NAME_MAX
        || !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return None;
    }
    let mut m = Map::new();
    let mut kept = 0;
    for (k, v) in &raw {
        if k == "e" || k == "src" || k == "client" {
            continue;
        }
        if kept >= FIELDS_MAX || k.len() > NAME_MAX {
            break;
        }
        let v = match v {
            Value::Bool(_) | Value::Number(_) | Value::Null => v.clone(),
            Value::String(s) => Value::from(s.chars().take(STRING_MAX).collect::<String>()),
            _ => continue,
        };
        m.insert(k.clone(), v);
        kept += 1;
    }
    // The page's own clock, when it gave one — events are batched there for
    // seconds before they arrive, and the moment they happened is the one
    // that matters.
    if !m.get("ts").is_some_and(|t| t.is_number()) {
        m.insert("ts".into(), Value::from(now_ms()));
    }
    m.insert("src".into(), Value::from("web"));
    m.insert("client".into(), Value::from(client));
    m.insert("e".into(), Value::from(name));
    Some(Value::Object(m))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn open() -> Option<std::fs::File> {
    let p = path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        Ok(f) => Some(f),
        Err(e) => {
            warn!(path = %p.display(), error = %e, "telemetry file could not be opened");
            None
        }
    }
}

fn flush(file: &mut Option<std::fs::File>, pending: &mut Vec<u8>) {
    if let Some(f) = file {
        if let Err(e) = f.write_all(pending).and_then(|_| f.flush()) {
            warn!(error = %e, "telemetry write failed");
        }
    }
    pending.clear();
}

/// Past the limit, the file becomes `telemetry.1.jsonl` — replacing the
/// previous one — and a fresh one is started.
fn rotate(file: &mut Option<std::fs::File>) {
    let Some(f) = file else { return };
    let Ok(meta) = f.metadata() else { return };
    if meta.len() < ROTATE_BYTES {
        return;
    }
    let p = path();
    let old = p.with_file_name("telemetry.1.jsonl");
    // Closed before the rename: Windows will not move an open file.
    *file = None;
    let _ = std::fs::remove_file(&old);
    if let Err(e) = std::fs::rename(&p, &old) {
        warn!(error = %e, "telemetry file could not be rotated");
    }
    *file = open();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_name_must_be_plain() {
        assert!(clean(1, json!({"e": "switch", "how": "tab"})).is_some());
        assert!(clean(1, json!({"e": "Switch"})).is_none());
        assert!(clean(1, json!({"e": "a b"})).is_none());
        assert!(clean(1, json!({"e": ""})).is_none());
        assert!(clean(1, json!({"how": "tab"})).is_none());
        assert!(clean(1, json!("switch")).is_none());
    }

    #[test]
    fn fields_are_scalars_cut_to_size() {
        let long = "x".repeat(500);
        let v = clean(7, json!({"e": "err", "code": long, "n": 3, "ok": true, "nested": {"a": 1}, "list": [1], "ts": 1234}))
            .unwrap();
        let m = v.as_object().unwrap();
        assert_eq!(m["code"].as_str().unwrap().len(), STRING_MAX);
        assert_eq!(m["n"], 3);
        assert_eq!(m["ok"], true);
        assert!(m.get("nested").is_none());
        assert!(m.get("list").is_none());
        assert_eq!(m["ts"], 1234, "the page's clock is kept");
        assert_eq!(m["src"], "web");
        assert_eq!(m["client"], 7);
        assert_eq!(m["e"], "err");
    }

    #[test]
    fn the_page_cannot_speak_for_the_daemon() {
        let v = clean(2, json!({"e": "spawn", "src": "daemon", "client": 99, "ts": "yesterday"})).unwrap();
        let m = v.as_object().unwrap();
        assert_eq!(m["src"], "web");
        assert_eq!(m["client"], 2);
        assert!(m["ts"].is_number(), "a stamp that is not a number is replaced");
    }

    #[test]
    fn the_file_lives_beside_the_config() {
        assert_eq!(path().file_name().and_then(|n| n.to_str()), Some("telemetry.jsonl"));
        assert_eq!(path().parent(), Some(crate::config::dir().as_path()));
    }
}
