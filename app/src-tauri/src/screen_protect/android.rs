//! Android：通过 Kotlin 插件给 Activity / 窗口加 `FLAG_SECURE`。

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

pub struct ScreenProtectHandle<R: Runtime>(pub tauri::plugin::PluginHandle<R>);

#[derive(Serialize)]
struct SetSecureArgs {
    secure: bool,
}

pub fn set_secure(app: &AppHandle, protect: bool) {
    if let Err(e) = set_secure_checked(app, protect) { log::warn!("无法更新 Android FLAG_SECURE：{e}"); }
}

pub fn set_secure_checked(app: &AppHandle, protect: bool) -> Result<(), String> {
    let Some(handle) = app.try_state::<ScreenProtectHandle<tauri::Wry>>() else {
        return Err("Android screen protection plugin is not ready".into());
    };
    handle.0.run_mobile_plugin::<()>(
        "setSecure",
        SetSecureArgs { secure: protect },
    ).map_err(|e| e.to_string())
}
