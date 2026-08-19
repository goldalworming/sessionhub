//! The file tree and file contents, for the panel to the right of the terminal.
//!
//! One request = one directory. No workspace-wide index is built up front: a
//! large repo holds tens of thousands of files, and scanning them to draw the
//! ten rows on screen is entirely wasted work. Only what the user opens is
//! read.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::proto::{FileBody, FileEntry, TreeList};

/// Directories with more entries than this are truncated. A real `node_modules`
/// can hold tens of thousands; sending it whole only loads every layer with
/// work nobody reads.
const MAX_ENTRIES: usize = 5000;

/// Upper bound for a file opened in the editor. Past this only the head is
/// sent, with a truncated marker — better than hanging the browser on a 400 MB
/// log file.
pub const MAX_READ: u64 = 2 * 1024 * 1024;

/// The contents of one directory: folders first, then files, both sorted
/// alphabetically and case-insensitively.
pub fn list(path: &str) -> Result<TreeList, String> {
    let dir = crate::browse::normalize(path);
    let meta = fs::metadata(&dir).map_err(|e| format!("Cannot open {}: {e}", dir.display()))?;
    if !meta.is_dir() {
        return Err(format!("{} is not a folder.", dir.display()));
    }

    let rd = fs::read_dir(&dir).map_err(|e| format!("Cannot read {}: {e}", dir.display()))?;
    let mut entries: Vec<FileEntry> = Vec::new();
    let mut truncated = false;
    for e in rd.flatten() {
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(ft) = e.file_type() else { continue };
        // `file_type` does not follow symlinks; the ones pointing at directories
        // should still be treated as folders.
        let is_dir = ft.is_dir()
            || (ft.is_symlink() && fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false));
        let size = if is_dir { 0 } else { e.metadata().map(|m| m.len()).unwrap_or(0) };
        entries.push(FileEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().to_string_lossy().into_owned(),
            is_dir,
            size,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(TreeList { path: dir.to_string_lossy().into_owned(), entries, truncated })
}

/// Read one file to show in the editor.
pub fn read(path: &str) -> Result<FileBody, String> {
    let file = crate::browse::normalize(path);
    let meta = fs::metadata(&file).map_err(|e| format!("Cannot open {}: {e}", file.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder.", file.display()));
    }

    let size = meta.len();
    let want = size.min(MAX_READ) as usize;
    let raw = read_head(&file, want)?;

    // A binary file's contents are not sent at all. Showing a PNG as text only
    // wastes bandwidth and dirties the screen; images are fetched by the client
    // over a separate HTTP route.
    if is_binary(&raw) {
        return Ok(FileBody {
            image: is_image(&file),
            path: file.to_string_lossy().into_owned(),
            name: name_of(&file),
            text: String::new(),
            binary: true,
            truncated: false,
            size,
            modified_ms: modified_ms(&meta),
        });
    }

    let mut text = String::from_utf8_lossy(&raw).into_owned();
    let truncated = size > MAX_READ;
    if truncated {
        // The cut can land mid-line; drop the remainder so what shows does not
        // look like the file itself is damaged.
        if let Some(cut) = text.rfind('\n') {
            text.truncate(cut + 1);
        }
    }

    Ok(FileBody {
        path: file.to_string_lossy().into_owned(),
        name: name_of(&file),
        text,
        binary: false,
        image: false,
        truncated,
        size,
        modified_ms: modified_ms(&meta),
    })
}

/// Images a browser can draw as they are. SVG is deliberately left out: it is
/// text, and in a tool like this it is more often edited than looked at.
pub fn is_image(path: &Path) -> bool {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "bmp" | "ico")
}

/// Write an existing file back. Deliberately refuses to create a new one: this
/// panel is a viewer and an editor, not a file manager.
pub fn write(path: &str, text: &str) -> Result<u64, String> {
    let file = crate::browse::normalize(path);
    let meta = fs::metadata(&file).map_err(|e| format!("Cannot open {}: {e}", file.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder.", file.display()));
    }
    if meta.permissions().readonly() {
        return Err(format!("{} is read-only.", name_of(&file)));
    }
    fs::write(&file, text).map_err(|e| format!("Could not save {}: {e}", name_of(&file)))?;
    let after = fs::metadata(&file).map(|m| modified_ms(&m)).unwrap_or(0);
    Ok(after)
}

fn read_head(path: &Path, want: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut f = fs::File::open(path).map_err(|e| format!("Cannot open: {e}"))?;
    let mut buf = vec![0u8; want];
    let mut filled = 0;
    while filled < want {
        match f.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) => return Err(format!("Cannot read: {e}")),
        }
    }
    buf.truncate(filled);
    Ok(buf)
}

