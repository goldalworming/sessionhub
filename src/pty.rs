//! The PTY host. This is the only module that knows about `portable-pty`; the
//! rest speaks through `PtyEvent` and `Pty`. The boundary is deliberate, so an
//! authoritative terminal parser can replace it later without touching
//! anything else.

use std::collections::BTreeMap;
use std::fmt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;
pub type EventSink = Arc<dyn Fn(PtyEvent) + Send + Sync>;

pub enum PtyEvent {
    /// PTY output, already stripped of the queries the daemon answers itself.
    Output(Vec<u8>),
    /// The child ended, with its exit code.
    Eof { code: i32 },
}

pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: SharedWriter,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// The root of this terminal's process tree, for measuring memory.
    pid: Option<u32>,
}

#[derive(Debug)]
pub enum SpawnError {
    NotFound(String),
    BadCwd(PathBuf),
    Pty(String),
}

impl fmt::Display for SpawnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SpawnError::NotFound(c) => {
                write!(f, "Could not run `{c}` — not found on PATH.")
            }
            SpawnError::BadCwd(p) => {
                write!(f, "Project directory does not exist: {}", p.display())
            }
            SpawnError::Pty(e) => write!(f, "Could not open a PTY: {e}"),
        }
    }
}

impl SpawnError {
    pub fn code(&self) -> &'static str {
        match self {
            SpawnError::NotFound(_) => "command_not_found",
            SpawnError::BadCwd(_) => "bad_project",
            SpawnError::Pty(_) => "spawn_failed",
        }
    }
}

impl Pty {
    /// Open a PTY, run `program` in `cwd`, and start the reader thread.
    /// `sink` is called from the reader thread for every chunk of output.
    pub fn spawn(
        program: &str,
        args: &[String],
        cwd: &Path,
        cols: u16,
        rows: u16,
        env: &BTreeMap<String, String>,
        sink: EventSink,
    ) -> Result<Pty, SpawnError> {
        if !cwd.is_dir() {
            return Err(SpawnError::BadCwd(cwd.to_path_buf()));
        }
        let resolved =
            resolve_command(program).ok_or_else(|| SpawnError::NotFound(program.to_string()))?;

        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| SpawnError::Pty(e.to_string()))?;

        let mut cmd = build_command(&resolved, args);
        cmd.cwd(cwd);
        apply_terminal_env(&mut cmd);
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child =
            pair.slave.spawn_command(cmd).map_err(|e| SpawnError::Pty(e.to_string()))?;
        drop(pair.slave);

        let mut reader =
            pair.master.try_clone_reader().map_err(|e| SpawnError::Pty(e.to_string()))?;
        let writer: SharedWriter = Arc::new(Mutex::new(
            pair.master.take_writer().map_err(|e| SpawnError::Pty(e.to_string()))?,
        ));
        let killer = child.clone_killer();
        let pid = child.process_id();

        // The child is handed entirely to the waiter thread. On Windows a dying
        // child does NOT close the ConPTY — the reader stays blocked in read() —
        // so exit has to be detected from the process, not from pipe EOF. The
        // killer is a separate handle, so `kill` never waits on `wait`.
        let exit_sink = Arc::clone(&sink);
        thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            exit_sink(PtyEvent::Eof { code });
        });

        let responder = Arc::clone(&writer);
        thread::spawn(move || {
            let mut filter = DsrFilter::default();
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let (clean, queries) = filter.feed(&chunk[..n]);
                        // ConPTY sends a DSR (ESC[6n) at start and WAITS for an
                        // answer before drawing anything. The daemon has to
                        // answer it itself: a terminal with no client attached
                        // must keep running, and that is the heart of this
                        // product. The query is also not forwarded, so xterm.js
                        // does not answer too and the child receive two replies.
                        for _ in 0..queries {
                            if let Ok(mut w) = responder.lock() {
                                let _ = w.write_all(b"\x1b[1;1R");
                                let _ = w.flush();
                            }
                        }
                        if !clean.is_empty() {
                            sink(PtyEvent::Output(clean));
                        }
                    }
                }
            }
            // The ConPTY closed (the master was dropped by the state actor). Exit
            // was already reported by the waiter thread; there is nothing left here.
        });

        Ok(Pty { master: pair.master, writer, killer, pid })
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Write keyboard input to the PTY. The volume is small; the lock is held
    /// only for the syscall.
    pub fn write_input(&self, data: &[u8]) {
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.write_all(data);
            let _ = w.flush();
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

/// Run a command without popping up a console window.
///
/// The daemon runs without a console of its own, so every console subprocess it
/// starts would flash a black window on the user's screen.
pub fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    // The `mut` is only exercised by the Windows block below; on unix nothing
    // needs hiding, so the binding is left untouched and the lint told why.
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Find an executable: a path that exists is used as-is, anything else is looked
/// up on PATH. An agent can be installed off PATH — say, under an nvm version
/// that is not active — so the config may hold an absolute path.
///
/// The lookup is done here rather than by calling `where.exe`: spawning a
/// subprocess for this costs hundreds of milliseconds per agent and flashes a
/// console window every time settings is opened.
pub fn resolve_command(name: &str) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    let direct = Path::new(name);
    if direct.is_file() {
        return Some(direct.to_path_buf());
    }

    // A name containing a separator is a path, not something to look up on PATH
    // — it only needs trying with the usual extensions.
    let has_sep = name.contains('/') || name.contains('\\');
    if has_sep {
        return with_extensions(direct).find(|p| p.is_file());
    }

    for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        if let Some(hit) = with_extensions(&dir.join(name)).find(|p| p.is_file()) {
            return Some(hit);
        }
    }
    None
}

