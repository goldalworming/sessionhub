//! Updating the daemon in place, from its GitHub releases.
//!
//! Two halves, and the second one is the delicate part:
//!
//! **Checking** asks the releases API for the newest tag and looks for the asset
//! built for this platform. HTTPS is done by shelling out to `curl` — the same
//! choice `tunnel.rs` makes for `cloudflared`. Both platforms ship it (Windows
//! since 1803, macOS always), and the alternative is a TLS stack pulled in for
//! one request a day.
//!
//! **Applying** cannot simply overwrite the file: on Windows a running `.exe` is
//! locked, and on unix writing a busy executable gives `ETXTBSY`. So the new
//! binary is downloaded to a temporary file and a small handoff script is left
//! to do the swap after this process is gone — wait for the pid to exit, move
//! the old binary aside, put the new one in its place, start it again. The old
//! binary is kept next to the new one until the next update, so a swap that
//! produces something that will not run can be undone by hand.
//!
//! What this costs the user is stated plainly in the UI rather than hidden: the
//! daemon restarts, and every live terminal is a child of it.

use std::path::{Path, PathBuf};
use std::process::Command;

use tracing::{info, warn};

const REPO: &str = "goldalworming/sessionhub";

/// What a release offers this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    /// The tag as published, e.g. `v0.0.2`.
    pub tag: String,
    /// Version numbers only, for comparing.
    pub version: String,
    /// Direct download for the asset built for this platform, if there is one.
    pub asset_url: Option<String>,
    pub asset_name: Option<String>,
    pub notes: String,
}

/// The version this binary was built as.
pub fn current() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The tail of the asset name built for the machine we are running on.
///
/// Matched as a suffix, not by full name: the version is part of the file name,
/// so an exact match would have to know the answer before asking the question.
pub fn asset_suffix() -> &'static str {
    if cfg!(windows) {
        "windows-x86_64.exe"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "macos-arm64"
        } else {
            "macos-x86_64"
        }
    } else if cfg!(target_arch = "aarch64") {
        "linux-arm64"
    } else {
        "linux-x86_64"
    }
}

/// `v1.2.3` and `1.2.3` are the same version; anything unparsable sorts as 0.
fn parts(v: &str) -> Vec<u64> {
    v.trim().trim_start_matches(['v', 'V']).split('.').map(|p| {
        p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0)
    }).collect()
}

/// Is `latest` newer than `have`?
///
/// Compared number by number rather than as text, or "0.0.10" would look older
/// than "0.0.9". A missing component counts as 0, so 1.2 and 1.2.0 are equal.
pub fn is_newer(latest: &str, have: &str) -> bool {
    let (a, b) = (parts(latest), parts(have));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// Pull the release out of the API's answer.
///
/// Kept apart from the network call so it can be tested against a recorded
/// body — the parsing is where the mistakes live, not the fetching.
pub fn parse_release(body: &[u8], suffix: &str) -> Result<Release, String> {
    let json: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "GitHub did not answer with JSON.".to_string())?;
    // GitHub answers a refusal with 200-shaped JSON carrying `message`, so a
    // missing tag usually means "it said no", not "the release is malformed".
    // Reporting it as a bad release sends you looking at the release page, where
    // everything is fine. The most common one by far is the anonymous rate
    // limit — 60 requests an hour per address, shared by everyone behind the
    // same router.
    let tag = match json.get("tag_name").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => {
            let said = json.get("message").and_then(|v| v.as_str()).unwrap_or("");
            return Err(if said.contains("rate limit") {
                "GitHub is rate-limiting this network right now. It allows 60 checks an \
                 hour per address; try again in a few minutes."
                    .to_string()
            } else if said.is_empty() {
                "GitHub's answer had no release in it.".to_string()
            } else {
                format!("GitHub said: {said}")
            });
        }
    };
    let notes = json.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let mut asset_url = None;
    let mut asset_name = None;
    if let Some(list) = json.get("assets").and_then(|v| v.as_array()) {
        for a in list {
            let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.ends_with(suffix) {
                asset_url = a
                    .get("browser_download_url")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                asset_name = Some(name.to_string());
                break;
            }
        }
    }
    let version = tag.trim_start_matches(['v', 'V']).to_string();
    Ok(Release { tag, version, asset_url, asset_name, notes })
}

/// The newest release, or why we could not find out.
pub fn check() -> Result<Release, String> {
    let out = curl(&[
        "-sS",
        "--max-time",
        "20",
        "-H",
        "User-Agent: sessionhubd",
        "-H",
        "Accept: application/vnd.github+json",
        &format!("https://api.github.com/repos/{REPO}/releases/latest"),
    ])?;
    parse_release(&out, asset_suffix())
}

