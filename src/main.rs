//! sessionhubd — a terminal daemon for coding agents.
//!
//! Steps 1-3: PTY + the WS protocol, multi-client with a ring buffer and size
//! negotiation, then the daemon lifecycle (detach, status, stop, service).
//! The session registry and the frontend came after.

mod config;
mod browse;
mod daemon;
mod drops;
mod files;
mod http;
mod memory;
mod proto;
mod pty;
mod registry;
mod remote;
mod ring;
mod service;
mod state;
mod tray;
mod tunnel;
mod typed;
mod webpack;
mod update;

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::unbounded;
use tracing::error;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let cmd = argv.first().map(String::as_str).unwrap_or("start");

    // `--home` beats the environment: a service runs under another account,
    // whose %USERPROFILE% is not the user's.
    let home = flag_value(&argv, "--home").map(PathBuf::from);
    if let Some(h) = &home {
        config::set_home(h.clone());
    }

    // Before anything else, and before the first thread exists: this daemon is
    // usually started without a terminal, so the PATH it inherits is nearly
    // empty and every agent would be reported as not installed.
    #[cfg(unix)]
    if let Some(path) = pty::adopt_login_path() {
        tracing::debug!(%path, "adopted PATH from the login shell");
    }

    match cmd {
        "start" if has_flag(&argv, "--foreground") => {
            run_daemon(home);
            ExitCode::SUCCESS
        }
        "start" => cmd_start(&argv, home, true),
        "stop" => cmd_stop(),
        "restart" => cmd_restart(&argv, home),
        "status" => cmd_status(),
        "install" => cmd_install(&argv, home),
        "uninstall" => cmd_uninstall(),
        "service-run" => match service::platform::run(home.as_deref()) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("service failed: {e}");
                ExitCode::FAILURE
            }
        },
        "token" => match argv.get(1).map(String::as_str) {
            Some("rotate") => cmd_token_rotate(),
            _ => {
                eprintln!("Usage: sessionhubd token rotate");
                ExitCode::from(2)
            }
        },
        "tray" => tray::run(home),
        "tunnel" => cmd_tunnel(),
        "bundle-web" => cmd_bundle_web(&argv),
        "revert-web" => cmd_revert_web(),
        "help" | "--help" | "-h" => {
            print_help();
            ExitCode::SUCCESS
        }
        other => {
            eprintln!("Unknown command `{other}`.\n");
            print_help();
            hold_console_open();
            ExitCode::from(2)
        }
    }
}

fn print_help() {
    println!(
        "sessionhubd — keeps coding agent terminals alive independently of the UI\n\
         \n\
         sessionhubd start [--foreground] [--no-open]  run; detaches and exits by default\n\
         sessionhubd stop                   stop the running daemon\n\
         sessionhubd restart [--force]      stop and start again, to load a new build\n\
         sessionhubd status                 port, live terminal count, uptime\n\
         sessionhubd token rotate           replace the token; the old one stops working\n\
         sessionhubd tray                   show the tray icon; `start` does this too\n\
         sessionhubd tunnel                 expose it externally through cloudflared\n\
         sessionhubd bundle-web FILE [--raw]  pack the frontend for a release\n\
         sessionhubd revert-web             drop an installed interface, back to the built-in\n\
         sessionhubd install [--account NAME --password SECRET]\n\
         sessionhubd uninstall\n\
         \n\
         --home PATH   use a specific home directory (used by service mode)\n\
         --no-open     do not open a browser at the address it just printed\n\
         --no-tray     do not put an icon in the tray or the menu bar\n"
    );
}

// ------------------------------------------------------------------ commands

