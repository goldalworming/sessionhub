//! The HTTP front: static files + the WebSocket upgrade, one port for all of it.
//!
//! Built on a plain `TcpListener` rather than `tiny_http`, because the topology
//! the spec asks for (1 reader + 1 writer thread per client) needs a socket that
//! can be `try_clone`d. `tiny_http::Request::upgrade` fuses the read and write
//! halves into one `Box<dyn ReadWrite>` that cannot be split, and two
//! `tungstenite` instances over the same socket are not safe — `read()` also
//! writes (auto-pong), so their frames can interleave.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Sender};
use tracing::{debug, info, warn};
use tungstenite::handshake::derive_accept_key;
use tungstenite::protocol::{Role, WebSocket};
use tungstenite::Message;

use crate::config::Config;
use crate::proto::{decode_drop, decode_frame, ClientMsg};
use crate::state::{Cmd, Out, CLIENT_QUEUE};

const MAX_HEAD: usize = 16 * 1024;

/// The token is kept apart from `Config` because it is the only value that can
/// change while the daemon is alive — `sessionhubd token rotate` swaps it
/// without killing running terminals.
pub type SharedToken = Arc<RwLock<String>>;

/// Everything an accept loop needs. Kept around so the LAN listener can be
/// switched on later without rebuilding anything.
#[derive(Clone)]
struct ServeCtx {
    cfg: Arc<Config>,
    token: SharedToken,
    tx: Sender<Cmd>,
    started: Instant,
    next_id: Arc<AtomicU64>,
}

static CTX: OnceLock<ServeCtx> = OnceLock::new();
static LAN: Mutex<Option<LanListener>> = Mutex::new(None);

struct LanListener {
    /// Every address a socket was actually opened on — a machine on Wi-Fi and a
    /// VPN at once has more than one, and the other side may try any of them.
    addrs: Vec<SocketAddr>,
    /// The one worth putting in a pairing link: see `config::reach_rank`.
    shown: SocketAddr,
    stop: Arc<AtomicBool>,
}

pub fn serve(
    cfg: Config,
    token: SharedToken,
    tx: Sender<Cmd>,
    started: Instant,
) -> io::Result<()> {
    // Loopback is always bound. Network access is added as a second listener, so
    // turning it on or off never has to rebind the main socket — which means no
    // daemon restart, and no live terminal dies with it.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, cfg.port))?;
    info!(port = cfg.port, "listening on 127.0.0.1");

    let lan_wanted = cfg.lan_access;
    let ctx = ServeCtx {
        cfg: Arc::new(cfg),
        token,
        tx,
        started,
        next_id: Arc::new(AtomicU64::new(1)),
    };
    let _ = CTX.set(ctx.clone());

    if lan_wanted {
        match set_lan_access(true) {
            Ok(Some(addr)) => info!(%addr, "also listening on the local network"),
            Ok(None) => warn!("lan access is on but no local network address was found"),
            Err(e) => warn!(error = %e, "could not open the local network listener"),
        }
    }

    accept_loop(listener, ctx, None);
    Ok(())
}

/// Turn the network listener on or off. Returns the address used.
pub fn set_lan_access(on: bool) -> Result<Option<SocketAddr>, String> {
    let Some(ctx) = CTX.get() else {
        return Err("server is not running yet".into());
    };
    let mut slot = LAN.lock().map_err(|_| "lan listener state is poisoned".to_string())?;

    if let Some(existing) = slot.take() {
        existing.stop.store(true, Ordering::Relaxed);
        // Accept is blocking; one brief connection per socket wakes it so it
        // sees the stop flag and leaves on its own.
        for addr in &existing.addrs {
            let _ = TcpStream::connect_timeout(addr, Duration::from_millis(500));
        }
        info!(addrs = ?existing.addrs, "stopped listening on the local network");
    }
    if !on {
        return Ok(None);
    }

    // Every interface, not the one the default route happens to use. A machine
    // with Wi-Fi and a VPN has several addresses and no way to know which one
    // the other side will try; binding a single guess is how "network access:
    // on" came to mean "refused" for everyone on the actual LAN.
    let ips = crate::config::lan_ips();
    if ips.is_empty() {
        return Ok(None);
    }

    let stop = Arc::new(AtomicBool::new(false));
    let mut addrs = Vec::new();
    for ip in ips {
        let addr = SocketAddr::new(ip, ctx.cfg.port);
        match TcpListener::bind(addr) {
            Ok(listener) => {
                let ctx = ctx.clone();
                let flag = Arc::clone(&stop);
                thread::spawn(move || accept_loop(listener, ctx, Some(flag)));
                addrs.push(addr);
            }
            // One address refusing to bind is not fatal — an interface can
            // disappear between listing it and opening it.
            Err(e) => warn!(%addr, error = %e, "could not listen on this address"),
        }
    }
    if addrs.is_empty() {
        return Err("no local network address could be opened".into());
    }

    // `lan_ips` sorts the most reachable first, so the head is what the pairing
    // link and `status` should show.
    let shown = addrs[0];
    // Loud in the log: from this second on, the machine is reachable from the network.
    warn!(?addrs, "listening on the local network — reachable from other devices");
    *slot = Some(LanListener { addrs, shown, stop });
    Ok(Some(shown))
}

pub fn lan_listening() -> Option<SocketAddr> {
    LAN.lock().ok().and_then(|s| s.as_ref().map(|l| l.shown))
}

