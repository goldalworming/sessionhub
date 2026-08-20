//! The frontend as one file, so it can be released and updated on its own.
//!
//! Most changes to this program are changes to `web/`: of the last three, two
//! touched no Rust at all. Shipping those as a new binary means swapping 8 MB
//! and killing every live terminal for a CSS fix. So the frontend gets its own
//! version and its own artifact, and the daemon can install one without
//! restarting.
//!
//! **Why not a zip or a tarball.** The payload is JavaScript that a browser will
//! execute, which makes unpacking it a security boundary, not a convenience.
//! `tar` and `Expand-Archive` honour whatever paths an archive contains — `..`
//! included — and delegating that to an outside tool is the one thing worth
//! keeping in hand here. A zip crate would be a dependency this project does not
//! otherwise have (even TLS is borrowed from `curl`). The format below is small
//! enough to read in one sitting, refuses any name that is not a plain relative
//! file, and is checked whole before a single byte is written to disk.
//!
//!   "SHWEB1" | u16 name length | name | u32 data length | data | …
//!
//! Little-endian, no compression. The app is 310 KB; over a tunnel that is
//! nothing, and compressing it would mean another dependency.

use std::collections::BTreeMap;
use std::path::PathBuf;

const MAGIC: &[u8] = b"SHWEB1";

/// Refuse anything larger than this, before allocating for it. The real bundle
/// is a third of a megabyte; a hundred times that is not a frontend.
const MAX_BUNDLE: usize = 32 * 1024 * 1024;

/// What the daemon knows about the frontend it is serving.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebVersion {
    pub version: String,
    /// The oldest daemon that can serve this frontend.
    pub needs_daemon: String,
}

/// Pack files into one bundle.
pub fn pack(files: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    let mut out = Vec::from(MAGIC);
    for (name, data) in files {
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
    }
    out
}

/// Read a bundle, or say why it cannot be trusted.
///
/// Every name is checked here, not at write time, so a bundle carrying one bad
/// path is rejected whole rather than half-installed.
pub fn unpack(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    if bytes.len() > MAX_BUNDLE {
        return Err(format!("that bundle is {} bytes — too large to be a frontend", bytes.len()));
    }
    if !bytes.starts_with(MAGIC) {
        return Err("that file is not a sessionhub frontend bundle".into());
    }
    let mut out = BTreeMap::new();
    let mut i = MAGIC.len();
    while i < bytes.len() {
        let n = read_u16(bytes, i).ok_or("the bundle ends in the middle of a name")? as usize;
        i += 2;
        let name = bytes.get(i..i + n).ok_or("the bundle ends in the middle of a name")?;
        let name = std::str::from_utf8(name).map_err(|_| "a name in the bundle is not UTF-8")?;
        check_name(name)?;
        i += n;
        let len = read_u32(bytes, i).ok_or("the bundle ends in the middle of a length")? as usize;
        i += 4;
        let data = bytes.get(i..i + len).ok_or_else(|| format!("`{name}` is cut short"))?;
        i += len;
        if out.insert(name.to_string(), data.to_vec()).is_some() {
            return Err(format!("`{name}` appears twice in the bundle"));
        }
    }
    if out.is_empty() {
        return Err("that bundle holds no files".into());
    }
    Ok(out)
}

/// A name may only be a plain relative path inside the frontend folder.
///
/// This is the check the whole format exists for. These files are served to a
/// browser and executed, so one entry called `../../.ssh/authorized_keys` would
/// be a very bad afternoon.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 200 {
        return Err(format!("`{name}` is not a usable file name"));
    }
    if name.starts_with('/') || name.starts_with('\\') || name.contains(':') {
        return Err(format!("`{name}` is not a relative path"));
    }
    for part in name.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("`{name}` tries to leave the frontend folder"));
        }
        // Anything that is not a plain file name is refused rather than
        // sanitised: guessing at what was meant is how these checks get bypassed.
        if !part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        {
            return Err(format!("`{name}` has characters a frontend file should not"));
        }
    }
    Ok(())
}

fn read_u16(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(i)?, *b.get(i + 1)?]))
}

