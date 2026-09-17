//! Windows：`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`。
//! WebView2 子 HWND 会晚一点出现，所以切换后会再补几次。

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, SetWindowDisplayAffinity,
};

const WDA_NONE: u32 = 0x0000_0000;
const WDA_EXCLUDEFROMCAPTURE: u32 = 0x0000_0011;

static GEN: AtomicU32 = AtomicU32::new(0);

pub fn set_excluded(app: &AppHandle, protect: bool) {
    let affinity = if protect {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };
    apply_tree(app, affinity);
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    std::thread::spawn(move || {
        for delay_ms in [80_u64, 300, 1000] {
            std::thread::sleep(Duration::from_millis(delay_ms));
            if GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            apply_tree(&handle, affinity);
        }
    });
}

fn apply_tree(app: &AppHandle, affinity: u32) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    let root = hwnd.0 as HWND;
    if root.is_null() {
        return;
    }
    unsafe {
        apply_one(root, affinity);
        let _ = EnumChildWindows(root, Some(enum_child), affinity as LPARAM);
    }
}

unsafe extern "system" fn enum_child(hwnd: HWND, lparam: LPARAM) -> BOOL {
    apply_one(hwnd, lparam as u32);
    TRUE
}

unsafe fn apply_one(hwnd: HWND, affinity: u32) {
    if hwnd.is_null() {
        return;
    }
    let _ = SetWindowDisplayAffinity(hwnd, affinity);
}
