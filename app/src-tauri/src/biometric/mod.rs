//! 平台原生生物识别：解锁走硬件密钥绑定（路线 B），隐私重认证走存在性确认（路线 A）。

pub(crate) mod store;

#[cfg(windows)]
mod windows;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "android")]
mod android;
#[cfg(not(any(windows, target_os = "macos", target_os = "android")))]
mod linux;

#[cfg(windows)]
use windows as backend;
#[cfg(target_os = "macos")]
use macos as backend;
#[cfg(target_os = "android")]
use android as backend;
#[cfg(not(any(windows, target_os = "macos", target_os = "android")))]
use linux as backend;

use crate::error::{AppError, Result};
use crate::vault::crypto::{MasterKey, KEY_LEN};
use crate::vault::envelope;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Runtime};
#[cfg(any(windows, target_os = "android"))]
use tauri::Manager;

pub use store::{is_enrolled_for, BiometricEnvFile};

#[derive(Debug, Clone, Copy)]
pub struct BiometricAvailability {
    pub available: bool,
    pub kind: &'static str,
    pub strong: bool,
    pub fingerprint: bool,
    pub face: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricStatus {
    pub available: bool,
    pub strong: bool,
    pub kind: String,
    pub enabled: bool,
    pub reveal_enabled: bool,
    pub reveal_secret: bool,
    pub stale: bool,
    pub fingerprint_available: bool,
    pub face_available: bool,
    pub preferred_method: String,
    pub enrolled_method: String,
}

#[cfg(windows)]
static PROMPT_HWND: Mutex<Option<isize>> = Mutex::new(None);
#[cfg(target_os = "android")]
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);
static METHOD: Mutex<String> = Mutex::new(String::new());

/// 注册 Android 原生生物识别插件。桌面端为空插件。
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("app-biometric")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.jeck.gitkeymaster", "BiometricPlugin")?;
                app.manage(android::BiometricHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}

pub fn bind_window(app: &AppHandle) {
    #[cfg(windows)]
    {
        if let Some(w) = app.get_webview_window("main") {
            if let Ok(h) = w.hwnd() {
                *PROMPT_HWND.lock().unwrap_or_else(|e| e.into_inner()) = Some(h.0 as isize);
            }
        }
    }
    #[cfg(target_os = "android")]
    {
        *APP.lock().unwrap_or_else(|e| e.into_inner()) = Some(app.clone());
    }
    let _ = app;
}

#[cfg(windows)]
pub(crate) fn prompt_hwnd() -> Option<isize> {
    *PROMPT_HWND.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(target_os = "android")]
pub(crate) fn android_app() -> Result<AppHandle> {
    APP.lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| AppError::Invalid("生物识别组件尚未就绪".into()))
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn session_method() -> String {
    let raw = METHOD.lock().unwrap_or_else(|e| e.into_inner()).clone();
    crate::app_config::clamp_biometric_method(&raw)
}

fn set_session_method(method: &str) {
    *METHOD.lock().unwrap_or_else(|e| e.into_inner()) =
        crate::app_config::clamp_biometric_method(method);
}

pub fn availability() -> BiometricAvailability {
    backend::availability()
}

pub fn status(workspace_id: Option<&str>, cfg: &crate::app_config::AppConfig) -> BiometricStatus {
    let avail = availability();
    let preferred = crate::app_config::clamp_biometric_method(&cfg.biometric_method);
    set_session_method(&preferred);
    let enrolled = workspace_id.map(store::is_enrolled_for).unwrap_or(false);
    let enrolled_method = workspace_id
        .and_then(|id| store::load_for_workspace(id).ok())
        .and_then(|file| file.method)
        .unwrap_or_else(|| preferred.clone());
    let stale = cfg.biometric_unlock_enabled && workspace_id.is_some() && !enrolled;
    let kind = if enrolled {
        enrolled_method.clone()
    } else if preferred != "auto" {
        preferred.clone()
    } else {
        avail.kind.to_string()
    };
    if enrolled {
        set_session_method(&enrolled_method);
    }
    BiometricStatus {
        available: avail.available,
        strong: avail.strong,
        kind,
        enabled: cfg.biometric_unlock_enabled && enrolled,
        reveal_enabled: cfg.biometric_reveal_enabled,
        reveal_secret: cfg.biometric_reveal_secret,
        stale,
        fingerprint_available: avail.fingerprint,
        face_available: avail.face,
        preferred_method: preferred,
        enrolled_method,
    }
}

pub fn enable(workspace_id: &str, mk: &MasterKey, method: &str) -> Result<()> {
    let method = crate::app_config::clamp_biometric_method(method);
    set_session_method(&method);
    let avail = availability();
    if method == "password" {
        return Err(AppError::Invalid("当前解锁方式为访问密码，无需绑定指纹".into()));
    }
    if !avail.fingerprint && !avail.available {
        return Err(AppError::Invalid("本机未检测到可用的指纹".into()));
    }
    if !avail.available {
        return Err(AppError::Invalid(
            "本机未检测到可用的指纹 / 人脸 / Windows Hello 硬件".into(),
        ));
    }
    let key_ref = format!("gam-vault-{workspace_id}");
    let mut challenge = vec![0u8; KEY_LEN];
    crate::vault::crypto::fill_random(&mut challenge);
    let raw = match backend::enroll(&key_ref, &challenge) {
        Ok(v) => v,
        Err(e) => {
            let _ = backend::remove(&key_ref);
            return Err(e);
        }
    };
    let envelope = match envelope::wrap_with_biometric(mk, &raw) {
        Ok(env) => env,
        Err(e) => {
            let _ = backend::remove(&key_ref);
            return Err(e);
        }
    };
    let file = BiometricEnvFile {
        version: store::VERSION,
        platform: store::current_platform().into(),
        workspace_id: workspace_id.to_string(),
        key_ref,
        challenge: store::encode_challenge(&challenge),
        envelope,
        created_at: crate::util::now_rfc3339(),
        method: Some(method),
    };
    if let Err(e) = store::save(&file) {
        let _ = backend::remove(&file.key_ref);
        return Err(e);
    }
    Ok(())
}

pub fn disable() -> Result<()> {
    if let Ok(file) = store::load() {
        let _ = backend::remove(&file.key_ref);
    }
    store::clear();
    Ok(())
}

pub fn unlock_master_key(workspace_id: &str) -> Result<MasterKey> {
    let file = store::load_for_workspace(workspace_id)?;
    set_session_method(file.method.as_deref().unwrap_or("auto"));
    let challenge = store::decode_challenge(&file.challenge)?;
    let raw = backend::derive(&file.key_ref, &challenge)?;
    envelope::unwrap_with_biometric(&file.envelope, &raw)
}

pub fn verify_presence(prompt: &str) -> Result<()> {
    if let Ok(file) = store::load() {
        set_session_method(file.method.as_deref().unwrap_or("auto"));
    }
    backend::verify_presence(prompt)
}

pub fn factory_reset_cleanup() {
    if let Ok(file) = store::load() {
        let _ = backend::remove(&file.key_ref);
    }
    store::clear();
}