/// Bracketing markers, so the PATH can be separated from other output.
///
/// An interactive shell often prints things of its own — banners, plugin
/// warnings, a stray `echo` in its rc. Taking all of stdout swallows those too.
#[cfg(unix)]
const PATH_MARK: (&str, &str) = ("__SHPATH__", "__ENDPATH__");

/// Adopt the PATH of the user's login shell. Unix only.
///
/// This daemon is designed **not** to run from a terminal: it detaches at
/// start, and on macOS/Linux it can be run by launchd or systemd. All three
/// inherit a nearly empty PATH — on the test Mac,
/// `/usr/bin:/bin:/usr/sbin:/sbin`. As a result every agent installed under
/// `~/.local/bin`, homebrew, bun, or nvm is reported "not found on PATH" while
/// plainly present in the user's terminal, and spawning it would fail too.
///
/// The shell is invoked **interactively** (`-i`), not just as a login shell
/// (`-l`): on macOS with zsh the user's PATH is usually written in `.zshrc`,
/// which `-l` alone does not read. Measured on a real machine — `-l` misses
/// `~/.local/bin`, `-i` picks it up.
///
/// Windows has no such problem: its PATH belongs to the user environment and
/// is inherited as-is, services included.
#[cfg(unix)]
pub fn login_path() -> Option<String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let script = format!(
        "printf '{}%s{}' \"$PATH\"",
        PATH_MARK.0, PATH_MARK.1
    );

    // An interactive shell can be slow, and on some setups can wait for input
    // that will never come. The timeout is hard: past it, the inherited PATH is
    // kept — better an incomplete list than a daemon that never finishes
    // starting.
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let out = Command::new(&shell)
            .args(["-lic", &script])
            .stdin(std::process::Stdio::null())
            .output();
        let _ = tx.send(out.ok().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()));
    });

    let raw = rx.recv_timeout(Duration::from_secs(4)).ok().flatten()?;
    let start = raw.find(PATH_MARK.0)? + PATH_MARK.0.len();
    let end = raw[start..].find(PATH_MARK.1)? + start;
    let found = raw[start..end].trim().to_string();
    if found.is_empty() {
        None
    } else {
        Some(found)
    }
}

/// Merge the login shell's PATH into this process's, without dropping what is
/// already there.
///
/// Overwriting wholesale is risky: the inherited PATH may hold something the
/// caller put there on purpose. So the shell's entries go in front and the rest
/// follows — with duplicates removed.
#[cfg(unix)]
pub fn adopt_login_path() -> Option<String> {
    let from_shell = login_path()?;
    let inherited = std::env::var("PATH").unwrap_or_default();
    let merged = merge_paths(&from_shell, &inherited);
    if merged == inherited {
        return None;
    }
    std::env::set_var("PATH", &merged);
    Some(merged)
}

#[cfg(unix)]
fn merge_paths(first: &str, second: &str) -> String {
    let mut seen = Vec::new();
    for part in first.split(':').chain(second.split(':')) {
        let part = part.trim();
        if part.is_empty() || seen.iter().any(|x| x == part) {
            continue;
        }
        seen.push(part.to_string());
    }
    seen.join(":")
}

