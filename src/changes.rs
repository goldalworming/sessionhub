//! What agents changed in a project, without git.
//!
//! The first terminal opened in a project takes a snapshot of its code files —
//! source, config and docs, never `node_modules`, build output or anything over
//! `MAX_FILE`. Asking for the changes walks the project again and compares: a
//! file whose size and time are the same is not read at all, so a look costs
//! one `stat` per code file.
//!
//! A snapshot ends three ways: "reviewed" (a new one is taken), the last
//! terminal in the project ending (it is dropped), or the daemon stopping. Each
//! time, what changed during it is written to `~/.sessionhub/changes/` first —
//! both sides of every file — so it can be looked at again days later.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::proto::{ChangedFile, RecordInfo};

/// Larger "source" files are generated — bundles, lockfiles, dumps — and are
/// not what anyone reviews line by line.
const MAX_FILE: u64 = 1024 * 1024;
/// Past either of these the project is too large to keep a copy of in memory,
/// and nothing is tracked rather than a partial copy that would list every
/// file it missed as new.
const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// How long a record of past changes is kept.
const KEEP: Duration = Duration::from_secs(30 * 24 * 3600);

/// Folders that hold dependencies, build output, caches or VCS data — never
/// code someone wrote in this project.
const SKIP_DIRS: &[&str] = &[
    "node_modules", "bower_components", "jspm_packages", "vendor", "target", "build", "dist",
    "out", "bin", "obj", "coverage", "__pycache__", "venv", "site-packages", "pods",
    "deriveddata", "cmake-build-debug", "cmake-build-release", ".git", ".hg", ".svn", ".jj",
    ".next", ".nuxt", ".svelte-kit", ".output", ".turbo", ".cache", ".parcel-cache", ".venv",
    ".tox", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".gradle", ".idea", ".vs",
    ".angular", ".expo", ".terraform", ".dart_tool", ".sessionhub",
];

const CODE_EXT: &[&str] = &[
    "rs", "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "astro", "py",
    "pyi", "go", "java", "kt", "kts", "scala", "groovy", "gradle", "swift", "m", "mm", "c", "h",
    "cc", "cpp", "cxx", "hpp", "hh", "hxx", "cs", "fs", "vb", "rb", "php", "pl", "pm", "lua",
    "r", "dart", "ex", "exs", "erl", "hrl", "clj", "cljs", "hs", "ml", "mli", "zig", "nim", "jl",
    "sol", "sql", "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "html", "htm", "css",
    "scss", "sass", "less", "json", "jsonc", "yaml", "yml", "toml", "xml", "ini", "cfg", "conf",
    "env", "md", "mdx", "txt", "proto", "graphql", "gql", "cmake", "mk", "tf", "nsi", "rc",
    "glsl", "hlsl", "wgsl", "asm", "s",
];

/// Code files without an extension worth tracking.
const CODE_NAMES: &[&str] = &["makefile", "dockerfile", "justfile", "rakefile", "gemfile", "procfile"];

