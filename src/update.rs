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

/// What a frontend bundle is called in a release.
const WEB_SUFFIX: &str = ".shweb";

/// The version out of `sessionhubd-0.0.4-windows-x86_64.exe`.
///
/// This is what the panel compares against, rather than the release tag, and the
/// difference is the point of releasing the frontend separately. A release that
/// changes only `web/` still needs a tag of its own — tags are unique — but it
/// carries the same daemon binary. Comparing tags would then offer a binary swap
/// that changes nothing, charging a restart and every live terminal for a CSS
/// fix. Comparing the binary the release actually ships says the honest thing:
/// the daemon is current, the interface is not.
pub fn daemon_version_from_name(name: &str) -> Option<String> {
    let rest = name.strip_prefix("sessionhubd-")?;
    let v = rest.split('-').next()?;
    if !v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.') {
        Some(v.to_string())
    } else {
        None
    }
}

/// The version out of `sessionhub-web-1.2.3.shweb`, so the panel can say what a
/// release offers without downloading it first.
fn web_version_from_name(name: &str) -> Option<String> {
    let stem = name.strip_suffix(WEB_SUFFIX)?;
    let v = stem.rsplit(char::is_alphabetic).next()?.trim_start_matches(['-', '_']);
    let v = v.trim_start_matches(['-', '_']);
    if !v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.') {
        Some(v.to_string())
    } else {
        None
    }
}

/// Fetch and install a frontend bundle. No restart, no terminal dies — this is
/// the whole reason the frontend is released on its own.
pub fn apply_web(rel: &Release) -> Result<crate::webpack::WebVersion, String> {
    let url = rel
        .web_url
        .as_deref()
        .ok_or_else(|| format!("release {} carries no interface bundle", rel.tag))?;
    let bytes = curl(&["-sSL", "--max-time", "120", url])?;
    if bytes.len() < 10_000 {
        return Err(format!("the download is only {} bytes — that is not a frontend", bytes.len()));
    }
    let v = crate::webpack::install(&bytes, current())?;
    info!(version = %v.version, bytes = bytes.len(), "interface installed");
    Ok(v)
}

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
    /// The frontend bundle in that release, if it carries one.
    ///
    /// Most releases change `web/` and nothing else. Installing that costs no
    /// restart and kills no terminal, so it is worth telling apart from the
    /// binary rather than folding both into one button.
    pub web_url: Option<String>,
    pub web_name: Option<String>,
    /// The frontend version that bundle declares, read from its name.
    pub web_version: Option<String>,
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
    // The frontend bundle is named `sessionhub-web-<version>.shweb`, so the
    // version can be read without downloading it first.
    let mut web_url = None;
    let mut web_name = None;
    let mut web_version = None;
    if let Some(list) = json.get("assets").and_then(|v| v.as_array()) {
        for a in list {
            let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.ends_with(WEB_SUFFIX) {
                web_url =
                    a.get("browser_download_url").and_then(|v| v.as_str()).map(|s| s.to_string());
                web_version = web_version_from_name(name);
                web_name = Some(name.to_string());
                break;
            }
        }
    }

    // The daemon version offered is the one in the binary's own name, falling
    // back to the tag when there is no build for this machine to read it from.
    let version = asset_name
        .as_deref()
        .and_then(daemon_version_from_name)
        .unwrap_or_else(|| tag.trim_start_matches(['v', 'V']).to_string());
    Ok(Release { tag, version, asset_url, asset_name, notes, web_url, web_name, web_version })
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

    write_and_launch_swapper(&exe, &staged, &rel.tag)?;
    Ok(())
}

