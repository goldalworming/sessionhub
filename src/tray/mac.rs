//! The macOS menu bar: an `NSStatusItem` whose menu is rebuilt every time it
//! opens, driven through the Objective-C runtime by hand.
//!
//! By hand because the alternative is a stack of `objc2-*` crates for one
//! status item and six menu entries, in a repo whose whole build is `cargo
//! build`. What that costs is spelled out below: every call goes through
//! `objc_msgSend`, which has no prototype of its own, so each one is
//! transmuted to the exact signature the selector expects. Get one wrong and
//! it is undefined behaviour, not a type error — hence a `send_*` helper per
//! shape rather than a cast at each call site.

use std::cell::RefCell;
use std::ffi::{c_char, c_void, CString};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use crate::{config, daemon};

type Id = *mut c_void;
type Sel = *const c_void;

const NIL: Id = std::ptr::null_mut();

/// The chevron from a shell prompt, which is what this thing is a door to.
const GLYPH: &str = "\u{276F}";

/// A menu bar item and no Dock icon: `NSApplicationActivationPolicyAccessory`.
const ACCESSORY: i64 = 1;
/// `NSAlertFirstButtonReturn` — the leftmost button, which is always the one
/// that goes ahead.
const FIRST_BUTTON: i64 = 1000;

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn objc_allocateClassPair(superclass: Id, name: *const c_char, extra: usize) -> Id;
    fn objc_registerClassPair(cls: Id);
    fn class_addMethod(cls: Id, name: Sel, imp: *const c_void, types: *const c_char) -> bool;
    fn objc_msgSend();
}

// Nothing is called from these directly. They are here so the linker brings in
// the frameworks whose classes this file looks up by name at runtime.
#[link(name = "AppKit", kind = "framework")]
extern "C" {}
#[link(name = "Foundation", kind = "framework")]
extern "C" {}

struct Tray {
    app: Id,
    item: Id,
    cfg: config::Config,
    home: Option<PathBuf>,
    /// What the last probe found, so the menu and the tooltip agree.
    status: Option<daemon::Status>,
}

thread_local! {
    static TRAY: RefCell<Option<Tray>> = const { RefCell::new(None) };
}

pub fn run(home: Option<PathBuf>) -> ExitCode {
    let Some(cfg) = crate::load_config() else { return ExitCode::FAILURE };

    // One item per menu bar. A second would be two answers to the same
    // question, and nothing distinguishes them up there.
    if already_showing() {
        println!("A sessionhub menu bar item is already showing.");
        return ExitCode::SUCCESS;
    }
    write_pid();

    unsafe {
        // Everything AppKit hands back here is autoreleased, and the run loop
        // that would normally own a pool has not started yet.
        let pool = send(send(class("NSAutoreleasePool"), sel("alloc")), sel("init"));

        let app = send(class("NSApplication"), sel("sharedApplication"));
        send_i64(app, sel("setActivationPolicy:"), ACCESSORY);

        let bar = send(class("NSStatusBar"), sel("systemStatusBar"));
        // NSVariableStatusItemLength: as wide as what it draws.
        let item = send_f64(bar, sel("statusItemWithLength:"), -1.0);
        send(item, sel("retain"));

        TRAY.with(|t| *t.borrow_mut() = Some(Tray { app, item, cfg, home, status: None }));

        let handler = make_handler();
        let menu = send(send(class("NSMenu"), sel("alloc")), sel("init"));
        // The menu is built by hand in `on_menu`, disabled rows and all, so
        // AppKit must not decide for itself which rows are live.
        send_bool(menu, sel("setAutoenablesItems:"), false);
        send_id(menu, sel("setDelegate:"), handler);
        send_id(item, sel("setMenu:"), menu);

        look();
        // Often enough to notice a daemon that died, rare enough to cost
        // nothing. The menu refreshes on its own when it opens.
        every(5.0, handler, sel("tick:"));

        // Safe to drain: the status item was retained above, and the menu and
        // the handler were made with alloc/init, so this owns them already.
        send(pool, sel("drain"));

        send(app, sel("run"));
    }

    forget_pid();
    ExitCode::SUCCESS
}

