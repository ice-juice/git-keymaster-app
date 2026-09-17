//! 窗口防截屏：默认禁止系统截图 / 录屏捕获本应用画面，用户可在设置里打开。
//!
//! 各平台能力不同，设置页必须如实展示，不能假装 Linux / iOS 已经涂黑。

use serde::Serialize;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime};

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "ios")]
mod ios;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

/// 当前系统实际做得到的防护。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenCaptureCapability {
    /// Android FLAG_SECURE / Windows WDA / macOS sharingType。
    Exclude,
    /// iOS：只能在切到后台时藏内容，系统仍可能允许截屏。
    Overlay,
    /// Linux（Wayland / X11）没有可靠的应用级拦截。
    Unsupported,
}

pub fn capability() -> ScreenCaptureCapability {
    #[cfg(any(windows, target_os = "android", target_os = "macos"))]
    {
        ScreenCaptureCapability::Exclude
    }
    #[cfg(target_os = "ios")]
    {
        ScreenCaptureCapability::Overlay
    }
    #[cfg(target_os = "linux")]
    {
        ScreenCaptureCapability::Unsupported
    }
    #[cfg(not(any(
        windows,
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        target_os = "linux"
    )))]
    {
        ScreenCaptureCapability::Unsupported
    }
}

/// 注册 Android 原生插件；iOS 在 setup 里挂后台遮罩观察者。其它平台为空插件。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("app-screen-protect")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("com.jeck.gitkeymaster", "ScreenProtectPlugin")?;
                app.manage(android::ScreenProtectHandle(handle));
            }
            #[cfg(target_os = "ios")]
            {
                ios::install(app.handle());
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}

/// 按配置立刻套上或放开防护。`allow_screenshots = false` 表示要防截屏。
pub fn apply(app: &AppHandle, allow_screenshots: bool) {
    let protect = !allow_screenshots;

    #[cfg(target_os = "android")]
    android::set_secure(app, protect);

    #[cfg(target_os = "ios")]
    ios::set_enabled(protect);

    #[cfg(windows)]
    windows::set_excluded(app, protect);

    #[cfg(target_os = "macos")]
    macos::set_sharing_none(app, protect);

    #[cfg(target_os = "linux")]
    linux::apply(app, protect);
}

/// 从已注册的 AppState 读配置再套用。状态还没挂上时按默认（禁止截屏）。
pub fn apply_from_app(app: &AppHandle) {
    let allow = app
        .try_state::<crate::commands::AppState>()
        .map(|state| crate::commands::recover_lock(&state.config).allow_screenshots)
        .unwrap_or(false);
    apply(app, allow);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_matches_os() {
        #[cfg(any(windows, target_os = "android", target_os = "macos"))]
        assert_eq!(capability(), ScreenCaptureCapability::Exclude);
        #[cfg(target_os = "ios")]
        assert_eq!(capability(), ScreenCaptureCapability::Overlay);
        #[cfg(target_os = "linux")]
        assert_eq!(capability(), ScreenCaptureCapability::Unsupported);
    }

    #[test]
    fn default_config_disallows_screenshots() {
        let cfg = crate::app_config::AppConfig::default();
        assert!(!cfg.allow_screenshots);
    }
}