/// `open_browser` is what the command wants by default: `start` opens the
/// address, `restart` does not — the tab that prompted the restart is already
/// sitting there. `--no-open` overrides either way.
fn cmd_start(argv: &[String], home: Option<PathBuf>, open_browser: bool) -> ExitCode {
    let Some(cfg) = load_config() else { return ExitCode::FAILURE };
    let open = open_browser && !has_flag(argv, "--no-open");

    // Running it again is how someone who lost the address asks for it back —
    // most likely after double-clicking the exe and watching the window vanish
    // with the url still in it. So this is not an error: say where the daemon
    // is and open it.
    let running = daemon::read_pid_file().map(|p| p.port).unwrap_or(cfg.port);
    if let Some(s) = daemon::probe(running, &cfg.token) {
        println!("sessionhubd is already running.");
        println!("  pid    : {}", s.pid);
        print_access(&cfg, s.port, open, argv, home.as_ref());
        println!("\nStop it with: sessionhubd stop");
        hold_console_open();
        return ExitCode::SUCCESS;
    }

    match daemon::spawn_detached(&cfg, home.as_ref()) {
        Ok(port) => {
            let status = daemon::probe(port, &cfg.token);
            println!("sessionhubd is running, detached from this terminal.");
            if let Some(s) = status {
                println!("  pid    : {}", s.pid);
            }
            print_access(&cfg, port, open, argv, home.as_ref());
            println!("\nClose this terminal any time — the daemon keeps running.");
            println!("Stop it with: sessionhubd stop");
            hold_console_open();
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Could not start the daemon: {e}");
            eprintln!("See {}", config::log_path().display());
            hold_console_open();
            ExitCode::FAILURE
        }
    }
}

/// The address, the log, and — when asked — a browser pointed at it. Printing
/// the url is not enough on its own: a double-clicked exe prints into a console
/// window that closes half a second later, so the line nobody could read has to
/// arrive somewhere that stays.
fn print_access(
    cfg: &config::Config,
    port: u16,
    open: bool,
    argv: &[String],
    home: Option<&PathBuf>,
) {
    let url = format!("http://127.0.0.1:{port}/?token={}", cfg.token);
    println!("  url    : {url}");
    println!("  log    : {}", config::log_path().display());
    ensure_tray(argv, home);
    print_lan_access(cfg, port);
    if open {
        match open_url(&url) {
            Ok(()) => println!("\nOpening it in your browser…"),
            Err(e) => println!("\nCould not open a browser ({e}); open the url above by hand."),
        }
    }
}

/// A window that closes itself is a poor place to keep the only copy of the
/// address. The icon stays: it is a second process, it outlives this command,
/// and it answers both of the questions a vanished console left behind.
fn ensure_tray(argv: &[String], home: Option<&PathBuf>) {
    #[cfg(any(windows, target_os = "macos"))]
    if !has_flag(argv, "--no-tray") && daemon::spawn_tray(home).is_ok() {
        let where_ = if cfg!(windows) { "the notification area" } else { "the menu bar" };
        println!("  tray   : in {where_} — open or stop it from there");
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = (argv, home);
}

/// Hand the url to whatever the desktop opens one with. Nothing here waits for
/// the browser: it is a request, not a child process this command owns.
fn open_url(url: &str) -> std::io::Result<()> {
    use std::process::{Command, Stdio};

    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        // One raw argument, so the url keeps its `?` and `&` instead of being
        // taken apart by cmd's own quoting. The empty `""` is the window title
        // `start` would otherwise read the url as.
        c.raw_arg(format!("/C start \"\" \"{url}\""));
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };

    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    Ok(())
}

