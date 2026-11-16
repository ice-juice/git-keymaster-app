//! 新配置允许截图；用户确认引导后应用防护。旧配置保持原来的捕获策略。
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
                let _ = api;
                ios::install(app);
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

/// Onboarding must not equate saving a preference with a successful native API call.
/// macOS remains best-effort; iOS provides an overlay, never screenshot exclusion.
pub fn apply_checked(app: &AppHandle, allow_screenshots: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    { android::set_secure_checked(app, !allow_screenshots) }
    #[cfg(not(target_os = "android"))]
    {
        #[cfg(windows)]
        windows::check_root(app, !allow_screenshots)?;
        #[cfg(target_os = "linux")]
        if !allow_screenshots { return Err("Screen capture exclusion is not supported on this platform".into()); }
        apply(app, allow_screenshots);
        Ok(())
    }
}

/// 未识别配置前保守防护；加载后以新配置或已有用户的真实设置为准。
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
    fn fresh_config_allows_screenshots_before_consent() {
        let cfg = crate::app_config::AppConfig::default();
        assert!(cfg.allow_screenshots);
    }
}