/// Generated even though they look like code.
const SKIP_NAMES: &[&str] = &["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "composer.lock"];

struct Snap {
    len: u64,
    mtime: u64,
    text: Vec<u8>,
}

enum Baseline {
    /// The first walk is still running.
    Taking,
    TooBig,
    Ready { root: String, at_ms: u64, files: HashMap<String, Snap> },
}

/// One per project with a live terminal, in memory, capped at `MAX_BYTES`.
static BASELINES: Mutex<Option<HashMap<String, Arc<Baseline>>>> = Mutex::new(None);

fn key(root: &str) -> String {
    crate::browse::normalize(root).to_string_lossy().to_lowercase()
}

fn with<T>(f: impl FnOnce(&mut HashMap<String, Arc<Baseline>>) -> T) -> T {
    let mut all = BASELINES.lock().unwrap_or_else(|e| e.into_inner());
    f(all.get_or_insert_with(HashMap::new))
}

fn get(root: &str) -> Option<Arc<Baseline>> {
    with(|all| all.get(&key(root)).cloned())
}

/// A finished snapshot goes in only where one was being waited for: if the
/// project's last terminal ended while it was taken, it is not wanted any more.
fn settle(root: &str, b: Baseline) {
    with(|all| {
        if matches!(all.get(&key(root)).map(|b| &**b), Some(Baseline::Taking)) {
            all.insert(key(root), Arc::new(b));
        }
    });
}

/// Start tracking a project if nothing is yet. Returns at once — this is on the
/// way to starting a terminal — and the snapshot is taken on its own thread.
pub fn track(root: &str) {
    let fresh = with(|all| {
        if all.contains_key(&key(root)) {
            return false;
        }
        all.insert(key(root), Arc::new(Baseline::Taking));
        true
    });
    if fresh {
        let root = root.to_string();
        std::thread::spawn(move || settle(&root, snapshot(&root)));
    }
}

/// "These are reviewed": keep what changed, then count from now.
pub fn reset(root: &str) {
    let old = with(|all| all.insert(key(root), Arc::new(Baseline::Taking)));
    if let Some(old) = old {
        save(&old);
    }
    settle(root, snapshot(root));
}

/// The project's last terminal has ended: keep what changed, and let the copy go.
pub fn release(root: &str) {
    if let Some(old) = with(|all| all.remove(&key(root))) {
        save(&old);
    }
}

/// The daemon is stopping: keep what every project changed.
pub fn save_all() {
    for b in with(|all| all.drain().map(|(_, b)| b).collect::<Vec<_>>()) {
        save(&b);
    }
}

fn snapshot(root: &str) -> Baseline {
    let Some(found) = walk(root) else { return Baseline::TooBig };
    let mut files = HashMap::with_capacity(found.len());
    for (path, (len, mtime)) in found {
        if let Ok(text) = fs::read(&path) {
            files.insert(path, Snap { len, mtime, text });
        }
    }
    Baseline::Ready { root: root.to_string(), at_ms: now_ms(), files }
}

/// Every code file under `root`: path -> (size, modified). `None` when the
/// project is over the limits.
fn walk(root: &str) -> Option<HashMap<String, (u64, u64)>> {
    let mut out = HashMap::new();
    let mut bytes = 0u64;
    let mut stack = vec![crate::browse::normalize(root)];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            // Not followed through symlinks: a link back up the tree would
            // otherwise never end.
            let Ok(ft) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().to_lowercase();
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(e.path());
                }
                continue;
            }
            if !ft.is_file() || !is_code(&name) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            if meta.len() > MAX_FILE {
                continue;
            }
            bytes += meta.len();
            if out.len() >= MAX_FILES || bytes > MAX_BYTES {
                return None;
            }
            out.insert(e.path().to_string_lossy().into_owned(), (meta.len(), mtime(&meta)));
        }
    }
    Some(out)
}

fn is_code(name: &str) -> bool {
    if SKIP_NAMES.contains(&name) || name.ends_with(".min.js") || name.ends_with(".min.css") {
        return false;
    }
    match name.rsplit_once('.') {
        Some((_, ext)) => CODE_EXT.contains(&ext),
        None => CODE_NAMES.contains(&name),
    }
}

/// One changed file with both sides.
struct Change {
    path: String,
    status: &'static str,
    before: Vec<u8>,
    after: Vec<u8>,
}

/// What differs between the snapshot and the disk now. `None` when the project
/// has grown past the limits since.
fn compare(root: &str, files: &HashMap<String, Snap>) -> Option<Vec<Change>> {
    let now = walk(root)?;
    let mut out = Vec::new();
    for (path, snap) in files {
        let status = match now.get(path) {
            None => "deleted",
            Some(&(len, mt)) if len == snap.len && mt == snap.mtime => continue,
            Some(_) => "modified",
        };
        let after = if status == "deleted" { Vec::new() } else { fs::read(path).unwrap_or_default() };
        if status == "modified" && after == snap.text {
            continue;
        }
        out.push(Change { path: path.clone(), status, before: snap.text.clone(), after });
    }
    for path in now.keys().filter(|p| !files.contains_key(*p)) {
        if let Ok(after) = fs::read(path) {
            out.push(Change { path: path.clone(), status: "added", before: Vec::new(), after });
        }
    }
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Some(out)
}

