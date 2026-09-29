//! sessionhubd — a terminal daemon for coding agents.
//!
//! Steps 1-3: PTY + the WS protocol, multi-client with a ring buffer and size
//! negotiation, then the daemon lifecycle (detach, status, stop, service).
//! The session registry and the frontend came after.

mod ansi;
mod config;
mod browse;
mod cloudflare;
mod daemon;
mod drops;
mod exec;
mod files;
mod http;
mod memory;
mod proto;
mod pty;
mod registry;
mod remote;
mod ring;
mod service;
mod skill;
mod state;
mod tasks;
mod tray;
mod tunnel;
mod typed;
mod webpack;
mod update;
mod telemetry;

use std::collections::BTreeMap;
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
        "machines" => cmd_machines(),
        "run" => cmd_run(&argv),
        "push" => cmd_push(&argv),
        "pull" => cmd_pull(&argv),
        "ls" => cmd_ls(&argv),
        "spawn" => cmd_spawn(&argv),
        "send" => cmd_send(&argv),
        "capture" => cmd_capture(&argv),
        "wait" => cmd_wait(&argv),
        "tray" => tray::run(home),
        "tunnel" => cmd_tunnel(),
        "bundle-web" => cmd_bundle_web(&argv),
        "install-web" => cmd_install_web(&argv),
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
         sessionhubd start [--foreground] [--no-open] [--no-wait]\n\
         \x20                                 run; detaches and exits by default\n\
         sessionhubd stop                   stop the running daemon\n\
         sessionhubd restart [--force]      stop and start again, to load a new build\n\
         sessionhubd status                 port, live terminal count, uptime\n\
         sessionhubd token rotate           replace the token; the old one stops working\n\
         \n\
         Working on a paired machine — like ssh, but to any machine sessionhub reaches:\n\
         sessionhubd machines               the machines paired with this one\n\
         sessionhubd run --on NAME [--cwd DIR] [--timeout SECONDS] -- COMMAND…\n\
         \x20                                 run it there; its exit code becomes ours\n\
         sessionhubd push --on NAME LOCAL THERE    send one file\n\
         sessionhubd pull --on NAME THERE LOCAL    fetch one file\n\
         \x20                                 a whole folder: tar it, push it, run tar -xzf\n\
         \n\
         Driving a terminal from a script — every one of these takes [--on NAME]\n\
         to reach it on a paired machine instead of this one:\n\
         sessionhubd ls [--json]             live terminals: id, name, agent, project, status\n\
         sessionhubd spawn --agent NAME --project DIR [--resume ID] [--name NAME]\n\
         \x20                                 [--env NAME=VALUE | --env NAME]…\n\
         \x20                                 start one, prints its id — --env NAME (no\n\
         \x20                                 value) reads this shell's own environment,\n\
         \x20                                 so a secret is never typed on the command line\n\
         sessionhubd send <id-or-name> [--file PATH | TEXT] [--enter] [--key NAME]…\n\
         \x20                                 [--from LABEL] [--raw] [--verify]\n\
         \x20                                 text with no --file reads stdin\n\
         sessionhubd capture <id-or-name> [--lines N] [--raw] [--json]\n\
         \x20                                 what is on screen, as plain text\n\
         sessionhubd wait <id-or-name> [--idle SECONDS] [--timeout SECONDS]\n\
         \x20                                 until quiet, or the process ends\n\
         \n\
         sessionhubd tray                   show the tray icon; `start` does this too\n\
         sessionhubd tunnel                 expose it externally through cloudflared\n\
         sessionhubd bundle-web FILE [--raw]  pack the frontend for a release\n\
         sessionhubd install-web FILE       install a .shweb already on disk, no download\n\
         sessionhubd revert-web             drop an installed interface, back to the built-in\n\
         sessionhubd install [--account NAME --password SECRET]\n\
         sessionhubd uninstall\n\
         \n\
         --home PATH   use a specific home directory (used by service mode)\n\
         --no-open     do not open a browser at the address it just printed\n\
         --no-wait     close a double-clicked window straight away, not on Enter\n\
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
    // The installer's start-at-login shortcut opens a console like a
    // double-click does, and nobody is there at login to press Enter.
    let hold = || {
        if !has_flag(argv, "--no-wait") {
            hold_console_open();
        }
    };

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
        hold();
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
            hold();
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Could not start the daemon: {e}");
            eprintln!("See {}", config::log_path().display());
            hold();
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

