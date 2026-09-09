//! Walking folders on the daemon's machine, to pick a new project from the
//! browser.
//!
//! Only directories are reported — this is a folder picker, not a file
//! explorer. It opens no new capability: anyone who can talk to the daemon
//! already has a full shell, so listing directories is not extra power, just
//! a shorter road.
//!

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::proto::{DirEntry, DirList};

/// Directories longer than this are not sent whole. Folders with tens of
/// thousands of children exist in the real world, and one giant message would
/// only freeze the panel.
const MAX_ENTRIES: usize = 2000;

/// The contents of one directory. An empty `path` means "start from home".
pub fn list(path: &str, projects: &[String]) -> Result<DirList, String> {
    let target = if path.trim().is_empty() {
        crate::config::home()
    } else {
        normalize(path)
    };

    let meta = fs::metadata(&target)
        .map_err(|e| format!("Cannot open {}: {e}", target.display()))?;
    if !meta.is_dir() {
        return Err(format!("{} is not a folder.", target.display()));
    }

    let rd = fs::read_dir(&target).map_err(|e| format!("Cannot read {}: {e}", target.display()))?;
    let known: Vec<String> = projects.iter().map(|p| p.to_lowercase()).collect();

    let mut entries: Vec<DirEntry> = Vec::new();
    let mut truncated = false;
    for e in rd.flatten() {
        // `file_type` does not follow symlinks; the ones pointing at directories
        // should still show up, so metadata is used as a fallback.
        let is_dir = match e.file_type() {
            Ok(t) if t.is_dir() => true,
            Ok(t) if t.is_symlink() => fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false),
            _ => false,
        };
        if !is_dir {
            continue;
        }
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let full = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        entries.push(DirEntry {
            is_repo: full.join(".git").exists(),
            is_project: known.contains(&full.to_string_lossy().to_lowercase()),
            path: full.to_string_lossy().into_owned(),
            name,
        });
    }
    // Case-insensitive, so the order matches what the eye sees in a file
    // explorer — not every capital letter first.
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(DirList {
        parent: target.parent().map(|p| p.to_string_lossy().into_owned()),
        path: target.to_string_lossy().into_owned(),
        name: display_name(&target),
        is_repo: target.join(".git").exists(),
        is_project: known.contains(&target.to_string_lossy().to_lowercase()),
        entries,
        truncated,
        roots: roots(),
    })
}

/// Create a folder inside `parent`. Returns its path.
pub fn make_dir(parent: &str, name: &str) -> Result<PathBuf, String> {
    make_entry(parent, name, true)
}

/// A name typed by a person, checked before it is allowed anywhere near the
/// disk. It must be **one component**: a client that could call its new file
/// `..\..\thing` would be writing outside the folder it named, which is the
/// whole risk in taking a name over the wire at all.
fn check_name<'a>(name: &'a str, what: &str) -> Result<&'a str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(format!("Give the {what} a name."));
    }
    if name.contains(['/', '\\', ':']) || Path::new(name).components().count() != 1 {
        return Err(format!("A {what} name cannot contain \\ / or :"));
    }
    if name == "." || name == ".." {
        return Err(format!("That is not a {what} name."));
    }
    if name.contains(['<', '>', '"', '|', '?', '*']) {
        return Err(format!("A {what} name cannot contain < > \" | ? *"));
    }
    Ok(name)
}

/// Create one folder or one empty file inside `parent`, and say where it is.
///
/// The file is created with `create_new`, which is atomic: two clients racing
/// cannot both believe they made it, and an existing file is never truncated.
/// The folder check is `exists()` first because `create_dir` alone would report
/// the same error for "already there" and for "the disk said no", and those
/// deserve different words.
pub fn make_entry(parent: &str, name: &str, dir: bool) -> Result<PathBuf, String> {
    let what = if dir { "folder" } else { "file" };
    let name = check_name(name, what)?;

    let base = normalize(parent);
    if !base.is_dir() {
        return Err(format!("{} is not a folder.", base.display()));
    }
    let full = base.join(name);
    if full.exists() {
        return Err(format!("`{name}` already exists here."));
    }
    if dir {
        fs::create_dir(&full).map_err(|e| format!("Could not create `{name}`: {e}"))?;
    } else {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&full)
            .map_err(|e| format!("Could not create `{name}`: {e}"))?;
    }
    Ok(full)
}

/// Clean a path from a client: drop `.` and `..` before touching the disk, so
/// what lands in the config is always the tidy form.
pub fn normalize(input: &str) -> PathBuf {
    let raw = PathBuf::from(input.trim());
    let mut out = PathBuf::new();
    for c in raw.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    // `C:` on its own points at that drive's working directory, not its root.
    if cfg!(windows) {
        let s = out.to_string_lossy();
        if s.len() == 2 && s.ends_with(':') {
            return PathBuf::from(format!("{s}\\"));
        }
    }
    if out.as_os_str().is_empty() {
        crate::config::home()
    } else {
        out
    }
}

