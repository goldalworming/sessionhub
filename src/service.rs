//! Installing as a system service so the daemon comes back after a reboot.
//!
//! Windows uses the Service Control Manager; unix generates a systemd user
//! unit or a launchd plist to a file.
//!
//! One thing that matters on Windows: a service runs as LocalSystem by
//! default, which has its own profile — its `%USERPROFILE%` is not the
//! user's. That is why the home path is passed as a `--home` argument at
//! install time rather than trusted from the environment.
//!
//! Windows memakai Service Control Manager; unix memakai systemd user unit

pub const SERVICE_NAME: &str = "sessionhubd";
pub const SERVICE_DISPLAY: &str = "sessionhub daemon";

/// Launch arguments baked into the service/unit.
pub fn launch_args(home: &std::path::Path) -> Vec<String> {
    vec!["service-run".into(), "--home".into(), home.display().to_string()]
}

// ------------------------------------------------------------------ Windows

#[cfg(windows)]
pub mod platform {
    use std::ffi::OsString;
    use std::path::Path;
    use std::time::Duration;

    use windows_service::service::{
        ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState,
        ServiceType,
    };
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

    use super::{launch_args, SERVICE_DISPLAY, SERVICE_NAME};

    pub struct InstallOpts {
        pub home: std::path::PathBuf,
        pub account: Option<String>,
        pub password: Option<String>,
    }

    pub fn install(opts: &InstallOpts) -> Result<String, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let manager = ServiceManager::local_computer(
            None::<&str>,
            ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
        )
        .map_err(access_hint)?;

        let info = ServiceInfo {
            name: OsString::from(SERVICE_NAME),
            display_name: OsString::from(SERVICE_DISPLAY),
            service_type: ServiceType::OWN_PROCESS,
            start_type: ServiceStartType::AutoStart,
            error_control: ServiceErrorControl::Normal,
            executable_path: exe,
            launch_arguments: launch_args(&opts.home).into_iter().map(OsString::from).collect(),
            dependencies: vec![],
            account_name: opts.account.as_ref().map(OsString::from),
            account_password: opts.password.as_ref().map(OsString::from),
        };

        let service = manager
            .create_service(&info, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START)
            .map_err(access_hint)?;
        let _ = service.set_description(
            "Keeps coding agent terminals alive independently of the UI.",
        );
        service.start::<&str>(&[]).map_err(|e| format!("service installed but failed to start: {e}"))?;

        Ok(match &opts.account {
            Some(a) => format!("installed and running as `{a}`"),
            None => "installed and running as LocalSystem".to_string(),
        })
    }

    pub fn uninstall() -> Result<(), String> {
        let manager =
            ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
                .map_err(access_hint)?;
        let service = manager
            .open_service(
                SERVICE_NAME,
                ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
            )
            .map_err(access_hint)?;

        if let Ok(status) = service.query_status() {
            if status.current_state != ServiceState::Stopped {
                let _ = service.stop();
                for _ in 0..30 {
                    std::thread::sleep(Duration::from_millis(200));
                    if matches!(
                        service.query_status().map(|s| s.current_state),
                        Ok(ServiceState::Stopped)
                    ) {
                        break;
                    }
                }
            }
        }
        service.delete().map_err(access_hint)?;
        Ok(())
    }

    pub fn is_installed() -> bool {
        ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .and_then(|m| m.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS))
            .is_ok()
    }

    /// `windows_service::Error` prints itself as "IO error in winapi call" —
    /// which says nothing. The real Windows code lives in its source error, and
    /// that is what decides what the user can actually do about it.
    fn access_hint(e: windows_service::Error) -> String {
        match os_code(&e) {
            Some(5) => "access denied.\n  \
                        Open a terminal as Administrator and try again."
                .to_string(),
            Some(1060) => format!(
                "service `{SERVICE_NAME}` is not installed.\n  \
                 Install it first with `sessionhubd install`."
            ),
            Some(1073) => format!(
                "service `{SERVICE_NAME}` is already installed.\n  \
                 Remove it first with `sessionhubd uninstall`."
            ),
            Some(1072) => format!(
                "service `{SERVICE_NAME}` is marked for deletion.\n  \
                 Close services.msc, or reboot, then try again."
            ),
            Some(1053) => "the service did not report to the Service Control Manager in time.\n  \
                           See ~/.sessionhub/sessionhubd.log."
                .to_string(),
            Some(c) => format!("failed with Windows error code {c}."),
            None => e.to_string(),
        }
    }

    /// Walk the source chain until an `io::Error` carrying an OS code turns up.
    fn os_code(e: &windows_service::Error) -> Option<i32> {
        let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
        while let Some(err) = cur {
            if let Some(io) = err.downcast_ref::<std::io::Error>() {
                return io.raw_os_error();
            }
            cur = err.source();
        }
        None
    }

    /// Entry point when the Service Control Manager runs us.
    pub fn run(home: Option<&Path>) -> Result<(), String> {
        super::dispatch::start(home)
    }
}

