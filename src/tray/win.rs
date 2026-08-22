//! The Windows notification area: `Shell_NotifyIcon`, a window that is
//! never shown, and a popup menu built fresh every time it opens.

use std::cell::RefCell;
use std::path::PathBuf;
use std::process::ExitCode;
use std::ptr::{null, null_mut};
use std::sync::OnceLock;
use std::time::Duration;

use windows_sys::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIM_ADD,
    NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

use crate::{config, daemon};

const CLASS: &str = "sessionhubd_tray";
/// The icon talks back through this one message; `lParam` carries the mouse
/// event that caused it.
const WM_TRAY: u32 = WM_APP + 1;
const TIMER_REFRESH: usize = 1;

const ID_OPEN: usize = 1;
const ID_COPY: usize = 2;
const ID_LOG: usize = 3;
const ID_STOP: usize = 4;
const ID_START: usize = 5;
const ID_HIDE: usize = 6;

/// 16x16, drawn here rather than taken from the icon the exe now carries.
/// See the palette below for why. `#` is the tile, `*` the prompt, `.` is
/// transparent.
const GLYPH: [&str; 16] = [
    "..############..",
    ".##############.",
    "################",
    "################",
    "##**############",
    "###**###########",
    "####**##########",
    "#####**#########",
    "####**##########",
    "###**###########",
    "##**############",
    "########*****###",
    "################",
    "################",
    ".##############.",
    "..############..",
];

/// The logo's own colours, sampled from `web/icon-512.webp`, so the tray reads
/// as the same product as the icon now on the exe.
///
/// The logo itself is not used here. At 16 pixels the `sh` inside it is a
/// smudge, and the one thing the tray has to say — running, or not — is said by
/// the colour of the ink, which a fixed picture cannot say at all.
const TILE: [u8; 3] = [0x0C, 0x0F, 0x19];
const LIVE: [u8; 3] = [0x55, 0xDB, 0xF9];
const IDLE: [u8; 3] = [0x6B, 0x72, 0x80];

struct Tray {
    hwnd: HWND,
    live: HICON,
    idle: HICON,
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

    // One icon per desktop. A second one would be two answers to the same
    // question, and the shell offers no way to tell them apart.
    if unsafe { !FindWindowW(wide(CLASS).as_ptr(), null()).is_null() } {
        println!("A sessionhub tray icon is already showing.");
        return ExitCode::SUCCESS;
    }

    unsafe {
        let hinst: HINSTANCE = GetModuleHandleW(null());
        let class = wide(CLASS);
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(wndproc),
            hInstance: hinst,
            lpszClassName: class.as_ptr(),
            ..Default::default()
        };
        if RegisterClassExW(&wc) == 0 {
            eprintln!("Could not register the tray window class.");
            return ExitCode::FAILURE;
        }

        // A real window, never shown. Not a message-only one: those miss the
        // broadcast Explorer sends when it restarts, and the icon would be
        // gone for good the first time it does.
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            wide("sessionhub").as_ptr(),
            WS_OVERLAPPED,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            0,
            0,
            null_mut(),
            null_mut(),
            hinst,
            null_mut(),
        );
        if hwnd.is_null() {
            eprintln!("Could not create the tray window.");
            return ExitCode::FAILURE;
        }

        let tray = Tray {
            hwnd,
            live: make_icon(hinst, LIVE),
            idle: make_icon(hinst, IDLE),
            cfg,
            home,
            status: None,
        };
        TRAY.with(|t| *t.borrow_mut() = Some(tray));

        look();
        add_icon();
        greet();
        SetTimer(hwnd, TIMER_REFRESH, 5_000, None);

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        remove_icon();
        TRAY.with(|t| {
            if let Some(tr) = t.borrow_mut().take() {
                DestroyIcon(tr.live);
                DestroyIcon(tr.idle);
            }
        });
    }
    ExitCode::SUCCESS
}

