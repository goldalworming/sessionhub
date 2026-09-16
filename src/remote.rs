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
    /// The link said `https://`, so that is how the machine is reached.
    pub tls: bool,
    pub token: String,
    /// A Cloudflare Access service token, when the link carries one as
    /// `cf_id=…&cf_secret=…`. One line to paste beats hand-editing
    /// `config.toml`, and it travels under the same trust the sessionhub token
    /// in the same link already does.
    pub access_id: String,
    pub access_secret: String,
}

impl PairLink {
    /// The address as it will be stored — the one spelling, see
    /// `Target::canonical`.
    pub fn addr(&self) -> String {
        Target { tls: self.tls, host: self.host.clone(), port: self.port }.canonical()
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
///
/// One exception to "no port": `https://box.example.com` needs none, because
/// 443 is the only port that name is served on. A port is still required for
/// every other shape, which is what keeps a half-typed LAN address refused.
pub fn parse_link(raw: &str) -> Result<PairLink, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("Paste a pairing link.".into());
    }

    // Strip any scheme we know. Only whether it was a TLS one is kept: that is
    // the single thing a scheme still decides once the address is stored.
    let (tls, rest) = strip_scheme(text);

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
    let (host, port) = split_hostport(hostport)?;
    if host.is_empty() {
        return Err("That link has no host.".into());
    }
    // `https://` in front of an IP address is a chat app being helpful, not a
    // tunnel: nobody puts Cloudflare in front of 10.8.0.4. Read it as the LAN
    // link it plainly is — there is a test made of exactly these shapes.
    let tls = tls && host.parse::<std::net::IpAddr>().is_err();
    let port = match port {
        Some(p) => p,
        // A hostname served over TLS needs no port; anything else does.
        None if tls => 443,
        None => {
            return Err(format!("`{hostport}` has no port — pairing needs host:port."));
        }
    };
    if port == 0 {
        return Err("Port 0 is not a port.".into());
    }

    Ok(PairLink {
        host: host.to_lowercase(),
        port,
        tls,
        token: token.to_string(),
        access_id: param(after_hash, after_q, "cf_id"),
        access_secret: param(after_hash, after_q, "cf_secret"),
    })
}

/// One named value from either half of a link.
fn param(fragment: &str, query: &str, name: &str) -> String {
    find_param(fragment, name).or_else(|| find_param(query, name)).unwrap_or_default()
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

/// The port a daemon listens on when an address does not say.
pub const DEFAULT_PORT: u16 = 7717;

/// Where a paired machine lives, once its address has been read.
///
/// One string in `config.toml` carries all of it — `box:7717`,
/// `http://box:7717`, or `https://box.example.com`. Deliberately not a separate
/// `tls` flag beside the address: two fields can disagree with each other, and
/// this one is shown to people — `sessionhubd machines` prints it, the machine
/// tab carries it in its tooltip — who should be able to paste it straight back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// Reached through TLS, and therefore through `curl` rather than through a
    /// socket of our own. See `request_curl` for why.
    pub tls: bool,
    pub host: String,
    pub port: u16,
}

