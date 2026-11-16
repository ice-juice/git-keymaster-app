//! Apple biometric KEKs live only in a device-only Keychain item whose access
//! control is enforced by Security.framework. No file or unauthenticated fallback.
use super::BiometricAvailability;
use crate::error::{AppError, Result};
use objc2_local_authentication::{LABiometryType, LAContext, LAPolicy};
use std::ffi::c_void;
use zeroize::{Zeroize, Zeroizing};

type Ref = *const c_void;
type MutableRef = *mut c_void;
const SERVICE: &str = "com.jeck.gitkeymaster.biometric.acl.v2";
const LEGACY_SERVICE: &str = "com.jeck.gitkeymaster.biometric";
pub const KEY_PREFIX: &str = "gam-vault-acl-v2-";
const UTF8: u32 = 0x0800_0100;
const BIOMETRY_CURRENT_SET: usize = 1 << 3;

#[repr(C)]
struct KeyCallbacks {
    version: isize,
    retain: Ref,
    release: Ref,
    description: Ref,
    equal: Ref,
    hash: Ref,
}
#[repr(C)]
struct ValueCallbacks {
    version: isize,
    retain: Ref,
    release: Ref,
    description: Ref,
    equal: Ref,
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFTypeDictionaryKeyCallBacks: KeyCallbacks;
    static kCFTypeDictionaryValueCallBacks: ValueCallbacks;
    static kCFBooleanTrue: Ref;
    static kCFAllocatorNull: Ref;
    fn CFRelease(value: Ref);
    fn CFStringCreateWithBytes(
        allocator: Ref,
        bytes: *const u8,
        length: isize,
        encoding: u32,
        external: u8,
    ) -> Ref;
    fn CFDataCreateWithBytesNoCopy(
        allocator: Ref,
        bytes: *const u8,
        length: isize,
        deallocator: Ref,
    ) -> Ref;
    fn CFDataGetLength(data: Ref) -> isize;
    fn CFDataGetBytePtr(data: Ref) -> *const u8;
    fn CFGetTypeID(value: Ref) -> usize;
    fn CFDataGetTypeID() -> usize;
    fn CFDictionaryCreateMutable(
        allocator: Ref,
        capacity: isize,
        keys: *const KeyCallbacks,
        values: *const ValueCallbacks,
    ) -> MutableRef;
    fn CFDictionarySetValue(dict: MutableRef, key: Ref, value: Ref);
}

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecClass: Ref;
    static kSecClassGenericPassword: Ref;
    static kSecAttrService: Ref;
    static kSecAttrAccount: Ref;
    static kSecAttrAccessControl: Ref;
    static kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly: Ref;
    static kSecValueData: Ref;
    static kSecReturnData: Ref;
    static kSecUseOperationPrompt: Ref;
    #[cfg(target_os = "macos")]
    static kSecUseDataProtectionKeychain: Ref;
    fn SecAccessControlCreateWithFlags(
        allocator: Ref,
        protection: Ref,
        flags: usize,
        error: *mut Ref,
    ) -> Ref;
    fn SecItemAdd(attributes: Ref, result: *mut Ref) -> i32;
    fn SecItemCopyMatching(query: Ref, result: *mut Ref) -> i32;
    fn SecItemDelete(query: Ref) -> i32;
}

struct Owned(Ref);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}
impl Owned {
    fn checked(raw: Ref) -> Result<Self> {
        if raw.is_null() {
            Err(AppError::Crypto)
        } else {
            Ok(Self(raw))
        }
    }
    fn string(s: &str) -> Result<Self> {
        Self::checked(unsafe {
            CFStringCreateWithBytes(std::ptr::null(), s.as_ptr(), s.len() as isize, UTF8, 0)
        })
    }
    fn set(&self, key: Ref, value: Ref) {
        unsafe { CFDictionarySetValue(self.0 as MutableRef, key, value) }
    }
}

fn query(service: &str, key_ref: &str, protected: bool) -> Result<Owned> {
    if !key_ref.starts_with("gam-vault-")
        || !key_ref
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(AppError::BiometricStale);
    }
    let dict = Owned::checked(unsafe {
        CFDictionaryCreateMutable(
            std::ptr::null(),
            0,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
    } as Ref)?;
    let service = Owned::string(service)?;
    let account = Owned::string(key_ref)?;
    unsafe {
        dict.set(kSecClass, kSecClassGenericPassword);
        dict.set(kSecAttrService, service.0);
        dict.set(kSecAttrAccount, account.0);
        #[cfg(target_os = "macos")]
        if protected {
            dict.set(kSecUseDataProtectionKeychain, kCFBooleanTrue);
        }
    }
    let _ = protected;
    Ok(dict)
}

