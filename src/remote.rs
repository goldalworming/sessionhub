//! Other machines reached through this daemon.
//!
//! The local daemon becomes a relay: the browser only ever talks here, and a
//! remote machine's token never leaves `config.toml`. What is passed through
//! are the existing protocol frames, untouched — no second protocol had to be
//! written, and not one line of the actor changed.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use crate::config::Remote;

/// The protocol version between instances. Raised when the shape of a message
/// changes in a way an older version would misread.
pub const PROTOCOL: u32 = 1;

/// Do not leave the user hanging when the address is wrong or the machine is down.
const DIAL_TIMEOUT: Duration = Duration::from_secs(5);
const IO_TIMEOUT: Duration = Duration::from_secs(15);

/// What a pairing link contains.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairLink {
    pub host: String,
    pub port: u16,
    pub token: String,
}

impl PairLink {
    pub fn addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// Parse a pairing link.
///
/// The official form is `sessionhub://host:port/pair#token=…`, but this link
/// travels through chat apps and mail that love to rewrite it. So `http(s)://`
/// is accepted too, the token may sit in the fragment or the query, and a bare
/// `host:port#token=…` works as well. What is **not** accepted is a half link:
/// no token, no port, or port 0 — better refused now than turned into a
/// confusing connection failure later.
pub fn parse_link(raw: &str) -> Result<PairLink, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("Paste a pairing link.".into());
    }

    // Strip any scheme we know; the rest is treated the same.
    let rest = ["sessionhub://", "http://", "https://", "ws://", "wss://"]
        .iter()
        .find_map(|p| text.strip_prefix(*p))
        .unwrap_or(text);

    // The token can be in the fragment or the query. Both are split off first so
    // a `/pair` in the middle is not carried into the hostname.
    let (before_hash, after_hash) = split_once(rest, '#');
    let (before_q, after_q) = split_once(before_hash, '?');
    let token = find_param(after_hash, "token")
        .or_else(|| find_param(after_q, "token"))
        .unwrap_or_default();
    if token.is_empty() {
        return Err("That link has no token.".into());
    }

    // The rest of the path (`/pair`) is dropped; only host and port are needed.
    let hostport = before_q.split('/').next().unwrap_or("").trim();
    if hostport.is_empty() {
        return Err("That link has no address.".into());
    }
    let (host, port_text) = hostport
        .rsplit_once(':')
        .ok_or_else(|| format!("`{hostport}` has no port — pairing needs host:port."))?;
    let host = host.trim_matches(['[', ']']);
    if host.is_empty() {
        return Err("That link has no host.".into());
    }
    let port: u16 = port_text
        .parse()
        .map_err(|_| format!("`{port_text}` is not a port number."))?;
    if port == 0 {
        return Err("Port 0 is not a port.".into());
    }

    Ok(PairLink { host: host.to_string(), port, token: token.to_string() })
}

fn split_once(s: &str, sep: char) -> (&str, &str) {
    match s.split_once(sep) {
        Some((a, b)) => (a, b),
        None => (s, ""),
    }
}

/// Find `name=…` inside a chunk like `a=1&b=2`.
fn find_param(blob: &str, name: &str) -> Option<String> {
    blob.split(['&', ';'])
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| k.trim() == name)
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The link this machine shows so another machine can pair with it.
pub fn pair_link(host: &str, port: u16, token: &str) -> String {
    format!("sessionhub://{host}:{port}/pair#token={token}")
}

/// What pairing keeps from another machine's `/api/status` answer.
///
/// Only the version: it goes into the config so Settings can show what the
/// machine answered when it was paired. The protocol number is enforced inside
/// `probe` and would be stale the moment it was stored; `terminals_alive` was
/// carried for a while and read by nobody.
#[derive(Debug, Clone)]
pub struct RemoteStatus {
    pub version: String,
}

/// Ask `/api/status` before storing anything.
///
/// A wrong token and a version mismatch surface here — not later in the middle
/// of a WebSocket upgrade, where they would appear as a parse error that tells
/// nobody anything.
pub fn probe(addr: &str, token: &str) -> Result<RemoteStatus, String> {
    let body = http_get(addr, &format!("/api/status?token={token}"))?;
    let json: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| format!("{addr} did not answer with JSON."))?;

    let protocol = json.get("protocol").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if protocol != PROTOCOL {
        // Name both versions: "mismatch" alone does not say which side needs
        // updating.
        return Err(format!(
            "{addr} speaks protocol {}, this machine speaks {PROTOCOL}. Update the older one.",
            if protocol == 0 { "0 (too old to say)".to_string() } else { protocol.to_string() },
        ));
    }
    Ok(RemoteStatus {
        version: json
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
    })
}