impl Target {
    /// `host:port`, bracketed for IPv6 — what `dial` takes.
    pub fn authority(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    /// The URL handed to curl.
    pub fn url(&self, path: &str) -> String {
        let host =
            if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        let scheme = if self.tls { "https" } else { "http" };
        let default = if self.tls { 443 } else { 0 };
        if self.port == default {
            format!("{scheme}://{host}{path}")
        } else {
            format!("{scheme}://{host}:{}{path}", self.port)
        }
    }

    /// How the address is written back into `config.toml`.
    ///
    /// One spelling per machine, and that matters beyond tidiness: `addr` is
    /// also the identity key. Re-pairing looks for a row with the same address
    /// and updates it rather than adding a second, and that lookup is a string
    /// compare — so `https://Box.Example.com:443` and `https://box.example.com`
    /// must not be able to become two machines.
    pub fn canonical(&self) -> String {
        match (self.tls, self.port) {
            (true, 443) => format!("https://{}", self.host),
            (true, p) => format!("https://{}:{p}", self.host),
            (false, _) => self.authority(),
        }
    }
}

/// Read an address of the shape `config.toml` stores.
pub fn parse_addr(addr: &str) -> Result<Target, String> {
    let text = addr.trim();
    if text.is_empty() {
        return Err("That address is empty.".into());
    }
    let (tls, rest) = strip_scheme(text);
    // A path is not part of an address; `https://box.example.com/` is the same
    // machine as `https://box.example.com`.
    let hostport = rest.split('/').next().unwrap_or("").trim();
    let (host, port) = split_hostport(hostport)?;
    if host.is_empty() {
        return Err(format!("`{addr}` has no host."));
    }
    // See `parse_link`: a scheme in front of an IP address is noise.
    let tls = tls && host.parse::<std::net::IpAddr>().is_err();
    let port = port.unwrap_or(if tls { 443 } else { DEFAULT_PORT });
    if port == 0 {
        return Err("Port 0 is not a port.".into());
    }
    Ok(Target { tls, host: host.to_lowercase(), port })
}

/// Split a scheme off, reporting only whether it was a TLS one.
///
/// Case-insensitive, because a scheme is: `HTTPS://` is what a phone keyboard
/// with the shift key stuck produces, and refusing it would report a missing
/// port rather than the real problem.
fn strip_scheme(text: &str) -> (bool, &str) {
    let lower = text.to_ascii_lowercase();
    for (prefix, tls) in [
        ("sessionhub://", false),
        ("https://", true),
        ("http://", false),
        ("wss://", true),
        ("ws://", false),
    ] {
        if lower.starts_with(prefix) {
            return (tls, &text[prefix.len()..]);
        }
    }
    (false, text)
}

/// `host[:port]`, with IPv6 in brackets. The port is optional here; who may
/// leave it out is decided by the caller.
fn split_hostport(hostport: &str) -> Result<(String, Option<u16>), String> {
    if let Some(rest) = hostport.strip_prefix('[') {
        let (inside, after) =
            rest.split_once(']').ok_or_else(|| format!("`{hostport}` has an unclosed `[`."))?;
        let port = match after.strip_prefix(':') {
            Some(p) => Some(parse_port(p)?),
            None => None,
        };
        return Ok((inside.to_string(), port));
    }
    match hostport.rsplit_once(':') {
        // A bare IPv6 literal is all colons and no port; only the bracketed form
        // can carry one.
        Some((host, port)) if !host.contains(':') => Ok((host.to_string(), Some(parse_port(port)?))),
        _ => Ok((hostport.to_string(), None)),
    }
}

fn parse_port(text: &str) -> Result<u16, String> {
    text.parse().map_err(|_| format!("`{text}` is not a port number."))
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
pub fn probe(p: &Peer, token: &str) -> Result<RemoteStatus, String> {
    let addr = &p.addr;
    let body = http_get(p, &format!("/api/status?token={token}"))?;
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

/// A machine to talk to, and what it takes to be let in.
///
/// Not a `&Remote`, because pairing does not have one yet — it has a link that
/// has only just been read. Both roads end here.
#[derive(Debug, Clone)]
pub struct Peer {
    pub addr: String,
    /// A Cloudflare Access service token, when the hostname sits behind a
    /// policy. Empty on a machine that does not.
    pub access_id: String,
    pub access_secret: String,
}

impl Peer {
    pub fn of(r: &Remote) -> Peer {
        Peer {
            addr: r.addr.clone(),
            access_id: r.access_id.clone(),
            access_secret: r.access_secret.clone(),
        }
    }

    /// A machine not in the config yet — which is every machine, at pairing time.
    pub fn at(addr: &str) -> Peer {
        Peer { addr: addr.to_string(), access_id: String::new(), access_secret: String::new() }
    }

    pub fn with_access(mut self, id: &str, secret: &str) -> Peer {
        self.access_id = id.to_string();
        self.access_secret = secret.to_string();
        self
    }

    /// The service token, if there is a whole one.
    ///
    /// Half of one is refused rather than sent: Access answers a request it does
    /// not recognise with a login **page**, so a typo in one of the two fields
    /// would surface as "did not answer with JSON" — the least helpful sentence
    /// available for the problem.
    fn access(&self) -> Result<Option<(&str, &str)>, String> {
        let id = self.access_id.trim();
        let secret = self.access_secret.trim();
        match (id.is_empty(), secret.is_empty()) {
            (true, true) => Ok(None),
            (false, false) => Ok(Some((id, secret))),
            _ => Err(format!(
                "{} has only half a Cloudflare Access service token in config.toml — \
                 `access_id` and `access_secret` are both needed, or neither.",
                self.addr
            )),
        }
    }
}

/// A GET to another daemon.
pub fn http_get(p: &Peer, path: &str) -> Result<Vec<u8>, String> {
    let (status, body) = request(p, "GET", path, &[], IO_TIMEOUT)?;
    judge(p, status, body)
}

/// `http_get` for something that takes its time.
///
/// The plain path sets a read timeout, which is right for asking a machine what
/// version it is and wrong for asking it to run a build. The deadline here
/// belongs to the command, not to the network.
pub fn http_get_slow(p: &Peer, path: &str, wait: Duration) -> Result<Vec<u8>, String> {
    let (status, body) = request(p, "GET", path, &[], wait)?;
    judge(p, status, body)
}

/// Send a file's bytes to another machine.
pub fn http_put(p: &Peer, path: &str, body: &[u8]) -> Result<Vec<u8>, String> {
    // A big file over a slow link takes longer than a status check may.
    let (status, answer) = request(p, "PUT", path, body, Duration::from_secs(120))?;
    judge(p, status, answer)
}

/// One request, one whole answer, whichever transport it took.
fn request(
    p: &Peer,
    method: &str,
    path: &str,
    body: &[u8],
    wait: Duration,
) -> Result<(u16, Vec<u8>), String> {
    let t = parse_addr(&p.addr)?;
    let access = p.access()?;
    if t.tls {
        request_curl(&t, method, path, body, access, wait)
    } else {
        request_tcp(&t, &p.addr, method, path, body, wait)
    }
}

/// The original transport: our own socket, our own request, plain HTTP.
///
/// Hand-written on purpose — only our own routes are ever called, and an HTTP
/// dependency for that is not worth it. It relies on `Connection: close` and
/// reads to end of file, which is safe because the daemon on the other side is
/// ours and always sends it.
fn request_tcp(
    t: &Target,
    addr: &str,
    method: &str,
    path: &str,
    body: &[u8],
    wait: Duration,
) -> Result<(u16, Vec<u8>), String> {
    let authority = t.authority();
    let mut sock = dial(&authority)?;
    sock.set_read_timeout(Some(wait)).map_err(|e| format!("{addr}: {e}"))?;

    let mut req = if body.is_empty() {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: {authority}\r\n\
             Connection: close\r\nAccept: */*\r\n\r\n"
        )
    } else {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\
             Content-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
    }
    .into_bytes();
    req.extend_from_slice(body);

    sock.write_all(&req).map_err(|e| format!("Could not reach {addr}: {e}"))?;
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
    Ok((status, raw[split + 4..].to_vec()))
}

/// The TLS transport: hand the whole thing to the system's curl.
///
/// Not a TLS crate, for the reason `update.rs` already gives — but the deciding
/// argument here is a different one. The reader above waits for the socket to
/// close and scans for one blank line. That works against our own daemon and
/// against nothing else: a CDN keeps connections alive and re-frames bodies as
/// chunked, so reaching one means writing a chunked decoder, a keep-alive-aware
/// reader and a certificate verifier. Those are exactly the three places a
/// hand-written client is silently wrong, and `pull` being silently wrong means
/// a corrupted file rather than an error.
fn request_curl(
    t: &Target,
    method: &str,
    path: &str,
    body: &[u8],
    access: Option<(&str, &str)>,
    wait: Duration,
) -> Result<(u16, Vec<u8>), String> {
    let host = t.host.clone();
    // The body goes in a file rather than down stdin, because stdin is already
    // carrying the config — and the config is the half with the secrets in it,
    // so it is the half that must not touch the disk.
    let scratch = if body.is_empty() { None } else { Some(BodyFile::new(body)?) };
    let config = curl_config(t, method, path, access, scratch.as_ref().map(|s| s.path()), wait);

    let mut child = crate::pty::quiet_command(crate::pty::curl_path())
        // Everything else rides in the config: the URL carries that machine's
        // token, and anything on the command line is readable by every other
        // process on this computer.
        .args(["-sS", "--config", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => format!(
                "Reaching {host} needs curl, and there is none at {}. Pair over \
                 http://host:port instead, or install curl.",
                crate::pty::curl_path().display()
            ),
            _ => format!("could not run curl: {e}"),
        })?;

    // The config is a few hundred bytes, well under a pipe buffer, so writing it
    // here cannot deadlock against curl's output. A 25 MB body could, which is
    // the other reason it goes in a file.
    if let Some(mut sink) = child.stdin.take() {
        sink.write_all(config.as_bytes()).map_err(|e| format!("could not talk to curl: {e}"))?;
    }
    let out = child.wait_with_output().map_err(|e| format!("curl failed: {e}"))?;

    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr);
        return Err(curl_failed(&host, out.status.code().unwrap_or(-1), why.trim(), wait));
    }

    // `--write-out "%{http_code}"` appends the status to the body with no
    // separator, so the last three bytes are it. Deliberately not `-i`: parsing
    // headers back out would break on a `100 Continue` block, and the body may
    // be a PNG rather than text.
    let mut raw = out.stdout;
    if raw.len() < 3 {
        return Err(format!("{host} sent a reply this version cannot read."));
    }
    let code = raw.split_off(raw.len() - 3);
    let status = String::from_utf8_lossy(&code).parse::<u16>().unwrap_or(0);
    Ok((status, raw))
}

/// Everything curl needs, in the file it reads instead of a command line.
fn curl_config(
    t: &Target,
    method: &str,
    path: &str,
    access: Option<(&str, &str)>,
    body_file: Option<&std::path::Path>,
    wait: Duration,
) -> String {
    let mut out = String::new();
    out.push_str(&format!("url = {}\n", quoted(&t.url(path))));
    out.push_str(&format!("request = {}\n", quoted(method)));
    // One response, one shape. HTTP/2 stream resets through a tunnel surface as
    // a curl exit code with nothing useful attached.
    out.push_str("http1.1\n");
    out.push_str(&format!("max-time = {}\n", quoted(&wait.as_secs().max(1).to_string())));
    out.push_str(&format!("connect-timeout = {}\n", quoted(&DIAL_TIMEOUT.as_secs().to_string())));
    out.push_str("header = \"Accept: */*\"\n");
    if let Some((id, secret)) = access {
        out.push_str(&format!("header = {}\n", quoted(&format!("CF-Access-Client-Id: {id}"))));
        out.push_str(&format!(
            "header = {}\n",
            quoted(&format!("CF-Access-Client-Secret: {secret}"))
        ));
    }
    if let Some(file) = body_file {
        // curl offers `Expect: 100-continue` for a body over 1 KB. Some edges
        // never answer it, and the answer, when it comes, is a second header
        // block. Neither is wanted.
        out.push_str("header = \"Expect:\"\n");
        out.push_str("header = \"Content-Type: application/octet-stream\"\n");
        out.push_str(&format!("data-binary = {}\n", quoted(&format!("@{}", file.display()))));
    }
    // Never `location`: Access refuses by redirecting to a login page, and
    // following it would turn a refusal into a 200 full of HTML.
    out.push_str("write-out = \"%{http_code}\"\n");
    out
}

/// A value for curl's config file. Only `\` and `"` mean anything inside one.
fn quoted(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        if c == '\\' || c == '"' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// What curl's exit code meant, in words that say what to do about it.
fn curl_failed(host: &str, code: i32, stderr: &str, wait: Duration) -> String {
    match code {
        6 => format!("Could not resolve {host}."),
        7 => format!("Could not reach {host} — nothing accepted the connection."),
        28 => format!("{host} stopped replying (gave up after {}s).", wait.as_secs()),
        35 | 58 | 60 | 77 | 83 => format!(
            "The certificate for {host} could not be verified: {stderr}. A self-signed \
             certificate will not do — put a real one in front of it."
        ),
        _ if stderr.is_empty() => format!("Could not reach {host} (curl exit {code})."),
        _ => format!("Could not reach {host}: {stderr}"),
    }
}

/// Turn a status and a body into either the body or a sentence.
///
/// Kept apart from every transport so the two answer alike, and so the sentences
/// can be tested without a socket or a subprocess.
fn judge(p: &Peer, status: u16, body: Vec<u8>) -> Result<Vec<u8>, String> {
    let addr = &p.addr;
    let has_access = !p.access_id.trim().is_empty();
    // Our own 401 says exactly this. Anything else at 401, and every redirect,
    // was written by something in front of the daemon — which behind a Zero
    // Trust hostname means Access.
    let ours = body.starts_with(b"401 invalid token");
    match status {
        200 => Ok(body),
        301 | 302 | 303 | 307 | 308 => Err(access_wall(addr, has_access)),
        401 if !ours => Err(access_wall(addr, has_access)),
        401 => Err(format!("{addr} refused the token.")),
        // The far side's own refusal, which already names its switch.
        403 => Err(String::from_utf8_lossy(&body).trim().to_string()),
        404 => Err(format!("{addr} does not have that.")),
        502 | 503 | 530 => Err(format!(
            "{addr} answered {status} — the tunnel is up but nothing is behind it. \
             Is sessionhubd running on that machine?"
        )),
        other => {
            let said = String::from_utf8_lossy(&body);
            let said = said.trim();
            if said.is_empty() {
                Err(format!("{addr} answered {other}."))
            } else {
                Err(format!("{addr} answered {other}: {said}"))
            }
        }
    }
}

fn access_wall(addr: &str, has_access: bool) -> String {
    if has_access {
        format!(
            "{addr} refused the Cloudflare Access service token — check `access_id` and \
             `access_secret` for that machine in config.toml. The sessionhub token was \
             never reached."
        )
    } else {
        format!(
            "{addr} answered with a Cloudflare Access login page rather than sessionhub. \
             Add that machine's service token to config.toml as `access_id` and \
             `access_secret`."
        )
    }
}

/// A file holding the body of a PUT, removed when the request is over.
struct BodyFile(std::path::PathBuf);

impl BodyFile {
    fn new(body: &[u8]) -> Result<BodyFile, String> {
        let dir = crate::config::dir();
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!(
            ".put-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::write(&path, body)
            .map_err(|e| format!("could not stage the body in {}: {e}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(BodyFile(path))
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for BodyFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
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
    let Ok(t) = parse_addr(addr) else { return false };
    // This daemon does not serve TLS, so anything reached that way is somewhere
    // else — even if the hostname eventually comes back to this machine.
    if t.tls || t.port != our_port {
        return false;
    }
    let host = t.host;
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
    let host = match parse_addr(addr) {
        // A public hostname is long, and its tail is shared by every machine in
        // the same domain — `box.example.com` and `web.example.com` both reach
        // 24 characters looking identical, and `check_name` would then refuse
        // the name with a complaint about something nobody typed. The first
        // label is the part that differs, and it is what the machine is called.
        Ok(t) if t.tls => t.host.split('.').next().unwrap_or_default().to_string(),
        Ok(t) => t.host,
        // Not an address at all; fall back to the old reading so `:7717` and
        // other rubbish still land on `remote` rather than panicking.
        Err(_) => addr.rsplit_once(':').map(|(h, _)| h).unwrap_or(addr).to_string(),
    };
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
    let t = parse_addr(&r.addr)?;
    // A terminal tab needs a socket that can be split in two — see `pump`, which
    // hands one half to another thread and shuts the socket down from the other
    // to wake it. A TLS stream can do neither, so this is refused here, plainly,
    // rather than left to fail as an unresolvable address further down.
    if t.tls {
        return Err(format!(
            "{} is reached over https, and a terminal tab to it is not supported yet. \
             `sessionhubd run`, `push` and `pull` work, and the file panel can still \
             read its files.",
            r.name
        ));
    }
    let mut sock = dial(&t.authority())?;

    let key = handshake_key()?;
    let req = format!(
        "GET /ws?token={} HTTP/1.1\r\n\
         Host: {}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: {key}\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n",
        percent_encode(&r.token),
        t.authority(),
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
        101 => {
            // Only now that the far side has answered. After the handshake this
            // connection idles for hours waiting on output — the read deadline
            // that was useful while connecting would cut it off. Clearing it
            // any earlier left a machine that accepts TCP but never replies
            // (a bad link, a half-open socket) hanging here for good, and the
            // browser tab with it: no error, no reconnect, nothing to retry.
            let _ = sock.set_read_timeout(None);
            let _ = sock.set_write_timeout(None);
            Ok(sock)
        }
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
                access_id: String::new(),
                access_secret: String::new(),
            })
            .collect()
    }

    fn t(addr: &str) -> Target {
        parse_addr(addr).unwrap_or_else(|e| panic!("{addr} ditolak: {e}"))
    }

    #[test]
    fn an_address_says_whether_it_is_tls_and_on_what_port() {
        assert_eq!(t("https://box.example.com"), Target {
            tls: true,
            host: "box.example.com".into(),
            port: 443,
        });
        assert_eq!(t("https://box.example.com:8443").port, 8443);
        assert!(!t("box:7717").tls);
        assert!(!t("http://box:7717").tls);
        assert_eq!(t("box").port, DEFAULT_PORT, "alamat tersimpan boleh tanpa port");
        assert_eq!(t("[::1]:7717"), Target { tls: false, host: "::1".into(), port: 7717 });
        assert_eq!(t("HTTPS://Box.Example.COM").host, "box.example.com");
        assert!(parse_addr("").is_err());
        assert!(parse_addr("box:0").is_err());
        assert!(parse_addr("box:abc").is_err());
    }

    /// The one case where a scheme is ignored on purpose. A chat app pasting
    /// `https://` in front of a LAN link must not turn it into a tunnel — there
    /// is a whole test above made of exactly these manglings.
    #[test]
    fn https_in_front_of_an_ip_address_is_not_tls() {
        assert!(!t("https://10.8.0.4:7717").tls);
        assert!(!t("https://[::1]:7717").tls);
        assert!(t("https://box.example.com").tls);
    }

    /// `addr` is the identity key — re-pairing finds the row by string compare —
    /// so one machine must have exactly one spelling.
    #[test]
    fn the_stored_spelling_is_stable() {
        for addr in [
            "https://box.example.com",
            "https://box.example.com:443",
            "https://BOX.example.com/",
            "https://box.example.com:8443",
            "10.8.0.4:7717",
            "http://10.8.0.4:7717",
            "[::1]:7717",
        ] {
            let once = t(addr).canonical();
            let twice = t(&once).canonical();
            assert_eq!(once, twice, "{addr} tidak stabil");
        }
        assert_eq!(t("https://box.example.com:443").canonical(), "https://box.example.com");
        assert_eq!(t("http://10.8.0.4:7717").canonical(), "10.8.0.4:7717");
    }

    #[test]
    fn a_url_is_built_without_a_redundant_port() {
        assert_eq!(t("https://box.example.com").url("/api/status"), "https://box.example.com/api/status");
        assert_eq!(
            t("https://box.example.com:8443").url("/api/status"),
            "https://box.example.com:8443/api/status"
        );
    }

    /// A hostname needs no port; everything else still does.
    #[test]
    fn a_tls_link_may_leave_the_port_out() {
        let l = parse_link("https://box.example.com/pair#token=abc123").expect("diterima");
        assert!(l.tls);
        assert_eq!((l.port, l.addr().as_str()), (443, "https://box.example.com"));

        assert!(parse_link("sessionhub://10.8.0.4/pair#token=abc").is_err(), "LAN tetap butuh port");
        assert!(parse_link("https://box.example.com/pair").is_err(), "tanpa token tetap ditolak");
    }

    #[test]
    fn a_link_can_carry_an_access_service_token() {
        let l = parse_link("https://box.example.com/pair#token=abc&cf_id=xyz&cf_secret=shh")
            .expect("diterima");
        assert_eq!((l.access_id.as_str(), l.access_secret.as_str()), ("xyz", "shh"));
        let plain = parse_link("https://box.example.com/pair#token=abc").expect("diterima");
        assert!(plain.access_id.is_empty() && plain.access_secret.is_empty());
    }

    #[test]
    fn a_machine_behind_https_is_never_taken_for_this_one() {
        assert!(!is_self("https://box.example.com", 443));
        assert!(!is_self("https://box.example.com", 7717));
        assert!(is_self("127.0.0.1:7717", 7717), "loopback tetap dikenali");
    }

    /// Every machine in one domain shares a tail; the first label is the half
    /// that differs — and the whole hostname would break `check_name`.
    #[test]
    fn a_hostname_becomes_a_short_name() {
        assert_eq!(name_from_addr("https://box.example.com"), "box");
        let long = name_from_addr("https://a-very-long-machine.department.example.com");
        assert!(check_name(&long).is_ok(), "{long} ditolak aturannya sendiri");
        // Unchanged for everything that is not a tunnel.
        assert_eq!(name_from_addr("kantor.local:7717"), "kantor-local");
        assert_eq!(name_from_addr("10.8.0.4:7717"), "10-8-0-4");
    }

    #[test]
    fn the_curl_config_carries_everything_and_leaks_nothing() {
        let target = t("https://box.example.com");
        let c = curl_config(&target, "GET", "/api/status?token=s3cret", None, None, Duration::from_secs(30));
        assert!(c.contains(r#"url = "https://box.example.com/api/status?token=s3cret""#), "{c}");
        assert!(c.contains(r#"request = "GET""#));
        assert!(c.contains(r#"max-time = "30""#));
        assert!(c.contains("write-out = \"%{http_code}\""));
        // Following a redirect would turn an Access refusal into 200-with-HTML.
        assert!(!c.contains("location"), "{c}");
        // No body, so no reason to touch either of these.
        assert!(!c.contains("Expect:"), "{c}");
        assert!(!c.contains("CF-Access"), "{c}");

        let with_access = curl_config(
            &target,
            "PUT",
            "/api/put",
            Some(("an-id", "a-secret")),
            Some(std::path::Path::new("C:\\tmp\\body")),
            Duration::from_secs(120),
        );
        assert!(with_access.contains(r#"header = "CF-Access-Client-Id: an-id""#));
        assert!(with_access.contains(r#"header = "CF-Access-Client-Secret: a-secret""#));
        // A body over 1 KB makes curl offer `Expect: 100-continue`, and a second
        // header block is the last thing this wants.
        assert!(with_access.contains(r#"header = "Expect:""#));
        assert!(with_access.contains(r#"data-binary = "@C:\\tmp\\body""#), "{with_access}");
    }

    #[test]
    fn a_value_with_quotes_cannot_break_out_of_the_config() {
        assert_eq!(quoted(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    #[test]
    fn a_refusal_says_which_wall_it_hit() {
        let bare = Peer::at("https://box.example.com");
        let with_token = bare.clone().with_access("id", "secret");

        // Our own 401 has a body we recognise; anything else at 401 was written
        // by whatever stands in front of the daemon.
        let ours = judge(&bare, 401, b"401 invalid token\n".to_vec()).unwrap_err();
        assert!(ours.contains("refused the token"), "{ours}");

        let wall = judge(&bare, 401, b"<html>Sign in</html>".to_vec()).unwrap_err();
        assert!(wall.contains("Access login page"), "{wall}");
        assert!(wall.contains("access_id"), "{wall}");

        let redirect = judge(&bare, 302, Vec::new()).unwrap_err();
        assert!(redirect.contains("Access login page"), "{redirect}");

        let bad_token = judge(&with_token, 302, Vec::new()).unwrap_err();
        assert!(bad_token.contains("refused the Cloudflare Access service token"), "{bad_token}");

        let empty = judge(&bare, 530, Vec::new()).unwrap_err();
        assert!(empty.contains("tunnel is up"), "{empty}");

        assert_eq!(judge(&bare, 200, b"hi".to_vec()).unwrap(), b"hi");
    }

    /// Half a service token is answered with a login page, so it is refused
    /// before anything is dialled.
    #[test]
    fn half_an_access_token_is_refused_up_front() {
        let half = Peer::at("https://box.example.com").with_access("id", "");
        let why = half.access().unwrap_err();
        assert!(why.contains("half"), "{why}");
        assert!(Peer::at("https://box.example.com").access().unwrap().is_none());
        assert!(Peer::at("x:1").with_access("a", "b").access().unwrap().is_some());
    }

    /// The curl transport against a real server, when one is offered.
    ///
    /// Skipped unless `SH_CURL_TEST` names a `host:port` speaking HTTP, because
    /// a unit test must not need the network. What it is here to catch is the
    /// half that is ours rather than curl's: pulling the status back out of
    /// `--write-out`, sending a body from a file, and reading a chunked
    /// keep-alive answer — the shape a CDN produces and the plain reader in this
    /// file cannot survive.
    ///
    /// TLS itself is deliberately not part of it. Verification is curl's, and
    /// the sentence a bad certificate produces is covered by `curl_failed`.
    #[test]
    fn the_curl_transport_survives_a_real_answer() {
        let Ok(hostport) = std::env::var("SH_CURL_TEST") else { return };
        let (host, port) = hostport.rsplit_once(':').expect("host:port");
        let t = Target { tls: false, host: host.into(), port: port.parse().unwrap() };

        let (status, body) =
            request_curl(&t, "GET", "/echo?n=200000", &[], None, Duration::from_secs(30))
                .expect("GET lewat curl");
        assert_eq!(status, 200);
        assert_eq!(body.len(), 200_000, "badan chunked harus utuh");
        assert!(body.iter().all(|b| *b == b'x'));

        // A body big enough that curl would offer `Expect: 100-continue`, and
        // big enough to deadlock a same-thread writer if it went down stdin.
        let sent = vec![7u8; 3 * 1024 * 1024];
        let (status, echoed) =
            request_curl(&t, "PUT", "/back", &sent, None, Duration::from_secs(60))
                .expect("PUT lewat curl");
        assert_eq!(status, 200);
        assert_eq!(echoed.len(), sent.len(), "yang kembali harus sepanjang yang dikirim");
        assert_eq!(echoed, sent, "byte-nya harus sama persis");

        // A status that is not 200 must come back as itself, not as an error.
        let (status, _) = request_curl(&t, "GET", "/missing", &[], None, Duration::from_secs(30))
            .expect("404 tetap sebuah jawaban");
        assert_eq!(status, 404);
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