/// Download the release and leave a script to swap it in once we are gone.
///
/// Returns having started nothing but that script: the caller is expected to
/// shut the daemon down straight afterwards, which is what lets the swap
/// happen at all.
pub fn apply(rel: &Release) -> Result<(), String> {
    let url = rel
        .asset_url
        .as_deref()
        .ok_or_else(|| format!("release {} has no build for this machine", rel.tag))?;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("the running binary has no folder")?.to_path_buf();
    let staged = dir.join(format!("sessionhubd-new{}", ext()));

    // Downloaded beside the binary rather than into the temp folder: they are
    // then certain to be on the same volume, and the swap is a rename instead
    // of a copy that could fail halfway.
    let _ = std::fs::remove_file(&staged);
    curl(&[
        "-sSL",
        "--max-time",
        "600",
        "-o",
        &staged.to_string_lossy(),
        url,
    ])?;

    let size = std::fs::metadata(&staged).map(|m| m.len()).unwrap_or(0);
    // A few hundred kB would mean an error page saved under a binary's name.
    if size < 1_000_000 {
        let _ = std::fs::remove_file(&staged);
        return Err(format!("the download is only {size} bytes — it is not a binary"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755));
    }
    info!(bytes = size, tag = %rel.tag, "update downloaded");

    write_and_launch_swapper(&exe, &staged)?;
    Ok(())
}

fn ext() -> &'static str {
    if cfg!(windows) {
        ".exe"
    } else {
        ""
    }
}

fn curl(args: &[&str]) -> Result<Vec<u8>, String> {
    let out = crate::pty::quiet_command(curl_path())
        .args(args)
        .output()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr);
        return Err(format!("download failed: {}", why.trim()));
    }
    Ok(out.stdout)
}

/// The system's own curl, by absolute path on Windows.
///
/// `curl` on PATH there is often an alias for PowerShell's `Invoke-WebRequest`,
/// which takes different arguments entirely.
fn curl_path() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(r"C:\Windows\System32\curl.exe")
    } else {
        PathBuf::from("curl")
    }
}