/// A class with no ivars, made at runtime, whose only job is to be something
/// the menu items and the timer can point their selectors at.
unsafe fn make_handler() -> Id {
    let cls = objc_allocateClassPair(class("NSObject"), cstr("SessionhubTray").as_ptr(), 0);
    // "one object argument, returns nothing" — the shape of every callback
    // here, including the menu delegate and the timer.
    let types = cstr("v@:@");
    for (name, imp) in [
        ("menuNeedsUpdate:", on_menu as *const c_void),
        ("tick:", on_tick as *const c_void),
        ("openUI:", on_open as *const c_void),
        ("copyAddress:", on_copy as *const c_void),
        ("openLog:", on_log as *const c_void),
        ("stopDaemon:", on_stop as *const c_void),
        ("startDaemon:", on_start as *const c_void),
        ("hideItem:", on_hide as *const c_void),
    ] {
        class_addMethod(cls, sel(name), imp, types.as_ptr());
    }
    objc_registerClassPair(cls);
    send(send(cls, sel("alloc")), sel("init"))
}

// -------------------------------------------------------------------- menu

/// Built fresh every time it opens: what it offers depends on whether anything
/// answered a moment ago.
extern "C" fn on_menu(this: Id, _cmd: Sel, menu: Id) {
    look();
    let status = TRAY.with(|t| t.borrow().as_ref().and_then(|tr| tr.status.clone()));
    unsafe {
        send(menu, sel("removeAllItems"));
        match &status {
            Some(s) => {
                dead_row(menu, &format!("sessionhub \u{2014} port {}", s.port));
                dead_row(
                    menu,
                    &format!(
                        "{} terminal(s), up {}",
                        s.terminals_alive,
                        daemon::human_uptime(s.uptime_secs)
                    ),
                );
                separator(menu);
                row(menu, "Open sessionhub", sel("openUI:"), this);
                row(menu, "Copy address", sel("copyAddress:"), this);
                row(menu, "Open log", sel("openLog:"), this);
                separator(menu);
                row(menu, "Stop sessionhub\u{2026}", sel("stopDaemon:"), this);
                row(
                    menu,
                    "Hide this item \u{2014} sessionhub keeps running",
                    sel("hideItem:"),
                    this,
                );
            }
            None => {
                dead_row(menu, "sessionhub \u{2014} not running");
                separator(menu);
                row(menu, "Start sessionhub", sel("startDaemon:"), this);
                row(menu, "Open log", sel("openLog:"), this);
                separator(menu);
                row(menu, "Hide this item", sel("hideItem:"), this);
            }
        }
    }
}

unsafe fn row(menu: Id, title: &str, action: Sel, target: Id) {
    let item = send_row(
        menu,
        sel("addItemWithTitle:action:keyEquivalent:"),
        nsstring(title),
        action,
        nsstring(""),
    );
    send_id(item, sel("setTarget:"), target);
}

/// A line that says something and does nothing.
unsafe fn dead_row(menu: Id, title: &str) {
    let item = send_row(
        menu,
        sel("addItemWithTitle:action:keyEquivalent:"),
        nsstring(title),
        std::ptr::null(),
        nsstring(""),
    );
    send_bool(item, sel("setEnabled:"), false);
}

unsafe fn separator(menu: Id) {
    send_id(menu, sel("addItem:"), send(class("NSMenuItem"), sel("separatorItem")));
}

// ----------------------------------------------------------------- actions

extern "C" fn on_tick(_this: Id, _cmd: Sel, _sender: Id) {
    look();
}

extern "C" fn on_open(_this: Id, _cmd: Sel, _sender: Id) {
    match address() {
        Some(url) => {
            let _ = crate::open_url(&url);
        }
        None => unsafe {
            tell("sessionhub", "Nothing answered on the daemon's port. Start it from this menu.")
        },
    }
}

extern "C" fn on_copy(_this: Id, _cmd: Sel, _sender: Id) {
    let Some(url) = address() else { return };
    unsafe {
        let board = send(class("NSPasteboard"), sel("generalPasteboard"));
        send(board, sel("clearContents"));
        send_id2(
            board,
            sel("setString:forType:"),
            nsstring(&url),
            nsstring("public.utf8-plain-text"),
        );
    }
}

extern "C" fn on_log(_this: Id, _cmd: Sel, _sender: Id) {
    let _ = crate::open_file(&config::log_path());
}