fn read_u32(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_le_bytes([*b.get(i)?, *b.get(i + 1)?, *b.get(i + 2)?, *b.get(i + 3)?]))
}

/// Pull `version` and `needs_daemon` out of a `version.json`.
///
/// Parsed with serde_json, which is already here; the file is written by hand,
/// so a missing field is a mistake worth naming rather than defaulting past.
pub fn parse_version(bytes: &[u8]) -> Result<WebVersion, String> {
    let v: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "version.json is not valid JSON".to_string())?;
    let get = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("version.json has no `{k}`"))
    };
    Ok(WebVersion { version: get("version")?, needs_daemon: get("needs_daemon")? })
}

/// Is this daemon new enough to serve that frontend?
pub fn daemon_is_new_enough(daemon: &str, needs: &str) -> bool {
    !crate::update::is_newer(needs, daemon)
}

/// Where an installed frontend lives. Files here win over the ones baked into
/// the binary; anything missing falls back to the built-in copy, which is how
/// `vendor/` stays out of the bundle.
pub fn installed_dir() -> PathBuf {
    crate::config::dir().join("web")
}

/// Read the installed frontend's version, if there is one and it can be used.
///
/// Returns `Err` with something worth showing when a frontend is installed but
/// this daemon cannot serve it — silence there would leave the user staring at
/// an old interface with no idea why.
pub fn installed() -> Result<Option<WebVersion>, String> {
    let path = installed_dir().join("version.json");
    let Ok(bytes) = std::fs::read(&path) else { return Ok(None) };
    let v = parse_version(&bytes)?;
    if !daemon_is_new_enough(env!("CARGO_PKG_VERSION"), &v.needs_daemon) {
        return Err(format!(
            "the installed interface {} needs sessionhub {} or newer; this one is {}",
            v.version,
            v.needs_daemon,
            env!("CARGO_PKG_VERSION")
        ));
    }
    Ok(Some(v))
}

/// Read one file from the installed frontend, if it is there and usable.
pub fn installed_file(rel: &str) -> Option<Vec<u8>> {
    if check_name(rel).is_err() {
        return None;
    }
    if !matches!(installed(), Ok(Some(_))) {
        return None;
    }
    std::fs::read(installed_dir().join(rel)).ok()
}

/// Write a checked bundle into place.
///
/// The bundle is read and checked whole first, so a bad entry means nothing is
/// written at all. Then the old folder is replaced — not merged — so a file
/// dropped from the frontend does not linger and get served forever.
pub fn install(bytes: &[u8], daemon: &str) -> Result<WebVersion, String> {
    let files = unpack(bytes)?;
    let Some(raw) = files.get("version.json") else {
        return Err("that bundle has no version.json".into());
    };
    let version = parse_version(raw)?;
    if !daemon_is_new_enough(daemon, &version.needs_daemon) {
        return Err(format!(
            "that interface ({}) needs sessionhub {} or newer, and this is {daemon}. \
             Update sessionhub itself first.",
            version.version, version.needs_daemon
        ));
    }

    let dir = installed_dir();
    let staging = dir.with_extension("new");
    let _ = std::fs::remove_dir_all(&staging);
    for (name, data) in &files {
        let path = staging.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
        }
        std::fs::write(&path, data).map_err(|e| format!("could not write {path:?}: {e}"))?;
    }
    let old = dir.with_extension("old");
    let _ = std::fs::remove_dir_all(&old);
    if dir.exists() {
        std::fs::rename(&dir, &old).map_err(|e| format!("could not move the old interface: {e}"))?;
    }
    std::fs::rename(&staging, &dir).map_err(|e| format!("could not put the new interface in place: {e}"))?;
    let _ = std::fs::remove_dir_all(&old);
    Ok(version)
}

