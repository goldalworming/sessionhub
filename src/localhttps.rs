//! This machine's own tunnel hostname, opened on this machine without the round
//! trip through Cloudflare.
//!
//! `https://sbox.example.com` from the computer the daemon runs on goes out to
//! Cloudflare and back down the tunnel: every keystroke crosses the internet
//! twice to reach a process on the same desk. Here the name is pointed at
//! 127.0.0.1 in the hosts file, a certificate made on the spot is added to the
//! ones Windows trusts, and port 443 on loopback ends TLS and hands the bytes to
//! the daemon's own port. Still https — the clipboard and everything else that
//! needs a secure page keep working — and the address is the one already
//! bookmarked, on every device.
//!
//! The hosts file and the trusted roots belong to the whole machine, so those
//! two steps run elevated, behind one UAC prompt on this machine's screen.
//!
//! ponytail: Windows only. macOS would be `security add-trusted-cert` and
//! `/etc/hosts` behind `osascript … with administrator privileges`; add it when
//! a Mac needs it and someone can be at it to test the prompt.

use std::path::PathBuf;

/// Written beside each hosts line this adds, and how undoing finds them.
const MARK: &str = "# sessionhub local-https";

#[derive(Debug, Clone, serde::Serialize)]
pub struct Info {
    /// The name in question: `sbox.example.com`.
    pub host: String,
    /// Set up here: the name points at this machine and the certificate exists.
    pub on: bool,
    /// Port 443 is actually answering. `on` without it means something else
    /// holds the port.
    pub serving: bool,
}

pub fn supported() -> bool {
    cfg!(windows)
}

fn dir() -> PathBuf {
    crate::config::dir().join("local-https")
}

fn hosts_path() -> PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    PathBuf::from(root).join(r"System32\drivers\etc\hosts")
}

/// Whether the hosts file sends `host` to 127.0.0.1.
fn points_here(hosts: &str, host: &str) -> bool {
    hosts.lines().any(|line| {
        let line = line.split('#').next().unwrap_or("");
        let mut words = line.split_whitespace();
        words.next() == Some("127.0.0.1") && words.any(|w| w.eq_ignore_ascii_case(host))
    })
}

/// The name it was set up for, when it was.
fn saved_host() -> Option<String> {
    let h = std::fs::read_to_string(dir().join("host")).ok()?;
    let h = h.trim();
    (!h.is_empty()).then(|| h.to_string())
}

/// What the panel is told. `public` is this machine's tunnel hostname, when it
/// has one; once set up, the name it was set up for wins.
pub fn info(public: Option<String>) -> Option<Info> {
    if !supported() {
        return None;
    }
    let host = saved_host().or(public)?;
    let hosts = std::fs::read_to_string(hosts_path()).unwrap_or_default();
    let on = points_here(&hosts, &host) && saved_host().as_deref() == Some(host.as_str()) && cert_ready();
    Some(Info { host, on, serving: imp::serving() })
}

fn cert_ready() -> bool {
    dir().join("cert.der").is_file() && dir().join("key.der").is_file()
}

/// At start-up: serve again what was set up before. Nothing is asked of
/// anyone here — no prompt, no network.
pub fn resume(port: u16) {
    if let Some(i) = info(None) {
        if i.on {
            if let Err(e) = imp::start(port) {
                tracing::warn!(error = %e, host = %i.host, "local https not served");
            }
        }
    }
}

/// Set it up for `host`: certificate, then the elevated step, then serve.
/// Blocks until the UAC prompt is answered, so never on the actor.
pub fn enable(host: &str, port: u16) -> Result<(), String> {
    if !supported() {
        return Err("Opening this machine's address locally is only available on Windows for now.".into());
    }
    if !valid_host(host) {
        return Err(format!("`{host}` does not look like a hostname."));
    }
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    imp::make_cert(host)?;
    imp::elevated(&imp::enable_script(host))?;
    std::fs::write(dir().join("host"), host).map_err(|e| e.to_string())?;
    imp::start(port)
}

/// Undo all of it: stop serving, take the hosts line and the certificate out.
pub fn disable() -> Result<(), String> {
    let Some(host) = saved_host() else { return Ok(()) };
    imp::stop();
    imp::elevated(&imp::disable_script(&host))?;
    for f in ["host", "cert.der", "key.der"] {
        let _ = std::fs::remove_file(dir().join(f));
    }
    Ok(())
}

/// Letters, digits, dots and dashes only: it goes into a script run elevated.
fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.contains('.')
        && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