/// Show a file the way [`open_url`] shows a page — but check that something
/// took it.
///
/// `.log` is an extension Windows does not know unless an editor claimed it,
/// and `start` on a file with no app behind it fails into the console that was
/// deliberately never shown. From a menu, that reads as a dead item. So wait
/// for `start` to say whether it handed the file over, and if it did not, use
/// the editor that is on every Windows there is.
#[cfg(windows)]
fn open_file(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    // `start` returns as soon as it has launched something, so this waits on
    // cmd's own exit, not on whatever opened the file.
    let handed_over = Command::new("cmd")
        .raw_arg(format!("/C start \"\" \"{}\"", path.display()))
        .creation_flags(0x0800_0000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if handed_over {
        return Ok(());
    }

    Command::new("notepad.exe")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}

/// On macOS `open` asks Launch Services, which offers a chooser rather than
/// failing when nothing owns the extension. There is nothing to fall back to.
#[cfg(target_os = "macos")]
fn open_file(path: &std::path::Path) -> std::io::Result<()> {
    open_url(&path.display().to_string())
}

/// True when this process is the only one attached to its console — the shape
/// of a double-click from Explorer, where the console was made for us alone and
/// dies with us. Started from a terminal there is a shell attached as well.
#[cfg(windows)]
fn owns_console() -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetConsoleProcessList(list: *mut u32, count: u32) -> u32;
    }
    let mut pids = [0u32; 8];
    // The count of processes attached, or 0 when there is no console at all.
    unsafe { GetConsoleProcessList(pids.as_mut_ptr(), pids.len() as u32) == 1 }
}

#[cfg(not(windows))]
fn owns_console() -> bool {
    // Finder opens a binary through Terminal.app, and that window stays after
    // the process exits. There is nothing to hold.
    false
}

/// Keep a double-clicked window on screen long enough to read. From a terminal
/// this does nothing — a shell is not a window that needs holding.
fn hold_console_open() {
    if !owns_console() {
        return;
    }
    println!("\nPress Enter to close this window. The daemon keeps running without it.");
    let _ = std::io::stdin().read_line(&mut String::new());
}

/// When network access is on, show the address other devices can really open —
/// along with what was just opened.
fn print_lan_access(cfg: &config::Config, port: u16) {
    if !cfg.lan_access {
        return;
    }
    match config::lan_ip() {
        Some(ip) => println!("  network: http://{ip}:{port}/?token={}", cfg.token),
        None => println!("  network: on, but no address was found (run `ipconfig`)"),
    }
    println!("\nWARNING: network access is on, so this daemon is reachable from your network.");
    println!("Anyone on it who has the URL and token can run commands on this machine,");
    println!("and the token travels in the clear over plain HTTP. Turn it off in");
    println!("Settings → Network access when you no longer need it.");
    if cfg!(windows) {
        println!("\nIf other devices still cannot connect, Windows Firewall is blocking the");
        println!("port. From an Administrator terminal:");
        println!(
            "  netsh advfirewall firewall add rule name=\"sessionhubd\" dir=in action=allow \
             protocol=TCP localport={port}"
        );
    }
}

fn cmd_status() -> ExitCode {
    let Some(cfg) = load_config() else { return ExitCode::FAILURE };
    let pidfile = daemon::read_pid_file();
    let port = pidfile.map(|p| p.port).unwrap_or(cfg.port);

    match daemon::probe(port, &cfg.token) {
        Some(s) => {
            println!("sessionhubd is running");
            println!("  pid      : {}", s.pid);
            println!("  port     : {}", s.port);
            println!(
                "  network  : {}",
                match (cfg.lan_access, config::lan_ip()) {
                    (true, Some(ip)) => format!("on — http://{ip}:{}", s.port),
                    (true, None) => "on".to_string(),
                    (false, _) => "off (127.0.0.1 only)".to_string(),
                }
            );
            println!("  uptime   : {}", daemon::human_uptime(s.uptime_secs));
            println!("  terminals: {} live of {} total", s.terminals_alive, s.terminals_total);
            println!("  service  : {}", if service::platform::is_installed() { "installed" } else { "not installed" });
            ExitCode::SUCCESS
        }
        None => {
            match pidfile {
                Some(p) if daemon::process_alive(p.pid) => {
                    println!("sessionhubd is not answering on port {port}, but pid {} is still alive.", p.pid);
                    println!("Check {}", config::log_path().display());
                }
                Some(p) => {
                    println!("sessionhubd is not running (pid file points at {}, which is gone).", p.pid);
                    daemon::remove_pid_file();
                }
                None => println!("sessionhubd is not running."),
            }
            ExitCode::from(1)
        }
    }
}