// --------------------------------------------------------------- messages

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match msg {
        WM_TRAY => {
            match l as u32 {
                WM_LBUTTONUP | WM_LBUTTONDBLCLK => open_ui(),
                WM_RBUTTONUP | WM_CONTEXTMENU => show_menu(hwnd),
                _ => {}
            }
            0
        }
        WM_TIMER if w == TIMER_REFRESH => {
            refresh();
            0
        }
        // Explorer restarted and threw every icon away with it.
        m if m == taskbar_created() => {
            add_icon();
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, w, l),
    }
}

fn taskbar_created() -> u32 {
    static MSG: OnceLock<u32> = OnceLock::new();
    *MSG.get_or_init(|| unsafe { RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()) })
}

/// The menu is built fresh every time it opens: what it offers depends on
/// whether anything answered a moment ago.
///
/// `TPM_RETURNCMD` hands the choice back here instead of posting it, so
/// nothing runs while this function is still inside the shell's click.
unsafe fn show_menu(hwnd: HWND) {
    refresh();
    let status = TRAY.with(|t| t.borrow().as_ref().and_then(|tr| tr.status.clone()));

    let menu = CreatePopupMenu();
    let dead = MF_STRING | MF_DISABLED | MF_GRAYED;
    match &status {
        Some(s) => {
            let head = format!("sessionhub — port {}", s.port);
            let body = format!(
                "{} terminal(s), up {}",
                s.terminals_alive,
                daemon::human_uptime(s.uptime_secs)
            );
            AppendMenuW(menu, dead, 0, wide(&head).as_ptr());
            AppendMenuW(menu, dead, 0, wide(&body).as_ptr());
            AppendMenuW(menu, MF_SEPARATOR, 0, null());
            AppendMenuW(menu, MF_STRING | MF_DEFAULT, ID_OPEN, wide("Open sessionhub").as_ptr());
            AppendMenuW(menu, MF_STRING, ID_COPY, wide("Copy address").as_ptr());
            AppendMenuW(menu, MF_STRING, ID_LOG, wide("Open log").as_ptr());
            AppendMenuW(menu, MF_SEPARATOR, 0, null());
            AppendMenuW(menu, MF_STRING, ID_STOP, wide("Stop sessionhub…").as_ptr());
            AppendMenuW(
                menu,
                MF_STRING,
                ID_HIDE,
                wide("Hide this icon — sessionhub keeps running").as_ptr(),
            );
        }
        None => {
            AppendMenuW(menu, dead, 0, wide("sessionhub — not running").as_ptr());
            AppendMenuW(menu, MF_SEPARATOR, 0, null());
            AppendMenuW(
                menu,
                MF_STRING | MF_DEFAULT,
                ID_START,
                wide("Start sessionhub").as_ptr(),
            );
            AppendMenuW(menu, MF_STRING, ID_LOG, wide("Open log").as_ptr());
            AppendMenuW(menu, MF_SEPARATOR, 0, null());
            AppendMenuW(menu, MF_STRING, ID_HIDE, wide("Hide this icon").as_ptr());
        }
    }

    let mut at = POINT { x: 0, y: 0 };
    GetCursorPos(&mut at);
    // A tray menu only closes on a click elsewhere if its owner is in front,
    // and only lets go of that click after a message it does not want.
    SetForegroundWindow(hwnd);
    let choice = TrackPopupMenu(
        menu,
        TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
        at.x,
        at.y,
        0,
        hwnd,
        null(),
    );
    PostMessageW(hwnd, WM_NULL, 0, 0);
    DestroyMenu(menu);

    match choice as usize {
        ID_OPEN => open_ui(),
        ID_COPY => copy_address(hwnd),
        ID_LOG => {
            let _ = crate::open_file(&config::log_path());
        }
        ID_STOP => stop_daemon(hwnd, status),
        ID_START => start_daemon(hwnd),
        ID_HIDE => PostQuitMessage(0),
        _ => {}
    }
}

// ---------------------------------------------------------------- actions

