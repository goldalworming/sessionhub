//! `sessionhubd tunnel` — run cloudflared as a child and print its public URL
//! together with the token.
//!
//! The daemon deliberately binds 127.0.0.1 only. A tunnel like this is the one
//! way in from outside, and it is a deliberate choice by the user — never
//! something that turns itself on.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;

/// Pull the tunnel URL out of one line of cloudflared output.
///
/// The line is wrapped in an ASCII box and ends with spaces then `|`, so the
/// URL is cut at a space as well as at the box edge.
///
pub fn extract_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['.', ',']).to_string();
    // One-off tunnels always live on this domain; other URLs in the log
    // (documentation, version notices) must not be read as a tunnel address.
    if url.contains(".trycloudflare.com") || url.contains(".cfargotunnel.com") {
        Some(url)
    } else {
        None
    }
}

pub fn install_hint() -> String {
    if cfg!(windows) {
        "cloudflared not found on PATH.\n  \
         Install it with one of:\n    \
         winget install --id Cloudflare.cloudflared\n    \
         scoop install cloudflared\n  \
         Or download it directly: https://github.com/cloudflare/cloudflared/releases/latest"
            .to_string()
    } else {
        "cloudflared not found on PATH.\n  \
         Install it with one of:\n    \
         brew install cloudflared\n    \
         https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
            .to_string()
    }
}

pub struct Tunnel {
    child: Child,
    pub lines: mpsc::Receiver<String>,
}

impl Tunnel {
    /// Run `cloudflared tunnel --url http://127.0.0.1:<port>` and stream its
    /// output. cloudflared writes to stderr, but both are read so a change in
    /// its behaviour cannot leave us mute.
    pub fn spawn(exe: &std::path::Path, port: u16) -> std::io::Result<Tunnel> {
        let mut child = Command::new(exe)
            .args(["tunnel", "--url", &format!("http://127.0.0.1:{port}")])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let (tx, lines) = mpsc::channel();
        for stream in [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let tx = tx.clone();
            thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    if tx.send(line).is_err() {
                        return;
                    }
                }
            });
        }
        Ok(Tunnel { child, lines })
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    pub fn try_wait(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }
}

/// Throwaway tunnels, one per forwarded address, for when there is no API token
/// to arrange a hostname of your own with.
///
/// What they cost is a name that changes: cloudflared invents a new one every
/// time it starts, so a link saved yesterday is a link to nothing. What they
/// save is an account, a credential and a DNS record.
pub mod quick {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use tracing::{info, warn};

    static QUICK: Mutex<Option<HashMap<String, Running>>> = Mutex::new(None);

    struct Running {
        tunnel: super::Tunnel,
        url: String,
    }

    /// Start one and wait for cloudflared to say where it landed.
    ///
    /// Waiting is the point: the address is the whole answer, and returning
    /// before it exists would leave the panel showing a row with nothing in it.
    pub fn start(name: &str, local: u16) -> Result<String, String> {
        let Some(exe) = crate::pty::resolve_command("cloudflared") else {
            return Err(super::install_hint());
        };
        stop(name);

        let mut tunnel = super::Tunnel::spawn(&exe, local)
            .map_err(|e| format!("could not run cloudflared: {e}"))?;

        let deadline = Instant::now() + Duration::from_secs(45);
        let mut url = String::new();
        while Instant::now() < deadline {
            match tunnel.lines.recv_timeout(Duration::from_millis(500)) {
                Ok(line) => {
                    if let Some(found) = super::extract_url(&line) {
                        url = found;
                        break;
                    }
                }
                Err(_) if tunnel.try_wait() => break,
                Err(_) => continue,
            }
        }
        if url.is_empty() {
            tunnel.kill();
            return Err("cloudflared did not give an address. Is this machine online?".into());
        }

        info!(%name, %url, "a throwaway tunnel is up");
        if let Ok(mut slot) = QUICK.lock() {
            slot.get_or_insert_with(HashMap::new)
                .insert(name.to_string(), Running { tunnel, url: url.clone() });
        } else {
            warn!("quick tunnel registry is poisoned");
        }
        Ok(url)
    }

    pub fn stop(name: &str) {
        let Ok(mut slot) = QUICK.lock() else { return };
        let Some(map) = slot.as_mut() else { return };
        if let Some(mut gone) = map.remove(name) {
            gone.tunnel.kill();
            info!(%name, "throwaway tunnel ended");
        }
    }

    /// Where one landed, if it is still up.
    pub fn url(name: &str) -> Option<String> {
        let slot = QUICK.lock().ok()?;
        slot.as_ref()?.get(name).map(|r| r.url.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_url_inside_the_ascii_box() {
        // The real shape of cloudflared output.
        let line = "2026-08-14T03:00:00Z INF |  https://calm-river-1234.trycloudflare.com   \
                    |";
        assert_eq!(
            extract_url(line).as_deref(),
            Some("https://calm-river-1234.trycloudflare.com")
        );
    }

    #[test]
    fn finds_bare_url() {
        assert_eq!(
            extract_url("https://a-b-c.trycloudflare.com").as_deref(),
            Some("https://a-b-c.trycloudflare.com")
        );
    }

    #[test]
    fn ignores_unrelated_links_in_the_log() {
        assert_eq!(extract_url("INF See https://developers.cloudflare.com/docs"), None);
        assert_eq!(extract_url("INF Version 2026.1.0 https://github.com/cloudflare/cloudflared"), None);
    }

    #[test]
    fn ignores_lines_without_any_url() {
        assert_eq!(extract_url("INF Starting tunnel"), None);
        assert_eq!(extract_url(""), None);
    }

    #[test]
    fn trims_trailing_punctuation() {
        assert_eq!(
            extract_url("Visit https://x-y-z.trycloudflare.com.").as_deref(),
            Some("https://x-y-z.trycloudflare.com")
        );
    }

    #[test]
    fn accepts_named_tunnel_hostnames() {
        assert_eq!(
            extract_url("INF |  https://abc123.cfargotunnel.com  |").as_deref(),
            Some("https://abc123.cfargotunnel.com")
        );
    }

    #[test]
    fn install_hint_names_a_concrete_command() {
        let h = install_hint();
        assert!(h.contains("cloudflared not found"));
        assert!(h.contains("install"), "must give a command, not just a complaint");
    }
}
