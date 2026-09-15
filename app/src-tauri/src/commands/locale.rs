//! 运行时 UI 语言：只写 config.json，不改卸载项 / 开始菜单 / productName。

use crate::app_config::clamp_ui_locale;
use crate::commands::{recover_lock, AppState};
use crate::error::Result;
use tauri::State;

#[tauri::command]
pub fn get_ui_locale(state: State<AppState>) -> Result<String> {
    Ok(clamp_ui_locale(&recover_lock(&state.config).ui_locale))
}

#[tauri::command]
pub fn set_ui_locale(state: State<AppState>, locale: String) -> Result<String> {
    let next = clamp_ui_locale(&locale);
    let mut cfg = recover_lock(&state.config);
    cfg.ui_locale = next.clone();
    cfg.save()?;
    Ok(next)
}