/// Stopping ends every live terminal, because they are children of the daemon.
/// That is worth one question, and worth saying what survives it.
extern "C" fn on_stop(_this: Id, _cmd: Sel, _sender: Id) {
    let Some(s) = TRAY.with(|t| t.borrow().as_ref().and_then(|tr| tr.status.clone())) else {
        return;
    };
    if s.terminals_alive > 0 {
        let body = format!(
            "{} live terminal(s) end with it.\n\nAgent sessions come back from the sidebar \
             with their context. A plain shell does not.",
            s.terminals_alive
        );
        if !unsafe { confirm("Stop sessionhub?", &body, "Stop") } {
            return;
        }
    }

    let Some(token) = TRAY.with(|t| t.borrow().as_ref().map(|tr| tr.cfg.token.clone())) else {
        return;
    };
    if daemon::request_stop(s.port, &token) {
        daemon::wait_gone(s.pid, Duration::from_secs(10));
        daemon::remove_pid_file();
    } else {
        unsafe { tell("sessionhub", "The daemon refused the stop command.") };
    }
    look();
}

extern "C" fn on_start(_this: Id, _cmd: Sel, _sender: Id) {
    let started = TRAY.with(|t| {
        let t = t.borrow();
        let tr = t.as_ref()?;
        Some(daemon::spawn_detached(&tr.cfg, tr.home.as_ref()))
    });
    match started {
        Some(Ok(_)) => {
            look();
            on_open(NIL, std::ptr::null(), NIL);
        }
        Some(Err(e)) => unsafe { tell("sessionhub", &format!("Could not start it: {e}")) },
        None => {}
    }
}

extern "C" fn on_hide(_this: Id, _cmd: Sel, _sender: Id) {
    // `terminate:` never comes back, so the pid file has to go first.
    forget_pid();
    let app = TRAY.with(|t| t.borrow().as_ref().map(|tr| tr.app).unwrap_or(NIL));
    unsafe { send_id(app, sel("terminate:"), NIL) };
}

// ------------------------------------------------------------------- state

fn address() -> Option<String> {
    TRAY.with(|t| {
        let t = t.borrow();
        let tr = t.as_ref()?;
        let s = tr.status.as_ref()?;
        Some(format!("http://127.0.0.1:{}/?token={}", s.port, tr.cfg.token))
    })
}

/// Ask the daemon what is true, then make the item say it.
///
/// A modal alert keeps the run loop turning, so the timer can land inside
/// another callback. Skipping that beat is the whole fix.
fn look() {
    let refreshed = TRAY.with(|t| {
        let Ok(mut t) = t.try_borrow_mut() else { return None };
        let tr = t.as_mut()?;
        let port = daemon::read_pid_file().map(|p| p.port).unwrap_or(tr.cfg.port);
        let mut found = daemon::probe(port, &tr.cfg.token);
        if found.is_none() {
            // Or the token was rotated while this item sat there.
            if let Ok(fresh) = config::load_or_create() {
                if fresh.token != tr.cfg.token {
                    found = daemon::probe(port, &fresh.token);
                }
                tr.cfg = fresh;
            }
        }
        tr.status = found.clone();
        Some(found)
    });
    let Some(found) = refreshed else { return };

    let tip = match &found {
        Some(s) => format!(
            "sessionhub \u{2014} {} terminal(s) on port {}",
            s.terminals_alive, s.port
        ),
        None => "sessionhub \u{2014} not running".to_string(),
    };
    unsafe {
        let button = TRAY.with(|t| match t.borrow().as_ref() {
            Some(tr) => send(tr.item, sel("button")),
            None => NIL,
        });
        if button.is_null() {
            return;
        }
        send_id(button, sel("setTitle:"), nsstring(GLYPH));
        send_id(button, sel("setToolTip:"), nsstring(&tip));
        // Dimmed is how the menu bar says "here, but nothing behind it". An
        // unknown selector is a crash rather than a mistake in objc, and this
        // is the one property here that not every macOS is certain to have.
        let dim = sel("setAppearsDisabled:");
        if responds(button, dim) {
            send_bool(button, dim, found.is_none());
        }
    }
}

// A menu bar item cannot be found by asking the system for one, the way a
// window can on Windows. So it leaves a pid behind instead.
fn pid_path() -> PathBuf {
    config::dir().join("tray.pid")
}

fn already_showing() -> bool {
    std::fs::read_to_string(pid_path())
        .ok()
        .and_then(|t| t.trim().parse::<u32>().ok())
        .map(|pid| pid != std::process::id() && daemon::process_alive(pid))
        .unwrap_or(false)
}

