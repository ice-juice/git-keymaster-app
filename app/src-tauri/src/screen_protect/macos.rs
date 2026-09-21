//! macOS：`NSWindow.sharingType = NSWindowSharingNone`，不用 Windows API。

use objc2::msg_send;
use objc2::runtime::AnyObject;
use tauri::{AppHandle, Manager};

/// `NSWindowSharingNone` / `NSWindowSharingReadOnly`
const SHARE_NONE: usize = 0;
const SHARE_READ_ONLY: usize = 1;

pub fn set_sharing_none(app: &AppHandle, protect: bool) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let Ok(ptr) = win.ns_window() else {
        return;
    };
    let obj = ptr as *mut AnyObject;
    if obj.is_null() {
        return;
    }
    let sharing = if protect { SHARE_NONE } else { SHARE_READ_ONLY };
    unsafe {
        let _: () = msg_send![obj, setSharingType: sharing];
    }
}