#[cfg(windows)]
mod dispatch {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::sync::OnceLock;
    use std::time::Duration;

    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};

    use super::SERVICE_NAME;

    static HOME: OnceLock<Option<PathBuf>> = OnceLock::new();

    pub fn start(home: Option<&Path>) -> Result<(), String> {
        let _ = HOME.set(home.map(|p| p.to_path_buf()));
        service_dispatcher::start(SERVICE_NAME, ffi_service_main).map_err(|e| e.to_string())
    }

    define_windows_service!(ffi_service_main, service_main);

    fn service_main(_args: Vec<OsString>) {
        let (shutdown_tx, shutdown_rx) = mpsc::channel();

        let handler = move |control| match control {
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = shutdown_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            _ => ServiceControlHandlerResult::NotImplemented,
        };

        let Ok(handle) = service_control_handler::register(SERVICE_NAME, handler) else {
            return;
        };

        let running = |state, accept| ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accept,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::from_secs(5),
            process_id: None,
        };
        let _ = handle.set_service_status(running(ServiceState::Running, ServiceControlAccept::STOP));

        let home = HOME.get().cloned().flatten();
        std::thread::spawn(move || {
            crate::run_daemon(home);
        });

        // Block until the SCM asks us to stop; the process then exits whole so
        // every PTY thread finishes with it.
        // sehingga semua thread PTY ikut selesai.
        let _ = shutdown_rx.recv();
        let _ = handle.set_service_status(running(ServiceState::Stopped, ServiceControlAccept::empty()));
        crate::daemon::remove_pid_file();
        std::process::exit(0);
    }
}

// --------------------------------------------------------------------- unix

#[cfg(unix)]
pub mod platform {
    use std::path::{Path, PathBuf};

    use super::SERVICE_NAME;

    pub struct InstallOpts {
        pub home: PathBuf,
        pub account: Option<String>,
        pub password: Option<String>,
    }

    pub fn install(opts: &InstallOpts) -> Result<String, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let path = unit_path(&opts.home);
        let text = if cfg!(target_os = "macos") {
            super::launchd_plist(&exe, &opts.home)
        } else {
            super::systemd_unit(&exe, &opts.home)
        };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, text).map_err(|e| e.to_string())?;
        // Flags that only mean something to the Windows service are called out,
        // not swallowed: a launchd/systemd user unit always runs as the user who
        // enables it, so an --account given here would otherwise look honoured.
        let ignored = if opts.account.is_some() || opts.password.is_some() {
            "\n  Note: --account/--password apply to the Windows service only; \
             a user unit runs as whoever enables it."
        } else {
            ""
        };
        Ok(format!(
            "unit written to {}\n  Enable it with: {}{ignored}",
            path.display(),
            if cfg!(target_os = "macos") {
                format!("launchctl load {}", path.display())
            } else {
                format!("systemctl --user enable --now {SERVICE_NAME}")
            }
        ))
    }

    pub fn uninstall() -> Result<(), String> {
        let home = crate::config::home();
        let path = unit_path(&home);
        std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn is_installed() -> bool {
        unit_path(&crate::config::home()).exists()
    }

    pub fn run(_home: Option<&Path>) -> Result<(), String> {
        Err("service mode only exists on Windows; use systemd/launchd".into())
    }

    fn unit_path(home: &Path) -> PathBuf {
        if cfg!(target_os = "macos") {
            home.join("Library/LaunchAgents").join(format!("com.{SERVICE_NAME}.plist"))
        } else {
            home.join(".config/systemd/user").join(format!("{SERVICE_NAME}.service"))
        }
    }

}

/// A pure function so its output can be tested without touching the system.
/// On Windows only tests use it — the service goes through the SCM, not a unit.
#[cfg_attr(windows, allow(dead_code))]
pub fn systemd_unit(exe: &std::path::Path, home: &std::path::Path) -> String {
    let args = launch_args(home).join(" ");
    format!(
        "[Unit]\n\
         Description={SERVICE_DISPLAY}\n\
         After=network.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={} {}\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        exe.display(),
        args
    )
}

#[cfg_attr(windows, allow(dead_code))]
pub fn launchd_plist(exe: &std::path::Path, home: &std::path::Path) -> String {
    let args: String = launch_args(home)
        .iter()
        .map(|a| format!("    <string>{a}</string>\n"))
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
         \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \x20 <key>Label</key>\n\
         \x20 <string>com.{SERVICE_NAME}</string>\n\
         \x20 <key>ProgramArguments</key>\n\
         \x20 <array>\n\
         \x20   <string>{}</string>\n{}\
         \x20 </array>\n\
         \x20 <key>RunAtLoad</key>\n\
         \x20 <true/>\n\
         \x20 <key>KeepAlive</key>\n\
         \x20 <true/>\n\
         </dict>\n\
         </plist>\n",
        exe.display(),
        args
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn launch_args_carry_home_explicitly() {
        let args = launch_args(Path::new("C:\\Users\\user"));
        assert_eq!(args, vec!["service-run", "--home", "C:\\Users\\user"]);
    }

    #[test]
    fn systemd_unit_runs_the_service_mode_with_home() {
        let u = systemd_unit(Path::new("/opt/sessionhubd"), Path::new("/home/user"));
        assert!(u.contains("ExecStart=/opt/sessionhubd service-run --home /home/user"), "{u}");
        assert!(u.contains("WantedBy=default.target"));
        assert!(u.contains("Restart=on-failure"));
    }

    #[test]
    fn launchd_plist_lists_each_argument_separately() {
        let p = launchd_plist(Path::new("/usr/local/bin/sessionhubd"), Path::new("/Users/u"));
        assert!(p.contains("<string>/usr/local/bin/sessionhubd</string>"));
        assert!(p.contains("<string>service-run</string>"));
        assert!(p.contains("<string>--home</string>"));
        assert!(p.contains("<string>/Users/u</string>"));
        assert!(p.contains("<key>RunAtLoad</key>"));
    }
}