/// Write the handoff script and start it detached.
fn write_and_launch_swapper(exe: &Path, staged: &Path) -> Result<(), String> {
    let home = crate::config::home();
    let pid = std::process::id();
    let backup = exe.with_extension(if cfg!(windows) { "old.exe" } else { "old" });
    let dir = exe.parent().ok_or("no folder")?;

    if cfg!(windows) {
        let script = dir.join("sessionhub-swap.ps1");
        let text = format!(
            "$ErrorActionPreference = 'SilentlyContinue'\r\n\
             # Wait for the daemon to let go of its own image; a running exe is locked.\r\n\
             for ($i = 0; $i -lt 120; $i++) {{\r\n\
             \x20 if (-not (Get-Process -Id {pid} -ErrorAction SilentlyContinue)) {{ break }}\r\n\
             \x20 Start-Sleep -Milliseconds 500\r\n\
             }}\r\n\
             if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{\r\n\
             \x20 # Still there after a minute. Swapping now would put a new binary\r\n\
             \x20 # under a daemon that still holds the port, and the replacement\r\n\
             \x20 # cannot bind it. Leave everything exactly as it was.\r\n\
             \x20 Remove-Item -LiteralPath $PSCommandPath -Force\r\n\
             \x20 exit 1\r\n\
             }}\r\n\
             Remove-Item -LiteralPath '{backup}' -Force\r\n\
             Move-Item -LiteralPath '{exe}' -Destination '{backup}' -Force\r\n\
             Move-Item -LiteralPath '{staged}' -Destination '{exe}' -Force\r\n\
             if (-not (Test-Path -LiteralPath '{exe}')) {{\r\n\
             \x20 # The swap failed: put back what was working.\r\n\
             \x20 Move-Item -LiteralPath '{backup}' -Destination '{exe}' -Force\r\n\
             }}\r\n\
             Start-Process -FilePath '{exe}' -ArgumentList 'start','--home','{home}' -WindowStyle Hidden\r\n\
             Remove-Item -LiteralPath $PSCommandPath -Force\r\n",
            pid = pid,
            exe = exe.display(),
            staged = staged.display(),
            backup = backup.display(),
            home = home.display(),
        );
        std::fs::write(&script, text).map_err(|e| format!("cannot write the updater: {e}"))?;
        crate::pty::quiet_command("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .spawn()
            .map_err(|e| format!("cannot start the updater: {e}"))?;
    } else {
        let script = dir.join("sessionhub-swap.sh");
        let text = format!(
            "#!/bin/sh\n\
             # Wait for the daemon to exit, then put the new binary in its place.\n\
             i=0\n\
             while kill -0 {pid} 2>/dev/null && [ $i -lt 120 ]; do sleep 0.5; i=$((i+1)); done\n\
             # Still there? Swapping under a running daemon leaves a binary that\n\
             # cannot take the port. Leave everything as it was.\n\
             if kill -0 {pid} 2>/dev/null; then rm -f \"$0\"; exit 1; fi\n\
             rm -f '{backup}'\n\
             mv '{exe}' '{backup}' 2>/dev/null\n\
             mv '{staged}' '{exe}' || mv '{backup}' '{exe}'\n\
             chmod +x '{exe}'\n\
             '{exe}' start --home '{home}'\n\
             rm -f \"$0\"\n",
            pid = pid,
            exe = exe.display(),
            staged = staged.display(),
            backup = backup.display(),
            home = home.display(),
        );
        std::fs::write(&script, text).map_err(|e| format!("cannot write the updater: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
        }
        Command::new("/bin/sh")
            .arg(&script)
            .spawn()
            .map_err(|e| format!("cannot start the updater: {e}"))?;
    }
    warn!("update staged; the daemon is about to restart into it");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_numbers_not_as_text() {
        assert!(is_newer("0.0.10", "0.0.9"), "text comparison would call this older");
        assert!(is_newer("v0.1.0", "0.0.9"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.0.1", "0.0.1"));
        assert!(!is_newer("0.0.1", "0.0.2"));
        // A leading v on either side changes nothing, and 1.2 == 1.2.0.
        assert!(!is_newer("v1.2", "1.2.0"));
        assert!(!is_newer("nonsense", "0.0.1"));
    }

    #[test]
    fn the_asset_for_this_machine_is_picked_out_of_the_release() {
        let body = br#"{
            "tag_name": "v0.0.2",
            "body": "notes here",
            "assets": [
                {"name": "sessionhubd-0.0.2-macos-arm64",
                 "browser_download_url": "https://example.invalid/mac"},
                {"name": "sessionhubd-0.0.2-windows-x86_64.exe",
                 "browser_download_url": "https://example.invalid/win"}
            ]
        }"#;
        let win = parse_release(body, "windows-x86_64.exe").unwrap();
        assert_eq!(win.tag, "v0.0.2");
        assert_eq!(win.version, "0.0.2");
        assert_eq!(win.asset_url.as_deref(), Some("https://example.invalid/win"));
        assert_eq!(win.notes, "notes here");

        let mac = parse_release(body, "macos-arm64").unwrap();
        assert_eq!(mac.asset_url.as_deref(), Some("https://example.invalid/mac"));
    }

    #[test]
    fn a_release_without_a_build_for_us_says_so_rather_than_guessing() {
        // Offering the wrong architecture would install something that cannot
        // run, and the daemon would be gone with no way back through the UI.
        let body = br#"{"tag_name":"v0.0.2","assets":[
            {"name":"sessionhubd-0.0.2-macos-arm64","browser_download_url":"https://example.invalid/mac"}]}"#;
        let got = parse_release(body, "linux-x86_64").unwrap();
        assert_eq!(got.tag, "v0.0.2");
        assert!(got.asset_url.is_none());
    }

    #[test]
    fn rubbish_from_the_network_is_an_error_not_a_panic() {
        assert!(parse_release(b"<html>404</html>", "windows-x86_64.exe").is_err());
        assert!(parse_release(b"{}", "windows-x86_64.exe").is_err());
    }

    #[test]
    fn a_refusal_from_github_is_reported_as_a_refusal() {
        // The real body GitHub sends once the anonymous limit is used up. This
        // was reported as "that release has no tag", which sends you to look at
        // a release page where nothing is wrong. Hit during the 0.0.2 release
        // itself, because publishing it spent the hour's requests.
        // One line on purpose: a literal newline inside a JSON string is not
        // valid JSON, and a prettier fixture would fail in the parser instead of
        // in the branch under test.
        let limited = br#"{"message":"API rate limit exceeded for 203.0.113.7. (But here's the good news: Authenticated requests get a higher rate limit.)","documentation_url":"https://docs.github.com/rest"}"#;
        let err = parse_release(limited, "windows-x86_64.exe").unwrap_err();
        assert!(err.contains("rate-limiting"), "{err}");
        assert!(err.contains("60"), "harus menyebut batasnya: {err}");

        // Any other refusal is quoted rather than guessed at.
        let gone = br#"{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}"#;
        let err = parse_release(gone, "windows-x86_64.exe").unwrap_err();
        assert!(err.contains("Not Found"), "{err}");

        // And a body with neither a tag nor a message still says something
        // truthful rather than blaming the release.
        let empty = parse_release(b"{}", "windows-x86_64.exe").unwrap_err();
        assert!(empty.contains("no release in it"), "{empty}");
    }
}
