//! Running one command and keeping what it said.
//!
//! Every other way this daemon runs something is a PTY: a terminal a person
//! looks at. That is the wrong shape for a machine asking another machine to do
//! work. A PTY hands back a rendered screen — ANSI escapes, echoed input,
//! prompts, lines rewrapped to whatever width was negotiated — and the only exit
//! code it reports is the shell's own, at the end, not the one belonging to the
//! command that was typed. Worse, a viewer's queue drops its oldest chunk when
//! it fills (`state::CLIENT_QUEUE`), so the middle of a long build can go
//! missing without a word.
//!
//! So this is the other shape: pipes, not a terminal. stdout and stderr stay
//! apart, nothing is rendered, the exit code is the command's own, and the whole
//! thing either finishes or is killed on a deadline.

use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

/// Neither stream may grow past this. A build that prints 400 MB should not be
/// answered by holding 400 MB in memory and then sending it down a socket.
pub const MAX_STREAM: usize = 1024 * 1024;

/// The default deadline, and the most that may be asked for.
pub const DEFAULT_TIMEOUT: u64 = 120;
pub const MAX_TIMEOUT: u64 = 600;

#[derive(Debug)]
pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    /// Either stream hit `MAX_STREAM` and lost its tail.
    pub truncated: bool,
    /// The deadline passed and the command was killed. What is returned is
    /// whatever it had said by then.
    pub timed_out: bool,
}

/// Run `command` through a shell, in `cwd`, and wait for it.
///
/// Through a shell rather than split into an argv, because the whole point is to
/// be told to do something the way it would be typed: pipes, redirects, `&&`.
/// Splitting a command line correctly is a per-platform guessing game; the shell
/// already knows how.
pub fn run(command: &str, cwd: &str, timeout: Duration) -> Result<Output, String> {
    if command.trim().is_empty() {
        return Err("There is no command to run.".into());
    }
    let dir = if cwd.trim().is_empty() {
        crate::config::home()
    } else {
        crate::browse::normalize(cwd)
    };
    if !dir.is_dir() {
        return Err(format!("{} is not a folder on this machine.", dir.display()));
    }

    let shell = crate::config::default_shell();
    let mut cmd = crate::pty::quiet_command(&shell);
    if cfg!(windows) {
        // `-NoProfile` so a profile that prints a banner does not end up in the
        // output, and so a slow profile does not eat the deadline.
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", command]);
    } else {
        // `-lc`, not `-c`: a login shell picks up nvm, rbenv, and the rest of
        // what a person's PATH is actually made of. The daemon itself does the
        // same thing for the same reason (`pty::login_path`).
        cmd.args(["-lc", command]);
    }

    let mut child = cmd
        .current_dir(&dir)
        // Null, not inherited: nothing is going to type an answer, and a command
        // that waits for one must hit the deadline rather than block forever on
        // a console the daemon does not have.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", shell))?;

    // Both pipes are drained on their own threads from the moment the child
    // starts. Reading them in turn after waiting would deadlock the moment
    // either one filled its buffer — which for a build is at once.
    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();
    let out_thread = std::thread::spawn(move || drain(out_pipe));
    let err_thread = std::thread::spawn(move || drain(err_pipe));

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                // A killed command has no exit code of its own. 124 is what
                // `timeout(1)` uses, and it is worth more than a bare -1: a
                // caller can tell "it was killed" from "it failed".
                break 124;
            }
            Err(e) => return Err(format!("Lost track of the command: {e}")),
        }
    };

    let (stdout, out_cut) = out_thread.join().unwrap_or_default();
    let (stderr, err_cut) = err_thread.join().unwrap_or_default();

    Ok(Output {
        code,
        stdout,
        stderr,
        truncated: out_cut || err_cut,
        timed_out,
    })
}

/// Read a pipe to its end, keeping at most `MAX_STREAM` bytes.
///
/// The reading continues past the cap rather than stopping: a full pipe blocks
/// the child, and a child blocked on a pipe nobody is draining would sit there
/// until the deadline killed it. So the bytes past the cap are read and thrown
/// away, which keeps the command running and the memory bounded.
fn drain(pipe: Option<impl Read>) -> (String, bool) {
    let Some(mut pipe) = pipe else { return (String::new(), false) };
    let mut kept: Vec<u8> = Vec::new();
    let mut cut = false;
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if kept.len() < MAX_STREAM {
                    let room = MAX_STREAM - kept.len();
                    kept.extend_from_slice(&buf[..n.min(room)]);
                    if n > room {
                        cut = true;
                    }
                } else {
                    cut = true;
                }
            }
        }
    }
    // Lossy: build tools print whatever their locale gives them, and a stray
    // byte must not turn the whole answer into an error.
    let mut text = String::from_utf8_lossy(&kept).into_owned();
    if cut {
        text.push_str("\n… output cut off here — it went past 1 MB.\n");
    }
    (text, cut)
}

/// The seconds a caller asked for, held inside what is allowed.
pub fn clamp_timeout(asked: Option<u64>) -> Duration {
    let secs = asked.unwrap_or(DEFAULT_TIMEOUT).clamp(1, MAX_TIMEOUT);
    Duration::from_secs(secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_reports_what_it_printed_and_its_code() {
        let out = run("echo hello", "", Duration::from_secs(20)).unwrap();
        assert_eq!(out.code, 0, "stderr was {:?}", out.stderr);
        assert!(out.stdout.contains("hello"), "stdout was {:?}", out.stdout);
        assert!(!out.timed_out);
        assert!(!out.truncated);
    }

    #[test]
    fn a_failing_command_keeps_its_exit_code() {
        // Written so both shells agree: `exit 3` means the same in PowerShell
        // and in bash.
        let out = run("exit 3", "", Duration::from_secs(20)).unwrap();
        assert_eq!(out.code, 3);
    }

    #[test]
    fn a_command_that_never_ends_is_killed() {
        let cmd = if cfg!(windows) { "Start-Sleep -Seconds 30" } else { "sleep 30" };
        let started = Instant::now();
        let out = run(cmd, "", Duration::from_secs(2)).unwrap();
        assert!(out.timed_out, "should have been killed");
        assert_eq!(out.code, 124);
        assert!(started.elapsed() < Duration::from_secs(20), "took {:?}", started.elapsed());
    }

    #[test]
    fn a_folder_that_is_not_there_is_refused_before_anything_runs() {
        let err = run("echo hi", "Z:\\nowhere\\at\\all", Duration::from_secs(5)).unwrap_err();
        assert!(err.contains("not a folder"), "{err}");
    }

    #[test]
    fn an_empty_command_is_refused() {
        assert!(run("   ", "", Duration::from_secs(5)).is_err());
    }

    #[test]
    fn the_timeout_asked_for_is_held_inside_what_is_allowed() {
        assert_eq!(clamp_timeout(None), Duration::from_secs(DEFAULT_TIMEOUT));
        assert_eq!(clamp_timeout(Some(0)), Duration::from_secs(1));
        assert_eq!(clamp_timeout(Some(9_000)), Duration::from_secs(MAX_TIMEOUT));
        assert_eq!(clamp_timeout(Some(30)), Duration::from_secs(30));
    }
}