fn status_error(status: i32) -> AppError {
    match status {
        -128 => AppError::BiometricCancelled,
        -25300 | -25293 => AppError::BiometricStale,
        _ => AppError::Other(format!("系统钥匙串拒绝生物识别密钥操作（{status}）。请确认应用签名、设备密码与钥匙串权限；不会降级为文件存储。")),
    }
}

pub fn availability() -> BiometricAvailability {
    let ctx = unsafe { LAContext::new() };
    let available =
        unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics) }
            .is_ok();
    let kind = if unsafe { ctx.biometryType() } == LABiometryType::FaceID {
        "face-id"
    } else {
        "touch-id"
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
    if !key_ref.starts_with(KEY_PREFIX) || !availability().available {
        return Err(AppError::BiometricStale);
    }
    let mut raw = Zeroizing::new(vec![0u8; crate::vault::crypto::KEY_LEN]);
    crate::vault::crypto::fill_random(&mut raw);
    let attrs = query(SERVICE, key_ref, true)?;
    let mut error: Ref = std::ptr::null();
    let access_raw = unsafe {
        SecAccessControlCreateWithFlags(
            std::ptr::null(),
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            BIOMETRY_CURRENT_SET,
            &mut error,
        )
    };
    let _error = Owned(error);
    let access = Owned::checked(access_raw)?;
    let data = Owned::checked(unsafe {
        // raw outlives both dictionary and CFData; CoreFoundation must not free it.
        CFDataCreateWithBytesNoCopy(
            std::ptr::null(),
            raw.as_ptr(),
            raw.len() as isize,
            kCFAllocatorNull,
        )
    })?;
    unsafe {
        attrs.set(kSecAttrAccessControl, access.0);
        attrs.set(kSecValueData, data.0);
    }
    let removed = unsafe { SecItemDelete(query(SERVICE, key_ref, true)?.0) };
    if removed != 0 && removed != -25300 {
        return Err(status_error(removed));
    }
    let status = unsafe { SecItemAdd(attrs.0, std::ptr::null_mut()) };
    if status != 0 {
        return Err(status_error(status));
    }
    // Round-trip through the actual ACL-protected item before publishing an envelope.
    let checked = Zeroizing::new(read_protected(key_ref, "启用面容 / 指纹解锁")?);
    if checked.as_slice() != raw.as_slice() {
        return Err(AppError::Crypto);
    }
    Ok(raw.to_vec())
}

fn read_protected(key_ref: &str, prompt: &str) -> Result<Vec<u8>> {
    if !key_ref.starts_with(KEY_PREFIX) {
        return Err(AppError::BiometricStale);
    }
    let query = query(SERVICE, key_ref, true)?;
    let prompt = Owned::string(prompt)?;
    unsafe {
        query.set(kSecReturnData, kCFBooleanTrue);
        query.set(kSecUseOperationPrompt, prompt.0);
    }
    let mut result: Ref = std::ptr::null();
    let status = unsafe { SecItemCopyMatching(query.0, &mut result) };
    let result = Owned(result);
    if status != 0 {
        return Err(status_error(status));
    }
    if result.0.is_null()
        || unsafe { CFGetTypeID(result.0) != CFDataGetTypeID() || CFDataGetLength(result.0) != 32 }
    {
        return Err(AppError::BiometricStale);
    }
    Ok(unsafe { std::slice::from_raw_parts(CFDataGetBytePtr(result.0), 32) }.to_vec())
}

pub fn derive(key_ref: &str, _challenge: &[u8]) -> Result<Vec<u8>> {
    read_protected(key_ref, "解锁工作空间")
}

pub fn verify_presence(prompt: &str) -> Result<()> {
    let file = super::store::load()?;
    let mut key = read_protected(&file.key_ref, prompt)?;
    key.zeroize();
    Ok(())
}

pub fn remove(key_ref: &str) -> Result<()> {
    let protected = key_ref.starts_with(KEY_PREFIX);
    // Validate the generated identifier before constructing even a legacy file path.
    let service = if protected { SERVICE } else { LEGACY_SERVICE };
    let item = query(service, key_ref, protected)?;
    // Old iOS versions never had a Keychain item: lack of an entitlement must not
    // prevent removing their plaintext file.
    if protected || cfg!(target_os = "macos") {
        let status = unsafe { SecItemDelete(item.0) };
        if status != 0 && status != -25300 {
            return Err(status_error(status));
        }
    }
    #[cfg(target_os = "ios")]
    if !protected {
        // Only remove the exact old application's generated files, never scan user paths.
        let dir = crate::app_config::config_dir().join("biometric-keys");
        for ext in ["kek", "domain", "kek.prev", "domain.prev"] {
            let path = dir.join(format!("{key_ref}.{ext}"));
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    Ok(())
}

pub(crate) fn clear_cache() {} // No application-level Apple KEK cache exists.