/// A simple GET to another daemon. Hand-written on purpose: only one route of
/// our own is ever called, and adding an HTTP dependency for that is not worth
/// it.
pub fn http_get(addr: &str, path: &str) -> Result<Vec<u8>, String> {
    let mut sock = dial(addr)?;
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nAccept: */*\r\n\r\n"
    );
    sock.write_all(req.as_bytes()).map_err(|e| format!("Could not reach {addr}: {e}"))?;

    let mut raw = Vec::new();
    sock.read_to_end(&mut raw).map_err(|e| format!("{addr} stopped replying: {e}"))?;

    let split = find_headers_end(&raw)
        .ok_or_else(|| format!("{addr} sent a reply this version cannot read."))?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .unwrap_or(0);
    match status {
        200 => Ok(raw[split + 4..].to_vec()),
        401 => Err(format!("{addr} refused the token.")),
        404 => Err(format!("{addr} does not have that.")),
        other => Err(format!("{addr} answered {other}.")),
    }
}

fn find_headers_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Connect to a `host:port`, with a deadline so a wrong address fails fast
/// instead of hanging.
pub fn dial(addr: &str) -> Result<TcpStream, String> {
    let mut last = format!("Could not resolve {addr}.");
    let targets: Vec<_> = std::net::ToSocketAddrs::to_socket_addrs(&addr)
        .map_err(|e| format!("Could not resolve {addr}: {e}"))?
        .collect();
    for target in targets {
        match TcpStream::connect_timeout(&target, DIAL_TIMEOUT) {
            Ok(s) => {
                let _ = s.set_read_timeout(Some(IO_TIMEOUT));
                let _ = s.set_write_timeout(Some(IO_TIMEOUT));
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Err(e) => last = format!("Could not reach {addr}: {e}"),
        }
    }
    Err(last)
}

/// Is this address our own daemon? Pairing with yourself is a loop waiting to
/// happen.
pub fn is_self(addr: &str, our_port: u16) -> bool {
    let Some((host, port)) = addr.rsplit_once(':') else { return false };
    let Ok(port) = port.parse::<u16>() else { return false };
    if port != our_port {
        return false;
    }
    let host = host.trim_matches(['[', ']']).to_lowercase();
    if host == "localhost" {
        return true;
    }
    let Ok(ip) = host.parse::<std::net::IpAddr>() else { return false };
    // All of our addresses, not just the preferred one: the daemon now answers
    // on every interface, so pairing with our own VPN address is just as much a
    // loop as pairing with our own Wi-Fi address.
    ip.is_loopback() || crate::config::lan_ips().contains(&ip)
}

/// Find a remote by name.
pub fn find<'a>(remotes: &'a [Remote], name: &str) -> Option<&'a Remote> {
    remotes.iter().find(|r| r.name == name)
}

/// A name not yet taken. Two machines offering the same name must not silently
/// overwrite each other.
pub fn unique_name(remotes: &[Remote], wanted: &str) -> String {
    let base = if wanted.is_empty() { "remote" } else { wanted };
    if find(remotes, base).is_none() {
        return base.to_string();
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if find(remotes, &candidate).is_none() {
            return candidate;
        }
    }
    format!("{base}-x")
}

/// Machine names are filtered more loosely than agent names, and deliberately so.
///
/// An agent name becomes a **key** in `config.toml`, so it has to be a bare TOML
/// key. A machine name is only a value inside an array of tables, and its
/// default is derived from an IP address — `10-8-0-4` has to pass. What really
/// matters: not empty, not too long, and safe to use in `?via=`.
pub fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Give the machine a name.".into());
    }
    if name.chars().count() > 24 {
        return Err("Keep the name under 24 characters.".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
    {
        return Err("Use lowercase letters, digits, and - _ . only.".into());
    }
    Ok(())
}

/// The default name for an address: its host, tidied into something that reads
/// well in a tab.
pub fn name_from_addr(addr: &str) -> String {
    let host = addr.rsplit_once(':').map(|(h, _)| h).unwrap_or(addr);
    let host = host.trim_matches(['[', ']']);
    let cleaned: String = host
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_lowercase();
    if cleaned.is_empty() {
        "remote".to_string()
    } else {
        cleaned
    }
}

/// Encode for a query string. A server-side `encodeURIComponent`, used when
/// forwarding Windows paths full of `:` and `\`.
pub fn percent_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 16);
    for b in raw.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Open a WebSocket to another machine's daemon and finish its handshake.
///
/// Written on a plain `TcpStream` for the same reason as the server side: what
/// is needed is a socket that can be `try_clone`d, so reading and writing can
/// be held by two different threads.
pub fn dial_ws(r: &Remote) -> Result<TcpStream, String> {
    let mut sock = dial(&r.addr)?;
    // After the handshake this connection idles for hours waiting on output —
    // the read deadline that was useful while connecting would now cut it off.
    let _ = sock.set_read_timeout(None);
    let _ = sock.set_write_timeout(None);

    let key = handshake_key()?;
    let req = format!(
        "GET /ws?token={} HTTP/1.1\r\n\
         Host: {}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: {key}\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n",
        percent_encode(&r.token),
        r.addr,
    );
    sock.write_all(req.as_bytes()).map_err(|e| format!("Could not reach {}: {e}", r.addr))?;
    sock.flush().map_err(|e| format!("Could not reach {}: {e}", r.addr))?;

    // Read the response head byte by byte: anything after the blank line already
    // belongs to a WebSocket frame, and must not be swallowed.
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while head.len() < 8192 {
        match sock.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                head.push(byte[0]);
                if head.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            Err(e) => return Err(format!("{} stopped replying: {e}", r.addr)),
        }
    }
    let text = String::from_utf8_lossy(&head);
    let status = text
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .unwrap_or(0);
    match status {
        101 => Ok(sock),
        401 => Err(format!("{} refused the token — re-pair that machine.", r.addr)),
        other => Err(format!("{} answered {other} instead of upgrading.", r.addr)),
    }
}

/// A random handshake key. Its value is not a secret — the server only echoes it
/// back — but it has to differ per connection.
fn handshake_key() -> Result<String, String> {
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
    Ok(base64(&raw))
}

fn base64(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Pump bytes both ways until one side stops.
///
/// Bytes on purpose, not frames: frames arriving from a client are already
/// masked and already valid to the far side, so taking them apart and putting
/// them back together only adds cost and one new place to be wrong.
pub fn pump(near: TcpStream, far: TcpStream) {
    let (near_r, near_w) = match (near.try_clone(), near) {
        (Ok(a), b) => (a, b),
        (Err(_), _) => return,
    };
    let (far_r, far_w) = match (far.try_clone(), far) {
        (Ok(a), b) => (a, b),
        (Err(_), _) => return,
    };

    let up = std::thread::spawn(move || copy_until_closed(near_r, far_w));
    copy_until_closed(far_r, near_w);
    let _ = up.join();
}

/// Copy until the end, then shut down **both** directions of the target socket.
/// Without that shutdown, the paired thread would hang forever in `read`.
fn copy_until_closed(mut from: TcpStream, mut to: TcpStream) {
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if to.write_all(&buf[..n]).is_err() || to.flush().is_err() {
                    break;
                }
            }
            Err(ref e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let _ = to.shutdown(std::net::Shutdown::Both);
    let _ = from.shutdown(std::net::Shutdown::Both);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(names: &[&str]) -> Vec<Remote> {
        names
            .iter()
            .map(|n| Remote {
                name: n.to_string(),
                addr: "10.0.0.1:7717".into(),
                token: "t".into(),
                version: String::new(),
            })
            .collect()
    }

    #[test]
    fn accepts_the_shape_it_prints() {
        let l = parse_link("sessionhub://192.168.0.115:7717/pair#token=abc123").unwrap();
        assert_eq!(l.host, "192.168.0.115");
        assert_eq!(l.port, 7717);
        assert_eq!(l.token, "abc123");
        assert_eq!(l.addr(), "192.168.0.115:7717");
    }

    #[test]
    fn accepts_the_shapes_chat_apps_produce() {
        // These are all the same link, after passing through various middlemen.
        for raw in [
            "sessionhub://10.8.0.4:7717/pair#token=abc123",
            "http://10.8.0.4:7717/pair#token=abc123",
            "https://10.8.0.4:7717/?token=abc123",
            "ws://10.8.0.4:7717/ws?token=abc123",
            "10.8.0.4:7717#token=abc123",
            "  sessionhub://10.8.0.4:7717/pair#token=abc123  ",
        ] {
            let l = parse_link(raw).unwrap_or_else(|e| panic!("{raw} ditolak: {e}"));
            assert_eq!((l.host.as_str(), l.port, l.token.as_str()), ("10.8.0.4", 7717, "abc123"));
        }
    }

    #[test]
    fn refuses_half_a_link() {
        for (raw, why) in [
            ("", "kosong"),
            ("   ", "spasi saja"),
            ("sessionhub://10.8.0.4:7717/pair", "tanpa token"),
            ("sessionhub://10.8.0.4:7717/pair#token=", "token kosong"),
            ("sessionhub://10.8.0.4/pair#token=abc", "tanpa port"),
            ("sessionhub://10.8.0.4:0/pair#token=abc", "port 0"),
            ("sessionhub://:7717/pair#token=abc", "tanpa host"),
            ("sessionhub://10.8.0.4:abc/pair#token=abc", "port is not a number"),
        ] {
            assert!(parse_link(raw).is_err(), "{why} ({raw:?}) seharusnya ditolak");
        }
    }

    #[test]
    fn the_error_says_what_is_missing() {
        assert!(parse_link("sessionhub://10.8.0.4:7717/pair").unwrap_err().contains("token"));
        assert!(parse_link("sessionhub://10.8.0.4/pair#token=a").unwrap_err().contains("port"));
    }

    #[test]
    fn the_printed_link_parses_back() {
        let out = pair_link("192.0.2.10", 7717, "EXAMPLE-token-not-a-real-one-0123456789abcd");
        let back = parse_link(&out).unwrap();
        assert_eq!(back.addr(), "192.0.2.10:7717");
        assert_eq!(back.token, "EXAMPLE-token-not-a-real-one-0123456789abcd");
    }

    #[test]
    fn pairing_with_ourselves_is_refused() {
        assert!(is_self("127.0.0.1:7717", 7717));
        assert!(is_self("localhost:7717", 7717));
        // Another port on the same machine is a different daemon — that is fine.
        assert!(!is_self("127.0.0.1:7719", 7717));
        assert!(!is_self("10.8.0.4:7717", 7717));
        assert!(!is_self("bukan-alamat", 7717));
    }

    #[test]
    fn names_never_overwrite_each_other() {
        let have = cfg(&["kantor"]);
        assert_eq!(unique_name(&have, "vps"), "vps");
        assert_eq!(unique_name(&have, "kantor"), "kantor-2");
        let have = cfg(&["kantor", "kantor-2"]);
        assert_eq!(unique_name(&have, "kantor"), "kantor-3");
    }

    #[test]
    fn machine_names_allow_what_addresses_produce() {
        // A default name is derived from an address, so one starting with a digit
        // has to pass — the "must start with a letter" rule belongs to agent
        // names, not this.
        for good in ["10-8-0-4", "kantor", "vps.rumah", "mesin_2", "127-0-0-1"] {
            assert!(check_name(good).is_ok(), "{good} seharusnya diterima");
        }
        for bad in ["", "Kantor", "mesin kantor", "a/b", &"x".repeat(25)] {
            assert!(check_name(bad).is_err(), "{bad:?} seharusnya ditolak");
        }
    }

    #[test]
    fn every_derived_name_passes_its_own_rule() {
        for addr in ["10.8.0.4:7717", "127.0.0.1:7721", "kantor.local:7717", ":7717"] {
            let n = name_from_addr(addr);
            assert!(check_name(&n).is_ok(), "{addr} -> {n} ditolak sendiri");
        }
    }

    #[test]
    fn a_default_name_comes_from_the_address() {
        assert_eq!(name_from_addr("10.8.0.4:7717"), "10-8-0-4");
        assert_eq!(name_from_addr("kantor.local:7717"), "kantor-local");
        assert_eq!(name_from_addr(":7717"), "remote");
    }

    #[test]
    fn finding_by_name_is_exact() {
        let have = cfg(&["kantor", "vps"]);
        assert!(find(&have, "kantor").is_some());
        // An unregistered name must never be served — otherwise this daemon
        // becomes an open proxy to any address a client asks for.
        assert!(find(&have, "Kantor").is_none());
        assert!(find(&have, "10.8.0.4:7717").is_none());
    }

    #[test]
    fn headers_end_is_found_only_at_the_blank_line() {
        assert_eq!(find_headers_end(b"HTTP/1.1 200 OK\r\n\r\nbody"), Some(15));
        assert_eq!(find_headers_end(b"HTTP/1.1 200 OK\r\nX: 1\r\n"), None);
    }
}