fn row(c: &Change) -> ChangedFile {
    let (added, removed) = line_counts(&c.before, &c.after);
    ChangedFile { path: c.path.clone(), status: c.status.to_string(), added, removed }
}

/// What changed since the snapshot, and the records of earlier ones. `state` is
/// "ready", "taking" (still being made — ask again), "too_big", or "idle" (no
/// terminal is open in the project, so nothing is being tracked).
pub fn list(root: &str) -> (&'static str, u64, Vec<ChangedFile>, Vec<RecordInfo>) {
    let history = history(root);
    let Some(base) = get(root) else { return ("idle", 0, Vec::new(), history) };
    match &*base {
        Baseline::Taking => ("taking", 0, Vec::new(), history),
        Baseline::TooBig => ("too_big", 0, Vec::new(), history),
        Baseline::Ready { at_ms, files, .. } => match compare(root, files) {
            Some(c) => ("ready", *at_ms, c.iter().map(row).collect(), history),
            None => ("too_big", *at_ms, Vec::new(), history),
        },
    }
}

/// One file's two sides, for the diff view: (status, before, after). From the
/// live snapshot, or from a saved record when `record` names one.
pub fn diff(root: &str, path: &str, record: Option<u64>) -> Result<(String, String, String), String> {
    if let Some(id) = record {
        let rec = read_record(root, id)?;
        let line = rec.lines().skip(1).find_map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).ok()?;
            (v["path"] == path).then_some(v)
        });
        let v = line.ok_or_else(|| format!("{path} is not in that record."))?;
        let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
        return Ok((s("status"), s("before"), s("after")));
    }
    let Some(base) = get(root) else { return Err("This project is not being tracked.".into()) };
    let Baseline::Ready { files, .. } = &*base else {
        return Err("The snapshot of this project is not ready.".into());
    };
    // Spelled the way `walk` spells it, whatever separators it came with.
    let path = &crate::browse::normalize(path).to_string_lossy().into_owned();
    let before = files.get(path).map(|s| String::from_utf8_lossy(&s.text).into_owned());
    let after = fs::read(path).ok().map(|t| String::from_utf8_lossy(&t).into_owned());
    let status = match (&before, &after) {
        (None, Some(_)) => "added",
        (Some(_), None) => "deleted",
        (Some(_), Some(_)) => "modified",
        (None, None) => return Err(format!("{path} is not there, and was not before.")),
    };
    Ok((status.into(), before.unwrap_or_default(), after.unwrap_or_default()))
}

// ---------------------------------------------------------------- records
//
// One file per snapshot, `<since_ms>.jsonl` in a folder per project: the first
// line is the summary (`RecordInfo` plus the root), then one line per changed
// file with both sides. A listing reads first lines only.

fn records_dir(root: &str) -> PathBuf {
    // FNV-1a: the same folder for the same project on every build, which std's
    // hasher does not promise.
    let h = key(root).bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    records_base().join(format!("{h:016x}"))
}

#[cfg(not(test))]
fn records_base() -> PathBuf {
    crate::config::dir().join("changes")
}

/// Never the real `~/.sessionhub` from a test.
#[cfg(test)]
fn records_base() -> PathBuf {
    std::env::temp_dir().join(format!("sh-changes-{}", std::process::id())).join("records")
}

