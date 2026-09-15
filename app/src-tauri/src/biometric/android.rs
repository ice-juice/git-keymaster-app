//! Android：BiometricPrompt + Keystore，只走指纹。

use crate::error::{AppError, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::BiometricAvailability;

pub struct BiometricHandle<R: Runtime>(pub tauri::plugin::PluginHandle<R>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HwStatus {
    available: bool,
    strong: bool,
    fingerprint: bool,
    face: bool,
}

#[derive(Debug, Deserialize)]
struct KeyPayload {
    key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthArgs<'a> {
    key_ref: &'a str,
    method: &'a str,
    title: &'a str,
    subtitle: &'a str,
}

fn run_plugin<T: serde::de::DeserializeOwned>(
    app: &AppHandle,
    cmd: &str,
    payload: impl Serialize,
) -> Result<T> {
    let handle = app.state::<BiometricHandle<tauri::Wry>>();
    handle.0.run_mobile_plugin(cmd, payload).map_err(map_plugin)
}

fn map_plugin(err: impl ToString) -> AppError {
    let raw = err.to_string();
    if raw.contains("BIOMETRIC_CANCELLED") {
        return AppError::BiometricCancelled;
    }
    if raw.contains("BIOMETRIC_STALE") {
        return AppError::BiometricStale;
    }
    let msg = raw
        .split_once("BIOMETRIC_INVALID:")
        .map(|(_, rest)| rest.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("生物识别失败");
    AppError::Invalid(msg.into())
}

fn run_status(app: &AppHandle) -> Result<HwStatus> {
    run_plugin(app, "status", ())
}

fn run_key(app: &AppHandle, cmd: &str, args: AuthArgs<'_>) -> Result<Vec<u8>> {
    let payload: KeyPayload = run_plugin(app, cmd, args)?;
    let raw = B64
        .decode(payload.key.as_bytes())
        .map_err(|_| AppError::BiometricStale)?;
    if raw.len() != crate::vault::crypto::KEY_LEN {
        return Err(AppError::BiometricStale);
    }
    Ok(raw)
}

pub fn availability() -> BiometricAvailability {
    match super::android_app().and_then(|app| run_status(&app)) {
        Ok(hw) => BiometricAvailability {
            available: hw.available,
            kind: if hw.fingerprint { "fingerprint" } else { "none" },
            strong: hw.strong,
            fingerprint: hw.fingerprint,
            face: false,
        },
        Err(_) => BiometricAvailability {
            available: false,
            kind: "none",
            strong: false,
            fingerprint: false,
            face: false,
        },
    }
}

pub fn enroll(key_ref: &str, _challenge: &[u8]) -> Result<Vec<u8>> {
    let app = super::android_app()?;
    let method = super::session_method();
    run_key(
        &app,
        "enroll",
        AuthArgs {
            key_ref,
            method: &method,
            title: "开启指纹解锁",
            subtitle: "验证通过后，本机可免输访问密码解锁",
        },
    )
}

pub fn derive(key_ref: &str, _challenge: &[u8]) -> Result<Vec<u8>> {
    let app = super::android_app()?;
    let method = super::session_method();
    run_key(
        &app,
        "derive",
        AuthArgs {
            key_ref,
            method: &method,
            title: "使用指纹解锁",
            subtitle: "解锁工作空间",
        },
    )
}

pub fn verify_presence(prompt: &str) -> Result<()> {
    let app = super::android_app()?;
    let method = super::session_method();
    let key_ref = super::store::load().ok().map(|f| f.key_ref).unwrap_or_default();
    run_plugin(
        &app,
        "verify",
        AuthArgs {
            key_ref: &key_ref,
            method: &method,
            title: prompt,
            subtitle: "",
        },
    )
}

pub fn remove(key_ref: &str) -> Result<()> {
    let Ok(app) = super::android_app() else {
        return Ok(());
    };
    let _ = run_plugin::<()>(
        &app,
        "remove",
        AuthArgs {
            key_ref,
            method: "auto",
            title: "",
            subtitle: "",
        },
    );
    Ok(())
}
