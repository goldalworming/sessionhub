//! Daemon lifecycle: detaching from the launching terminal, the pid file, and
//! the `status`/`stop` commands that talk to the daemon over loopback HTTP.

use std::fs;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use crate::config::{self, Config};

/// Contents of `~/.sessionhub/daemon.pid`: one line, `<pid> <port>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PidFile {
    pub pid: u32,
    pub port: u16,
}

impl PidFile {
    pub fn parse(text: &str) -> Option<PidFile> {
        let mut parts = text.split_whitespace();
        let pid = parts.next()?.parse().ok()?;
        let port = parts.next()?.parse().ok()?;
        Some(PidFile { pid, port })
    }

    pub fn render(&self) -> String {
        format!("{} {}\n", self.pid, self.port)
    }
}

pub fn write_pid_file(port: u16) -> io::Result<()> {
    fs::create_dir_all(config::dir())?;
    let pf = PidFile { pid: std::process::id(), port };
    fs::write(config::pid_path(), pf.render())
}

pub fn remove_pid_file() {
    let _ = fs::remove_file(config::pid_path());
}

pub fn read_pid_file() -> Option<PidFile> {
    fs::read_to_string(config::pid_path())
        .ok()
        .and_then(|t| PidFile::parse(&t))
}

// ------------------------------------------------------------------- detach

/// Re-run ourselves as a detached process, then wait until it actually
/// answers. Returns the port it took.
pub fn spawn_detached(cfg: &Config, home_override: Option<&PathBuf>) -> io::Result<u16> {
    if let Some(status) = probe(cfg.port, &cfg.token) {
        return Err(io::Error::other(format!(
            "sessionhubd is already running (pid {}, port {})",
            status.pid, status.port
        )));
    }

    let exe = std::env::current_exe()?;
    let mut cmd = Command::new(exe);
    cmd.arg("start").arg("--foreground");
    if let Some(h) = home_override {
        cmd.arg("--home").arg(h);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());

    platform_detach(&mut cmd)?;

    // Wait for the daemon to answer. If it never does, do not pretend it worked.
    for _ in 0..100 {
        thread::sleep(Duration::from_millis(100));
        if probe(cfg.port, &cfg.token).is_some() {
            return Ok(cfg.port);
        }
    }
    Err(io::Error::other(
        "the daemon did not answer within 10 seconds — see ~/.sessionhub/sessionhubd.log",
    ))
}

#[cfg(windows)]
fn platform_detach(cmd: &mut Command) -> io::Result<()> {
    use std::os::windows::process::CommandExt;

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;

    // If the launcher sits inside a Job Object, the child joins it too and dies
    // with the launcher — exactly what must not happen here. BREAKAWAY only
    // works if the job allows it, so try first and then step back gracefully.
    cmd.creation_flags(base | CREATE_BREAKAWAY_FROM_JOB);
    match cmd.spawn() {
        Ok(_) => Ok(()),
        Err(_) => {
            cmd.creation_flags(base);
            cmd.spawn().map(|_| ())
        }
    }
}

#[cfg(unix)]
fn platform_detach(cmd: &mut Command) -> io::Result<()> {
    use std::os::unix::process::CommandExt;
    // setsid: leave the controlling terminal so the SIGHUP fired when that
    // terminal closes never reaches the daemon.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn().map(|_| ())
}

// ------------------------------------------------------ local control client

#[derive(Debug, Clone)]
pub struct Status {
    pub pid: u32,
    pub port: u16,
    pub uptime_secs: u64,
    pub terminals_alive: usize,
    pub terminals_total: usize,
}

/// Ask the daemon over `/api/status`. `None` means nothing answered.
pub fn probe(port: u16, token: &str) -> Option<Status> {
    let body = request(port, "GET", &format!("/api/status?token={token}"))?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    Some(Status {
        pid: v.get("pid")?.as_u64()? as u32,
        port: v.get("port")?.as_u64()? as u16,
        uptime_secs: v.get("uptime_secs")?.as_u64()?,
        terminals_alive: v.get("terminals_alive")?.as_u64()? as usize,
        terminals_total: v.get("terminals_total")?.as_u64()? as usize,
    })
}