fn cmd_stop() -> ExitCode {
    if stop_daemon() { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

/// Stop the daemon if it is running. `true` when nothing is left behind —
/// including the case where it was not running to begin with.
///
/// Split out of `cmd_stop` so `restart` can reuse it: `ExitCode` cannot be
/// compared, so a restart built on `cmd_stop` would have no way to tell whether
/// the stop actually worked before starting again.
fn stop_daemon() -> bool {
    let Some(cfg) = load_config() else { return false };
    let pidfile = daemon::read_pid_file();
    let port = pidfile.map(|p| p.port).unwrap_or(cfg.port);

    let Some(status) = daemon::probe(port, &cfg.token) else {
        // No answer: if the pid is still alive, that is a stuck process.
        if let Some(p) = pidfile {
            if daemon::process_alive(p.pid) {
                println!("Daemon is not answering; force-killing pid {}.", p.pid);
                daemon::force_kill(p.pid);
                daemon::remove_pid_file();
                return true;
            }
            daemon::remove_pid_file();
        }
        println!("sessionhubd is not running.");
        return true;
    };

    if status.terminals_alive > 0 {
        println!("Stopping {} live terminal(s)…", status.terminals_alive);
    }
    if !daemon::request_stop(port, &cfg.token) {
        eprintln!("The daemon refused the stop command.");
        return false;
    }
    if daemon::wait_gone(status.pid, Duration::from_secs(10)) {
        daemon::remove_pid_file();
        println!("sessionhubd stopped.");
    } else {
        println!("Still alive after 10 seconds; force-killing.");
        daemon::force_kill(status.pid);
        daemon::remove_pid_file();
    }
    true
}

/// Stop and start again — the way a new build actually gets served.
///
/// `token rotate` can reach a running daemon through `/api/reload`, but that
/// only re-reads the config. A changed binary — new Rust, or the `web/` assets
/// baked into a release build — cannot be loaded into a process that is already
/// running. Replacing the process is the only way, and doing it by hand means
/// remembering the `--home` that daemon was started with.
///
/// It ENDS every live terminal. The shells and agents are children of the
/// daemon and die with it, so this refuses while any are running unless it is
/// told plainly to go ahead: losing an agent session to a command that sounded
/// routine is not a trade anyone would pick on purpose.
fn cmd_restart(argv: &[String], home: Option<PathBuf>) -> ExitCode {
    let Some(cfg) = load_config() else { return ExitCode::FAILURE };
    let port = daemon::read_pid_file().map(|p| p.port).unwrap_or(cfg.port);

    match daemon::probe(port, &cfg.token) {
        Some(status) if status.terminals_alive > 0 && !has_flag(argv, "--force") => {
            eprintln!(
                "{} live terminal(s) would be killed: they are children of the daemon\n\
                 and cannot outlive it. Nothing has been stopped.\n\
                 \n\
                 Run `sessionhubd restart --force` to go ahead anyway.",
                status.terminals_alive
            );
            return ExitCode::from(2);
        }
        Some(_) => {
            if !stop_daemon() {
                eprintln!("Not restarting: the daemon is still up.");
                return ExitCode::FAILURE;
            }
        }
        None => println!("sessionhubd was not running; starting it."),
    }
    cmd_start(argv, home, false)
}

fn cmd_install(argv: &[String], home: Option<PathBuf>) -> ExitCode {
    let opts = service::platform::InstallOpts {
        home: home.unwrap_or_else(config::home),
        account: flag_value(argv, "--account"),
        password: flag_value(argv, "--password"),
    };
    if opts.account.is_none() && cfg!(windows) {
        println!(
            "Note: without --account the service runs as LocalSystem, so agents run as\n\
             SYSTEM too — your agent credentials and config may not be visible to them.\n\
             For everyday use:\n  \
             sessionhubd install --account \"{}\" --password \"…\"\n",
            whoami()
        );
    }
    match service::platform::install(&opts) {
        Ok(msg) => {
            println!("service `{}` {msg}", service::SERVICE_NAME);
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Could not install the service: {e}");
            ExitCode::FAILURE
        }
    }
}

fn cmd_uninstall() -> ExitCode {
    match service::platform::uninstall() {
        Ok(()) => {
            println!("service `{}` removed.", service::SERVICE_NAME);
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Could not remove the service: {e}");
            ExitCode::FAILURE
        }
    }
}

fn cmd_token_rotate() -> ExitCode {
    let Some(old) = load_config() else { return ExitCode::FAILURE };
    let running = daemon::read_pid_file().map(|p| p.port).unwrap_or(old.port);
    let was_up = daemon::probe(running, &old.token).is_some();

    let token = match config::rotate_token() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Could not write the new token: {e}");
            return ExitCode::FAILURE;
        }
    };

    // A running daemon is told using the OLD token — the one moment the old
    // token is still useful. Live terminals are not disturbed.
    if was_up {
        if daemon::request_reload(running, &old.token) {
            println!("Token replaced and already in effect.");
        } else {
            println!("Token replaced, but the daemon did not acknowledge it.");
            println!("Run `sessionhubd stop` then `sessionhubd start` to apply it.");
        }
    } else {
        println!("Token replaced. It takes effect when the daemon starts.");
    }

    println!("\nNew address:\n  http://127.0.0.1:{running}/?token={token}");
    println!("\nBrowser tabs still open use the old token and will be rejected;");
    println!("open the address above once to refresh them.");
    ExitCode::SUCCESS
}