/// The same binary guess git uses: one NUL byte in the head of the file is
/// enough. Cheap, and never wrong for source code.
fn is_binary(head: &[u8]) -> bool {
    head.iter().take(8000).any(|b| *b == 0)
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn sandbox(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sh-files-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn folders_come_before_files_and_sort_case_insensitively() {
        let dir = sandbox("order");
        for d in ["zebra", "Alpha"] {
            fs::create_dir(dir.join(d)).unwrap();
        }
        for f in ["b.txt", "A.txt"] {
            fs::write(dir.join(f), "x").unwrap();
        }
        let out = list(&dir.to_string_lossy()).unwrap();
        let names: Vec<&str> = out.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "zebra", "A.txt", "b.txt"]);
        assert!(out.entries[0].is_dir && !out.entries[2].is_dir);
    }

    #[test]
    fn file_size_is_reported_and_folders_report_zero() {
        let dir = sandbox("size");
        fs::create_dir(dir.join("sub")).unwrap();
        fs::write(dir.join("a.txt"), "12345").unwrap();
        let out = list(&dir.to_string_lossy()).unwrap();
        let f = out.entries.iter().find(|e| e.name == "a.txt").unwrap();
        let d = out.entries.iter().find(|e| e.name == "sub").unwrap();
        assert_eq!(f.size, 5);
        assert_eq!(d.size, 0);
    }

    #[test]
    fn reading_a_text_file_returns_its_contents() {
        let dir = sandbox("read");
        fs::write(dir.join("a.rs"), "fn main() {}\n").unwrap();
        let body = read(&dir.join("a.rs").to_string_lossy()).unwrap();
        assert_eq!(body.text, "fn main() {}\n");
        assert!(!body.binary && !body.truncated);
        assert_eq!(body.name, "a.rs");
    }

    #[test]
    fn binary_files_are_flagged_and_their_bytes_are_not_sent() {
        let dir = sandbox("bin");
        fs::write(dir.join("a.png"), [0x89, b'P', b'N', b'G', 0x00, 0x01]).unwrap();
        let body = read(&dir.join("a.png").to_string_lossy()).unwrap();
        assert!(body.binary);
        assert!(body.text.is_empty(), "isi berkas biner tidak boleh ikut dikirim");
    }

    #[test]
    fn oversized_files_are_cut_at_a_line_boundary() {
        let dir = sandbox("big");
        let path = dir.join("big.log");
        let mut f = fs::File::create(&path).unwrap();
        // Just past the limit, with a line length that does not divide evenly.
        let line = "x".repeat(999);
        for _ in 0..(MAX_READ / 1000 + 10) {
            writeln!(f, "{line}").unwrap();
        }
        drop(f);
        let body = read(&path.to_string_lossy()).unwrap();
        assert!(body.truncated);
        assert!(body.text.ends_with('\n'), "potongan harus berhenti di akhir baris");
        assert!(body.text.len() as u64 <= MAX_READ);
    }

    #[test]
    fn saving_writes_the_file_and_reports_a_newer_timestamp() {
        let dir = sandbox("save");
        let path = dir.join("a.txt");
        fs::write(&path, "before").unwrap();
        let stamp = write(&path.to_string_lossy(), "after").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "after");
        assert!(stamp > 0);
    }

    #[test]
    fn saving_refuses_to_create_a_new_file() {
        // The panel is an editor, not a file manager: saving to a mistyped path
        // must not quietly create a new file.
        let dir = sandbox("nocreate");
        let err = write(&dir.join("tidakada.txt").to_string_lossy(), "x").unwrap_err();
        assert!(err.contains("Cannot open"), "{err}");
    }

    #[test]
    fn a_folder_is_never_read_or_written_as_a_file() {
        let dir = sandbox("isdir");
        assert!(read(&dir.to_string_lossy()).unwrap_err().contains("is a folder"));
        assert!(write(&dir.to_string_lossy(), "x").unwrap_err().contains("is a folder"));
    }

    #[test]
    fn traversal_in_the_path_is_flattened_before_disk_is_touched() {
        let dir = sandbox("trav");
        fs::create_dir(dir.join("sub")).unwrap();
        fs::write(dir.join("a.txt"), "hi").unwrap();
        // The separator has to be one this system actually knows: on unix
        // `sub\...txt` is a single file name, not a detour.
        let sep = if cfg!(windows) { '\\' } else { '/' };
        let sneaky = format!("{}{sep}sub{sep}..{sep}a.txt", dir.display());
        let body = read(&sneaky).unwrap();
        assert_eq!(body.text, "hi");
        assert!(!body.path.contains(".."), "{}", body.path);
    }
}