pub fn request_stop(port: u16, token: &str) -> bool {
    request(port, "POST", &format!("/api/stop?token={token}")).is_some()
}

/// Tell the daemon to re-read its config — used after the token is rotated.
pub fn request_reload(port: u16, token: &str) -> bool {
    request(port, "POST", &format!("/api/reload?token={token}")).is_some()
}

/// Just enough HTTP for loopback: two control endpoints do not justify
/// dragging a full HTTP client into the binary.
/// menyeret klien HTTP penuh ke dalam binary.
fn request(port: u16, method: &str, target: &str) -> Option<String> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut sock = TcpStream::connect_timeout(&addr, Duration::from_millis(1500)).ok()?;
    sock.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    sock.write_all(
        format!("{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .ok()?;
    sock.flush().ok()?;

    let mut raw = Vec::new();
    sock.read_to_end(&mut raw).ok()?;
    let _ = sock.shutdown(Shutdown::Both);

    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.1 200") {
        return None;
    }
    Some(body.to_string())
}

/// Wait for a process to really be gone after being asked to stop.
pub fn wait_gone(pid: u32, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !process_alive(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    !process_alive(pid)
}

#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    // No extra dependency: tasklist is always there, and this is not a hot
    // path. The CSV output is compared column by column — matching the pid
    // digits in free text would also hit the memory column or a session id.
    let want = pid.to_string();
    crate::pty::quiet_command("tasklist.exe")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout).lines().any(|line| {
                line.split(',').nth(1).map(|f| f.trim().trim_matches('"') == want).unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

#[cfg(unix)]
pub fn process_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
pub fn force_kill(pid: u32) -> bool {
    crate::pty::quiet_command("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
pub fn force_kill(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, libc::SIGKILL) == 0 }
}

pub fn human_uptime(secs: u64) -> String {
    let (d, h, m, s) = (secs / 86400, (secs % 86400) / 3600, (secs % 3600) / 60, secs % 60);
    if d > 0 {
        format!("{d}d {h}h {m}m")
    } else if h > 0 {
        format!("{h}h {m}m")
    } else if m > 0 {
        format!("{m}m {s}s")
    } else {
        format!("{s}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_file_roundtrips() {
        let pf = PidFile { pid: 4321, port: 7717 };
        assert_eq!(pf.render(), "4321 7717\n");
        assert_eq!(PidFile::parse(&pf.render()), Some(pf));
    }

    #[test]
    fn pid_file_rejects_garbage() {
        assert_eq!(PidFile::parse(""), None);
        assert_eq!(PidFile::parse("4321"), None, "port wajib ada");
        assert_eq!(PidFile::parse("bukan-angka 7717"), None);
        assert_eq!(PidFile::parse("4321 bukan-port"), None);
    }

    #[test]
    fn pid_file_tolerates_trailing_whitespace() {
        assert_eq!(PidFile::parse("12 7717\r\n"), Some(PidFile { pid: 12, port: 7717 }));
    }

    #[test]
    fn detects_own_process_as_alive() {
        assert!(process_alive(std::process::id()));
    }

    #[test]
    fn detects_finished_process_as_gone() {
        // Use a real, already-reaped process rather than an invented pid: small
        // pids like 0 do exist on Windows (System Idle Process).
        let mut child = if cfg!(windows) {
            Command::new("cmd.exe").args(["/c", "exit"]).spawn().unwrap()
        } else {
            Command::new("true").spawn().unwrap()
        };
        let pid = child.id();
        child.wait().unwrap();
        assert!(!process_alive(pid), "pid {pid} sudah selesai tapi dilaporkan hidup");
    }

    #[test]
    fn probe_on_closed_port_returns_none() {
        // Port 1 on loopback is used by nothing in the test environment.
        assert!(probe(1, "apa-saja").is_none());
    }

    #[test]
    fn uptime_reads_naturally() {
        assert_eq!(human_uptime(5), "5s");
        assert_eq!(human_uptime(65), "1m 5s");
        assert_eq!(human_uptime(3671), "1h 1m");
        assert_eq!(human_uptime(90061), "1d 1h 1m");
    }
}
