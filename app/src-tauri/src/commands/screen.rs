//! 屏幕截图开关：写入本机 AppConfig，并立刻套用各端防护。

use crate::commands::{recover_lock, AppState};
use crate::error::Result;
use crate::screen_protect::{self, ScreenCaptureCapability};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
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
        cfg.allow_screenshots = allow;
        cfg.save()?;
    }
    screen_protect::apply(&app, allow);
    let settings = ScreenCaptureSettings {
        allow_screenshots: allow,
        capability: screen_protect::capability(),
    };
    let _ = app.emit("screen-capture-changed", &settings);
    Ok(settings)
}