/// Pack the frontend this binary carries into one file, for a release.
///
/// Built from the embedded assets rather than from `web/` on disk, so the bundle
/// is exactly what this binary would have served. A release built from a
/// different tree than the bundle is the one mistake this whole scheme must not
/// make quietly.
fn cmd_bundle_web(argv: &[String]) -> ExitCode {
    // `--raw` skips the bundler. It exists so this command still works on a
    // machine without bun — packing a slower frontend is worth more than
    // refusing to cut a release at all — and so a bundling bug can be stepped
    // around without unpicking anything.
    let raw = argv.iter().any(|a| a == "--raw");
    let Some(out) = argv.iter().skip(1).find(|a| !a.starts_with("--")) else {
        eprintln!("Usage: sessionhubd bundle-web FILE [--raw]");
        return ExitCode::from(2);
    };
    let mut files = http::embedded_app_files();
    let version = match files.get("version.json") {
        Some(json) => match webpack::parse_version(json) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("web/version.json is not usable: {e}");
                return ExitCode::FAILURE;
            }
        },
        None => {
            eprintln!("web/version.json is missing — the bundle needs it to declare its version.");
            return ExitCode::FAILURE;
        }
    };
    let squashed = if raw {
        println!("--raw: packing {} files unbundled", files.len());
        None
    } else {
        match webpack::bundle_modules(&mut files) {
            Ok(b) => Some(b),
            Err(e) => {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
        }
    };
    let bytes = webpack::pack(&files);
    // Read it back before claiming success: a bundle that cannot be unpacked is
    // worse than no bundle, because it only fails on someone else's machine.
    if let Err(e) = webpack::unpack(&bytes) {
        eprintln!("the bundle just written cannot be read back: {e}");
        return ExitCode::FAILURE;
    }
    if let Err(e) = std::fs::write(out, &bytes) {
        eprintln!("could not write {out}: {e}");
        return ExitCode::FAILURE;
    }
    println!("frontend {} packed into {out}", version.version);
    println!("  files  : {}", files.len());
    println!("  size   : {:.0} KB", bytes.len() as f64 / 1024.0);
    if let Some(b) = squashed {
        println!(
            "  modules: {} squashed into app.js, {:.0} KB → {:.0} KB",
            b.modules,
            b.before as f64 / 1024.0,
            b.after as f64 / 1024.0
        );
    }
    println!("  needs  : sessionhub {} or newer", version.needs_daemon);
    ExitCode::SUCCESS
}