fn save(base: &Baseline) {
    let Baseline::Ready { root, at_ms, files } = base else { return };
    let Some(changes) = compare(root, files) else { return };
    if changes.is_empty() {
        return;
    }
    let rows: Vec<ChangedFile> = changes.iter().map(row).collect();
    let summary = RecordInfo {
        since_ms: *at_ms,
        until_ms: now_ms(),
        files: rows.len() as u32,
        added: rows.iter().map(|r| r.added).sum(),
        removed: rows.iter().map(|r| r.removed).sum(),
    };
    let mut out = serde_json::json!({ "root": root, "summary": summary }).to_string();
    for (c, r) in changes.iter().zip(&rows) {
        out.push('\n');
        out.push_str(
            &serde_json::json!({
                "path": c.path, "status": c.status, "added": r.added, "removed": r.removed,
                "before": String::from_utf8_lossy(&c.before), "after": String::from_utf8_lossy(&c.after),
            })
            .to_string(),
        );
    }
    let dir = records_dir(root);
    let file = dir.join(format!("{at_ms}.jsonl"));
    // Written aside and moved in whole: an update restarts the daemon shortly
    // after asking it to stop, and a record cut short would be unreadable.
    let part = file.with_extension("part");
    let wrote = fs::create_dir_all(&dir).and_then(|_| fs::write(&part, out)).and_then(|_| fs::rename(&part, &file));
    if let Err(e) = wrote {
        tracing::warn!(error = %e, "could not keep a record of changes");
    }
    prune(&dir);
}

