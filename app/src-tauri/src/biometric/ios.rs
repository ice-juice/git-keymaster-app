//! iOS：LAContext 弹 Face ID / Touch ID，KEK 放在应用沙箱（只有本应用可读）。
//!
//! 不用 Keychain ACL：未带完整 entitlement 的自签包（NB 助手 / ad-hoc）容易拿不到
//! 钥匙串访问；沙箱文件 + 每次读写前做生物识别，与路线 B 一致。

use crate::error::{AppError, Result};
use block2::RcBlock;
use objc2_foundation::{NSError, NSString};
use objc2_local_authentication::{LABiometryType, LAContext, LAError, LAPolicy};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use super::BiometricAvailability;

const AUTH_TIMEOUT: Duration = Duration::from_secs(120);
const POLICY: LAPolicy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;

pub fn availability() -> BiometricAvailability {
    let ctx = unsafe { LAContext::new() };
    let available = unsafe { ctx.canEvaluatePolicy_error(POLICY) }.is_ok();
    let kind = match unsafe { ctx.biometryType() } {
        LABiometryType::FaceID => "face-id",
        _ => "touch-id",
    };
    BiometricAvailability {
        available,
        kind,
        strong: available,
        fingerprint: available && kind == "touch-id",
        face: available && kind == "face-id",
    }
}

pub fn enroll(key_ref: &str, _challenge: &[u8]) -> Result<Vec<u8>> {
    if !availability().available {
        return Err(AppError::Invalid("本机未检测到可用的指纹 / 面容 ID".into()));
    }
    let domain = evaluate_biometrics("开启面容 / 指纹解锁")?;
    let mut raw = vec![0u8; crate::vault::crypto::KEY_LEN];
    crate::vault::crypto::fill_random(&mut raw);
    write_secret(kek_path(key_ref), &raw)?;
    write_secret(domain_path(key_ref), &domain)?;
    Ok(raw)
}

pub fn derive(key_ref: &str, _challenge: &[u8]) -> Result<Vec<u8>> {
    let domain = evaluate_biometrics("解锁工作空间")?;
    ensure_domain_current(key_ref, &domain)?;
    read_secret(&kek_path(key_ref))
}

pub fn verify_presence(prompt: &str) -> Result<()> {
    let file = super::store::load().map_err(|_| AppError::BiometricStale)?;
    let domain = evaluate_biometrics(prompt)?;
    ensure_domain_current(&file.key_ref, &domain)
}

pub fn remove(key_ref: &str) -> Result<()> {
    let _ = std::fs::remove_file(kek_path(key_ref));
    let _ = std::fs::remove_file(domain_path(key_ref));
    Ok(())
}

fn store_dir() -> PathBuf {
    crate::app_config::config_dir().join("biometric-keys")
}

fn kek_path(key_ref: &str) -> PathBuf {
    store_dir().join(format!("{key_ref}.kek"))
}

fn domain_path(key_ref: &str) -> PathBuf {
    store_dir().join(format!("{key_ref}.domain"))
}

fn write_secret(path: PathBuf, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::vault::atomic_write(&path, bytes)
}

fn read_secret(path: &PathBuf) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|_| AppError::BiometricStale)
}

fn ensure_domain_current(key_ref: &str, current: &[u8]) -> Result<()> {
    let stored = match std::fs::read(domain_path(key_ref)) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    if stored.is_empty() || current.is_empty() || stored == current {
        Ok(())
    } else {
        Err(AppError::BiometricStale)
    }
}

fn evaluate_biometrics(reason: &str) -> Result<Vec<u8>> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(AppError::Invalid("生物识别验证原因不能为空".into()));
    }
    let context = unsafe { LAContext::new() };
    if let Err(err) = unsafe { context.canEvaluatePolicy_error(POLICY) } {
        return Err(map_la_error(&err));
    }
    unsafe {
        context.setLocalizedFallbackTitle(Some(&NSString::from_str("")));
    }

    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |success, error: *mut NSError| {
        let outcome = if bool::from(success) {
            Ok(())
        } else if error.is_null() {
            Err(AppError::Other("生物识别失败".into()))
        } else {
            Err(map_la_error(unsafe { &*error }))
        };
        let _ = tx.send(outcome);
    });
    unsafe {
        context.evaluatePolicy_localizedReason_reply(POLICY, &NSString::from_str(reason), &block);
    }
    match rx.recv_timeout(AUTH_TIMEOUT) {
        Ok(Ok(())) => Ok(read_domain_state(&context)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(AppError::Other("生物识别超时".into())),
    }
}

fn read_domain_state(ctx: &LAContext) -> Vec<u8> {
    #[allow(deprecated)]
    unsafe { ctx.evaluatedPolicyDomainState() }
        .map(|data| data.to_vec())
        .unwrap_or_default()
}

fn map_la_error(err: &NSError) -> AppError {
    match LAError(err.code()) {
        LAError::UserCancel
        | LAError::SystemCancel
        | LAError::AppCancel
        | LAError::UserFallback => AppError::BiometricCancelled,
        LAError::BiometryNotAvailable | LAError::BiometryNotEnrolled => {
            AppError::Invalid("本机未检测到可用的指纹 / 面容 ID".into())
        }
        LAError::BiometryLockout => {
            AppError::Invalid("生物识别已锁定，请先在系统中解锁，或改用访问密码".into())
        }
        LAError::PasscodeNotSet => {
            AppError::Invalid("请先在系统中设置锁屏密码后再开启面容 / 指纹解锁".into())
        }
        other => AppError::Other(format!("生物识别失败（{}）", other.0)),
    }
}