fn write_pid() {
    let _ = std::fs::create_dir_all(config::dir());
    let _ = std::fs::write(pid_path(), std::process::id().to_string());
}

fn forget_pid() {
    let _ = std::fs::remove_file(pid_path());
}

// ------------------------------------------------------------------- alerts

unsafe fn confirm(title: &str, body: &str, go: &str) -> bool {
    alert(title, body, Some(go)) == FIRST_BUTTON
}

unsafe fn tell(title: &str, body: &str) {
    alert(title, body, None);
}

unsafe fn alert(title: &str, body: &str, go: Option<&str>) -> i64 {
    // An accessory app is not frontmost, and a modal sheet from behind another
    // window is a dialog nobody can find.
    let app = TRAY.with(|t| t.borrow().as_ref().map(|tr| tr.app).unwrap_or(NIL));
    send_bool(app, sel("activateIgnoringOtherApps:"), true);

    let alert = send(send(class("NSAlert"), sel("alloc")), sel("init"));
    send_id(alert, sel("setMessageText:"), nsstring(title));
    send_id(alert, sel("setInformativeText:"), nsstring(body));
    match go {
        Some(go) => {
            send_id(alert, sel("addButtonWithTitle:"), nsstring(go));
            send_id(alert, sel("addButtonWithTitle:"), nsstring("Cancel"));
        }
        None => {
            send_id(alert, sel("addButtonWithTitle:"), nsstring("OK"));
        }
    }
    let answer = send_i64_ret(alert, sel("runModal"));
    send(alert, sel("release"));
    answer
}

// ------------------------------------------------------------- objc plumbing

fn cstr(s: &str) -> CString {
    CString::new(s).unwrap_or_default()
}

fn class(name: &str) -> Id {
    unsafe { objc_getClass(cstr(name).as_ptr()) }
}

fn sel(name: &str) -> Sel {
    unsafe { sel_registerName(cstr(name).as_ptr()) }
}

unsafe fn nsstring(s: &str) -> Id {
    let text = cstr(s);
    send_id(class("NSString"), sel("stringWithUTF8String:"), text.as_ptr() as Id)
}

// One helper per call shape. `objc_msgSend` is declared without arguments on
// purpose: the only correct way to call it is through a pointer typed exactly
// like the method being sent.
unsafe fn responds(obj: Id, cmd: Sel) -> bool {
    let f: extern "C" fn(Id, Sel, Sel) -> bool =
        std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, sel("respondsToSelector:"), cmd)
}

unsafe fn send(obj: Id, cmd: Sel) -> Id {
    let f: extern "C" fn(Id, Sel) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, cmd)
}

unsafe fn send_id(obj: Id, cmd: Sel, a: Id) -> Id {
    let f: extern "C" fn(Id, Sel, Id) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, cmd, a)
}

unsafe fn send_id2(obj: Id, cmd: Sel, a: Id, b: Id) -> Id {
    let f: extern "C" fn(Id, Sel, Id, Id) -> Id =
        std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, cmd, a, b)
}

unsafe fn send_row(obj: Id, cmd: Sel, title: Id, action: Sel, key: Id) -> Id {
    let f: extern "C" fn(Id, Sel, Id, Sel, Id) -> Id =
        std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, cmd, title, action, key)
}

unsafe fn send_f64(obj: Id, cmd: Sel, a: f64) -> Id {
    let f: extern "C" fn(Id, Sel, f64) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, cmd, a)
}

unsafe fn send_i64(obj: Id, cmd: Sel, a: i64) -> Id {
    let f: extern "C" fn(Id, Sel, i64) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, cmd, a)
}

unsafe fn send_i64_ret(obj: Id, cmd: Sel) -> i64 {
    let f: extern "C" fn(Id, Sel) -> i64 = std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, cmd)
}

/// `BOOL` is a one-byte C `_Bool` on every Mac this can run on.
unsafe fn send_bool(obj: Id, cmd: Sel, a: bool) -> Id {
    let f: extern "C" fn(Id, Sel, bool) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, cmd, a)
}

/// `NSTimer scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:`
unsafe fn every(seconds: f64, target: Id, action: Sel) -> Id {
    let f: extern "C" fn(Id, Sel, f64, Id, Sel, Id, bool) -> Id =
        std::mem::transmute(objc_msgSend as *const c_void);
    f(
        class("NSTimer"),
        sel("scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:"),
        seconds,
        target,
        action,
        NIL,
        true,
    )
}