/// Records past `KEEP` go.
fn prune(dir: &std::path::Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
        if old.is_some_and(|age| age > KEEP) {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// The saved records for a project, newest first.
fn history(root: &str) -> Vec<RecordInfo> {
    let Ok(rd) = fs::read_dir(records_dir(root)) else { return Vec::new() };
    let mut out: Vec<RecordInfo> = rd
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| {
            let mut first = String::new();
            BufReader::new(fs::File::open(e.path()).ok()?).read_line(&mut first).ok()?;
            let v: serde_json::Value = serde_json::from_str(&first).ok()?;
            serde_json::from_value(v["summary"].clone()).ok()
        })
        .collect();
    out.sort_by(|a, b| b.since_ms.cmp(&a.since_ms));
    out
}

fn read_record(root: &str, id: u64) -> Result<String, String> {
    fs::read_to_string(records_dir(root).join(format!("{id}.jsonl")))
        .map_err(|_| "That record of changes is gone.".to_string())
}

/// One saved record's files, without their contents.
pub fn record(root: &str, id: u64) -> Result<(RecordInfo, Vec<ChangedFile>), String> {
    let text = read_record(root, id)?;
    let mut lines = text.lines();
    let head: serde_json::Value =
        lines.next().and_then(|l| serde_json::from_str(l).ok()).ok_or("That record is damaged.")?;
    let info: RecordInfo = serde_json::from_value(head["summary"].clone()).map_err(|e| e.to_string())?;
    let files = lines.filter_map(|l| serde_json::from_str::<ChangedFile>(l).ok()).collect();
    Ok((info, files))
}

/// Lines added and removed, counted as the difference between the two sides'
/// multisets of lines.
// ponytail: a line moved elsewhere counts as unchanged, and a repeated line
// edited in one place may be matched to its twin; a real diff (Myers) if the
// numbers ever need to agree with git's exactly.
fn line_counts(before: &[u8], after: &[u8]) -> (u32, u32) {
    let mut seen: HashMap<&[u8], i64> = HashMap::new();
    for l in lines(before) {
        *seen.entry(l).or_default() += 1;
    }
    for l in lines(after) {
        *seen.entry(l).or_default() -= 1;
    }
    let removed: i64 = seen.values().filter(|n| **n > 0).sum();
    let added: i64 = -seen.values().filter(|n| **n < 0).sum::<i64>();
    (added as u32, removed as u32)
}

fn lines(text: &[u8]) -> impl Iterator<Item = &[u8]> {
    // The empty piece after a final newline is not a line, and neither is an
    // empty file.
    let body = text.strip_suffix(b"\n").unwrap_or(text);
    body.split(|b| *b == b'\n')
        .filter(move |_| !text.is_empty())
        .map(|l| l.strip_suffix(b"\r").unwrap_or(l))
}

fn mtime(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn only_code_counts() {
        assert!(is_code("main.rs") && is_code("app.tsx") && is_code("makefile") && is_code("readme.md"));
        assert!(!is_code("logo.png") && !is_code("package-lock.json") && !is_code("app.min.js"));
        assert!(!is_code("license"));
    }

    #[test]
    fn lines_are_counted_like_a_diff_stat() {
        assert_eq!(line_counts(b"a\nb\nc\n", b"a\nB\nc\nd\n"), (2, 1));
        assert_eq!(line_counts(b"", b"x\ny\n"), (2, 0));
        assert_eq!(line_counts(b"x\r\ny\r\n", b"x\ny\n"), (0, 0), "line endings alone are not a change");
        assert_eq!(line_counts(b"a\nb", b"a\nb\n"), (0, 0));
    }

    fn names(files: &[ChangedFile]) -> Vec<(String, String, u32, u32)> {
        files
            .iter()
            .map(|f| {
                let name = Path::new(&f.path).file_name().unwrap().to_string_lossy().into_owned();
                (name, f.status.clone(), f.added, f.removed)
            })
            .collect()
    }

    #[test]
    fn changes_are_listed_kept_and_let_go() {
        let dir = std::env::temp_dir().join(format!("sh-changes-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let proj = dir.join("proj");
        fs::create_dir_all(proj.join("src")).unwrap();
        fs::create_dir_all(proj.join("node_modules/x")).unwrap();
        fs::create_dir_all(proj.join("target")).unwrap();
        fs::write(proj.join("src/a.rs"), "fn a() {}\n").unwrap();
        fs::write(proj.join("src/gone.rs"), "x\n").unwrap();
        fs::write(proj.join("logo.png"), "png").unwrap();
        let root = proj.to_string_lossy().into_owned();

        assert_eq!(list(&root).0, "idle", "nothing is tracked before a terminal opens");
        track(&root);
        while list(&root).0 == "taking" {
            std::thread::sleep(Duration::from_millis(20));
        }
        fs::write(proj.join("src/a.rs"), "fn a() { 1 }\n").unwrap();
        fs::remove_file(proj.join("src/gone.rs")).unwrap();
        fs::write(proj.join("src/new.ts"), "let x = 1;\nlet y = 2;\n").unwrap();
        fs::write(proj.join("node_modules/x/i.js"), "dep").unwrap();
        fs::write(proj.join("target/out.rs"), "gen").unwrap();
        fs::write(proj.join("logo.png"), "png2").unwrap();

        let (state, _, files, history) = list(&root);
        assert_eq!(state, "ready");
        assert!(history.is_empty());
        let want = vec![
            ("a.rs".to_string(), "modified".to_string(), 1, 1),
            ("gone.rs".into(), "deleted".into(), 0, 1),
            ("new.ts".into(), "added".into(), 2, 0),
        ];
        assert_eq!(names(&files), want);

        let a = proj.join("src/a.rs").to_string_lossy().into_owned();
        let (status, before, after) = diff(&root, &a, None).unwrap();
        assert_eq!((status.as_str(), before.as_str(), after.as_str()), ("modified", "fn a() {}\n", "fn a() { 1 }\n"));

        // Reviewed: the list empties, and what it held is kept.
        reset(&root);
        let (_, _, files, history) = list(&root);
        assert!(files.is_empty());
        assert_eq!(history.len(), 1);
        assert_eq!((history[0].files, history[0].added, history[0].removed), (3, 3, 2));
        let (_, kept) = record(&root, history[0].since_ms).unwrap();
        assert_eq!(names(&kept), want);
        let a = files_path(&kept, "a.rs");
        let (_, before, after) = diff(&root, &a, Some(history[0].since_ms)).unwrap();
        assert_eq!((before.as_str(), after.as_str()), ("fn a() {}\n", "fn a() { 1 }\n"));

        // The last terminal ends: the copy goes, after its changes are kept.
        fs::write(proj.join("src/a.rs"), "fn a() { 2 }\n").unwrap();
        std::thread::sleep(Duration::from_millis(5));
        release(&root);
        assert_eq!(list(&root).0, "idle");
        assert_eq!(super::history(&root).len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    fn files_path(files: &[ChangedFile], name: &str) -> String {
        files.iter().find(|f| f.path.ends_with(name)).unwrap().path.clone()
    }
}
