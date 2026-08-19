//! Files dragged from the browser onto a terminal.
//!
//! A PTY carries only bytes, and an agent does not read images from stdin —
//! what it reads is a path. So the file has to land on the machine where the
//! agent lives first, and only then is its path typed into the terminal. That
//! is all this module is: storing, naming safely, and sweeping what is done.
//!

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tracing::{info, warn};

use crate::config::Drops;

/// A file that just landed must not be swept by the size limit: the agent may
/// not have read it yet. The age limit needs no such guard — a file that old
/// is finished with.
const GRACE: Duration = Duration::from_secs(10 * 60);

const MB: u64 = 1024 * 1024;

/// Clean a name from a client. What arrives over the network is never trusted
/// as a path: only its file name is taken, and only letters, digits, dots,
/// dashes and underscores survive. `..` and directory separators cannot get
/// through this sieve.
fn safe_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let mut out = String::new();
    let mut last_dot = false;
    for c in base.chars() {
        let keep = match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => true,
            // Runs of dots collapse into one, which also kills `..`.
            '.' if !last_dot && !out.is_empty() => true,
            _ => false,
        };
        last_dot = keep && c == '.';
        if keep {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_matches(['-', '.']).to_string();
    if out.is_empty() {
        "drop".to_string()
    } else {
        out
    }
}

/// A time prefix so two `screenshot.png` never overwrite each other, and so the
/// files read in order in a file explorer.
fn stamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Store one file. Returns its full path.
pub fn save(cfg: &Drops, name: &str, data: &[u8]) -> Result<PathBuf, String> {
    if data.is_empty() {
        return Err("The file is empty.".into());
    }
    if cfg.max_file_mb > 0 && data.len() as u64 > cfg.max_file_mb * MB {
        // Refused up front, not stored and then quietly thrown away.
        return Err(format!(
            "That file is {:.1} MB, over the {} MB limit for a single drop.",
            data.len() as f64 / MB as f64,
            cfg.max_file_mb
        ));
    }

    let dir = crate::config::dropped_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    let base = safe_name(name);
    let mut path = dir.join(format!("{}-{base}", stamp()));
    // Two drops in the same millisecond are still possible; do not overwrite.
    for n in 1..100 {
        if !path.exists() {
            break;
        }
        path = dir.join(format!("{}-{n}-{base}", stamp()));
    }

    fs::write(&path, data).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    info!(path = %path.display(), bytes = data.len(), "file dropped");
    Ok(path)
}

struct Entry {
    path: PathBuf,
    size: u64,
    age: Duration,
}

fn scan(dir: &Path) -> Vec<Entry> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let now = SystemTime::now();
    let mut out = Vec::new();
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let age = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .unwrap_or_default();
        out.push(Entry { path: e.path(), size: meta.len(), age });
    }
    out
}

pub fn usage() -> (usize, u64) {
    let files = scan(&crate::config::dropped_dir());
    (files.len(), files.iter().map(|f| f.size).sum())
}

/// Sweep the drop folder. Returns (files removed, bytes freed).
///
/// Age first, size second. The size limit may only touch files past the grace
/// period; if the folder is still too large after that, it is logged and left
/// alone — deleting a file the agent may be reading costs more than a disk
/// that stays large for a while.
///
pub fn sweep(cfg: &Drops) -> (usize, u64) {
    let dir = crate::config::dropped_dir();
    let mut files = scan(&dir);
    let mut gone = 0usize;
    let mut freed = 0u64;

    if cfg.max_age_hours > 0 {
        let limit = Duration::from_secs(cfg.max_age_hours * 3600);
        files.retain(|f| {
            if f.age <= limit {
                return true;
            }
            match fs::remove_file(&f.path) {
                Ok(()) => {
                    gone += 1;
                    freed += f.size;
                    false
                }
                Err(e) => {
                    warn!(path = %f.path.display(), error = %e, "could not remove aged drop");
                    true
                }
            }
        });
    }

    if cfg.max_total_mb > 0 {
        let cap = cfg.max_total_mb * MB;
        let mut total: u64 = files.iter().map(|f| f.size).sum();
        if total > cap {
            // Oldest first; anything still inside the grace period is untouched.
            files.sort_by(|a, b| b.age.cmp(&a.age));
            for f in &files {
                if total <= cap {
                    break;
                }
                if f.age < GRACE {
                    continue;
                }
                if fs::remove_file(&f.path).is_ok() {
                    gone += 1;
                    freed += f.size;
                    total -= f.size;
                }
            }
            if total > cap {
                warn!(
                    total_mb = total / MB,
                    cap_mb = cfg.max_total_mb,
                    "dropped folder is over its size limit, but everything left is too recent \
                     to remove safely"
                );
            }
        }
    }

    if gone > 0 {
        info!(files = gone, freed_kb = freed / 1024, "swept dropped files");
    }
    (gone, freed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_directories_and_traversal() {
        // A name from a client must never end up writing outside the folder.
        for raw in [
            "../../../Windows/System32/evil.dll",
            "..\\..\\evil.dll",
            "/etc/passwd",
            "C:\\Windows\\hosts",
        ] {
            let s = safe_name(raw);
            assert!(!s.contains(".."), "{raw} -> {s}");
            assert!(!s.contains('/') && !s.contains('\\'), "{raw} -> {s}");
            assert!(!s.is_empty());
        }
    }

    #[test]
    fn keeps_a_readable_name_and_its_extension() {
        assert_eq!(safe_name("Screenshot 2026-08-14.png"), "Screenshot-2026-08-14.png");
        assert_eq!(safe_name("logo.PNG"), "logo.PNG");
    }

    #[test]
    fn survives_names_made_entirely_of_junk() {
        // A name sieved down to nothing must still produce a file, not a panic.
        for raw in ["", "///", "???", "..", "   "] {
            let s = safe_name(raw);
            assert!(!s.is_empty(), "{raw:?} menghasilkan nama kosong");
        }
    }

    #[test]
    fn long_names_are_cut_short() {
        let s = safe_name(&format!("{}.png", "a".repeat(500)));
        assert!(s.len() <= 48, "panjangnya {}", s.len());
    }

    #[test]
    fn oversized_files_are_refused_before_touching_disk() {
        let cfg = Drops { max_age_hours: 24, max_total_mb: 100, max_file_mb: 1 };
        let err = save(&cfg, "big.png", &vec![0u8; 2 * MB as usize]).unwrap_err();
        assert!(err.contains("2.0 MB") && err.contains("1 MB"), "{err}");
    }

    #[test]
    fn empty_files_are_refused() {
        let cfg = Drops::default();
        assert!(save(&cfg, "x.png", b"").is_err());
    }

    #[test]
    fn a_zero_limit_means_no_limit() {
        let cfg = Drops { max_age_hours: 0, max_total_mb: 0, max_file_mb: 0 };
        // No file may disappear when every limit is turned off.
        let (gone, _) = sweep(&cfg);
        assert_eq!(gone, 0);
    }
}