#[cfg(windows)]
mod imp {
    use super::{dir, hosts_path, MARK};
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    static SERVING: AtomicBool = AtomicBool::new(false);
    static STOP: AtomicBool = AtomicBool::new(false);

    pub fn serving() -> bool {
        SERVING.load(Ordering::SeqCst)
    }

    /// The common name certutil finds it by when undoing.
    fn common_name(host: &str) -> String {
        format!("sessionhub local {host}")
    }

    pub fn make_cert(host: &str) -> Result<(), String> {
        make_cert_in(&dir(), host)
    }

    fn make_cert_in(d: &std::path::Path, host: &str) -> Result<(), String> {
        use rcgen::{CertificateParams, DnType, ExtendedKeyUsagePurpose, KeyPair};
        let mut p = CertificateParams::new(vec![host.to_string()]).map_err(|e| e.to_string())?;
        p.distinguished_name.push(DnType::CommonName, common_name(host));
        p.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        // Trusted by this machine alone, so the 398-day rule for public
        // certificates does not apply; ten years means never thinking of it.
        p.not_before = rcgen::date_time_ymd(2025, 1, 1);
        p.not_after = rcgen::date_time_ymd(2036, 1, 1);
        let key = KeyPair::generate().map_err(|e| e.to_string())?;
        let cert = p.self_signed(&key).map_err(|e| e.to_string())?;
        std::fs::write(d.join("cert.der"), cert.der()).map_err(|e| e.to_string())?;
        std::fs::write(d.join("key.der"), key.serialize_der()).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// PowerShell single-quoted.
    fn q(s: &str) -> String {
        format!("'{}'", s.replace('\'', "''"))
    }

    pub fn enable_script(host: &str) -> String {
        let hosts = hosts_path().display().to_string();
        let cert = dir().join("cert.der").display().to_string();
        let re = format!(r"^\s*127\.0\.0\.1\s+(\S+\s+)*{}(\s|#|$)", host.replace('.', r"\."));
        format!(
            "certutil -delstore Root {cn} | Out-Null\n\
             certutil -addstore -f Root {cert} | Out-Null\n\
             if ($LASTEXITCODE -ne 0) {{ throw 'certutil could not add the certificate' }}\n\
             if (-not (Select-String -Path {hosts} -Pattern {re} -Quiet)) {{\n\
               Add-Content -Path {hosts} -Value \"`r`n127.0.0.1  {host}  {MARK}\" -Encoding ASCII\n\
             }}\n\
             ipconfig /flushdns | Out-Null\n",
            cn = q(&common_name(host)),
            cert = q(&cert),
            hosts = q(&hosts),
            re = q(&re),
        )
    }

    pub fn disable_script(host: &str) -> String {
        let hosts = q(&hosts_path().display().to_string());
        format!(
            "certutil -delstore Root {cn} | Out-Null\n\
             $keep = Get-Content -Path {hosts} | Where-Object {{ $_ -notmatch {mark} }}\n\
             Set-Content -Path {hosts} -Value $keep -Encoding ASCII\n\
             ipconfig /flushdns | Out-Null\n",
            cn = q(&common_name(host)),
            mark = q(&regex_escape(MARK)),
        )
    }

    fn regex_escape(s: &str) -> String {
        s.chars().fold(String::new(), |mut o, c| {
            if !c.is_alphanumeric() && c != ' ' && c != '-' {
                o.push('\\');
            }
            o.push(c);
            o
        })
    }

    /// Run `body` as administrator, behind the UAC prompt, and wait for it.
    /// Success is a file the script writes as its last act: a declined prompt
    /// and a failed step look the same from out here otherwise.
    pub fn elevated(body: &str) -> Result<(), String> {
        let script = dir().join("elevate.ps1");
        let done = dir().join("elevate.ok");
        let _ = std::fs::remove_file(&done);
        let full = format!(
            "$ErrorActionPreference = 'Stop'\n{body}Set-Content -Path {} -Value ok\n",
            q(&done.display().to_string())
        );
        std::fs::write(&script, full).map_err(|e| e.to_string())?;
        let launch = format!(
            "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList \
             '-NoProfile','-ExecutionPolicy','Bypass','-File',{}",
            q(&format!("\"{}\"", script.display()))
        );
        let out = crate::pty::quiet_command("powershell")
            .args(["-NoProfile", "-Command", &launch])
            .output()
            .map_err(|e| format!("could not run PowerShell: {e}"))?;
        let _ = std::fs::remove_file(&script);
        if std::fs::remove_file(&done).is_ok() {
            return Ok(());
        }
        let why = String::from_utf8_lossy(&out.stderr);
        Err(if why.contains("canceled") || why.contains("cancelled") {
            "The administrator prompt was declined, so nothing was changed.".into()
        } else {
            "The administrator step did not finish — it needs someone at this computer to accept \
             the prompt (it cannot be shown to a service)."
                .into()
        })
    }

    fn tls_config(d: &std::path::Path) -> Result<Arc<rustls::ServerConfig>, String> {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
        let cert = std::fs::read(d.join("cert.der")).map_err(|e| e.to_string())?;
        let key = std::fs::read(d.join("key.der")).map_err(|e| e.to_string())?;
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let cfg = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert)],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
            )
            .map_err(|e| e.to_string())?;
        Ok(Arc::new(cfg))
    }

    pub fn start(port: u16) -> Result<(), String> {
        if SERVING.load(Ordering::SeqCst) {
            return Ok(());
        }
        let cfg = tls_config(&dir())?;
        let listener = TcpListener::bind(("127.0.0.1", 443))
            .map_err(|e| format!("Port 443 on this machine is taken by something else ({e})."))?;
        STOP.store(false, Ordering::SeqCst);
        SERVING.store(true, Ordering::SeqCst);
        tracing::info!("local https on 127.0.0.1:443");
        std::thread::spawn(move || {
            accept(listener, port, cfg);
            SERVING.store(false, Ordering::SeqCst);
        });
        Ok(())
    }

    fn accept(listener: TcpListener, port: u16, cfg: Arc<rustls::ServerConfig>) {
        for sock in listener.incoming() {
            if STOP.load(Ordering::SeqCst) {
                break;
            }
            let Ok(sock) = sock else { continue };
            let cfg = cfg.clone();
            std::thread::spawn(move || {
                let _ = relay(sock, port, cfg);
            });
        }
    }

    pub fn stop() {
        if SERVING.load(Ordering::SeqCst) {
            STOP.store(true, Ordering::SeqCst);
            // `accept` only looks at the flag once something arrives.
            let _ = TcpStream::connect(("127.0.0.1", 443));
        }
    }

    /// Send everything out of the connection that rustls has waiting.
    fn flush(c: &mut rustls::ServerConnection, w: &mut TcpStream) -> std::io::Result<()> {
        while c.wants_write() {
            c.write_tls(w)?;
        }
        Ok(())
    }

    /// One browser connection: TLS on the outside, the daemon's own port on the
    /// inside, bytes passed through as they are — WebSockets included.
    ///
    /// Two threads, one per direction, share the TLS state behind a lock that is
    /// held only to feed it or drain it, never across a blocking read.
    fn relay(client: TcpStream, port: u16, cfg: Arc<rustls::ServerConfig>) -> std::io::Result<()> {
        let up = TcpStream::connect(("127.0.0.1", port))?;
        let _ = client.set_nodelay(true);
        let _ = up.set_nodelay(true);
        let conn = rustls::ServerConnection::new(cfg).map_err(std::io::Error::other)?;
        let conn = Arc::new(Mutex::new(conn));

        // The daemon's answers, out to the browser.
        {
            let conn = conn.clone();
            let mut from_up = up.try_clone()?;
            let mut to_client = client.try_clone()?;
            std::thread::spawn(move || {
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    let n = match from_up.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    let mut c = conn.lock().unwrap();
                    if c.writer().write_all(&buf[..n]).is_err() || flush(&mut c, &mut to_client).is_err() {
                        break;
                    }
                }
                let mut c = conn.lock().unwrap();
                c.send_close_notify();
                let _ = flush(&mut c, &mut to_client);
                let _ = to_client.shutdown(Shutdown::Both);
            });
        }

        // The browser's requests, in to the daemon.
        let mut from_client = client.try_clone()?;
        let mut to_client = client;
        let mut to_up = up;
        let mut buf = vec![0u8; 16 * 1024];
        let result = (|| -> std::io::Result<()> {
            loop {
                let n = from_client.read(&mut buf)?;
                if n == 0 {
                    return Ok(());
                }
                let mut plain = Vec::new();
                let mut closed = false;
                {
                    let mut c = conn.lock().unwrap();
                    let mut rd = &buf[..n];
                    while !rd.is_empty() {
                        c.read_tls(&mut rd)?;
                        let st = match c.process_new_packets() {
                            Ok(st) => st,
                            Err(e) => {
                                let _ = flush(&mut c, &mut to_client);
                                return Err(std::io::Error::other(e));
                            }
                        };
                        let want = st.plaintext_bytes_to_read();
                        if want > 0 {
                            let at = plain.len();
                            plain.resize(at + want, 0);
                            c.reader().read_exact(&mut plain[at..])?;
                        }
                        closed |= st.peer_has_closed();
                    }
                    flush(&mut c, &mut to_client)?;
                }
                if !plain.is_empty() {
                    to_up.write_all(&plain)?;
                }
                if closed {
                    return Ok(());
                }
            }
        })();
        let _ = to_up.shutdown(Shutdown::Both);
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// A browser's view: a TLS client that trusts only the made certificate,
        /// talking through the relay to an echo server standing in for the
        /// daemon — a request in, the answer back, and a second round on the
        /// same connection the way a WebSocket keeps going.
        #[test]
        fn a_made_certificate_is_served_and_bytes_pass_both_ways() {
            let d = std::env::temp_dir().join(format!("sh-localhttps-{}", std::process::id()));
            std::fs::create_dir_all(&d).unwrap();
            make_cert_in(&d, "sbox.example.com").unwrap();
            let cfg = tls_config(&d).unwrap();

            let echo = TcpListener::bind("127.0.0.1:0").unwrap();
            let echo_port = echo.local_addr().unwrap().port();
            std::thread::spawn(move || {
                let (mut s, _) = echo.accept().unwrap();
                let mut buf = [0u8; 1024];
                loop {
                    let n = s.read(&mut buf).unwrap_or(0);
                    if n == 0 { break; }
                    let mut out = b"echo:".to_vec();
                    out.extend_from_slice(&buf[..n]);
                    s.write_all(&out).unwrap();
                }
            });
            let front = TcpListener::bind("127.0.0.1:0").unwrap();
            let front_port = front.local_addr().unwrap().port();
            std::thread::spawn(move || accept(front, echo_port, cfg));

            let mut roots = rustls::RootCertStore::empty();
            roots.add(rustls::pki_types::CertificateDer::from(std::fs::read(d.join("cert.der")).unwrap())).unwrap();
            let client_cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth();
            let name = rustls::pki_types::ServerName::try_from("sbox.example.com").unwrap();
            let mut conn = rustls::ClientConnection::new(Arc::new(client_cfg), name).unwrap();
            let mut sock = TcpStream::connect(("127.0.0.1", front_port)).unwrap();
            let mut tls = rustls::Stream::new(&mut conn, &mut sock);
            for round in ["first", "second"] {
                tls.write_all(round.as_bytes()).unwrap();
                let mut got = vec![0u8; 5 + round.len()];
                tls.read_exact(&mut got).unwrap();
                assert_eq!(got, format!("echo:{round}").into_bytes());
            }
            let _ = std::fs::remove_dir_all(&d);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn serving() -> bool {
        false
    }
    pub fn start(_port: u16) -> Result<(), String> {
        Ok(())
    }
    pub fn stop() {}
    pub fn make_cert(_host: &str) -> Result<(), String> {
        Err("not supported here".into())
    }
    pub fn elevated(_body: &str) -> Result<(), String> {
        Err("not supported here".into())
    }
    pub fn enable_script(_host: &str) -> String {
        String::new()
    }
    pub fn disable_script(_host: &str) -> String {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hosts_line_counts_only_for_its_own_name_and_only_uncommented() {
        let hosts = "# 127.0.0.1 commented.example.com\n\
                     127.0.0.1  localhost\n\
                     127.0.0.1  sbox.example.com  # sessionhub local-https\n\
                     0.0.0.0 blocked.example.com\n";
        assert!(points_here(hosts, "sbox.example.com"));
        assert!(points_here(hosts, "SBOX.example.com"));
        assert!(!points_here(hosts, "commented.example.com"));
        assert!(!points_here(hosts, "blocked.example.com"));
        assert!(!points_here(hosts, "box.example.com"));
    }

    #[test]
    fn nothing_that_could_break_out_of_the_script_is_a_hostname() {
        assert!(valid_host("sbox.airienka.com"));
        assert!(!valid_host("sbox"));
        assert!(!valid_host("a.com'; rm"));
        assert!(!valid_host("a.com\nb"));
        assert!(!valid_host(""));
    }
}