fn accept_loop(listener: TcpListener, ctx: ServeCtx, stop: Option<Arc<AtomicBool>>) {
    for conn in listener.incoming() {
        if stop.as_ref().is_some_and(|s| s.load(Ordering::Relaxed)) {
            return;
        }
        let sock = match conn {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "accept failed");
                continue;
            }
        };
        let cfg = Arc::clone(&ctx.cfg);
        let token = Arc::clone(&ctx.token);
        let tx = ctx.tx.clone();
        let started = ctx.started;
        let id = ctx.next_id.fetch_add(1, Ordering::Relaxed);
        thread::spawn(move || {
            if let Err(e) = handle(sock, cfg, token, tx, id, started) {
                debug!(error = %e, "connection finished");
            }
        });
    }
}

fn handle(
    sock: TcpStream,
    cfg: Arc<Config>,
    token: SharedToken,
    tx: Sender<Cmd>,
    id: u64,
    started: Instant,
) -> io::Result<()> {
    sock.set_nodelay(true)?;
    let mut sock = sock;
    let head = read_head(&mut sock)?;
    let req = Request::parse(&head).ok_or_else(|| io::Error::other("malformed request head"))?;
    let secret = token.read().map(|t| t.clone()).unwrap_or_default();

    // The token is checked before anything else — never upgrade first and check
    // after. Static assets cannot carry a token from localStorage (a <script>
    // tag has no way to add one), so a cookie carries it after coming in once
    // through /?token=…
    let from_query = req.query_param("token");
    let authed = token_ok(&secret, from_query.as_deref())
        || token_ok(&secret, req.cookie("sh_token").as_deref());
    if !authed {
        // A browser that typed the address without a token gets an input box, not
        // one line of text. The status stays 401 — only the shape of the answer
        // changes, and only for page requests.
        if wants_html(&req) {
            return respond(
                &mut sock,
                401,
                "text/html; charset=utf-8",
                signin_page(&req.path).as_bytes(),
            );
        }
        return respond(&mut sock, 401, "text/plain; charset=utf-8", b"401 invalid token\n");
    }
    let set_cookie = from_query.is_some();

    // `via` redirects this request to another paired machine. Only registered
    // names are served: if a free address were accepted, this daemon would turn
    // into an open proxy for anyone holding the token.
    if let Some(name) = req.query_param("via") {
        let Some(r) = ask_remote(&tx, &name) else {
            return respond(
                &mut sock,
                404,
                "text/plain; charset=utf-8",
                format!("404 no paired machine called `{name}`\n").as_bytes(),
            );
        };
        return match req.path.as_str() {
            "/ws" => relay_ws(sock, req, r),
            "/api/file" => relay_file(&mut sock, &req, &r),
            other => respond(
                &mut sock,
                404,
                "text/plain; charset=utf-8",
                format!("404 {other} cannot be reached through another machine\n").as_bytes(),
            ),
        };
    }

    match req.path.as_str() {
        "/ws" => upgrade(sock, req, tx, id, drop_limit(&cfg)),
        "/api/status" => api_status(&mut sock, &cfg, &tx, started),
        "/api/stop" => api_stop(&mut sock, &tx),
        "/api/reload" => api_reload(&mut sock, &token),
        "/api/file" => api_file(&mut sock, &req),
        _ => serve_static(&mut sock, &req, set_cookie, &secret),
    }
}

/// Ask the actor for a remote entry — it holds the live config. The config at
/// this layer is only a snapshot from start-up, and is already stale the moment
/// a new machine is paired.
fn ask_remote(tx: &Sender<Cmd>, name: &str) -> Option<crate::config::Remote> {
    let (reply, wait) = bounded(1);
    tx.send(Cmd::Remote { name: name.to_string(), reply }).ok()?;
    wait.recv_timeout(Duration::from_secs(3)).ok().flatten()
}

/// Forward a WebSocket to another machine's daemon, byte by byte.
///
/// No frame is interpreted here: what passes through is the protocol that
/// already exists, and that is exactly why not one line of the actor had to
/// change. Backpressure comes free too — a relay that cannot keep writing makes
/// TCP hold back the far side by itself.
fn relay_ws(sock: TcpStream, req: Request, r: crate::config::Remote) -> io::Result<()> {
    let Some(key) = req.header("sec-websocket-key") else {
        return respond(&mut { sock }, 400, "text/plain", b"400 not a websocket handshake\n");
    };

    // Connect to the far side first; if that fails, the client can still be told
    // over plain HTTP instead of getting a connection that dies suddenly.
    let far = match crate::remote::dial_ws(&r) {
        Ok(f) => f,
        Err(e) => {
            warn!(remote = %r.name, error = %e, "could not reach the paired machine");
            let mut sock = sock;
            return respond(&mut sock, 502, "text/plain; charset=utf-8", e.as_bytes());
        }
    };

    let mut sock = sock;
    let accept = derive_accept_key(key.as_bytes());
    sock.write_all(
        format!(
            "HTTP/1.1 101 Switching Protocols\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Accept: {accept}\r\n\r\n"
        )
        .as_bytes(),
    )?;
    sock.flush()?;

    info!(remote = %r.name, addr = %r.addr, "relaying a session");
    crate::remote::pump(sock, far);
    info!(remote = %r.name, "relayed session ended");
    Ok(())
}

