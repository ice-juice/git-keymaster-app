//! 屏幕截图开关：写入本机 AppConfig，并立刻套用各端防护。

use crate::commands::{recover_lock, AppState};
use crate::error::{AppError, Result};
use crate::screen_protect::{self, ScreenCaptureCapability};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCaptureSettings {
    pub allow_screenshots: bool,
    pub capability: ScreenCaptureCapability,
}

#[tauri::command]
pub fn get_screen_capture_settings(state: State<AppState>) -> ScreenCaptureSettings {
    let allow = recover_lock(&state.config).allow_screenshots;
    ScreenCaptureSettings {
        allow_screenshots: allow,
        capability: screen_protect::capability(),
    }
}

#[tauri::command]
pub fn set_allow_screenshots(
    app: AppHandle,
    state: State<AppState>,
    allow: bool,
) -> Result<ScreenCaptureSettings> {
    {
        let mut cfg = recover_lock(&state.config);
        if cfg.onboarding.pending.is_some() { return Err(AppError::Busy); }
        if cfg.load_error.is_some() { return Err(AppError::Other("Local configuration is unavailable".into())); }
        let mut next = cfg.clone();
        next.allow_screenshots = allow;
        screen_protect::apply_checked(&app, allow).map_err(AppError::Other)?;
        if let Err(error) = next.save() {
            if let Err(restore_error) = screen_protect::apply_checked(&app, cfg.allow_screenshots) {
                log::warn!("Could not restore capture protection after save failure: {restore_error}");
            }
            return Err(error);
        }
        *cfg = next;
    }
    let settings = ScreenCaptureSettings {
        allow_screenshots: allow,
        capability: screen_protect::capability(),
    };
    let _ = app.emit("screen-capture-changed", &settings);
    Ok(settings)
}