/// Candidate file names: as given first, then every extension in PATHEXT.
fn with_extensions(base: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|s| !s.is_empty())
            // PATHEXT is written in capitals, but the files are almost always
            // lower case. File names on Windows are case-insensitive, so this is
            // purely cosmetic: `claude.exe` reads better in the settings panel
            // than `claude.EXE`.
            .map(|s| s.to_ascii_lowercase())
            .collect()
    } else {
        Vec::new()
    };
    std::iter::once(base.to_path_buf()).chain(exts.into_iter().map(move |ext| {
        let mut s = base.as_os_str().to_os_string();
        s.push(ext);
        PathBuf::from(s)
    }))
}

/// Terminal capabilities are announced by the emulator, and here the emulator is
/// this daemon together with the xterm.js in front of it — not the environment
/// of whichever process happened to run `sessionhubd start`.
///
/// This matters because the daemon is usually detached from a terminal or run
/// as a service, so its environment is arbitrary. A `NO_COLOR` sneaking in from
/// there would render every agent in black and white while the frontend
/// supports truecolor.
fn apply_terminal_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env_remove("NO_COLOR");
}

/// A `.cmd`/`.bat` shim cannot be CreateProcess'd directly — and Node-based CLI
/// agents are almost always shaped that way on Windows.
fn build_command(resolved: &Path, args: &[String]) -> CommandBuilder {
    let is_script = resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);

    let mut cmd = if is_script {
        let mut c = CommandBuilder::new("cmd.exe");
        c.args(["/c", &resolved.to_string_lossy()]);
        c
    } else {
        CommandBuilder::new(resolved)
    };
    for a in args {
        cmd.arg(a);
    }
    cmd
}

const DSR: &[u8] = b"\x1b[6n";

/// Strips `ESC[6n` out of the output stream, surviving a sequence split across
/// chunks.
#[derive(Default)]
struct DsrFilter {
    matched: usize,
}