/// Forward `GET /api/file` to another machine. The file panel uses it for images,
/// so what comes back is raw bytes along with their type.
fn relay_file(sock: &mut TcpStream, req: &Request, r: &crate::config::Remote) -> io::Result<()> {
    let Some(path) = req.query_param("path") else {
        return respond(sock, 400, "text/plain; charset=utf-8", b"400 missing path\n");
    };
    let url = format!(
        "/api/file?token={}&path={}",
        r.token,
        crate::remote::percent_encode(&path),
    );
    match crate::remote::http_get(&r.addr, &url) {
        Ok(body) => respond(sock, 200, mime_of(&path), &body),
        Err(e) => respond(sock, 502, "text/plain; charset=utf-8", e.as_bytes()),
    }
}

/// Re-read the config from disk and adopt its token. Called by `token rotate`
/// with the old token, so rotating never forces the daemon to stop.
fn api_reload(sock: &mut TcpStream, token: &SharedToken) -> io::Result<()> {
    let fresh = match crate::config::load_or_create() {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "could not reload config");
            return respond(sock, 500, "text/plain; charset=utf-8", b"could not read config\n");
        }
    };
    if let Ok(mut t) = token.write() {
        *t = fresh.token;
    }
    info!("token reloaded from config");
    respond(sock, 200, "application/json", br#"{"reloaded":true}"#)
}

