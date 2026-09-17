//! 免密查看时效、剪贴板清空、图标上传。

use crate::app_config;
use crate::clipboard;
use crate::commands::{ensure_writes_allowed, recover_lock, AppState};
use crate::error::{AppError, Result};
use crate::icons::{self, BuiltinIconInfo, CustomIconInfo};
use crate::store;
use serde::Serialize;
use tauri::{AppHandle, State};
use zeroize::Zeroize;

fn clipboard_err(e: impl ToString) -> AppError {
    AppError::Other(format!("剪贴板操作失败：{}", e.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardWriteResult {
    pub excluded: bool,
    pub fallback: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

#[tauri::command]
pub fn clipboard_write(
    app: AppHandle,
    state: State<AppState>,
    mut text: String,
    secret: Option<bool>,
) -> Result<ClipboardWriteResult> {
    let clear_seconds = recover_lock(&state.config).clipboard_clear_seconds;

    #[cfg(target_os = "android")]
    {
        let outcome = clipboard::write_android(&app, &text);
        text.zeroize();
        let _ = (secret, clear_seconds);
        let outcome = outcome.map_err(clipboard_err)?;
        return Ok(ClipboardWriteResult {
            excluded: outcome.excluded,
            fallback: outcome.fallback,
            notice: None,
        });
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let secret = secret.unwrap_or(false);
        let outcome = clipboard::write(&text, secret);
        text.zeroize();
        let outcome = outcome.map_err(clipboard_err)?;
        // 后端计时，不依赖界面还活着。
        if secret {
            clipboard::arm_auto_clear(clear_seconds);
        }
        Ok(ClipboardWriteResult {
            excluded: outcome.excluded,
            fallback: outcome.fallback,
            notice: if outcome.fallback {
                Some("剪贴板正被其他程序占用，已改为普通复制；本次内容可能进入剪贴板历史。".into())
            } else {
                None
            },
        })
    }
}

#[tauri::command]
pub fn clipboard_read(app: AppHandle) -> Result<String> {
    #[cfg(target_os = "android")]
    {
        return clipboard::read_android(&app).map_err(clipboard_err);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        clipboard::read().map_err(clipboard_err)
    }
}

#[tauri::command]
pub fn clipboard_clear(app: AppHandle) -> Result<()> {
    #[cfg(target_os = "android")]
    {
        return clipboard::clear_android(&app).map_err(clipboard_err);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        clipboard::clear_if_ours().map_err(clipboard_err)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealSettings {
    pub reveal_grace_minutes: u32,
    pub clipboard_clear_seconds: u32,
    pub account_history_limit: u32,
}

#[tauri::command]
pub fn get_reveal_settings(state: State<AppState>) -> RevealSettings {
    let cfg = recover_lock(&state.config);
    RevealSettings {
        reveal_grace_minutes: cfg.reveal_grace_minutes,
        clipboard_clear_seconds: cfg.clipboard_clear_seconds,
        account_history_limit: cfg.account_history_limit,
    }
}

#[tauri::command]
pub fn set_reveal_grace_minutes(state: State<AppState>, minutes: u32) -> Result<u32> {
    let minutes = app_config::clamp_reveal_grace_minutes(minutes);
    let mut cfg = recover_lock(&state.config);
    cfg.reveal_grace_minutes = minutes;
    cfg.save()?;
    if minutes == 0 {
        crate::commands::clear_reveal_grace(&state);
    }
    Ok(minutes)
}

#[tauri::command]
pub fn set_clipboard_clear_seconds(state: State<AppState>, seconds: u32) -> Result<u32> {
    let seconds = app_config::clamp_clipboard_clear_seconds(seconds);
    let mut cfg = recover_lock(&state.config);
    cfg.clipboard_clear_seconds = seconds;
    cfg.save()?;
    Ok(seconds)
}

#[tauri::command]
pub fn set_account_history_limit(state: State<AppState>, limit: u32) -> Result<u32> {
    let limit = app_config::clamp_account_history_limit(limit);
    let mut cfg = recover_lock(&state.config);
    cfg.account_history_limit = limit;
    cfg.save()?;
    Ok(limit)
}

#[tauri::command]
pub fn icon_list_builtin() -> Vec<BuiltinIconInfo> {
    icons::list_builtin()
}

#[tauri::command]
pub fn icon_upload_custom(state: State<AppState>, file_path: String) -> Result<CustomIconInfo> {
    ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let bytes = std::fs::read(&file_path)?;
    icons::process_and_store(v, &bytes)
}

#[tauri::command]
pub fn icon_get_custom(state: State<AppState>, icon_ref: String) -> Result<String> {
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let hash = icons::parse_custom_hash(&icon_ref).ok_or_else(|| AppError::Invalid("不是自定义图标".into()))?;
    let webp = store::load_icon(v, hash)?;
    Ok(icons::data_url(&webp))
}
