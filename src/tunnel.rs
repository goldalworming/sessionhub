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