/// Install a `.shweb` already sitting on disk, without asking GitHub for it.
///
/// Settings does the same thing over HTTPS, and that is the way to go when it
/// works. This is for when it does not — a network that cannot reach
/// github.com, the exact reason `push_to_mac.py` carries the source over SFTP
/// instead. Whatever daemon is already running this machine's `~/.sessionhub`
/// picks the file up on the next page load; nothing here restarts it.
fn cmd_install_web(argv: &[String]) -> ExitCode {
    let Some(path) = argv.iter().skip(1).find(|a| !a.starts_with("--")) else {
        eprintln!("Usage: sessionhubd install-web FILE.shweb");
        return ExitCode::from(2);
    };
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("could not read {path}: {e}");
            return ExitCode::FAILURE;
        }
    };
    match webpack::install(&bytes, update::current()) {
        Ok(v) => {
            println!("installed frontend {}", v.version);
            println!("Reload the page — the daemon already running picks it up with no restart.");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
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

// ------------------------------------------------------- another machine
//
// Four commands that make a paired machine usable the way ssh makes a Unix box
// usable: list them, run something, send a file, fetch a file.
//
// They exist for an agent as much as for a person. Told "build this on the
// other computer", a coding agent has no ssh to reach a Windows machine and no
// business learning this daemon's WebSocket protocol — but it already knows how
// to run a command line. So the shape is deliberately ssh's: output on stdout,
// errors on stderr, and the far side's exit code becomes ours, so `&&` and `||`
// keep their meaning.
//
// Everything goes to the LOCAL daemon with `?via=<machine>`; it holds the other
// machine's token and does the relaying. No token for the far side is ever read,
// typed, or stored here.

/// The port the local daemon is on, and its token — or a message saying why not.
fn local_daemon() -> Option<(u16, String)> {
    let cfg = load_config()?;
    let port = daemon::read_pid_file().map(|p| p.port).unwrap_or(cfg.port);
    if daemon::probe(port, &cfg.token).is_none() {
        eprintln!("sessionhubd is not running here. Run `sessionhubd start` first.");
        return None;
    }
    Some((port, cfg.token))
}

/// `--on NAME`, which every one of these needs.
fn machine_flag(argv: &[String]) -> Option<String> {
    match flag_value(argv, "--on") {
        Some(name) if !name.trim().is_empty() => Some(name),
        _ => {
            eprintln!("Which machine? Add `--on <name>`; `sessionhubd machines` lists them.");
            None
        }
    }
}

fn cmd_machines() -> ExitCode {
    let Some(cfg) = load_config() else { return ExitCode::FAILURE };
    if cfg.remotes.is_empty() {
        println!("No machines paired yet.");
        println!("On the other computer: Settings -> Network access, copy its pairing link,");
        println!("then paste it into the + box above the terminal here.");
        return ExitCode::SUCCESS;
    }
    for r in &cfg.remotes {
        let version = if r.version.is_empty() { "?".to_string() } else { r.version.clone() };
        println!("{:<20} {:<24} {}", r.name, r.addr, version);
    }
    ExitCode::SUCCESS
}

fn cmd_run(argv: &[String]) -> ExitCode {
    let Some(on) = machine_flag(argv) else { return ExitCode::from(2) };
    // Everything after `--` is the command, untouched. Without this rule a
    // command carrying its own `--release` or `--on` would be eaten by the flag
    // parser above.
    let Some(at) = argv.iter().position(|a| a == "--") else {
        eprintln!("Usage: sessionhubd run --on <machine> [--cwd DIR] [--timeout SECONDS] -- COMMAND…");
        return ExitCode::from(2);
    };
    let command = argv[at + 1..].join(" ");
    if command.trim().is_empty() {
        eprintln!("There is no command after `--`.");
        return ExitCode::from(2);
    }
    let cwd = flag_value(argv, "--cwd").unwrap_or_default();
    let asked = flag_value(argv, "--timeout").and_then(|t| t.parse::<u64>().ok());

    let Some((port, token)) = local_daemon() else { return ExitCode::FAILURE };
    let mut target = format!(
        "/api/exec?token={}&via={}&cmd={}",
        remote::percent_encode(&token),
        remote::percent_encode(&on),
        remote::percent_encode(&command),
    );
    if !cwd.is_empty() {
        target.push_str(&format!("&cwd={}", remote::percent_encode(&cwd)));
    }
    if let Some(t) = asked {
        target.push_str(&format!("&timeout={t}"));
    }
    // Longer than the command's own deadline: the two relay hops each add their
    // own margin, and giving up here first would report a timeout that did not
    // happen.
    let wait = exec::clamp_timeout(asked) + std::time::Duration::from_secs(45);

    let (status, body) = match daemon::ask(port, "GET", &target, &[], wait) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    if status != 200 {
        eprintln!("{}", String::from_utf8_lossy(&body).trim());
        return ExitCode::FAILURE;
    }
    let parsed: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("{on} sent something this version cannot read.");
            return ExitCode::FAILURE;
        }
    };
    if let Some(message) = parsed.get("error").and_then(|v| v.as_str()) {
        eprintln!("{message}");
        return ExitCode::FAILURE;
    }
    print!("{}", parsed.get("stdout").and_then(|v| v.as_str()).unwrap_or(""));
    eprint!("{}", parsed.get("stderr").and_then(|v| v.as_str()).unwrap_or(""));
    let _ = std::io::Write::flush(&mut std::io::stdout());
    if parsed.get("timed_out").and_then(|v| v.as_bool()).unwrap_or(false) {
        eprintln!("(killed after the timeout — what is above is how far it got)");
    }
    let code = parsed.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    // The far side's exit code becomes ours. That is the whole contract: a
    // caller can write `sessionhubd run … && next-thing`.
    //
    // Anything outside a byte becomes 1 rather than being clamped. Clamping is
    // what a first draft of this did, and it turned -1 — "we never learned the
    // code" — into 0, which is to say into success. A Windows crash code like
    // 0xC0000005 has the same problem from the other end.
    ExitCode::from(match code {
        0 => 0,
        c if (1..=255).contains(&c) => c as u8,
        _ => 1,
    })
}