/// The raw bytes of a file, for `<img src>` in the file panel.
///
/// Deliberately over plain HTTP rather than the WebSocket: the browser can cache
/// it, and the bytes do not swell by a third as base64 inside JSON. The token
/// was already checked before routing, exactly like any other asset.
fn api_file(sock: &mut TcpStream, req: &Request) -> io::Result<()> {
    let Some(raw) = req.query_param("path") else {
        return respond(sock, 400, "text/plain; charset=utf-8", b"400 missing path
");
    };
    let path = crate::browse::normalize(&raw);
    let meta = match std::fs::metadata(&path) {
        Ok(m) if m.is_file() => m,
        _ => return respond(sock, 404, "text/plain; charset=utf-8", b"404 not a file
"),
    };
    // A ceiling so one request cannot pull a 4 GB file into memory.
    if meta.len() > MAX_INLINE {
        return respond(sock, 413, "text/plain; charset=utf-8", b"413 file too large
");
    }
    let body = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            warn!(path = %path.display(), error = %e, "could not read file for /api/file");
            return respond(sock, 500, "text/plain; charset=utf-8", b"500 cannot read
");
        }
    };
    respond(sock, 200, mime_of(&path.to_string_lossy()), &body)
}

/// The limit for `/api/file`. Large enough for screenshots and assets, small
/// enough that it is not used to pull video files.
const MAX_INLINE: u64 = 25 * 1024 * 1024;

// ----------------------------------------------------------------- control

fn api_status(
    sock: &mut TcpStream,
    cfg: &Config,
    tx: &Sender<Cmd>,
    started: Instant,
) -> io::Result<()> {
    let (reply, wait) = bounded(1);
    if tx.send(Cmd::Stats { reply }).is_err() {
        return respond(sock, 500, "text/plain", b"actor is gone\n");
    }
    // If the actor is stalling, do not leave the caller hanging.
    let (alive, total) = wait
        .recv_timeout(Duration::from_secs(3))
        .unwrap_or((0, 0));

    let body = serde_json::json!({
        "pid": std::process::id(),
        "port": cfg.port,
        "uptime_secs": started.elapsed().as_secs(),
        "terminals_alive": alive,
        "terminals_total": total,
        // Used by another machine before pairing. A version mismatch surfaces
        // here — not later as a parse error mid-upgrade, which would not say
        // which side needs updating.
        "protocol": crate::remote::PROTOCOL,
        "version": env!("CARGO_PKG_VERSION"),
    })
    .to_string();
    respond(sock, 200, "application/json", body.as_bytes())
}

fn api_stop(sock: &mut TcpStream, tx: &Sender<Cmd>) -> io::Result<()> {
    respond(sock, 200, "application/json", br#"{"stopping":true}"#)?;
    let tx = tx.clone();
    // Answer first, then die — so `sessionhubd stop` knows the command landed
    // instead of guessing from a dropped connection.
    thread::spawn(move || {
        let _ = tx.send(Cmd::Shutdown);
        thread::sleep(Duration::from_millis(400));
        info!("stopping on request");
        crate::daemon::remove_pid_file();
        std::process::exit(0);
    });
    Ok(())
}

// --------------------------------------------------------------- websocket

fn upgrade(
    mut sock: TcpStream,
    req: Request,
    tx: Sender<Cmd>,
    id: u64,
    limit: usize,
) -> io::Result<()> {
    let Some(key) = req.header("sec-websocket-key") else {
        return respond(&mut sock, 400, "text/plain", b"400 not a websocket handshake\n");
    };
    if !req
        .header("upgrade")
        .map(|u| u.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
    {
        return respond(&mut sock, 400, "text/plain", b"400 missing upgrade header\n");
    }

    let accept = derive_accept_key(key.as_bytes());
    sock.write_all(
        format!(
            "HTTP/1.1 101 Switching Protocols\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Accept: {accept}\r\n\r\n"
        )
        .as_bytes(),
    )?;
    sock.flush()?;

    let read_sock = sock.try_clone()?;
    let shutdown_sock = sock.try_clone()?;
    let (out_tx, out_rx) = bounded::<Out>(CLIENT_QUEUE);

    // The actor holds the sending end; the copy of the receiving end exists only
    // to drop the oldest chunk when the queue is full.
    if tx
        .send(Cmd::ClientUp { id, tx: out_tx.clone(), rx: out_rx.clone() })
        .is_err()
    {
        return Ok(());
    }

    let writer = thread::spawn(move || {
        let mut ws = WebSocket::from_raw_socket(sock, Role::Server, None);
        for out in out_rx.iter() {
            let msg = match out {
                Out::Text(s) => Message::text(s),
                Out::Binary(b) => Message::binary(b),
                Out::Pong(p) => Message::Pong(p.into()),
            };
            if ws.write(msg).is_err() || ws.flush().is_err() {
                break;
            }
        }
        let _ = ws.close(None);
        let _ = ws.flush();
        // Wake the reader still blocked in read().
        let _ = shutdown_sock.shutdown(Shutdown::Both);
    });

    read_loop(read_sock, &tx, &out_tx, id, limit);

    // The reader's Sender is released here; once the actor releases its own on
    // ClientDown, the writer thread leaves by itself without any flag.
    drop(out_tx);
    let _ = tx.send(Cmd::ClientDown { id });
    let _ = writer.join();
    Ok(())
}

/// The upper bound on one incoming message. The browser sends a dropped file as
/// a single whole frame, so tungstenite's default (16 MiB per frame) has to
/// follow the file size limit — otherwise a large upload drops the connection
/// instead of being refused with a message someone can read.
fn drop_limit(cfg: &Config) -> usize {
    const CEILING: usize = 256 << 20;
    if cfg.drops.max_file_mb == 0 {
        // "No limit" in the config still needs a ceiling here: one WS message is
        // read into memory whole.
        return CEILING;
    }
    let want = cfg.drops.max_file_mb.saturating_add(2).saturating_mul(1 << 20);
    (want as usize).clamp(8 << 20, CEILING)
}

fn read_loop(sock: TcpStream, tx: &Sender<Cmd>, out: &Sender<Out>, id: u64, limit: usize) {
    let conf = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(limit))
        .max_frame_size(Some(limit));
    let mut ws = WebSocket::from_raw_socket(ReadHalf(sock), Role::Server, Some(conf));
    loop {
        match ws.read() {
            Ok(Message::Text(t)) => match serde_json::from_str::<ClientMsg>(t.as_str()) {
                Ok(msg) => {
                    if tx.send(Cmd::ClientMsg { id, msg }).is_err() {
                        break;
                    }
                }
                Err(e) => warn!(client = id, error = %e, "unrecognised control JSON"),
            },
            Ok(Message::Binary(b)) => {
                // A dropped file uses a marker id that can never be a real
                // terminal, so both can share one frame type without base64.
                if let Some(d) = decode_drop(&b) {
                    let cmd = Cmd::ClientDrop {
                        id,
                        term: d.term,
                        name: d.name,
                        data: d.data.to_vec(),
                    };
                    if tx.send(cmd).is_err() {
                        break;
                    }
                } else if let Some((term, data)) = decode_frame(&b) {
                    if tx
                        .send(Cmd::ClientInput { term, data: data.to_vec() })
                        .is_err()
                    {
                        break;
                    }
                }
            }
            Ok(Message::Ping(p)) => {
                // Pongs go out through the writer thread; the reading side must
                if out.send(Out::Pong(p.to_vec())).is_err() {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

/// The WebSocket read side. `Read` goes to the socket, `Write` is thrown away:
/// tungstenite answers ping/close from inside `read()`, and those bytes must
/// not reach the socket and interleave with a frame from the writer thread.
struct ReadHalf(TcpStream);

impl Read for ReadHalf {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

impl Write for ReadHalf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// ------------------------------------------------------------------- static

/// The contents of `web/` are embedded in the binary so distribution is a single
/// file. On a debug build rust-embed reads them from disk instead, so editing
/// the frontend only needs a reload.
#[derive(rust_embed::RustEmbed)]
#[folder = "web/"]
struct Web;

fn serve_static(
    sock: &mut TcpStream,
    req: &Request,
    set_cookie: bool,
    token: &str,
) -> io::Result<()> {
    let rel = match req.path.as_str() {
        "/" => "index.html",
        p => p.trim_start_matches('/'),
    };
    // `..` is never valid: rust-embed only knows relative paths inside the
    // folder, but refusing it here makes the intent explicit.
    if rel.contains("..") {
        return respond(sock, 404, "text/plain; charset=utf-8", b"404\n");
    }

    let Some(file) = Web::get(rel) else {
        return respond(sock, 404, "text/plain; charset=utf-8", b"404\n");
    };
    // The page is served with every app asset URL stamped `?v=<hash>`. That is
    // what lets an update actually arrive: a changed file changes the hash,
    // which changes the URL, and whatever any cache along the way — a phone
    // browser, a tunnel edge — held under the old URL simply stops being asked
    // for. No cache needs to be cleared, ever; stale copies just go unused.
    if rel == "index.html" {
        let html = stamp_index(&String::from_utf8_lossy(&file.data), &asset_version());
        let caching = caching_for(rel, false);
        let extra = if set_cookie {
            format!("{caching}{}", cookie_header(token))
        } else {
            caching.to_string()
        };
        return respond_with(sock, 200, mime_of(rel), html.as_bytes(), &extra);
    }
    let caching = caching_for(rel, req.query_param("v").is_some());
    let extra = if set_cookie {
        format!("{caching}{}", cookie_header(token))
    } else {
        caching.to_string()
    };
    respond_with(sock, 200, mime_of(rel), &file.data, &extra)
}

/// How long the sign-in cookie lives.
///
/// It used to have no expiry at all, which makes it a *session* cookie: the
/// browser throws it away when it closes. The next visit then lands on the
/// sign-in page — and the token sitting in `localStorage` cannot rescue it,
/// because the only code that reads `localStorage` is `app.js`, which is itself
/// behind this gate and never runs. The whole of it was retyping the token
/// after every browser restart.
///
/// 400 days is as long as a browser will honour — Chrome caps it there and
/// quietly trims anything larger — and it matches what `localStorage` already
/// does on the same origin. That is the point: this is not a new place for the
/// secret to live, it is the same lifetime the frontend already assumed. Of the
/// two, the cookie is the safer, being `HttpOnly` and so unreadable by script.
const COOKIE_MAX_AGE_SECS: u64 = 400 * 24 * 60 * 60;

/// The sign-in cookie, in one place — it used to be written out twice,
/// identically, which is one edit away from two different cookies.
///
/// `SameSite=Lax`, not `Strict`. Strict withholds the cookie on a cross-site
/// top-level navigation, and opening the app from a link — a chat message, a
/// note — is exactly that: the sign-in page appeared even with a perfectly good
/// cookie in the jar. Lax still withholds it from cross-site subresource loads
/// and form posts, which is the shape that actually matters here.
///
/// No `Secure`. The daemon is reached over plain HTTP on a LAN, and it cannot
/// tell what scheme the client used anyway once a tunnel is in front of it;
/// marking the cookie Secure would simply stop it being sent on the LAN.
fn cookie_header(token: &str) -> String {
    format!(
        "Set-Cookie: sh_token={token}; Path=/; Max-Age={COOKIE_MAX_AGE_SECS}; \
         SameSite=Lax; HttpOnly\r\n"
    )
}

/// Cache headers for one asset.
///
/// Without `Cache-Control`, a browser falls back on its own heuristics and may
/// hold an old `app.js` without ever asking again. Frontend changes then appear
/// not to apply, and the only way out is a hard reload — something a user
/// should never need to know about.
///
/// `vendor/` is excluded: it holds xterm and Monaco, which only change when
/// their version does, and Monaco alone is nearly 5 MB. Re-fetching it on every
/// load makes the first open feel heavy for no reason.
fn caching_for(rel: &str, versioned: bool) -> &'static str {
    // A `?v=<hash>` URL names one exact content: when the content changes, the
    // page asks under a new URL. So these may be cached hard — that is what
    // makes a phone open instantly — while the unversioned name stays
    // revalidated for anything that still fetches it directly.
    if rel.starts_with("vendor/") || versioned {
        "Cache-Control: public, max-age=31536000, immutable\r\n"
    } else {
        "Cache-Control: no-cache\r\n"
    }
}

/// One hash over every app file (vendor excluded — those change only with their
/// own version). Two builds serving the same bytes stamp the same version; any
/// edit to any file changes it. On a debug build rust-embed reads from disk, so
/// this also tracks live edits without a restart.
fn asset_version() -> String {
    use std::hash::Hasher;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let mut names: Vec<_> = Web::iter().filter(|n| !n.starts_with("vendor/")).collect();
    // Iteration order is not promised; the hash must not depend on it.
    names.sort();
    for name in names {
        h.write(name.as_bytes());
        if let Some(f) = Web::get(&name) {
            h.write(&f.data);
        }
    }
    format!("{:016x}", h.finish())
}

/// Stamp `?v=` onto every app asset the page references.
///
/// Two mechanisms, because assets are reached two ways:
/// - the `<link>`/`<script src>` tags are rewritten directly;
/// - an import map covers the ES modules, which reach each other through
///   `import './x.js'` statements the server never sees. The map remaps every
///   root-level module to its versioned URL at resolution time, nested imports
///   included. It must be in place before the first module loads, hence
///   injected at the top of `<head>`.
fn stamp_index(html: &str, version: &str) -> String {
    let mut out = html.to_string();
    let mut imports: Vec<String> = Vec::new();
    let mut names: Vec<_> = Web::iter().filter(|n| !n.starts_with("vendor/")).collect();
    names.sort();
    for name in &names {
        if name.ends_with(".js") {
            imports.push(format!("\"/{name}\": \"/{name}?v={version}\""));
        }
        // Tag rewriting: only the exact quoted form index.html uses.
        let plain = format!("\"/{name}\"");
        let stamped = format!("\"/{name}?v={version}\"");
        out = out.replace(&plain, &stamped);
    }
    let map = format!(
        "<script type=\"importmap\">{{\"imports\":{{{}}}}}</script>",
        imports.join(",")
    );
    out.replacen("<head>", &format!("<head>\n{map}"), 1)
}

/// A request that deserves a page rather than one line of text.
///
/// Not simply "has `Accept: text/html`": a `fetch()` from a page whose token
/// expired can carry that too, and an HTML page landing where JSON was expected
/// is more confusing than a plain 401.
fn wants_html(req: &Request) -> bool {
    if req.path == "/ws" || req.path.starts_with("/api/") {
        return false;
    }
    // A real navigation always asks for a document. This header is sent by every
    // mainstream browser and never appears on an ordinary `fetch()`.
    if req.header("sec-fetch-mode").is_some_and(|m| m == "navigate") {
        return true;
    }
    // Older browsers without Sec-Fetch-*: fall back to Accept, but only when HTML
    // is genuinely asked for ahead of `*/*`.
    req.header("accept").is_some_and(|a| a.starts_with("text/html"))
}

/// The token input box. Embedded here rather than in `web/`, because everything
/// in `web/` needs a token to fetch — so this page has to stand without a single
/// asset from there.
fn signin_page(path: &str) -> String {
    // Where to go once the token is filled in. Only our own paths are accepted;
    // anything arriving from outside could be someone else's address.
    let dest = "/";
    let _ = path;
    format!(
        r##"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sessionhub</title>
<style>
  :root {{ color-scheme: light dark; --bg:#FBFBFA; --fg:#23262A; --mut:#8A8F94;
           --bd:#E2E0DB; --ac:#4C9A8A; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#0F1113; --fg:#D6D9DC; --mut:#7C858D; --bd:#24282C; }}
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; min-height:100vh; display:flex; align-items:center;
          justify-content:center; background:var(--bg); color:var(--fg);
          font:14px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }}
  form {{ width:min(92vw, 380px); }}
  h1 {{ font-size:15px; font-weight:600; margin:0 0 4px; }}
  p {{ margin:0 0 18px; color:var(--mut); font-size:12.5px; }}
  input {{ width:100%; height:36px; padding:0 10px; color:var(--fg);
           background:transparent; border:1px solid var(--bd); border-radius:4px;
           font:13px ui-monospace, Consolas, monospace; outline:none; }}
  input:focus {{ border-color:var(--ac); }}
  button {{ margin-top:10px; width:100%; height:36px; border:0; border-radius:4px;
            background:var(--ac); color:#fff; font-size:13px; font-weight:500;
            cursor:pointer; }}
  .hint {{ margin:14px 0 0; font-size:11.5px; }}
  code {{ font-family:ui-monospace, Consolas, monospace; }}
</style></head>
<body>
  <form onsubmit="go(event)">
    <h1>sessionhub</h1>
    <p>Paste the daemon token to sign in.</p>
    <input id="t" type="password" autocomplete="off" autofocus spellcheck="false"
           placeholder="token" aria-label="Token">
    <button type="submit">Sign in</button>
    <p class="hint">The token is in <code>~/.sessionhub/config.toml</code>, or on the
       <code>url</code> line of <code>sessionhubd status</code>.</p>
  </form>
<script>
function go(e) {{
  e.preventDefault();
  var v = document.getElementById('t').value.trim();
  if (v) location.href = {dest:?} + '?token=' + encodeURIComponent(v);
}}
</script>
</body></html>
"##
    )
}

fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        // Monaco's icons arrive as TTF; without the right type Chrome refuses to
        // load them and every editor icon turns into an empty box.
        "ttf" => "font/ttf",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}

fn respond(sock: &mut TcpStream, status: u16, ctype: &str, body: &[u8]) -> io::Result<()> {
    respond_with(sock, status, ctype, body, "")
}

fn respond_with(
    sock: &mut TcpStream,
    status: u16,
    ctype: &str,
    body: &[u8],
    extra_headers: &str,
) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Error",
    };
    sock.write_all(
        format!(
            "HTTP/1.1 {status} {reason}\r\n\
             Content-Type: {ctype}\r\n\
             Content-Length: {}\r\n\
             {extra_headers}\
             Connection: close\r\n\r\n",
            body.len()
        )
        .as_bytes(),
    )?;
    sock.write_all(body)?;
    sock.flush()
}

// ------------------------------------------------------------- HTTP parsing

struct Request {
    path: String,
    query: String,
    headers: Vec<(String, String)>,
}

impl Request {
    fn parse(head: &str) -> Option<Request> {
        let mut lines = head.split("\r\n");
        let mut parts = lines.next()?.split(' ');
        let _method = parts.next()?;
        let target = parts.next()?;

        let (path, query) = match target.split_once('?') {
            Some((p, q)) => (p.to_string(), q.to_string()),
            None => (target.to_string(), String::new()),
        };

        let headers = lines
            .filter(|l| !l.is_empty())
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();

        Some(Request { path, query, headers })
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    fn cookie(&self, name: &str) -> Option<String> {
        self.header("cookie")?
            .split(';')
            .filter_map(|kv| kv.trim().split_once('='))
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.to_string())
    }

    fn query_param(&self, name: &str) -> Option<String> {
        self.query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .find(|(k, _)| *k == name)
            .map(|(_, v)| percent_decode(v))
    }
}

/// Decode `%XX` only. `+` is deliberately **not** turned into a space: that rule
/// belongs to HTML forms, while the values here come from `encodeURIComponent`,
/// which writes a space as `%20` and leaves `+` alone — and `+` really can
/// appear in a file name.
fn percent_decode(raw: &str) -> String {
    if !raw.contains('%') {
        return raw.to_string();
    }
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    // Byte sequences that are not UTF-8 are left as replacements rather than
    // dropping the request: what fails next is the file's metadata, with a far
    // more useful message.
    String::from_utf8_lossy(&out).into_owned()
}

/// Read to the end of the headers, byte by byte. Slow, but it never swallows
/// bytes belonging to a WebSocket frame that arrived in the same packet.
fn read_head(sock: &mut TcpStream) -> io::Result<String> {
    let mut buf = Vec::with_capacity(512);
    let mut byte = [0u8; 1];
    while buf.len() < MAX_HEAD {
        if sock.read(&mut byte)? == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            return String::from_utf8(buf).map_err(|_| io::Error::other("header is not UTF-8"));
        }
    }
    Err(io::Error::other("incomplete header"))
}

/// A constant-time comparison; it does not leak how many characters matched.
fn token_ok(expected: &str, given: Option<&str>) -> bool {
    let Some(given) = given else { return false };
    if given.len() != expected.len() {
        return false;
    }
    let diff = expected
        .as_bytes()
        .iter()
        .zip(given.as_bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "GET /ws?token=abc&x=1 HTTP/1.1\r\n\
                        Host: 127.0.0.1:7717\r\n\
                        Upgrade: websocket\r\n\
                        Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";

    #[test]
    fn parses_path_query_and_headers() {
        let r = Request::parse(HEAD).unwrap();
        assert_eq!(r.path, "/ws");
        assert_eq!(r.query_param("token").as_deref(), Some("abc"));
        assert_eq!(r.query_param("x").as_deref(), Some("1"));
        assert_eq!(r.query_param("tidak-ada"), None);
        assert_eq!(r.header("upgrade"), Some("websocket"));
        assert_eq!(r.header("UPGRADE"), None, "lookup memang lowercase");
    }

    #[test]
    fn parses_target_without_query() {
        let r = Request::parse("GET / HTTP/1.1\r\n\r\n").unwrap();
        assert_eq!(r.path, "/");
        assert_eq!(r.query_param("token"), None);
    }

    #[test]
    fn rejects_wrong_missing_and_truncated_tokens() {
        assert!(token_ok("rahasia", Some("rahasia")));
        assert!(!token_ok("rahasia", Some("rahasiA")));
        assert!(!token_ok("rahasia", Some("rahasi")));
        assert!(!token_ok("rahasia", Some("")));
        assert!(!token_ok("rahasia", None));
    }

    #[test]
    fn accept_key_follows_rfc6455_example() {
        // The official example from RFC 6455 §1.3.
        assert_eq!(
            derive_accept_key(b"dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }


    #[test]
    fn query_values_are_percent_decoded() {
        let req = Request::parse(
            "GET /api/file?path=C%3A%5Cdata%5Cmy%20app%5Ca.png HTTP/1.1\r\nHost: x\r\n\r\n",
        )
        .unwrap();
        assert_eq!(req.query_param("path").unwrap(), r"C:\data\my app\a.png");
    }

    #[test]
    fn a_plus_in_a_name_survives_decoding() {
        // The "+ means space" rule belongs to HTML forms, not `encodeURIComponent`.
        let req = Request::parse(
            "GET /api/file?path=c%3A%5Cc%2B%2B%5Cx.png HTTP/1.1\r\nHost: x\r\n\r\n",
        )
        .unwrap();
        assert_eq!(req.query_param("path").unwrap(), r"c:\c++\x.png");
    }

    #[test]
    fn a_broken_escape_is_left_alone_rather_than_dropping_the_request() {
        let req = Request::parse(
            "GET /x?path=50%25%zz HTTP/1.1\r\nHost: x\r\n\r\n",
        )
        .unwrap();
        assert_eq!(req.query_param("path").unwrap(), "50%%zz");
    }

    #[test]
    fn tokens_are_unaffected_by_decoding() {
        // base64url never contains `%`, so the fast path is the one taken.
        let t = "EXAMPLE-token-not-a-real-one-0123456789abcd";
        let raw = format!("GET /?token={t} HTTP/1.1\r\nHost: x\r\n\r\n");
        let req = Request::parse(&raw).unwrap();
        assert_eq!(req.query_param("token").unwrap(), t);
    }

    fn req(head: &str) -> Request {
        Request::parse(head).unwrap()
    }

    #[test]
    fn app_assets_are_never_cached_silently() {
        // This is what makes a frontend change arrive without a hard reload.
        assert_eq!(caching_for("app.js", false), "Cache-Control: no-cache\r\n");
        assert_eq!(caching_for("index.html", false), "Cache-Control: no-cache\r\n");
        assert_eq!(caching_for("keybar.js", false), "Cache-Control: no-cache\r\n");
    }

    #[test]
    fn vendor_assets_are_cached_forever() {
        // Monaco is nearly 5 MB and only changes when its version does.
        assert!(caching_for("vendor/xterm.js", false).contains("immutable"));
        assert!(caching_for("vendor/monaco/loader.js", false).contains("max-age=31536000"));
    }

    #[test]
    fn versioned_assets_are_cached_forever() {
        // A `?v=<hash>` URL names one exact content, so it may be held for
        // good; the update arrives as a different URL, not a fresher copy.
        assert!(caching_for("app.js", true).contains("immutable"));
        // But the page itself never is — it is where the fresh URLs come from.
        assert_eq!(caching_for("index.html", false), "Cache-Control: no-cache\r\n");
    }

    #[test]
    fn the_page_is_stamped_with_the_asset_version() {
        let html = "<head>\n<link rel=\"stylesheet\" href=\"/app.css\">\
                    <script type=\"module\" src=\"/app.js\"></script>\
                    <script src=\"/vendor/xterm.js\"></script>";
        let out = stamp_index(html, "abc123");
        // Tags are rewritten…
        assert!(out.contains("\"/app.css?v=abc123\""), "{out}");
        assert!(out.contains("\"/app.js?v=abc123\""), "{out}");
        // …vendor is left alone (its own caching already handles it)…
        assert!(out.contains("\"/vendor/xterm.js\""), "{out}");
        assert!(!out.contains("vendor/xterm.js?v="), "{out}");
        // …and the import map carries every module, so `import './conn.js'`
        // inside app.js resolves to a versioned URL too.
        assert!(out.contains("<script type=\"importmap\">"), "{out}");
        assert!(out.contains("\"/conn.js\": \"/conn.js?v=abc123\""), "{out}");
        assert!(out.contains("\"/sidebar.js\": \"/sidebar.js?v=abc123\""), "{out}");
        // The map must precede the first module load.
        assert!(out.find("importmap").unwrap() < out.find("/app.js?").unwrap(), "{out}");
    }

    #[test]
    fn the_asset_version_is_stable_and_real() {
        // Twice the same answer, and it looks like a hash rather than a stub.
        let a = asset_version();
        assert_eq!(a, asset_version());
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn browser_navigation_gets_a_page() {
        let r = req("GET / HTTP/1.1\r\nSec-Fetch-Mode: navigate\r\nAccept: text/html\r\n\r\n");
        assert!(wants_html(&r));
    }

    #[test]
    fn old_browsers_without_sec_fetch_get_one_too() {
        let r = req("GET / HTTP/1.1\r\nAccept: text/html,application/xhtml+xml\r\n\r\n");
        assert!(wants_html(&r));
    }

    #[test]
    fn ws_and_api_never_get_a_page() {
        // Clients here are waiting for an upgrade or JSON; an HTML page landing
        // there only becomes a misleading parse error.
        for path in ["/ws", "/api/status", "/api/file"] {
            let head = format!(
                "GET {path} HTTP/1.1\r\nSec-Fetch-Mode: navigate\r\nAccept: text/html\r\n\r\n"
            );
            assert!(!wants_html(&req(&head)), "{path} seharusnya tetap teks polos");
        }
    }

    #[test]
    fn plain_fetch_still_gets_text() {
        let r = req("GET /app.js HTTP/1.1\r\nSec-Fetch-Mode: cors\r\nAccept: */*\r\n\r\n");
        assert!(!wants_html(&r));
    }

    #[test]
    fn the_signin_page_stands_alone() {
        let page = signin_page("/");
        // Must not reference a single asset from `web/`: they all need a token, so
        // this page would render half-finished.
        assert!(!page.contains("/app.css"));
        assert!(!page.contains("/vendor/"));
        assert!(!page.contains("src="));
        assert!(page.contains("<input"));
    }

    #[test]
    fn the_destination_cannot_be_steered_from_outside() {
        // An unknown path falls back to "/", so there is no way to make this page
        // send a token to an address of someone else's choosing.
        let page = signin_page("//evil.example/x");
        assert!(!page.contains("evil.example"));
    }

    /// The cookie outlives the browser.
    ///
    /// This is the whole reason the header exists: without an expiry it is a
    /// session cookie, the browser drops it on close, and the next visit is the
    /// sign-in page again — with the token still in `localStorage` and no way to
    /// reach it, because `app.js` is behind the same gate.
    #[test]
    fn the_cookie_survives_the_browser_closing() {
        let h = cookie_header("abc");
        assert!(h.contains("Max-Age="), "no expiry makes it a session cookie: {h}");
        let secs: u64 = h
            .split("Max-Age=")
            .nth(1)
            .and_then(|s| s.split(';').next())
            .and_then(|s| s.trim().parse().ok())
            .expect("Max-Age should be a number of seconds");
        // Long enough to be worth having; not so long a browser trims it.
        assert!(secs >= 30 * 24 * 60 * 60, "too short to help: {secs}s");
        assert!(secs <= 400 * 24 * 60 * 60, "browsers cap this at 400 days: {secs}s");
    }

    /// Arriving by a link from somewhere else still carries the cookie.
    ///
    /// `Strict` withholds it on a cross-site top-level navigation, which is what
    /// opening the app from a chat message is — the sign-in page appeared with a
    /// good cookie in the jar.
    #[test]
    fn a_link_from_elsewhere_still_arrives_signed_in() {
        let h = cookie_header("abc");
        assert!(h.contains("SameSite=Lax"), "{h}");
        assert!(!h.contains("SameSite=Strict"), "{h}");
    }

    #[test]
    fn the_cookie_is_scoped_and_hidden_from_scripts() {
        let h = cookie_header("abc");
        assert!(h.contains("sh_token=abc"));
        // Every asset lives under the root, so the cookie has to as well.
        assert!(h.contains("Path=/"));
        // The frontend takes its token from the query string; nothing reads this
        // one from script, and keeping it unreadable is what makes it the safer
        // of the two places the secret lives.
        assert!(h.contains("HttpOnly"));
        // A header is one line and must end as one.
        assert!(h.ends_with("\r\n"));
        assert_eq!(h.matches("\r\n").count(), 1);
        // No `Secure`: the LAN is plain HTTP, and the daemon cannot see through a
        // tunnel to know otherwise. Marking it Secure would stop it being sent.
        assert!(!h.contains("Secure"));
    }
}
