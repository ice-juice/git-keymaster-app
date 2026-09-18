//! macOS：登录钥匙串存随机 KEK，每次用 LocalAuthentication 弹 Touch ID / 面容。
//!
//! 不用 Keychain ACL / Data Protection 钥匙串：那条路径会写 `kSecAttrSynchronizable`
//! 或 `kSecUseDataProtectionKeychain`，未带 App ID entitlement 的签名（GitHub
//! 分发、ad-hoc、`tauri dev`）会得到 `A required entitlement isn't present`。
//!
//! KEK 与指纹域状态放进**同一条**钥匙串，避免解锁时连续弹两次「允许访问钥匙串」。
//! 同进程内第一次读成功后缓存，后续解锁只再弹 Touch ID。

use crate::error::{AppError, Result};
use block2::RcBlock;
use objc2_foundation::{NSError, NSString};
use objc2_local_authentication::{LABiometryType, LAContext, LAError, LAPolicy};
use security_framework::passwords::{
    delete_generic_password, generic_password, set_generic_password, PasswordOptions,
};
use std::sync::{Mutex, mpsc};
use std::time::Duration;

use super::BiometricAvailability;

const SERVICE: &str = "com.jeck.gitkeymaster.biometric";
const AUTH_TIMEOUT: Duration = Duration::from_secs(120);
const POLICY: LAPolicy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;
const BLOB_VERSION: u8 = 1;

static SESSION: Mutex<Option<CachedSecret>> = Mutex::new(None);

struct CachedSecret {
    key_ref: String,
    kek: Vec<u8>,
    domain: Vec<u8>,
}

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
    let domain = evaluate_biometrics("开启指纹解锁")?;
    let mut raw = vec![0u8; crate::vault::crypto::KEY_LEN];
    crate::vault::crypto::fill_random(&mut raw);
    delete_item(key_ref);
    delete_item(&domain_account(key_ref));
    write_secret(key_ref, &raw, &domain)?;
    cache_secret(key_ref, raw.clone(), domain);
    Ok(raw)
}

pub fn derive(key_ref: &str, _challenge: &[u8]) -> Result<Vec<u8>> {
    let domain = evaluate_biometrics("解锁工作空间")?;
    let (kek, stored_domain) = read_secret(key_ref)?;
    ensure_domain_matches(&stored_domain, &domain)?;
    cache_secret(key_ref, kek.clone(), stored_domain);
    Ok(kek)
}

pub fn verify_presence(prompt: &str) -> Result<()> {
    let file = super::store::load().map_err(|_| AppError::BiometricStale)?;
    let domain = evaluate_biometrics(prompt)?;
    let (_, stored_domain) = read_secret(&file.key_ref)?;
    ensure_domain_matches(&stored_domain, &domain)
}

pub fn remove(key_ref: &str) -> Result<()> {
    clear_cache();
    delete_item(key_ref);
    delete_item(&domain_account(key_ref));
    Ok(())
}

fn domain_account(key_ref: &str) -> String {
    format!("{key_ref}.domain")
}

fn encode_blob(kek: &[u8], domain: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(3 + kek.len() + domain.len());
    out.push(BLOB_VERSION);
    out.extend_from_slice(&(u16::try_from(kek.len()).unwrap_or(0)).to_le_bytes());
    out.extend_from_slice(kek);
    out.extend_from_slice(domain);
    out
}

fn decode_blob(raw: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    if raw.first().copied() != Some(BLOB_VERSION) || raw.len() < 3 {
        return None;
    }
    let kek_len = u16::from_le_bytes([raw[1], raw[2]]) as usize;
    if raw.len() < 3 + kek_len {
        return None;
    }
    Some((raw[3..3 + kek_len].to_vec(), raw[3 + kek_len..].to_vec()))
}

fn write_secret(key_ref: &str, kek: &[u8], domain: &[u8]) -> Result<()> {
    set_generic_password(SERVICE, key_ref, &encode_blob(kek, domain))
        .map_err(|e| AppError::Other(format!("无法写入钥匙串：{e}")))
}

fn read_secret(key_ref: &str) -> Result<(Vec<u8>, Vec<u8>)> {
    if let Some(hit) = cached_secret(key_ref) {
        return Ok(hit);
    }
    let raw = generic_password(PasswordOptions::new_generic_password(SERVICE, key_ref))
        .map_err(map_keychain)?;
    if let Some((kek, domain)) = decode_blob(&raw) {
        return Ok((kek, domain));
    }
    // 旧版拆成两条钥匙串：升级时合并，避免以后每次解锁弹两次。
    let domain = generic_password(PasswordOptions::new_generic_password(
        SERVICE,
        &domain_account(key_ref),
    ))
    .unwrap_or_default();
    if let Err(e) = write_secret(key_ref, &raw, &domain) {
        log::debug!("合并钥匙串项失败：{e}");
    }
    let _ = delete_generic_password(SERVICE, &domain_account(key_ref));
    Ok((raw, domain))
}

fn cached_secret(key_ref: &str) -> Option<(Vec<u8>, Vec<u8>)> {
    let guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().and_then(|cached| {
        if cached.key_ref == key_ref {
            Some((cached.kek.clone(), cached.domain.clone()))
        } else {
            None
        }
    })
}

fn cache_secret(key_ref: &str, kek: Vec<u8>, domain: Vec<u8>) {
    *SESSION.lock().unwrap_or_else(|e| e.into_inner()) = Some(CachedSecret {
        key_ref: key_ref.to_string(),
        kek,
        domain,
    });
}

pub(crate) fn clear_cache() {
    *SESSION.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

fn delete_item(account: &str) {
    if let Err(e) = delete_generic_password(SERVICE, account) {
        let msg = e.to_string();
        if !(msg.contains("-25300") || msg.to_lowercase().contains("not found")) {
            log::debug!("删除钥匙串项 {account} 失败：{e}");
        }
    }
}

fn ensure_domain_matches(stored: &[u8], current: &[u8]) -> Result<()> {
    if stored.is_empty() || current.is_empty() || stored == current {
        Ok(())
    } else {
        Err(AppError::BiometricStale)
    }
}

fn evaluate_biometrics(reason: &str) -> Result<Vec<u8>> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(AppError::Invalid("指纹验证原因不能为空".into()));
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
            Err(AppError::Other("指纹验证失败".into()))
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
        Err(_) => Err(AppError::Other("指纹验证超时".into())),
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
            AppError::Invalid("指纹已锁定，请先在系统中解锁，或改用访问密码".into())
        }
        LAError::PasscodeNotSet => {
            AppError::Invalid("请先在系统中设置开机密码后再开启指纹解锁".into())
        }
        other => AppError::Other(format!("指纹验证失败（{}）", other.0)),
    }
}

fn map_keychain(e: security_framework::base::Error) -> AppError {
    let msg = e.to_string();
    let lower = msg.to_lowercase();
    if msg.contains("-128") || lower.contains("cancel") {
        AppError::BiometricCancelled
    } else if msg.contains("-25300") || lower.contains("not found") {
        AppError::BiometricStale
    } else {
        AppError::Other(format!("无法读取钥匙串：{e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_blob, encode_blob};

    #[test]
    fn blob_roundtrip_keeps_kek_and_domain() {
        let (kek, domain) = decode_blob(&encode_blob(b"kek-bytes-32-bytes-long------", b"dom")).unwrap();
        assert_eq!(kek, b"kek-bytes-32-bytes-long------");
        assert_eq!(domain, b"dom");
        assert!(decode_blob(b"legacy-raw-kek").is_none());
    }
}