fn address() -> Option<String> {
    TRAY.with(|t| {
        let t = t.borrow();
        let tr = t.as_ref()?;
        let s = tr.status.as_ref()?;
        Some(format!("http://127.0.0.1:{}/?token={}", s.port, tr.cfg.token))
    })
}

fn open_ui() {
    match address() {
        Some(url) => {
            let _ = crate::open_url(&url);
        }
        None => unsafe {
            say(
                null_mut(),
                "sessionhub",
                "Nothing answered on the daemon's port. Start it from this menu.",
                MB_ICONINFORMATION,
            );
        },
    }
}

fn copy_address(hwnd: HWND) {
    let Some(url) = address() else { return };
    unsafe {
        if !to_clipboard(hwnd, &url) {
            say(hwnd, "sessionhub", "Could not put the address on the clipboard.", MB_ICONWARNING);
        }
    }
}

/// Stopping ends every live terminal, because they are children of the
/// daemon. That is worth one question, and worth saying what survives it.
unsafe fn stop_daemon(hwnd: HWND, status: Option<daemon::Status>) {
    let Some(s) = status else { return };
    if s.terminals_alive > 0 {
        let text = format!(
            "{} live terminal(s) end with it.\n\n\
             Agent sessions come back from the sidebar with their context. \
             A plain shell does not.\n\n\
             Stop sessionhub?",
            s.terminals_alive
        );
        if MessageBoxW(
            hwnd,
            wide(&text).as_ptr(),
            wide("Stop sessionhub").as_ptr(),
            MB_YESNO | MB_ICONWARNING,
        ) != IDYES
        {
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
        say(hwnd, "sessionhub", "The daemon refused the stop command.", MB_ICONWARNING);
    }
    refresh();
}

unsafe fn start_daemon(hwnd: HWND) {
    let started = TRAY.with(|t| {
        let t = t.borrow();
        let tr = t.as_ref()?;
        Some(daemon::spawn_detached(&tr.cfg, tr.home.as_ref()))
    });
    match started {
        Some(Ok(_)) => {
            refresh();
            open_ui();
        }
        Some(Err(e)) => {
            say(hwnd, "sessionhub", &format!("Could not start it: {e}"), MB_ICONWARNING)
        }
        None => {}
    }
}

// ------------------------------------------------------------------ state

/// Ask the daemon what is true, then make the icon and the tooltip say it.
///
/// A menu or a dialog keeps pumping messages, so the refresh timer can land
/// inside another handler. Skipping that beat is the whole fix.
fn refresh() {
    if TRAY.with(|t| t.try_borrow_mut().is_err()) {
        return;
    }
    look();
}

fn look() {
    let found = TRAY.with(|t| {
        let mut t = t.borrow_mut();
        let Some(tr) = t.as_mut() else { return None };
        let port = daemon::read_pid_file().map(|p| p.port).unwrap_or(tr.cfg.port);
        let mut found = daemon::probe(port, &tr.cfg.token);
        if found.is_none() {
            // Or the token was rotated while this icon sat there.
            if let Ok(fresh) = config::load_or_create() {
                if fresh.token != tr.cfg.token {
                    found = daemon::probe(port, &fresh.token);
                }
                tr.cfg = fresh;
            }
        }
        tr.status = found.clone();
        found
    });

    unsafe {
        let mut data = icon_data();
        data.uFlags = NIF_ICON | NIF_TIP;
        data.hIcon = TRAY.with(|t| match t.borrow().as_ref() {
            Some(tr) if found.is_some() => tr.live,
            Some(tr) => tr.idle,
            None => null_mut(),
        });
        fill(&mut data.szTip, &tooltip(found.as_ref()));
        Shell_NotifyIconW(NIM_MODIFY, &data);
    }
}

fn tooltip(status: Option<&daemon::Status>) -> String {
    match status {
        Some(s) => format!("sessionhub — {} terminal(s) on port {}", s.terminals_alive, s.port),
        None => "sessionhub — not running".to_string(),
    }
}

fn icon_data() -> NOTIFYICONDATAW {
    NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: TRAY.with(|t| t.borrow().as_ref().map(|tr| tr.hwnd).unwrap_or(null_mut())),
        uID: 1,
        uCallbackMessage: WM_TRAY,
        ..Default::default()
    }
}