impl DsrFilter {
    /// Returns (output without DSR, number of DSRs found).
    fn feed(&mut self, data: &[u8]) -> (Vec<u8>, usize) {
        let mut out = Vec::with_capacity(data.len());
        let mut found = 0;
        for &b in data {
            if b == DSR[self.matched] {
                self.matched += 1;
                if self.matched == DSR.len() {
                    found += 1;
                    self.matched = 0;
                }
                continue;
            }
            // No match: emit the prefix held back, then re-test this byte from
            // the start. `ESC[6n` has no prefix that is also a suffix, so one
            // re-test is enough.
            if self.matched > 0 {
                out.extend_from_slice(&DSR[..self.matched]);
                self.matched = 0;
                if b == DSR[0] {
                    self.matched = 1;
                    continue;
                }
            }
            out.push(b);
        }
        (out, found)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(chunks: &[&[u8]]) -> (Vec<u8>, usize) {
        let mut f = DsrFilter::default();
        let mut out = Vec::new();
        let mut n = 0;
        for c in chunks {
            let (o, k) = f.feed(c);
            out.extend_from_slice(&o);
            n += k;
        }
        (out, n)
    }

    #[test]
    fn passes_through_plain_output() {
        let (out, n) = feed_all(&[b"halo dunia"]);
        assert_eq!(out, b"halo dunia");
        assert_eq!(n, 0);
    }

    #[test]
    fn strips_dsr_and_counts_it() {
        let (out, n) = feed_all(&[b"a\x1b[6nb"]);
        assert_eq!(out, b"ab");
        assert_eq!(n, 1);
    }

    #[test]
    fn handles_dsr_split_across_chunks() {
        let (out, n) = feed_all(&[b"a\x1b", b"[6", b"nb"]);
        assert_eq!(out, b"ab");
        assert_eq!(n, 1);
    }

    #[test]
    fn keeps_other_escape_sequences_intact() {
        let (out, n) = feed_all(&[b"\x1b[6X\x1b[2J"]);
        assert_eq!(out, b"\x1b[6X\x1b[2J");
        assert_eq!(n, 0);
    }

    #[test]
    fn recovers_when_partial_match_restarts_with_esc() {
        // "ESC ESC [ 6 n" — the first ESC is not part of the DSR, the second is.
        let (out, n) = feed_all(&[b"\x1b\x1b[6n"]);
        assert_eq!(out, b"\x1b");
        assert_eq!(n, 1);
    }

    #[test]
    fn holds_incomplete_tail_until_resolved() {
        let mut f = DsrFilter::default();
        let (out, n) = f.feed(b"x\x1b[6");
        assert_eq!(out, b"x", "prefix belum boleh dikeluarkan");
        assert_eq!(n, 0);
        let (out, n) = f.feed(b"n");
        assert!(out.is_empty());
        assert_eq!(n, 1);
    }

    #[test]
    fn counts_repeated_queries() {
        let (out, n) = feed_all(&[b"\x1b[6n\x1b[6n"]);
        assert!(out.is_empty());
        assert_eq!(n, 2);
    }

    #[test]
    #[cfg(unix)]
    fn merging_keeps_shell_path_first_and_drops_duplicates() {
        let out = merge_paths("/a:/b", "/b:/c");
        assert_eq!(out, "/a:/b:/c");
    }

    #[test]
    #[cfg(unix)]
    fn merging_ignores_empty_segments() {
        // An empty PATH entry means "working directory" in some shells —
        // putting that in an agent search path is a security hole.
        assert_eq!(merge_paths("/a::", ":/b:"), "/a:/b");
    }

    #[test]
    fn resolves_absolute_path_without_touching_path_env() {
        let me = std::env::current_exe().unwrap();
        assert_eq!(resolve_command(me.to_str().unwrap()), Some(me));
    }

    #[test]
    fn missing_command_resolves_to_none() {
        assert!(resolve_command("sessionhub-tidak-ada-xyz").is_none());
        assert!(resolve_command("").is_none());
    }

    #[test]
    fn finds_programs_on_path_without_spawning_anything() {
        // A name without an extension has to be found through PATHEXT.
        let name = if cfg!(windows) { "cmd" } else { "sh" };
        let hit = resolve_command(name).expect("shell sistem selalu ada di PATH");
        assert!(hit.is_file());
        if cfg!(windows) {
            assert!(
                hit.extension().is_some(),
                "di Windows hasilnya harus punya ekstensi: {}",
                hit.display()
            );
        }
    }

    #[test]
    fn finds_program_when_extension_is_already_given() {
        let name = if cfg!(windows) { "cmd.exe" } else { "sh" };
        assert!(resolve_command(name).is_some());
    }

    #[test]
    fn resolving_never_shells_out() {
        // This used to call `where.exe` per agent: hundreds of milliseconds and a
        // flashing console window. What must not come back is the subprocess.
        //
        // Two earlier shapes of this test measured wall-clock against a fixed
        // number, and both were really measuring the machine. The total of 20
        // calls under 200ms went red three times while a build ran in parallel.
        // The fastest of 20 under 5ms went red too: a PATH scan reads real
        // directories, and on a cold cache the best case is milliseconds.
        //
        // So the number to compare against is measured here, now, on this
        // machine: what a process spawn actually costs. A slow or busy machine
        // inflates both sides together, which is exactly what a fixed threshold
        // could not do.
        let name = if cfg!(windows) { "cmd" } else { "sh" };

        // Warm the PATH cache first — the question is whether a spawn happens,
        // not whether the first directory read hits the disk.
        let _ = resolve_command(name);
        let mut best = std::time::Duration::MAX;
        for _ in 0..20 {
            let t0 = std::time::Instant::now();
            let _ = resolve_command(name);
            best = best.min(t0.elapsed());
        }

        let mut spawn = std::time::Duration::MAX;
        for _ in 0..3 {
            let t0 = std::time::Instant::now();
            let out = if cfg!(windows) {
                std::process::Command::new("cmd").args(["/c", "exit"]).output()
            } else {
                std::process::Command::new("/bin/sh").args(["-c", ":"]).output()
            };
            if out.is_ok() {
                spawn = spawn.min(t0.elapsed());
            }
        }
        // If a process could not be started at all there is nothing to compare
        // against, and failing here would say nothing about `resolve_command`.
        if spawn == std::time::Duration::MAX {
            return;
        }

        assert!(
            best * 5 < spawn,
            "resolusi tercepat {best:?} vs biaya spawn {spawn:?} — sepertinya ada proses yang dijalankan"
        );
    }
}
