//! The tray icon: sessionhub's smallest possible face.
//!
//! It is `sessionhubd tray` — the same binary, a different process. That is on
//! purpose. The daemon may be running as a service in another session, where a
//! tray icon cannot be drawn at all, and the one principle this project has is
//! that the interface and the engine are separate processes. So the tray owns
//! no PTY and holds no state: it asks `/api/status` what is true, the same way
//! the browser does, and offers the two answers that were hard to find from a
//! console window that closed itself — where sessionhub is, and how to stop it.

use std::process::ExitCode;

#[cfg(not(any(windows, target_os = "macos")))]
pub fn run(_home: Option<std::path::PathBuf>) -> ExitCode {
    eprintln!(
        "The tray icon is Windows and macOS only for now.\n\
         `sessionhubd status` says where the daemon is, and `sessionhubd stop` ends it."
    );
    ExitCode::from(2)
}

#[cfg(windows)]
pub fn run(home: Option<std::path::PathBuf>) -> ExitCode {
    win::run(home)
}

#[cfg(target_os = "macos")]
pub fn run(home: Option<std::path::PathBuf>) -> ExitCode {
    mac::run(home)
}

#[cfg(windows)]
mod win;

#[cfg(target_os = "macos")]
mod mac;