fn cmd_push(argv: &[String]) -> ExitCode {
    let Some(on) = machine_flag(argv) else { return ExitCode::from(2) };
    let rest: Vec<&String> = positional(argv);
    let (Some(local), Some(there)) = (rest.first(), rest.get(1)) else {
        eprintln!("Usage: sessionhubd push --on <machine> <local file> <path over there>");
        return ExitCode::from(2);
    };
    let body = match std::fs::read(local.as_str()) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("Cannot read {local}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let Some((port, token)) = local_daemon() else { return ExitCode::FAILURE };
    let target = format!(
        "/api/put?token={}&via={}&path={}",
        remote::percent_encode(&token),
        remote::percent_encode(&on),
        remote::percent_encode(there),
    );
    let bytes = body.len();
    match daemon::ask(port, "PUT", &target, &body, std::time::Duration::from_secs(180)) {
        Ok((200, _)) => {
            println!("sent {bytes} bytes to {on}:{there}");
            ExitCode::SUCCESS
        }
        Ok((_, answer)) => {
            eprintln!("{}", String::from_utf8_lossy(&answer).trim());
            ExitCode::FAILURE
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

fn cmd_pull(argv: &[String]) -> ExitCode {
    let Some(on) = machine_flag(argv) else { return ExitCode::from(2) };
    let rest: Vec<&String> = positional(argv);
    let (Some(there), Some(local)) = (rest.first(), rest.get(1)) else {
        eprintln!("Usage: sessionhubd pull --on <machine> <path over there> <local file>");
        return ExitCode::from(2);
    };
    let Some((port, token)) = local_daemon() else { return ExitCode::FAILURE };
    // Nothing new is needed on the far side for this: `/api/file` has always
    // served raw bytes and has always been relayable.
    let target = format!(
        "/api/file?token={}&via={}&path={}",
        remote::percent_encode(&token),
        remote::percent_encode(&on),
        remote::percent_encode(there),
    );
    match daemon::ask(port, "GET", &target, &[], std::time::Duration::from_secs(180)) {
        Ok((200, body)) => match std::fs::write(local.as_str(), &body) {
            Ok(()) => {
                println!("fetched {} bytes into {local}", body.len());
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("Cannot write {local}: {e}");
                ExitCode::FAILURE
            }
        },
        Ok((_, answer)) => {
            eprintln!("{}", String::from_utf8_lossy(&answer).trim());
            ExitCode::FAILURE
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

// ------------------------------------------------------- scripted control
//
// `ls`/`spawn`/`send`/`capture`/`wait` — a script's way to do what a person
// does by hand in the browser: start an agent's terminal, tell it something,
// read what it said back, wait until it is done. Every one of these also
// takes `--on NAME` and goes through the exact same local-daemon-then-relay
// path `run`/`push`/`pull` above already use — nothing new about *how* they
// reach another machine, only about what they ask it to do once there.
//
// A short-lived process only ever gets a request/response answer here, never
// a live view — `wait` polls `capture`/`ls` on an interval rather than
// holding anything open, and that is a deliberate choice, not a limitation
// worth working around: see the daemon-side comments on `Cmd::TermCapture`
// and `Cmd::TermSpawn` in `state.rs` for why the actor stays out of it.

/// A daemon old enough to have never heard of a new route answers with the
/// same bare `404\n` any unmatched path gets. Told apart from a real, useful
/// 404 — "no terminal with that id" — only by checking the body is exactly
/// that generic one.
fn old_daemon_message(status: u16, body: &[u8]) -> Option<&'static str> {
    if status == 404 && body == b"404\n" {
        Some("This sessionhub does not understand this command yet — update it first.")
    } else {
        None
    }
}

/// `id=...` if the target parses as a number, `name=...` otherwise — the
/// query fragment every scripted-control command that names a terminal sends.
fn target_query(target: &str) -> String {
    match target.parse::<u32>() {
        Ok(id) => format!("id={id}"),
        Err(_) => format!("name={}", remote::percent_encode(target)),
    }
}

/// The exact byte sequences `web/keybar.js` sends for the same names, so
/// `--key` means the same thing on a script as it does on a phone's on-screen
/// key bar. `None` for anything this table and the generic `ctrl-<letter>`
/// rule below do not recognise.
fn key_bytes(name: &str) -> Option<Vec<u8>> {
    let literal: &[u8] = match name {
        "esc" => b"\x1b",
        "enter" => b"\r",
        "tab" => b"\t",
        "shift-tab" => b"\x1b[Z",
        "up" => b"\x1b[A",
        "down" => b"\x1b[B",
        "right" => b"\x1b[C",
        "left" => b"\x1b[D",
        "home" => b"\x1b[H",
        "end" => b"\x1b[F",
        "pgup" => b"\x1b[5~",
        "pgdn" => b"\x1b[6~",
        "del" => b"\x1b[3~",
        "ctrl-c" => b"\x03",
        "ctrl-d" => b"\x04",
        "ctrl-r" => b"\x12",
        _ => {
            let letter = name.strip_prefix("ctrl-")?;
            let mut chars = letter.chars();
            let c = chars.next()?;
            if chars.next().is_some() || !c.is_ascii_alphabetic() {
                return None;
            }
            return Some(vec![c.to_ascii_uppercase() as u8 - 64]);
        }
    };
    Some(literal.to_vec())
}

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

/// Wrap text in a bracketed paste, so a readline-style prompt takes embedded
/// newlines as part of one block instead of as separate Enter presses — the
/// same thing that already happens when a person pastes multiple lines into
/// a terminal by hand. `src/typed.rs` already parses these markers on the way
/// in; nothing before this wrote them going out.
fn wrap_paste(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + PASTE_START.len() + PASTE_END.len());
    out.extend_from_slice(PASTE_START);
    out.extend_from_slice(text);
    out.extend_from_slice(PASTE_END);
    out
}

fn cmd_ls(argv: &[String]) -> ExitCode {
    let Some((port, token)) = local_daemon() else { return ExitCode::FAILURE };
    let mut target = format!("/api/term/ls?token={}", remote::percent_encode(&token));
    if let Some(on) = flag_value(argv, "--on") {
        target.push_str(&format!("&via={}", remote::percent_encode(&on)));
    }
    let (status, body) = match daemon::ask(port, "GET", &target, &[], Duration::from_secs(10)) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    if let Some(msg) = old_daemon_message(status, &body) {
        eprintln!("{msg}");
        return ExitCode::FAILURE;
    }
    if status != 200 {
        eprintln!("{}", String::from_utf8_lossy(&body).trim());
        return ExitCode::FAILURE;
    }
    if has_flag(argv, "--json") {
        print!("{}", String::from_utf8_lossy(&body));
        return ExitCode::SUCCESS;
    }
    let list: Vec<serde_json::Value> = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("sessionhub sent something this version cannot read.");
            return ExitCode::FAILURE;
        }
    };
    if list.is_empty() {
        println!("No live terminals.");
        return ExitCode::SUCCESS;
    }
    println!("{:<6} {:<16} {:<10} {:<7} {}", "ID", "NAME", "AGENT", "STATUS", "PROJECT");
    for t in &list {
        let id = t.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
        let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("-");
        let agent = t.get("agent").and_then(|v| v.as_str()).unwrap_or("");
        let alive = t.get("alive").and_then(|v| v.as_bool()).unwrap_or(false);
        let working = t.get("working").and_then(|v| v.as_bool()).unwrap_or(false);
        let status = if !alive { "exited" } else if working { "busy" } else { "idle" };
        let project = t.get("project").and_then(|v| v.as_str()).unwrap_or("");
        println!("{id:<6} {name:<16} {agent:<10} {status:<7} {project}");
    }
    ExitCode::SUCCESS
}

/// Limits mirrored from `state::validate_env` — the daemon is the
/// authoritative check (it may be a different machine entirely, over
/// `--on`), this one is purely for fast local feedback before a round trip.
const MAX_ENV_VARS: usize = 32;
const MAX_ENV_VALUE_LEN: usize = 4096;

/// `--env NAME=VALUE` (used as given) or `--env NAME` (pulled from this
/// process's own environment) — repeatable. The bare-`NAME` form exists so a
/// secret never has to be typed on the command line, where any other process
/// on the machine can read it back out of the argument list.
fn parse_env_flags(argv: &[String]) -> Result<BTreeMap<String, String>, String> {
    let mut env = BTreeMap::new();
    let mut i = 0;
    while i < argv.len() {
        if argv[i] == "--env" {
            let spec = argv.get(i + 1).map(String::as_str).unwrap_or("");
            let (name, value) = match spec.split_once('=') {
                Some((n, v)) => (n.to_string(), v.to_string()),
                None => {
                    let Ok(v) = std::env::var(spec) else {
                        return Err(format!(
                            "--env {spec}: not set in this shell's environment"
                        ));
                    };
                    (spec.to_string(), v)
                }
            };
            let mut chars = name.chars();
            let starts_ok = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
            let rest_ok = chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
            if name.is_empty() || !starts_ok || !rest_ok {
                return Err(format!(
                    "'{name}' is not a valid environment variable name (letters, digits, _ only, cannot start with a digit)"
                ));
            }
            if value.len() > MAX_ENV_VALUE_LEN {
                return Err(format!("'{name}' is too long (max {MAX_ENV_VALUE_LEN} bytes)"));
            }
            if value.contains('\0') {
                return Err(format!("'{name}' contains a NUL byte"));
            }
            env.insert(name, value);
            if env.len() > MAX_ENV_VARS {
                return Err(format!("too many --env variables (max {MAX_ENV_VARS})"));
            }
        }
        i += 1;
    }
    Ok(env)
}

/// Whether the daemon that will actually create the terminal — this machine,
/// or `on` over `--on` — understands `--env`. Checked before `spawn` is ever
/// sent: an older daemon would otherwise ignore the request body entirely
/// and answer 200 having silently started the terminal without it.
fn term_env_supported(port: u16, token: &str, on: Option<&str>) -> Result<bool, String> {
    let mut target = format!("/api/status?token={}", remote::percent_encode(token));
    if let Some(on) = on {
        target.push_str(&format!("&via={}", remote::percent_encode(on)));
    }
    let (status, body) = daemon::ask(port, "GET", &target, &[], Duration::from_secs(10))?;
    if status != 200 {
        return Err(String::from_utf8_lossy(&body).trim().to_string());
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| "sessionhub sent an unreadable status".to_string())?;
    Ok(parsed.get("term_env").and_then(|v| v.as_bool()).unwrap_or(false))
}

fn cmd_spawn(argv: &[String]) -> ExitCode {
    let (Some(project), Some(agent)) = (flag_value(argv, "--project"), flag_value(argv, "--agent"))
    else {
        eprintln!(
            "Usage: sessionhubd spawn --agent NAME --project DIR [--resume ID] [--name NAME] \
             [--env NAME=VALUE | --env NAME]… [--on MACHINE]"
        );
        return ExitCode::from(2);
    };
    let on = flag_value(argv, "--on");
    // Worth catching here, on this machine — but only when the folder IS on
    // this machine. `--on` means the path belongs to whatever is on the far
    // end, which this process cannot see.
    if on.is_none() && !std::path::Path::new(&project).is_dir() {
        eprintln!("{project} is not a folder on this machine.");
        return ExitCode::FAILURE;
    }
    let env = match parse_env_flags(argv) {
        Ok(e) => e,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(2);
        }
    };
    let Some((port, token)) = local_daemon() else { return ExitCode::FAILURE };
    if !env.is_empty() {
        match term_env_supported(port, &token, on.as_deref()) {
            Ok(true) => {}
            Ok(false) => {
                let where_ = on.as_deref().unwrap_or("this machine");
                eprintln!("sessionhub on {where_} does not support --env yet. Update it first.");
                return ExitCode::FAILURE;
            }
            Err(e) => {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
        }
    }
    let mut target = format!(
        "/api/term/spawn?token={}&project={}&agent={}",
        remote::percent_encode(&token),
        remote::percent_encode(&project),
        remote::percent_encode(&agent),
    );
    if let Some(resume) = flag_value(argv, "--resume") {
        target.push_str(&format!("&resume={}", remote::percent_encode(&resume)));
    }
    if let Some(name) = flag_value(argv, "--name") {
        target.push_str(&format!("&name={}", remote::percent_encode(&name)));
    }
    if let Some(on) = &on {
        target.push_str(&format!("&via={}", remote::percent_encode(on)));
    }
    // Never in the query string above — env values are secrets, and a URL can
    // end up in a log line or a proxy's own access log. Empty when `--env`
    // was not used, so the request is byte-for-byte what it always was.
    let body: Vec<u8> = if env.is_empty() {
        Vec::new()
    } else {
        serde_json::json!({ "env": env }).to_string().into_bytes()
    };
    let (status, body) = match daemon::ask(port, "PUT", &target, &body, Duration::from_secs(20)) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    if let Some(msg) = old_daemon_message(status, &body) {
        eprintln!("{msg}");
        return ExitCode::FAILURE;
    }
    // A 403 (remote commands off) or 502 (relay failed) answers in plain
    // text, not JSON — the same shape `run`'s own non-200 handling expects.
    if status != 200 {
        eprintln!("{}", String::from_utf8_lossy(&body).trim());
        return ExitCode::FAILURE;
    }
    let parsed: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("sessionhub sent something this version cannot read.");
            return ExitCode::FAILURE;
        }
    };
    if let Some(message) = parsed.get("error").and_then(|v| v.as_str()) {
        eprintln!("{message}");
        return ExitCode::FAILURE;
    }
    let Some(id) = parsed.get("id").and_then(|v| v.as_u64()) else {
        eprintln!("sessionhub did not say which terminal it started.");
        return ExitCode::FAILURE;
    };
    // Human-readable line to stderr, bare id to stdout — so
    // `id=$(sessionhubd spawn ...)` in a script gets exactly the id and
    // nothing else, the same discipline `run` already keeps between its
    // stdout and stderr.
    eprintln!("spawned terminal {id} ({agent} in {project})");
    println!("{id}");
    ExitCode::SUCCESS
}

fn cmd_send(argv: &[String]) -> ExitCode {
    let rest = positional(argv);
    let Some(target) = rest.first().map(|s| s.to_string()) else {
        eprintln!(
            "Usage: sessionhubd send <id-or-name> [--file PATH | TEXT] [--enter] [--key NAME]… \
             [--from LABEL] [--raw] [--verify] [--on MACHINE]"
        );
        return ExitCode::from(2);
    };

    let raw = has_flag(argv, "--raw");
    let enter = has_flag(argv, "--enter");
    let verify = has_flag(argv, "--verify");
    let from = flag_value(argv, "--from");
    let on = flag_value(argv, "--on");

    let mut keys = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        if argv[i] == "--key" {
            match argv.get(i + 1).and_then(|n| key_bytes(n)) {
                Some(bytes) => keys.push(bytes),
                None => {
                    eprintln!("Unknown --key '{}'.", argv.get(i + 1).map(String::as_str).unwrap_or(""));
                    return ExitCode::from(2);
                }
            }
        }
        i += 1;
    }

    let text: Option<Vec<u8>> = if let Some(path) = flag_value(argv, "--file") {
        match std::fs::read(&path) {
            Ok(b) => Some(b),
            Err(e) => {
                eprintln!("could not read {path}: {e}");
                return ExitCode::FAILURE;
            }
        }
    } else if let Some(t) = rest.get(1) {
        Some(t.as_bytes().to_vec())
    } else if keys.is_empty() {
        // Nothing else was asked for — read whatever is piped in, the same
        // way `cat` would.
        use std::io::Read;
        let mut buf = Vec::new();
        match std::io::stdin().read_to_end(&mut buf) {
            Ok(_) => Some(buf),
            Err(e) => {
                eprintln!("could not read stdin: {e}");
                return ExitCode::FAILURE;
            }
        }
    } else {
        None
    };

    if keys.is_empty() && text.as_ref().is_none_or(|t| t.is_empty()) && !enter {
        eprintln!("Nothing to send — give text, --file, or --key.");
        return ExitCode::from(2);
    }

    let Some((port, token)) = local_daemon() else { return ExitCode::FAILURE };
    let id_query = target_query(&target);

    let send_bytes = |payload: &[u8]| -> Result<u64, ExitCode> {
        let mut url = format!("/api/term/send?token={}&{id_query}", remote::percent_encode(&token));
        if let Some(from) = &from {
            url.push_str(&format!("&from={}", remote::percent_encode(from)));
        }
        if let Some(on) = &on {
            url.push_str(&format!("&via={}", remote::percent_encode(on)));
        }
        let (status, body) = daemon::ask(port, "PUT", &url, payload, Duration::from_secs(15))
            .map_err(|e| {
                eprintln!("{e}");
                ExitCode::FAILURE
            })?;
        if let Some(msg) = old_daemon_message(status, &body) {
            eprintln!("{msg}");
            return Err(ExitCode::FAILURE);
        }
        if status != 200 {
            eprintln!("{}", String::from_utf8_lossy(&body).trim());
            return Err(ExitCode::FAILURE);
        }
        let parsed: serde_json::Value = serde_json::from_slice(&body).map_err(|_| {
            eprintln!("sessionhub sent something this version cannot read.");
            ExitCode::FAILURE
        })?;
        if let Some(message) = parsed.get("error").and_then(|v| v.as_str()) {
            eprintln!("{message}");
            return Err(ExitCode::FAILURE);
        }
        parsed.get("id").and_then(|v| v.as_u64()).ok_or_else(|| {
            eprintln!("sessionhub did not say which terminal received it.");
            ExitCode::FAILURE
        })
    };

    let mut sent_id = None;
    for key in &keys {
        sent_id = Some(match send_bytes(key) {
            Ok(id) => id,
            Err(code) => return code,
        });
    }
    if let Some(text) = &text {
        let payload = if raw { text.clone() } else { wrap_paste(text) };
        sent_id = Some(match send_bytes(&payload) {
            Ok(id) => id,
            Err(code) => return code,
        });
    }
    if enter {
        sent_id = Some(match send_bytes(b"\r") {
            Ok(id) => id,
            Err(code) => return code,
        });
    }

    if verify {
        if let (Some(text), Some(id)) = (&text, sent_id) {
            if !verify_visible(port, &token, id, &on, text) {
                eprintln!("warning: could not confirm the text appeared on screen within 3s.");
                return ExitCode::from(1);
            }
        }
    }
    ExitCode::SUCCESS
}