/// Throw away an installed interface and go back to the one inside the binary.
///
/// A command rather than a button, because the case it exists for is an
/// interface that does not work — and then there is no button to press. The
/// daemon serves the built-in copy again on the next page load, with nothing to
/// restart.
fn cmd_revert_web() -> ExitCode {
    match webpack::installed() {
        Ok(None) => {
            println!("No interface is installed; the built-in one is already what is served.");
            return ExitCode::SUCCESS;
        }
        Ok(Some(v)) => println!("Removing interface {}…", v.version),
        // Refused for needing a newer daemon, and still worth removing — that is
        // one of the states someone would be trying to get out of.
        Err(why) => println!("Removing the installed interface ({why})…"),
    }
    match webpack::remove_installed() {
        Ok(()) => {
            println!("Done. Reload the page; the built-in interface is served again.");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Could not remove it: {e}");
            ExitCode::FAILURE
        }
    }
}

fn cmd_tunnel() -> ExitCode {
    let Some(cfg) = load_config() else { return ExitCode::FAILURE };
    let port = daemon::read_pid_file().map(|p| p.port).unwrap_or(cfg.port);

    if daemon::probe(port, &cfg.token).is_none() {
        eprintln!("sessionhubd is not running yet. Run `sessionhubd start` first.");
        return ExitCode::FAILURE;
    }

    let Some(exe) = pty::resolve_command("cloudflared") else {
        eprintln!("{}", tunnel::install_hint());
        return ExitCode::FAILURE;
    };

    println!("Opening a tunnel to http://127.0.0.1:{port} through cloudflared…");
    println!("WARNING: this exposes your shell to the internet. Anyone holding the");
    println!("URL and its token can run commands on this machine.\n");

    let mut t = match tunnel::Tunnel::spawn(&exe, port) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Could not run cloudflared: {e}");
            return ExitCode::FAILURE;
        }
    };

    let mut announced = false;
    loop {
        match t.lines.recv_timeout(Duration::from_millis(500)) {
            Ok(line) => {
                if !announced {
                    if let Some(url) = tunnel::extract_url(&line) {
                        announced = true;
                        println!("Tunnel ready:\n  {url}/?token={}\n", cfg.token);
                        println!("Press Ctrl+C to close it.");
                        println!("Consider putting Cloudflare Access in front of this hostname —");
                        println!("a token alone is not an adequate layer for a shell.\n");
                        continue;
                    }
                }
                // The rest of cloudflared's log is passed through as-is so a
                // failure does not turn into silence.
                if !announced {
                    eprintln!("  {line}");
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if t.try_wait() {
                    eprintln!("cloudflared exited before the tunnel was ready.");
                    return ExitCode::FAILURE;
                }
            }
            Err(_) => break,
        }
    }
    t.kill();
    ExitCode::SUCCESS
}

fn whoami() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".into());
    match std::env::var("USERDOMAIN") {
        Ok(d) => format!("{d}\\{user}"),
        Err(_) => user,
    }
}

// --------------------------------------------------------------------- core

