//! 桌面端 WebView 摄像头授权。
//! Windows 的 WebView2 默认会静默拒绝 getUserMedia，必须挂 PermissionRequested。

#![cfg(windows)]

use tauri::{AppHandle, Manager};

pub fn grant_camera(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let _ = win.with_webview(|webview| {
        attach_camera_permission(webview);
    });
}

fn attach_camera_permission(webview: tauri::webview::PlatformWebview) {
    use webview2_com::PermissionRequestedEventHandler;

    let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else {
        return;
    };
    let handler = PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
        if let Some(args) = args {
            allow_camera(&args);
        }
        Ok(())
    }));
    let mut token = 0;
    let _ = unsafe { core.add_PermissionRequested(&handler, &mut token) };
}

fn allow_camera(args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2PermissionRequestedEventArgs) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };

    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
    if unsafe { args.PermissionKind(&mut kind) }.is_err() {
        return;
    }
    if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
        let _ = unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW) };
    }
}