/// After sending, check the sent text actually shows up in the terminal's
/// scrollback within a few seconds — proof it landed somewhere visible, not
/// just that the daemon accepted it onto the wire. Best-effort: a prompt that
/// echoes differently than it was sent (word-wrap, no echo at all in some
/// ink-based TUIs) can still fail this honestly even when the send worked.
fn verify_visible(port: u16, token: &str, id: u64, on: &Option<String>, text: &[u8]) -> bool {
    let stripped = crate::ansi::strip_ansi(text);
    let needle: String = stripped.trim().chars().take(80).collect();
    if needle.is_empty() {
        return true;
    }
    for _ in 0..6 {
        std::thread::sleep(Duration::from_millis(500));
        let mut url = format!("/api/term/capture?token={}&id={id}", remote::percent_encode(token));
        if let Some(on) = on {
            url.push_str(&format!("&via={}", remote::percent_encode(on)));
        }
        if let Ok((200, body)) = daemon::ask(port, "GET", &url, &[], Duration::from_secs(5)) {
            if crate::ansi::strip_ansi(&body).contains(&needle) {
                return true;
            }
        }
    }
    false
}

fn cmd_capture(argv: &[String]) -> ExitCode {
    let rest = positional(argv);
    let Some(target) = rest.first() else {
        eprintln!("Usage: sessionhubd capture <id-or-name> [--lines N] [--raw] [--json] [--on MACHINE]");
        return ExitCode::from(2);
    };
    let Some((port, token)) = local_daemon() else { return ExitCode::FAILURE };
    let mut url = format!(
        "/api/term/capture?token={}&{}",
        remote::percent_encode(&token),
        target_query(target)
    );
    if let Some(on) = flag_value(argv, "--on") {
        url.push_str(&format!("&via={}", remote::percent_encode(&on)));
    }
    let (status, body) = match daemon::ask(port, "GET", &url, &[], Duration::from_secs(10)) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    if let Some(msg) = old_daemon_message(status, &body) {
        eprintln!("{msg}");
        return ExitCode::FAILURE;
    }
    if status != 200 {
        eprintln!("{}", String::from_utf8_lossy(&body).trim());
        return ExitCode::FAILURE;
    }
    let text = if has_flag(argv, "--raw") {
        String::from_utf8_lossy(&body).into_owned()
    } else {
        crate::ansi::strip_ansi(&body)
    };
    let text = match flag_value(argv, "--lines").and_then(|n| n.parse::<usize>().ok()) {
        Some(n) => {
            let lines: Vec<&str> = text.lines().collect();
            let start = lines.len().saturating_sub(n);
            lines[start..].join("\n")
        }
        None => text,
    };
    if has_flag(argv, "--json") {
        println!("{}", serde_json::json!({ "text": text }));
    } else {
        println!("{text}");
    }
    ExitCode::SUCCESS
}

