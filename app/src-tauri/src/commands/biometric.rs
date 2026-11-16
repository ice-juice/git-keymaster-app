//! 指纹解锁与隐私重认证 IPC。

use crate::biometric;
use crate::commands::vault::{ensure_loaded, resolve_workspace_id};
use crate::commands::{recover_lock, AppState};
use crate::error::{AppError, Result};
use std::sync::{atomic::Ordering, Mutex};
use tauri::{AppHandle, State};
static BIOMETRIC_OPERATION: Mutex<()> = Mutex::new(());

#[tauri::command(async)]
pub fn biometric_status(app: AppHandle, state: State<'_, AppState>) -> biometric::BiometricStatus {
    biometric::bind_window(&app);
    let _ = ensure_loaded(&state);
    let cfg = recover_lock(&state.config).clone();
    let workspace_id = resolve_workspace_id(&state);
    // 不持锁调用系统 API，避免 WinRT 重入把配置锁弄脏。
    biometric::status(workspace_id.as_deref(), &cfg)
}

#[tauri::command(async)]
pub fn biometric_enable(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<()> {
    let _operation = recover_lock(&BIOMETRIC_OPERATION);
    let password = zeroize::Zeroizing::new(password);
    biometric::bind_window(&app);
    ensure_loaded(&state)?;
    let (auth_vault, epoch) = {
        let vault = recover_lock(&state.vault);
        let v = vault.as_ref().ok_or(AppError::Locked)?;
        if !v.is_unlocked() {
            return Err(AppError::Locked);
        }
        v.verify_password(&password)?;
        (v.clone(), state.session_epoch.load(Ordering::SeqCst))
    };
    let method = {
        let cfg = recover_lock(&state.config);
        crate::app_config::clamp_biometric_method(&cfg.biometric_method)
    };
    biometric::enable(&auth_vault, &method)?;
    let mut cfg = recover_lock(&state.config);
    let guard = recover_lock(&state.vault);
    if state.session_epoch.load(Ordering::SeqCst) != epoch
        || !auth_vault.is_unlocked()
        || !guard
            .as_ref()
            .is_some_and(|v| v.is_unlocked() && v.workspace_id() == auth_vault.workspace_id())
    {
        let _ = biometric::disable();
        return Err(AppError::Locked);
    }
    cfg.biometric_unlock_enabled = true;
    cfg.biometric_reveal_enabled = true;
    cfg.biometric_method = method;
    cfg.save()
}

#[tauri::command(async)]
pub fn biometric_disable(state: State<'_, AppState>) -> Result<()> {
    let _operation = recover_lock(&BIOMETRIC_OPERATION);
    biometric::disable()?;
    let mut cfg = recover_lock(&state.config);
    cfg.biometric_unlock_enabled = false;
    cfg.save()
}

#[tauri::command(async)]
pub fn reveal_authorize_biometric(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let _operation = recover_lock(&BIOMETRIC_OPERATION);
    biometric::bind_window(&app);
    let epoch = {
        let vault = recover_lock(&state.vault);
        let v = vault.as_ref().ok_or(AppError::Locked)?;
        if !v.is_unlocked() {
            return Err(AppError::Locked);
        }
        state.session_epoch.load(Ordering::SeqCst)
    };
    let (enabled, reveal_enabled) = {
        let cfg = recover_lock(&state.config);
        (cfg.biometric_unlock_enabled, cfg.biometric_reveal_enabled)
    };
    if !enabled || !reveal_enabled {
        return Err(AppError::Invalid("未开启指纹重认证".into()));
    }
    let workspace_id = resolve_workspace_id(&state).ok_or(AppError::NotInitialized)?;
    if !biometric::is_enrolled_for(&workspace_id) {
        return Err(AppError::BiometricStale);
    }
    biometric::verify_presence("确认查看敏感信息")?;
    let minutes = recover_lock(&state.config).reveal_grace_minutes;
    let vault = recover_lock(&state.vault);
    if state.session_epoch.load(Ordering::SeqCst) != epoch
        || !vault
            .as_ref()
            .is_some_and(|v| v.is_unlocked() && v.workspace_id() == workspace_id)
    {
        return Err(AppError::Locked);
    }
    *recover_lock(&state.reveal_grace) = if minutes > 0 {
        Some(std::time::Instant::now() + std::time::Duration::from_secs(u64::from(minutes) * 60))
    } else {
        None
    };
    Ok(())
}

#[tauri::command]
pub fn set_biometric_reveal_enabled(state: State<AppState>, enabled: bool) -> Result<()> {
    let mut cfg = recover_lock(&state.config);
    cfg.biometric_reveal_enabled = enabled;
    cfg.save()
}

#[tauri::command]
pub fn set_biometric_reveal_secret(state: State<AppState>, enabled: bool) -> Result<()> {
    let mut cfg = recover_lock(&state.config);
    cfg.biometric_reveal_secret = enabled;
    cfg.save()
}

#[tauri::command]
pub fn set_biometric_method(state: State<AppState>, method: String) -> Result<String> {
    let method = crate::app_config::clamp_biometric_method(&method);
    let mut cfg = recover_lock(&state.config);
    cfg.biometric_method = method.clone();
    cfg.save()?;
    Ok(method)
}