/// Say so if the last swap did not take, then clear the note.
///
/// The swapper cannot log — the daemon that owns the log is gone by the time it
/// runs — so it leaves a line in a file next to the binary and this reads it on
/// the way up. Without this the only evidence is a version number that did not
/// move, which reads as "the update button does nothing".
pub fn report_failed_swap() {
    let Ok(exe) = std::env::current_exe() else { return };
    let Some(dir) = exe.parent() else { return };
    let report = dir.join("sessionhub-swap.log");
    let Ok(said) = std::fs::read_to_string(&report) else { return };
    // Windows PowerShell's `-Encoding utf8` writes a byte order mark, and it
    // would otherwise be the first thing in the log line.
    let said = said.trim_start_matches('\u{feff}');
    warn!(
        detail = said.trim(),
        path = %report.display(),
        "the last update did not replace the binary — still running {}",
        current()
    );
    let _ = std::fs::remove_file(&report);
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
fn write_and_launch_swapper(exe: &Path, staged: &Path, tag: &str) -> Result<(), String> {
    let home = crate::config::home();
    let pid = std::process::id();
    let backup = exe.with_extension(if cfg!(windows) { "old.exe" } else { "old" });
    let dir = exe.parent().ok_or("no folder")?;

    if cfg!(windows) {
        let script = dir.join("sessionhub-swap.ps1");
        let report = dir.join("sessionhub-swap.log");
        // Windows locks the image of a running executable, and the daemon is not
        // the only process running this one: `ensure_tray` starts `sessionhubd
        // tray` as a second process from the same file. Waiting for the daemon's
        // pid alone left the tray holding the image, `Move-Item` failed, and —
        // because the old exe was still sitting there — the guard below saw a
        // file and called it success. The old binary was started again and
        // nothing anywhere said a word. Three updates in a row went that way.
        //
        // So: wait for the daemon, then end anything still running this exe (the
        // tray is meant to go with the daemon; `start` brings a fresh one back),
        // and retry the move — a virus scanner reading a freshly downloaded
        // binary holds it for a moment too. Then CHECK, and if it still did not
        // work, leave a file saying so rather than pretending.
        let text = windows_swap_script(WindowsSwap {
            pid,
            exe: &exe.display().to_string(),
            staged: &staged.display().to_string(),
            backup: &backup.display().to_string(),
            report: &report.display().to_string(),
            tag,
            home: &home.display().to_string(),
        });
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

/// What the Windows handoff script needs to know.
pub struct WindowsSwap<'a> {
    pub pid: u32,
    pub exe: &'a str,
    pub staged: &'a str,
    pub backup: &'a str,
    pub report: &'a str,
    pub tag: &'a str,
    pub home: &'a str,
}

/// The handoff script, as text — kept apart from writing and running it so the
/// thing that has gone wrong twice can be read, and tested, on its own.
pub fn windows_swap_script(s: WindowsSwap<'_>) -> String {
    let WindowsSwap { pid, exe, staged, backup, report, tag, home } = s;
    format!(
            "$ErrorActionPreference = 'SilentlyContinue'\r\n\
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
             $swapped = $false\r\n\
             $why = 'never tried'\r\n\
             for ($try = 0; $try -lt 20; $try++) {{\r\n\
             \x20 # Anything else running either name. The tray is a second\r\n\
             \x20 # process on the same image, and after a previous update a\r\n\
             \x20 # surviving one is running from the BACKUP name — renamed out\r\n\
             \x20 # from under it. That one keeps the backup locked forever, and\r\n\
             \x20 # a locked backup is what stops the next update dead.\r\n\
             \x20 Get-Process -ErrorAction SilentlyContinue |\r\n\
             \x20   Where-Object {{ $_.Path -eq '{exe}' -or $_.Path -eq '{backup}' }} |\r\n\
             \x20   Stop-Process -Force -ErrorAction SilentlyContinue\r\n\
             \x20 Start-Sleep -Milliseconds 300\r\n\
             \x20 Remove-Item -LiteralPath '{backup}' -Force -ErrorAction SilentlyContinue\r\n\
             \x20 if (Test-Path -LiteralPath '{backup}') {{\r\n\
             \x20   # Still there, so something still holds it. A rename always\r\n\
             \x20   # works even on a running image, so move it out of the way\r\n\
             \x20   # instead of insisting on the name.\r\n\
             \x20   $aside = '{backup}' + '.' + [DateTime]::UtcNow.Ticks\r\n\
             \x20   Move-Item -LiteralPath '{backup}' -Destination $aside -Force -ErrorAction SilentlyContinue\r\n\
             \x20 }}\r\n\
             \x20 Move-Item -LiteralPath '{exe}' -Destination '{backup}' -Force -ErrorAction SilentlyContinue\r\n\
             \x20 if (-not (Test-Path -LiteralPath '{exe}')) {{\r\n\
             \x20   Move-Item -LiteralPath '{staged}' -Destination '{exe}' -Force -ErrorAction SilentlyContinue\r\n\
             \x20   if (Test-Path -LiteralPath '{exe}') {{ $swapped = $true; break }}\r\n\
             \x20   # The new one would not go in. Put the old one back.\r\n\
             \x20   Move-Item -LiteralPath '{backup}' -Destination '{exe}' -Force -ErrorAction SilentlyContinue\r\n\
             \x20   $why = 'the new binary could not be moved into place'\r\n\
             \x20 }} else {{\r\n\
             \x20   $why = 'the old binary could not be moved aside - something is running it'\r\n\
             \x20 }}\r\n\
             \x20 Start-Sleep -Milliseconds 500\r\n\
             }}\r\n\
             if (-not $swapped) {{\r\n\
             \x20 # Loud, on disk, beside the binary: the daemon reads this on its\r\n\
             \x20 # next start and puts it in the log. A silent failure here looks\r\n\
             \x20 # exactly like a successful update that did nothing.\r\n\
             \x20 $when = Get-Date -Format o\r\n\
             \x20 $note = \"$when update to {tag} did not go in: $why\"\r\n\
             \x20 Set-Content -LiteralPath '{report}' -Value $note -Encoding utf8\r\n\
             }}\r\n\
             Start-Process -FilePath '{exe}' -ArgumentList 'start','--home','{home}' -WindowStyle Hidden\r\n\
             Remove-Item -LiteralPath $PSCommandPath -Force\r\n",
    )
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
    fn a_release_that_only_changes_the_interface_does_not_offer_a_binary_swap() {
        // The case the whole split exists for. Tags must be unique, so a
        // frontend-only release still gets a new tag — but it ships the same
        // daemon binary. Comparing tags would charge a restart and every live
        // terminal for a CSS fix.
        let body = br#"{
            "tag_name": "v0.0.4-web2",
            "assets": [
              {"name":"sessionhubd-0.0.4-windows-x86_64.exe","browser_download_url":"https://x/bin"},
              {"name":"sessionhub-web-1.0.1.shweb","browser_download_url":"https://x/web"}
            ]
        }"#;
        let r = parse_release(body, "windows-x86_64.exe").unwrap();
        assert_eq!(r.tag, "v0.0.4-web2");
        assert_eq!(r.version, "0.0.4", "the daemon offered is the one in the binary name");
        assert!(!is_newer(&r.version, "0.0.4"), "so a 0.0.4 daemon is told it is current");
        assert_eq!(r.web_version.as_deref(), Some("1.0.1"), "while the interface is newer");
    }

    #[test]
    fn the_daemon_version_is_read_out_of_the_binary_name() {
        assert_eq!(
            daemon_version_from_name("sessionhubd-0.0.4-windows-x86_64.exe").as_deref(),
            Some("0.0.4")
        );
        assert_eq!(daemon_version_from_name("sessionhubd-1.10.2-macos-arm64").as_deref(), Some("1.10.2"));
        // Anything not shaped that way falls back to the tag rather than
        // inventing a version.
        assert_eq!(daemon_version_from_name("sessionhubd-nightly-macos-arm64"), None);
        assert_eq!(daemon_version_from_name("something-else"), None);
    }

    #[test]
    fn without_a_build_for_us_the_tag_still_names_the_release() {
        let body = br#"{"tag_name":"v0.9.0","assets":[
            {"name":"sessionhubd-0.9.0-linux-arm64","browser_download_url":"https://x/bin"}]}"#;
        let r = parse_release(body, "windows-x86_64.exe").unwrap();
        assert!(r.asset_url.is_none());
        assert_eq!(r.version, "0.9.0", "read from the tag when no asset can supply it");
    }

    #[test]
    fn the_interface_bundle_is_picked_out_alongside_the_binary() {
        // A release carries both. They are told apart because installing one
        // costs a restart and the other costs nothing, and the panel has to be
        // able to offer only the cheap one.
        let body = br#"{
            "tag_name": "v0.0.5",
            "body": "notes",
            "assets": [
              {"name":"sessionhubd-0.0.5-windows-x86_64.exe","browser_download_url":"https://x/bin"},
              {"name":"sessionhub-web-1.2.0.shweb","browser_download_url":"https://x/web"}
            ]
        }"#;
        let r = parse_release(body, "windows-x86_64.exe").unwrap();
        assert_eq!(r.asset_url.as_deref(), Some("https://x/bin"));
        assert_eq!(r.web_url.as_deref(), Some("https://x/web"));
        assert_eq!(r.web_version.as_deref(), Some("1.2.0"));
    }

    #[test]
    fn a_release_with_no_interface_bundle_offers_none() {
        // Every release before this feature looks like this, and the panel must
        // not invent a frontend update out of it.
        let body = br#"{"tag_name":"v0.0.3","assets":[
            {"name":"sessionhubd-0.0.3-macos-arm64","browser_download_url":"https://x/bin"}]}"#;
        let r = parse_release(body, "macos-arm64").unwrap();
        assert!(r.web_url.is_none());
        assert!(r.web_version.is_none());
    }

    #[test]
    fn the_interface_version_is_read_out_of_its_name() {
        assert_eq!(web_version_from_name("sessionhub-web-1.0.0.shweb").as_deref(), Some("1.0.0"));
        assert_eq!(web_version_from_name("sessionhub-web-10.2.30.shweb").as_deref(), Some("10.2.30"));
        // Anything that does not carry a plain version is left unnamed rather
        // than guessed at — the panel then says a bundle exists without lying
        // about which one.
        assert_eq!(web_version_from_name("sessionhub-web.shweb"), None);
        assert_eq!(web_version_from_name("something-else.zip"), None);
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

#[cfg(test)]
mod swap_tests {
    use super::*;

    fn script() -> String {
        windows_swap_script(WindowsSwap {
            pid: 4242,
            exe: r"C:\app\sessionhubd.exe",
            staged: r"C:\app\sessionhubd-new.exe",
            backup: r"C:\app\sessionhubd.old.exe",
            report: r"C:\app\sessionhub-swap.log",
            tag: "v0.0.19",
            home: r"C:\Users\x",
        })
    }

    #[test]
    fn it_waits_for_the_daemon_before_touching_anything() {
        let s = script();
        let wait = s.find("Get-Process -Id 4242").expect("no wait for the daemon");
        let move_ = s.find("Move-Item").expect("no move at all");
        assert!(wait < move_, "the swap must not start before the daemon is gone");
    }

    #[test]
    fn it_ends_whatever_else_is_running_that_same_binary() {
        // The bug this exists for: the tray is a second process on the same
        // image, and Windows will not move a file that is running.
        let s = script();
        assert!(s.contains(r"$_.Path -eq 'C:\app\sessionhubd.exe'"), "{s}");
        assert!(s.contains("Stop-Process -Force"), "nothing ends the holder");
    }

    #[test]
    fn it_checks_the_swap_and_leaves_a_note_when_it_fails() {
        let s = script();
        assert!(s.contains("$swapped = $true"), "success is never recorded");
        assert!(s.contains("if (-not $swapped)"), "failure is never noticed");
        assert!(s.contains(r"C:\app\sessionhub-swap.log"), "failure is never written down");
        assert!(s.contains("v0.0.19"), "the note does not say which version");
    }

    #[test]
    fn it_puts_the_old_binary_back_when_the_new_one_will_not_go_in() {
        let s = script();
        let restore = format!(
            "Move-Item -LiteralPath '{}' -Destination '{}'",
            r"C:\app\sessionhubd.old.exe", r"C:\app\sessionhubd.exe"
        );
        assert!(s.contains(&restore), "there is no way back");
    }

    #[test]
    fn it_always_starts_something_again() {
        let s = script();
        assert!(s.contains(r"Start-Process -FilePath 'C:\app\sessionhubd.exe'"));
        assert!(s.contains(r"'start','--home','C:\Users\x'"));
    }
}

#[cfg(test)]
mod swap_dump {
    use super::*;
    /// Not an assertion: writes the real script where a live test can run it,
    /// so what is exercised is the text this code actually produces.
    #[test]
    #[ignore]
    fn dump() {
        let dir = std::env::var("SWAP_DIR").expect("SWAP_DIR");
        let pid: u32 = std::env::var("SWAP_PID").unwrap().parse().unwrap();
        let text = windows_swap_script(WindowsSwap {
            pid,
            exe: &format!(r"{dir}\sessionhubd.exe"),
            staged: &format!(r"{dir}\sessionhubd-new.exe"),
            backup: &format!(r"{dir}\sessionhubd.old.exe"),
            report: &format!(r"{dir}\sessionhub-swap.log"),
            tag: "v0.0.19",
            home: &format!(r"{dir}\home"),
        });
        std::fs::write(format!(r"{dir}\swap.ps1"), text).unwrap();
    }
}
