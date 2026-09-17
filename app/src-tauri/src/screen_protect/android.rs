//! Android：通过 Kotlin 插件给 Activity / 窗口加 `FLAG_SECURE`。

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

pub struct ScreenProtectHandle<R: Runtime>(pub tauri::plugin::PluginHandle<R>);

#[derive(Serialize)]
struct SetSecureArgs {
    secure: bool,
}

pub fn set_secure(app: &AppHandle, protect: bool) {
    let Some(handle) = app.try_state::<ScreenProtectHandle<tauri::Wry>>() else {
        return;
    };
    if let Err(e) = handle.0.run_mobile_plugin::<()>(
        "setSecure",
        SetSecureArgs { secure: protect },
    ) {
        log::warn!("无法更新 Android FLAG_SECURE：{e}");
    }
}