fn add_icon() {
    unsafe {
        let mut data = icon_data();
        data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
        let (icon, tip) = TRAY.with(|t| {
            let t = t.borrow();
            match t.as_ref() {
                Some(tr) => (
                    if tr.status.is_some() { tr.live } else { tr.idle },
                    tooltip(tr.status.as_ref()),
                ),
                None => (null_mut(), String::new()),
            }
        });
        data.hIcon = icon;
        fill(&mut data.szTip, &tip);
        Shell_NotifyIconW(NIM_ADD, &data);
    }
}

fn remove_icon() {
    unsafe {
        let data = icon_data();
        Shell_NotifyIconW(NIM_DELETE, &data);
    }
}

/// Say hello once, because the window that used to carry this news closed
/// itself half a second after it opened.
fn greet() {
    let Some(s) = TRAY.with(|t| t.borrow().as_ref().and_then(|tr| tr.status.clone())) else {
        return;
    };
    unsafe {
        let mut data = icon_data();
        data.uFlags = NIF_INFO;
        data.dwInfoFlags = NIIF_INFO;
        fill(&mut data.szInfoTitle, "sessionhub is running");
        fill(
            &mut data.szInfo,
            &format!("Port {}. Click this icon to open it, right-click to stop it.", s.port),
        );
        Shell_NotifyIconW(NIM_MODIFY, &data);
    }
}

// ------------------------------------------------------------------ win32

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn fill(dst: &mut [u16], s: &str) {
    let mut n = 0;
    for c in s.encode_utf16().take(dst.len() - 1) {
        dst[n] = c;
        n += 1;
    }
    dst[n] = 0;
}

unsafe fn say(hwnd: HWND, title: &str, text: &str, style: MESSAGEBOX_STYLE) {
    MessageBoxW(hwnd, wide(text).as_ptr(), wide(title).as_ptr(), style);
}

unsafe fn to_clipboard(hwnd: HWND, text: &str) -> bool {
    if OpenClipboard(hwnd) == 0 {
        return false;
    }
    EmptyClipboard();
    let w = wide(text);
    let mem = GlobalAlloc(GMEM_MOVEABLE, w.len() * 2);
    if mem.is_null() {
        CloseClipboard();
        return false;
    }
    let p = GlobalLock(mem) as *mut u16;
    std::ptr::copy_nonoverlapping(w.as_ptr(), p, w.len());
    GlobalUnlock(mem);
    // On success the clipboard owns that memory and frees it itself.
    let ok = !SetClipboardData(CF_UNICODETEXT as u32, mem as HANDLE).is_null();
    CloseClipboard();
    ok
}

/// Paint [`GLYPH`] into an icon: a colour bitmap plus a 1-bit mask, where a
/// set mask bit means "leave the desktop showing through here".
unsafe fn make_icon(hinst: HINSTANCE, ink: [u8; 3]) -> HICON {
    let mut mask = [0u8; 16 * 2];
    let mut color = [0u8; 16 * 16 * 4];
    for (y, row) in GLYPH.iter().enumerate() {
        for (x, ch) in row.bytes().enumerate() {
            let paint = match ch {
                b'#' => TILE,
                b'*' => ink,
                _ => {
                    mask[y * 2 + x / 8] |= 0x80 >> (x % 8);
                    continue;
                }
            };
            let i = (y * 16 + x) * 4;
            color[i] = paint[2];
            color[i + 1] = paint[1];
            color[i + 2] = paint[0];
            color[i + 3] = 0xFF;
        }
    }
    CreateIcon(hinst, 16, 16, 1, 32, mask.as_ptr(), color.as_ptr())
}