/// A readable name for a folder. A drive root has no `file_name`, so its own
/// path is used instead.
pub(crate) fn display_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string_lossy().into_owned())
}

/// Where walking starts: home, then every drive that actually exists.
fn roots() -> Vec<DirEntry> {
    let mut out = Vec::new();
    let home = crate::config::home();
    if home.is_dir() {
        out.push(DirEntry {
            name: "Home".into(),
            path: home.to_string_lossy().into_owned(),
            is_repo: false,
            is_project: false,
        });
    }
    if cfg!(windows) {
        for c in 'A'..='Z' {
            let p = format!("{c}:\\");
            if fs::metadata(&p).is_ok() {
                out.push(DirEntry {
                    name: format!("{c}:"),
                    path: p,
                    is_repo: false,
                    is_project: false,
                });
            }
        }
    } else {
        out.push(DirEntry {
            name: "/".into(),
            path: "/".into(),
            is_repo: false,
            is_project: false,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An absolute path in the shape this system actually uses.
    ///
    /// `normalize` leans on `Path::components()`, whose rules differ per
    /// platform: on unix `C:` is not three folder levels but one file name
    /// that happens to contain backslashes. A test that writes Windows paths
    /// everywhere therefore passes on Windows and misleads elsewhere.
    ///
    fn abs(segments: &[&str]) -> String {
        if cfg!(windows) {
            format!("C:\\{}", segments.join("\\"))
        } else {
            format!("/{}", segments.join("/"))
        }
    }

    #[test]
    fn traversal_is_flattened_before_touching_disk() {
        let p = normalize(&abs(&["data", "code", "..", "..", "Windows"]));
        assert_eq!(p, PathBuf::from(abs(&["Windows"])));
        let q = normalize(&abs(&["data", ".", "code"]));
        assert_eq!(q, PathBuf::from(abs(&["data", "code"])));
    }

    #[test]
    fn climbing_past_the_root_stops_there() {
        // Must never produce an empty path that then becomes a working directory.
        let p = normalize(&abs(&["..", "..", ".."]));
        assert!(p.as_os_str().is_empty() || p.is_absolute(), "{p:?}");
    }

    #[test]
    fn an_empty_path_means_home() {
        assert_eq!(normalize("   "), crate::config::home());
    }

    #[test]
    fn a_bare_drive_letter_becomes_its_root() {
        if cfg!(windows) {
            assert_eq!(normalize("C:"), PathBuf::from("C:\\"));
        }
    }

    #[test]
    fn folder_names_cannot_be_paths() {
        for bad in ["", "  ", "..", ".", "a/b", "a\\b", "C:", "x<y", "q|r"] {
            assert!(make_dir(".", bad).is_err(), "{bad:?} seharusnya ditolak");
            assert!(make_entry(".", bad, false).is_err(), "{bad:?} juga untuk berkas");
        }
    }

    /// The two halves of creating a file: it appears, and a second attempt does
    /// not quietly empty the first one.
    #[test]
    fn a_new_file_is_created_once_and_never_overwritten() {
        let dir = std::env::temp_dir().join(format!("sh-make-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let parent = dir.to_string_lossy().into_owned();

        let made = make_entry(&parent, "notes.md", false).expect("file dibuat");
        assert!(made.is_file());
        fs::write(&made, b"isi").unwrap();

        assert!(make_entry(&parent, "notes.md", false).is_err(), "yang kedua ditolak");
        assert_eq!(fs::read(&made).unwrap(), b"isi", "isinya tidak boleh hilang");

        let sub = make_entry(&parent, "sub", true).expect("folder dibuat");
        assert!(sub.is_dir());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn listing_reports_only_folders_and_marks_repos() {
        let dir = crate::config::home();
        let out = list(&dir.to_string_lossy(), &[]).unwrap();
        assert_eq!(out.path, dir.to_string_lossy());
        assert!(out.entries.iter().all(|e| !e.name.is_empty()));
        assert!(!out.roots.is_empty(), "harus ada titik awal");
    }

    #[test]
    fn a_known_project_is_marked_as_one() {
        let here = std::env::current_dir().unwrap();
        let parent = here.parent().unwrap().to_string_lossy().into_owned();
        let out = list(&parent, &[here.to_string_lossy().to_uppercase()]).unwrap();
        let me = out.entries.iter().find(|e| e.path.eq_ignore_ascii_case(&here.to_string_lossy()));
        // The comparison has to ignore case: Windows writes the same drive and
        // folder with different spellings.
        assert!(me.is_some_and(|e| e.is_project), "project yang sudah ada harus ditandai");
    }
}
