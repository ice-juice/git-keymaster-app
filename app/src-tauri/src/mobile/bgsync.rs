//! Android 前台服务只负责保活进程，云同步仍由 Rust 调度器按固定周期执行。
//!
//! iOS：仓库里还没有 `gen/apple` 工程，不在这里生成。BGAppRefresh / BGProcessing
//! 要等苹果工程落地后再接；唤醒时间点由系统决定，不是固定周期。

use tauri::{AppHandle, Runtime};

#[cfg(target_os = "android")]
use serde::Serialize;
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
struct BgSyncHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// 桌面和 iOS 注册空插件，避免调用方分平台写两套。真正的服务只在 Android 上挂上。
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("bg-sync")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("com.jeck.gitkeymaster", "ForegroundSyncPlugin")?;
                app.manage(BgSyncHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}

/// 打开或关掉「退后台时拉起前台服务」。非 Android 什么都不做。
pub fn set_enabled(app: &AppHandle, enabled: bool) {
    #[cfg(target_os = "android")]
    {
        let Some(handle) = app.try_state::<BgSyncHandle<tauri::Wry>>() else {
            return;
        };
        if let Err(e) = handle.0.run_mobile_plugin::<()>(
            "setEnabled",
            SetEnabledArgs { enabled },
        ) {
            log::warn!("无法更新 Android 后台同步保活：{e}");
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, enabled);
    }
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct SetEnabledArgs {
    enabled: bool,
}