/// The ceiling on `wait --timeout` — `exec::clamp_timeout`'s 600s belongs to
/// `run`, which is a single bounded command; a script legitimately waiting on
/// a long build needs more room than that, just not forever.
const WAIT_MAX_TIMEOUT: u64 = 3600;

fn cmd_wait(argv: &[String]) -> ExitCode {
    let rest = positional(argv);
    let Some(target) = rest.first().map(|s| s.to_string()) else {
        eprintln!("Usage: sessionhubd wait <id-or-name> [--idle SECONDS] [--timeout SECONDS] [--on MACHINE]");
        return ExitCode::from(2);
    };
    let idle_secs = flag_value(argv, "--idle").and_then(|s| s.parse::<u64>().ok());
    let timeout_secs = flag_value(argv, "--timeout")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(300)
        .min(WAIT_MAX_TIMEOUT);
    let on = flag_value(argv, "--on");
    let Some((port, token)) = local_daemon() else { return ExitCode::FAILURE };

    let ls_url = {
        let mut u = format!("/api/term/ls?token={}", remote::percent_encode(&token));
        if let Some(on) = &on {
            u.push_str(&format!("&via={}", remote::percent_encode(on)));
        }
        u
    };
    let capture_url = {
        let mut u = format!(
            "/api/term/capture?token={}&{}",
            remote::percent_encode(&token),
            target_query(&target)
        );
        if let Some(on) = &on {
            u.push_str(&format!("&via={}", remote::percent_encode(on)));
        }
        u
    };

    let start = Instant::now();
    let mut last_output: Option<Vec<u8>> = None;
    let mut quiet_since = Instant::now();
    loop {
        if start.elapsed().as_secs() >= timeout_secs {
            eprintln!("timed out after {timeout_secs}s, still busy or running");
            return ExitCode::from(1);
        }
        if let Ok((200, body)) = daemon::ask(port, "GET", &ls_url, &[], Duration::from_secs(10)) {
            if let Ok(list) = serde_json::from_slice::<Vec<serde_json::Value>>(&body) {
                let numeric = target.parse::<u64>().ok();
                let mine = list.iter().find(|t| {
                    t.get("id").and_then(|v| v.as_u64()) == numeric
                        || t.get("name").and_then(|v| v.as_str()) == Some(target.as_str())
                });
                match mine {
                    Some(t) if t.get("alive").and_then(|v| v.as_bool()) == Some(false) => {
                        println!("exited");
                        return ExitCode::SUCCESS;
                    }
                    None => {
                        eprintln!("no live terminal '{target}'");
                        return ExitCode::FAILURE;
                    }
                    _ => {}
                }
            }
        }
        if let Some(idle_secs) = idle_secs {
            if let Ok((200, body)) = daemon::ask(port, "GET", &capture_url, &[], Duration::from_secs(10)) {
                if Some(&body) != last_output.as_ref() {
                    last_output = Some(body);
                    quiet_since = Instant::now();
                } else if quiet_since.elapsed().as_secs() >= idle_secs {
                    println!("idle");
                    return ExitCode::SUCCESS;
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// The arguments that are not the subcommand, a flag, or a flag's value.
///
/// Every flag that swallows the word after it has to be listed, `--home`
/// included — it is global, so it can appear in front of these commands too, and
/// leaving it out made its path look like the file being sent.
fn positional(argv: &[String]) -> Vec<&String> {
    const TAKES_VALUE: [&str; 16] = [
        "--on", "--cwd", "--timeout", "--home", "--account", "--password",
        "--agent", "--project", "--resume", "--name", "--file", "--key", "--from", "--idle",
        "--lines", "--env",
    ];
    let mut out = Vec::new();
    let mut skip = false;
    for a in argv.iter().skip(1) {
        if skip {
            skip = false;
            continue;
        }
        if TAKES_VALUE.contains(&a.as_str()) {
            skip = true;
            continue;
        }
        if a.starts_with("--") {
            continue;
        }
        out.push(a);
    }
    out
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

    // Did the last update actually go in? An update that fails leaves a note
    // beside the binary, because the alternative is what happened on one
    // machine here: three updates in a row that downloaded, restarted, and came
    // back on the old version without a word anywhere.
    update::report_failed_swap();

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
    // What is done with the daemon, written to a file beside the config and
    // nowhere else. Before the actor, so its first events are not lost.
    telemetry::start(cfg.telemetry.enabled);

    let registry_cfg = registry::spawn(cfg.clone(), tx.clone());

    // How busy the machine is, on its own thread and its own clock. A few
    // hundred microseconds every couple of seconds — see `memory::watch`.
    memory::watch(tx.clone());

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

    #[test]
    fn positional_swallows_every_new_scripted_control_flag_value() {
        let a = argv(&[
            "send", "builder", "--from", "orchestrator", "--key", "esc", "--idle", "20",
            "--lines", "5",
        ]);
        assert_eq!(positional(&a), vec!["builder"]);
    }

    #[test]
    fn positional_keeps_spawn_args_and_drops_their_flags() {
        let a = argv(&[
            "spawn", "--agent", "omp", "--project", "~/code/demo", "--resume", "abc",
            "--name", "builder", "--file", "task.md",
        ]);
        assert!(positional(&a).is_empty());
    }

    #[test]
    fn old_daemon_message_only_matches_the_generic_404() {
        assert!(old_daemon_message(404, b"404\n").is_some());
        assert!(old_daemon_message(404, b"no terminal 9\n").is_none());
        assert!(old_daemon_message(200, b"404\n").is_none());
    }

    #[test]
    fn target_query_picks_id_for_numbers_and_name_otherwise() {
        assert_eq!(target_query("42"), "id=42");
        assert_eq!(target_query("builder"), "name=builder");
        assert_eq!(target_query("bui lder"), "name=bui%20lder");
    }

    #[test]
    fn key_bytes_matches_the_keybar_table() {
        assert_eq!(key_bytes("esc"), Some(b"\x1b".to_vec()));
        assert_eq!(key_bytes("enter"), Some(b"\r".to_vec()));
        assert_eq!(key_bytes("shift-tab"), Some(b"\x1b[Z".to_vec()));
        assert_eq!(key_bytes("ctrl-c"), Some(b"\x03".to_vec()));
    }

    #[test]
    fn key_bytes_supports_generic_ctrl_letter() {
        assert_eq!(key_bytes("ctrl-a"), Some(vec![1]));
        assert_eq!(key_bytes("ctrl-z"), Some(vec![26]));
        assert_eq!(key_bytes("ctrl-A"), Some(vec![1]));
    }

    #[test]
    fn key_bytes_rejects_unknown_names() {
        assert_eq!(key_bytes("ctrl-1"), None);
        assert_eq!(key_bytes("ctrl-ab"), None);
        assert_eq!(key_bytes("nonsense"), None);
    }

    #[test]
    fn wrap_paste_brackets_the_text_unchanged() {
        assert_eq!(wrap_paste(b"line1\nline2"), b"\x1b[200~line1\nline2\x1b[201~".to_vec());
    }

    #[test]
    fn parse_env_flags_reads_name_equals_value() {
        let a = argv(&["spawn", "--env", "FOO=bar", "--env", "BAZ=qux"]);
        let env = parse_env_flags(&a).unwrap();
        assert_eq!(env.get("FOO").map(String::as_str), Some("bar"));
        assert_eq!(env.get("BAZ").map(String::as_str), Some("qux"));
    }

    #[test]
    fn parse_env_flags_reads_bare_name_from_this_process_environment() {
        std::env::set_var("SESSIONHUBD_TEST_ENV_VAR", "secret-value");
        let a = argv(&["spawn", "--env", "SESSIONHUBD_TEST_ENV_VAR"]);
        let env = parse_env_flags(&a).unwrap();
        std::env::remove_var("SESSIONHUBD_TEST_ENV_VAR");
        assert_eq!(env.get("SESSIONHUBD_TEST_ENV_VAR").map(String::as_str), Some("secret-value"));
    }

    #[test]
    fn parse_env_flags_errors_clearly_when_a_bare_name_is_not_set() {
        let a = argv(&["spawn", "--env", "SESSIONHUBD_TEST_VAR_NOT_SET"]);
        let err = parse_env_flags(&a).unwrap_err();
        assert!(err.contains("SESSIONHUBD_TEST_VAR_NOT_SET"), "{err}");
    }

    #[test]
    fn parse_env_flags_rejects_a_bad_name() {
        let a = argv(&["spawn", "--env", "1FOO=bar"]);
        assert!(parse_env_flags(&a).is_err());
    }

    #[test]
    fn parse_env_flags_rejects_too_many_variables() {
        let mut items = vec!["spawn".to_string()];
        for i in 0..=MAX_ENV_VARS {
            items.push("--env".to_string());
            items.push(format!("V{i}=x"));
        }
        let a: Vec<String> = items;
        assert!(parse_env_flags(&a).is_err());
    }

    #[test]
    fn parse_env_flags_with_no_env_flags_is_empty() {
        let a = argv(&["spawn", "--agent", "claude"]);
        assert!(parse_env_flags(&a).unwrap().is_empty());
    }
}