/// Undo an install: go back to whatever is baked into the binary.
pub fn remove_installed() -> Result<(), String> {
    let dir = installed_dir();
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("could not remove {dir:?}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> BTreeMap<String, Vec<u8>> {
        BTreeMap::from([
            ("index.html".to_string(), b"<!doctype html>".to_vec()),
            ("app.js".to_string(), b"export const x = 1;".to_vec()),
            ("version.json".to_string(), br#"{"version":"1.0.0","needs_daemon":"0.0.4"}"#.to_vec()),
        ])
    }

    #[test]
    fn a_bundle_survives_the_round_trip() {
        let back = unpack(&pack(&tree())).unwrap();
        assert_eq!(back, tree());
    }

    #[test]
    fn binary_content_survives_intact() {
        // Lengths are explicit precisely so content is never parsed.
        let mut files = BTreeMap::new();
        files.insert("odd.bin".to_string(), vec![0u8, 255, b'\n', 0, b'S', b'H', b'W', b'E', b'B']);
        let back = unpack(&pack(&files)).unwrap();
        assert_eq!(back["odd.bin"], files["odd.bin"]);
    }

    #[test]
    fn a_name_that_leaves_the_folder_is_refused() {
        // The reason this format is hand-written rather than a tarball.
        for bad in [
            "../evil.js",
            "..\\evil.js",
            "sub/../../evil.js",
            "/etc/passwd",
            "C:\\windows\\system32\\x.dll",
            "",
            "a/../b",
            ".",
            "..",
        ] {
            let mut files = BTreeMap::new();
            files.insert(bad.to_string(), b"x".to_vec());
            let packed = pack(&files);
            assert!(unpack(&packed).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn an_odd_character_in_a_name_is_refused_rather_than_cleaned_up() {
        for bad in ["we ird.js", "quote\".js", "star*.js", "nul\0.js", "semi;.js"] {
            let mut files = BTreeMap::new();
            files.insert(bad.to_string(), b"x".to_vec());
            assert!(unpack(&pack(&files)).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_truncated_bundle_is_an_error_not_a_panic() {
        let full = pack(&tree());
        for cut in [0, 3, 6, 7, 10, 20, full.len() - 1] {
            let _ = unpack(&full[..cut]);
        }
        assert!(unpack(b"not a bundle at all").is_err());
        assert!(unpack(b"").is_err());
        assert!(unpack(MAGIC).is_err(), "a bundle with no files is not useful");
    }

    #[test]
    fn version_json_must_say_both_things() {
        let v = parse_version(br#"{"version":"1.2.3","needs_daemon":"0.0.4"}"#).unwrap();
        assert_eq!(v.version, "1.2.3");
        assert_eq!(v.needs_daemon, "0.0.4");

        assert!(parse_version(br#"{"version":"1.2.3"}"#).is_err(), "no needs_daemon");
        assert!(parse_version(br#"{"needs_daemon":"0.0.4"}"#).is_err(), "no version");
        assert!(parse_version(br#"{"version":"","needs_daemon":"0.0.4"}"#).is_err(), "empty");
        assert!(parse_version(b"not json").is_err());
    }

    #[test]
    fn a_frontend_from_the_future_is_refused() {
        // The whole point of `needs_daemon`: an old daemon must say no, not serve
        // a page whose buttons quietly do nothing.
        assert!(daemon_is_new_enough("0.0.4", "0.0.4"), "exactly new enough counts");
        assert!(daemon_is_new_enough("0.0.5", "0.0.4"));
        assert!(daemon_is_new_enough("0.1.0", "0.0.9"));
        assert!(!daemon_is_new_enough("0.0.3", "0.0.4"));
        assert!(!daemon_is_new_enough("0.0.9", "0.1.0"));
        // Numeric, not textual: 0.0.10 is newer than 0.0.9.
        assert!(daemon_is_new_enough("0.0.10", "0.0.9"));
    }

    #[test]
    fn installing_a_frontend_this_daemon_cannot_serve_says_why() {
        let mut files = tree();
        files.insert(
            "version.json".to_string(),
            br#"{"version":"2.0.0","needs_daemon":"9.9.9"}"#.to_vec(),
        );
        let err = install(&pack(&files), "0.0.4").unwrap_err();
        assert!(err.contains("9.9.9"), "{err}");
        assert!(err.contains("Update sessionhub itself first"), "{err}");
    }

    #[test]
    fn a_bundle_without_a_version_is_refused() {
        let mut files = tree();
        files.remove("version.json");
        assert!(install(&pack(&files), "0.0.4").is_err());
    }
}