/// Run the daemon in this process until it finishes. Used by
/// `start --foreground` and by service mode.
pub fn run_daemon(home: Option<PathBuf>) {
    if let Some(h) = home {
        config::set_home(h);
    }
    let Some(cfg) = load_config() else { return };

    init_logging();
    let started = Instant::now();

    if let Err(e) = daemon::write_pid_file(cfg.port) {
        error!(error = %e, "could not write pid file");
    }

    println!("sessionhubd di http://127.0.0.1:{}", cfg.port);
    println!("  config : {}", config::config_path().display());
    println!("  log    : {}", config::log_path().display());
    println!("  ws     : ws://127.0.0.1:{}/ws?token={}", cfg.port, cfg.token);
    print_lan_access(&cfg, cfg.port);

    // Sweep once at start: a daemon that died yesterday left drop files past
    // their age, and nothing else cleans them up.
    drops::sweep(&cfg.drops);

    let token: http::SharedToken = Arc::new(RwLock::new(cfg.token.clone()));

    let (tx, rx) = unbounded();

    // Scanning and the file watcher live on their own thread: both read
    // hundreds of files and call external CLIs, which must not stall the actor.
    let registry_cfg = registry::spawn(cfg.clone(), tx.clone());

    let actor_cfg = cfg.clone();
    let actor_tx = tx.clone();
    let actor = thread::spawn(move || state::run(actor_cfg, rx, actor_tx, registry_cfg));

    if let Err(e) = http::serve(cfg, token, tx, started) {
        error!(error = %e, "server stopped");
        eprintln!("Could not bind the port: {e}");
        daemon::remove_pid_file();
        return;
    }
    let _ = actor.join();
    daemon::remove_pid_file();
}

fn load_config() -> Option<config::Config> {
    match config::load_or_create() {
        Ok(c) => Some(c),
        Err(e) => {
            eprintln!("Could not read {}: {e}", config::config_path().display());
            None
        }
    }
}

// ------------------------------------------------------------------- arguments

fn has_flag(argv: &[String], name: &str) -> bool {
    argv.iter().any(|a| a == name)
}

fn flag_value(argv: &[String], name: &str) -> Option<String> {
    let i = argv.iter().position(|a| a == name)?;
    argv.get(i + 1).filter(|v| !v.starts_with("--")).cloned()
}

// ------------------------------------------------------------------- logging

/// Log to a file — required once the daemon leaves the terminal and has no
/// console left — and to stderr as well while still in the foreground.
fn init_logging() {
    let _ = std::fs::create_dir_all(config::dir());
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(config::log_path())
        .ok()
        .map(|f| Arc::new(Mutex::new(f)));

    let make = move || Tee { file: file.clone() };
    let _ = tracing_subscriber::fmt().with_ansi(false).with_writer(make).try_init();
}

struct Tee {
    file: Option<Arc<Mutex<File>>>,
}

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let Some(f) = &self.file {
            if let Ok(mut f) = f.lock() {
                let _ = f.write_all(buf);
            }
        }
        // A detached process has no stderr; failing there is not an error.
        let _ = std::io::stderr().write_all(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if let Some(f) = &self.file {
            if let Ok(mut f) = f.lock() {
                let _ = f.flush();
            }
        }
        let _ = std::io::stderr().flush();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detects_boolean_flags() {
        assert!(has_flag(&argv(&["start", "--foreground"]), "--foreground"));
        assert!(!has_flag(&argv(&["start"]), "--foreground"));
    }

    #[test]
    fn reads_flag_values() {
        let a = argv(&["install", "--home", "C:\\Users\\user", "--account", "DOM\\u"]);
        assert_eq!(flag_value(&a, "--home").as_deref(), Some("C:\\Users\\user"));
        assert_eq!(flag_value(&a, "--account").as_deref(), Some("DOM\\u"));
        assert_eq!(flag_value(&a, "--password"), None);
    }

    #[test]
    fn flag_without_value_is_not_swallowed_by_next_flag() {
        // `--home` without a value must not swallow `--foreground` as its path.
        let a = argv(&["start", "--home", "--foreground"]);
        assert_eq!(flag_value(&a, "--home"), None);
        assert!(has_flag(&a, "--foreground"));
    }

    #[test]
    fn flag_at_end_without_value_is_none() {
        assert_eq!(flag_value(&argv(&["install", "--home"]), "--home"), None);
    }
}
