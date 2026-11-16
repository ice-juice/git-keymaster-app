//! 文件寄存柜：随机内容密钥的分块 AEAD、取件码哈希、封装与销毁判定。
//!
//! 密文帧与文件保险库 blob 相同（`GKB1`），但密钥是每项随机的 CK，不进内容寻址池。

pub mod deploy;
pub mod worker;

use crate::error::{AppError, Result};
use crate::model;
use crate::store::blob;
use crate::vault::crypto::{self, LABEL_LOCKER_CODE, LABEL_LOCKER_WRAP, KEY_LEN, XNONCE_LEN};
use crate::vault::Vault;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::io::{Read, Write};
use std::path::Path;
use zeroize::Zeroize;

pub const DEFAULT_TTL_SECS: u64 = 24 * 60 * 60;
pub const DEFAULT_MAX_PULLS: u32 = 1;
pub const LOCKER_MAX_BYTES: u64 = 100 * 1024 * 1024;
const TAG_LEN: usize = 16;
const HEADER_LEN: usize = 9;
const MAX_CHUNK: u32 = 8 * 1024 * 1024;

type HmacSha256 = Hmac<Sha256>;

/// 取件码 HMAC。密钥是公开标签 `LABEL_LOCKER_CODE` 的字节，不是主密钥子密钥。
/// Worker 只存这个十六进制摘要，收到 6 位码后用同一算法复核，全程拿不到 CK。
pub fn pickup_code_hash(code: &str) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(LABEL_LOCKER_CODE).expect("HMAC 接受任意长度密钥");
    mac.update(code.as_bytes());
    hex_encode(&mac.finalize().into_bytes())
}

pub fn normalize_pickup_code(raw: &str) -> Result<String> {
    let digits: String = raw.chars().filter(|c| !c.is_whitespace()).map(|c| {
        if ('０'..='９').contains(&c) { char::from_u32(c as u32 - 0xfee0).unwrap() } else { c }
    }).collect();
    if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::Invalid("取件码必须是 6 位数字".into()));
    }
    Ok(digits)
}

pub fn random_pickup_code() -> String {
    const SPACE: u32 = 1_000_000;
    let limit = u32::MAX - (u32::MAX % SPACE);
    loop {
        let mut buf = [0u8; 4];
        crypto::fill_random(&mut buf);
        let n = u32::from_le_bytes(buf);
        if n < limit {
            return format!("{:06}", n % SPACE);
        }
    }
}

pub fn random_slug() -> String {
    const ABC: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut out = String::with_capacity(10);
    while out.len() < 10 {
        let mut b = [0u8; 1];
        crypto::fill_random(&mut b);
        if b[0] < 248 {
            out.push(ABC[(b[0] % 62) as usize] as char);
        }
    }
    out
}

pub fn random_content_key() -> [u8; KEY_LEN] {
    let mut ck = [0u8; KEY_LEN];
    crypto::fill_random(&mut ck);
    ck
}

pub fn logical_path(id: &str) -> String {
    format!("locker/{id}")
}

/// S3 子路径。真正的对象名是 HMAC，前面再加 `locker/`，避开同步用的 `obj/` 与快照 GC。
pub fn object_subpath(object_name: &str) -> String {
    format!("locker/{object_name}")
}

pub fn wrap_content_key(vault: &Vault, ck: &[u8; KEY_LEN]) -> Result<String> {
    let mut key = vault.subkey(LABEL_LOCKER_WRAP)?;
    let wrapped = wrap_with_key(&key, ck);
    key.zeroize();
    wrapped
}

pub fn unwrap_content_key(vault: &Vault, wrap_self: &str) -> Result<[u8; KEY_LEN]> {
    let mut key = vault.subkey(LABEL_LOCKER_WRAP)?;
    let ck = unwrap_with_key(&key, wrap_self);
    key.zeroize();
    ck
}

fn wrap_with_key(key: &[u8; KEY_LEN], ck: &[u8; KEY_LEN]) -> Result<String> {
    let nonce = crypto::new_nonce();
    let ct = crypto::aead_encrypt(key, &nonce, ck)?;
    let mut raw = Vec::with_capacity(XNONCE_LEN + ct.len());
    raw.extend_from_slice(&nonce);
    raw.extend_from_slice(&ct);
    Ok(B64.encode(raw))
}

fn unwrap_with_key(key: &[u8; KEY_LEN], wrap_self: &str) -> Result<[u8; KEY_LEN]> {
    let raw = B64.decode(wrap_self.trim()).map_err(|_| AppError::Crypto)?;
    if raw.len() < XNONCE_LEN + TAG_LEN {
        return Err(AppError::Crypto);
    }
    let mut nonce = [0u8; XNONCE_LEN];
    nonce.copy_from_slice(&raw[..XNONCE_LEN]);
    let mut pt = crypto::aead_decrypt(key, &nonce, &raw[XNONCE_LEN..])?;
    if pt.len() != KEY_LEN {
        pt.zeroize();
        return Err(AppError::Crypto);
    }
    let mut ck = [0u8; KEY_LEN];
    ck.copy_from_slice(&pt);
    pt.zeroize();
    Ok(ck)
}

pub fn ck_fragment(ck: &[u8; KEY_LEN]) -> String {
    URL_SAFE_NO_PAD.encode(ck)
}

/// 与 Worker `safeDownloadName` 对齐：只留最后一段文件名，去掉控制字符和前导点，最长 80。
/// 没有可用名字时用 `download.bin`，避免取件页把 jpg 存成无名二进制。
pub fn download_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let without_controls: String = base.chars().filter(|c| *c > '\u{001f}').collect();
    let sliced: String = without_controls.trim_start_matches('.').chars().take(80).collect();
    let cleaned = sliced.trim();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "download.bin".to_string()
    } else {
        cleaned.to_string()
    }
}

const SHARE_AUTH_KEY_LABEL: &[u8] = b"gam-locker-share-auth-key-v2";

fn share_base(base: &str) -> Result<String> {
    let url = url::Url::parse(base.trim()).map_err(|_| AppError::Invalid("取件服务地址无效".into()))?;
    if !matches!(url.scheme(), "http" | "https") || !url.has_host()
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some() {
        return Err(AppError::Invalid("取件服务地址无效".into()));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn share_mac_key(ck: &[u8; KEY_LEN]) -> [u8; KEY_LEN] {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(ck).expect("HMAC key");
    mac.update(SHARE_AUTH_KEY_LABEL);
    mac.finalize().into_bytes().into()
}

fn share_auth_payload(base: &str, slug: &str, size: u64, name: &str) -> String {
    format!("gam-locker-share-v2\n{base}\n{slug}\n{size}\n{name}")
}

/// Authenticated size prevents a valid prefix of GKB1 chunks being accepted as
/// a complete file. Filename, service and slug are bound to the same metadata.
/// All integrity material remains in the URL fragment and is not sent to Worker.
pub fn share_link(base: &str, slug: &str, ck: &[u8; KEY_LEN], filename: &str, plain_size: u64) -> Result<String> {
    if plain_size > LOCKER_MAX_BYTES || slug.len() != 10 || !slug.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(AppError::Invalid("分享文件大小或短码无效".into()));
    }
    let base = share_base(base)?;
    let name = URL_SAFE_NO_PAD.encode(download_filename(filename).as_bytes());
    let mut auth_key = share_mac_key(ck);
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&auth_key).expect("HMAC key");
    auth_key.zeroize();
    mac.update(share_auth_payload(&base, slug, plain_size, &name).as_bytes());
    let tag = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!("{base}/d/{slug}#v2.{}.{plain_size}.{name}.{tag}", ck_fragment(ck)))
}

pub fn verify_share_fragment(base: &str, slug: &str, fragment: &str) -> Result<([u8; KEY_LEN], String, u64)> {
    let parts: Vec<_> = fragment.split('.').collect();
    if parts.len() != 5 || parts[0] != "v2" {
        return Err(AppError::Invalid("旧分享链接缺少完整性信息，请发送方重新复制分享链接".into()));
    }
    let invalid = || AppError::Invalid("分享链接完整性校验失败，请重新复制完整链接".into());
    if fragment.len() > 2048 || slug.len() != 10 || !slug.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(invalid());
    }
    let size = parts[2].parse::<u64>().map_err(|_| invalid())?;
    if size > LOCKER_MAX_BYTES || size.to_string() != parts[2] { return Err(invalid()); }
    let raw_key = zeroize::Zeroizing::new(URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| invalid())?);
    if raw_key.len() != KEY_LEN { return Err(invalid()); }
    let mut ck = zeroize::Zeroizing::new([0u8; KEY_LEN]);
    ck.copy_from_slice(&raw_key);
    let tag = URL_SAFE_NO_PAD.decode(parts[4]).map_err(|_| invalid())?;
    let name = String::from_utf8(URL_SAFE_NO_PAD.decode(parts[3]).map_err(|_| invalid())?).map_err(|_| invalid())?;
    let base = share_base(base)?;
    let mut auth_key = share_mac_key(&ck);
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&auth_key).expect("HMAC key");
    auth_key.zeroize();
    mac.update(share_auth_payload(&base, slug, size, parts[3]).as_bytes());
    mac.verify_slice(&tag).map_err(|_| invalid())?;
    Ok((*ck, download_filename(&name), size))
}

/// `expire_at` 为空表示永久。`now >= expire_at` 视为到期。
pub fn is_expired(expire_at: Option<&str>, now: &str) -> bool {
    match expire_at.map(str::trim).filter(|s| !s.is_empty()) {
        None => false,
        Some(exp) => model::timestamp_newer_or_eq(now, exp),
    }
}

/// 成功取出一次之后的剩余次数。返回 `(新的 pulls_left, 是否该焚毁)`。
/// `None` 表示不限次数，不焚毁。归零则焚毁。
pub fn after_successful_pull(pulls_left: Option<u32>) -> (Option<u32>, bool) {
    match pulls_left {
        None => (None, false),
        Some(0) | Some(1) => (Some(0), true),
        Some(n) => (Some(n - 1), false),
    }
}

pub fn pulls_exhausted(pulls_left: Option<u32>) -> bool {
    pulls_left == Some(0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PutPolicy {
    pub expire_at: Option<String>,
    pub max_pulls: Option<u32>,
}

pub fn resolve_put_policy(
    permanent: bool,
    ttl_secs: Option<u64>,
    unlimited_pulls: bool,
    max_pulls: Option<u32>,
    now: time::OffsetDateTime,
) -> Result<PutPolicy> {
    let expire_at = if permanent {
        None
    } else {
        let ttl = ttl_secs.unwrap_or(DEFAULT_TTL_SECS);
        if ttl == 0 {
            return Err(AppError::Invalid("存放时长至少 1 秒".into()));
        }
        if ttl > 100 * 366 * 24 * 60 * 60 {
            return Err(AppError::Invalid("存放时长过长".into()));
        }
        let exp = now
            .checked_add(time::Duration::seconds(ttl as i64))
            .ok_or_else(|| AppError::Invalid("存放时长无效".into()))?;
        Some(
            exp.format(&time::format_description::well_known::Rfc3339)
                .map_err(|_| AppError::Invalid("存放时长无效".into()))?,
        )
    };
    let max_pulls = if unlimited_pulls {
        None
    } else {
        let n = max_pulls.unwrap_or(DEFAULT_MAX_PULLS);
        if n == 0 {
            return Err(AppError::Invalid("可取次数至少为 1，不限请单独选择".into()));
        }
        Some(n)
    };
    Ok(PutPolicy {
        expire_at,
        max_pulls,
    })
}

pub fn framed_ciphertext_len(plain: u64, chunk_size: u32) -> u64 {
    let chunk = u64::from(chunk_size);
    if plain == 0 || chunk == 0 {
        return HEADER_LEN as u64;
    }
    let full = plain / chunk;
    let rem = plain % chunk;
    let per = XNONCE_LEN as u64 + chunk + TAG_LEN as u64;
    let mut n = HEADER_LEN as u64 + full * per;
    if rem > 0 {
        n += XNONCE_LEN as u64 + rem + TAG_LEN as u64;
    }
    n
}

pub fn seal_framed<R: Read, W: Write>(
    mut reader: R,
    mut writer: W,
    key: &[u8; KEY_LEN],
    chunk_size: u32,
    max_bytes: u64,
) -> Result<u64> {
    if !(1..=MAX_CHUNK).contains(&chunk_size) {
        return Err(AppError::Invalid("无效的分块大小".into()));
    }
    writer.write_all(blob::BLOB_MAGIC)?;
    writer.write_all(&[blob::BLOB_VERSION])?;
    writer.write_all(&chunk_size.to_le_bytes())?;

    let mut buf = vec![0u8; chunk_size as usize];
    let mut size = 0u64;
    let mut index = 0u64;
    loop {
        let n = read_some(&mut reader, &mut buf)?;
        if n == 0 {
            break;
        }
        let next = size.saturating_add(n as u64);
        if next > max_bytes {
            buf.zeroize();
            let mb = (max_bytes / (1024 * 1024)).max(1);
            return Err(AppError::Invalid(format!("单个文件不能超过 {mb} MB")));
        }
        size = next;
        let nonce = crypto::new_nonce();
        let ct = crypto::aead_encrypt_with_aad(key, &nonce, &buf[..n], &index.to_le_bytes())?;
        writer.write_all(&nonce)?;
        writer.write_all(&ct)?;
        index += 1;
    }
    buf.zeroize();
    writer.flush()?;
    Ok(size)
}

pub fn open_framed<R: Read, W: Write>(
    mut reader: R,
    mut writer: W,
    key: &[u8; KEY_LEN],
    expected_plain: Option<u64>,
) -> Result<u64> {
    let mut header = [0u8; HEADER_LEN];
    reader.read_exact(&mut header).map_err(|_| AppError::Crypto)?;
    if &header[..4] != blob::BLOB_MAGIC || header[4] != blob::BLOB_VERSION {
        return Err(AppError::Crypto);
    }
    let chunk_size = u32::from_le_bytes(header[5..9].try_into().unwrap());
    if !(1..=MAX_CHUNK).contains(&chunk_size) {
        return Err(AppError::Crypto);
    }

    let mut size = 0u64;
    let mut index = 0u64;
    loop {
        let mut nonce = [0u8; XNONCE_LEN];
        match read_exact_eof(&mut reader, &mut nonce)? {
            ReadEof::Clean => break,
            ReadEof::Partial => return Err(AppError::Crypto),
            ReadEof::Full => {}
        }
        let mut ct = vec![0u8; chunk_size as usize + TAG_LEN];
        let n = read_some(&mut reader, &mut ct)?;
        if n < TAG_LEN + 1 {
            ct.zeroize();
            return Err(AppError::Crypto);
        }
        ct.truncate(n);
        let mut plain = crypto::aead_decrypt_with_aad(key, &nonce, &ct, &index.to_le_bytes())?;
        ct.zeroize();
        let short = (plain.len() as u32) < chunk_size;
        writer.write_all(&plain)?;
        size = size.saturating_add(plain.len() as u64);
        plain.zeroize();
        index += 1;
        if short {
            let mut extra = [0u8; 1];
            if reader.read(&mut extra)? != 0 {
                return Err(AppError::Crypto);
            }
            break;
        }
    }
    if let Some(expected) = expected_plain {
        if expected != size {
            return Err(AppError::Crypto);
        }
    }
    writer.flush().ok();
    Ok(size)
}

pub fn seal_framed_to_path<R: Read>(
    reader: R,
    key: &[u8; KEY_LEN],
    chunk_size: u32,
    max_bytes: u64,
    path: &Path,
) -> Result<u64> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = std::fs::File::create(path)?;
    seal_framed(reader, file, key, chunk_size, max_bytes)
}

enum ReadEof {
    Clean,
    Partial,
    Full,
}

fn read_exact_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<ReadEof> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => {
                return Ok(if filled == 0 {
                    ReadEof::Clean
                } else {
                    ReadEof::Partial
                });
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(ReadEof::Full)
}

fn read_some<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(filled)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn key() -> [u8; 32] {
        [9u8; 32]
    }

    #[test]
    fn framed_roundtrip() {
        let plain = b"locker-frame-hello".repeat(5);
        let mut ct = Vec::new();
        let n = seal_framed(Cursor::new(plain.clone()), &mut ct, &key(), 16, LOCKER_MAX_BYTES).unwrap();
        assert_eq!(n, plain.len() as u64);
        assert!(ct.starts_with(blob::BLOB_MAGIC));
        assert!(!ct.windows(6).any(|w| w == b"locker"));
        assert_eq!(ct.len() as u64, framed_ciphertext_len(plain.len() as u64, 16));
        let mut out = Vec::new();
        let got = open_framed(Cursor::new(ct), &mut out, &key(), Some(plain.len() as u64)).unwrap();
        assert_eq!(got, plain.len() as u64);
        assert_eq!(out, plain);
    }

    #[test]
    fn framed_empty_roundtrip() {
        let mut ct = Vec::new();
        assert_eq!(seal_framed(Cursor::new(&[] as &[u8]), &mut ct, &key(), 32, 1024).unwrap(), 0);
        let mut out = Vec::new();
        assert_eq!(open_framed(Cursor::new(ct), &mut out, &key(), Some(0)).unwrap(), 0);
        assert!(out.is_empty());
    }

    #[test]
    fn tamper_and_truncate_rejected() {
        let plain = b"integrity-check-payload-0123456789";
        let mut ct = Vec::new();
        seal_framed(Cursor::new(plain.as_slice()), &mut ct, &key(), 12, 1024).unwrap();

        let mut tampered = ct.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x5a;
        assert!(open_framed(Cursor::new(tampered), Vec::new(), &key(), Some(plain.len() as u64)).is_err());

        let mut truncated = ct.clone();
        truncated.truncate(truncated.len() - 8);
        assert!(open_framed(Cursor::new(truncated), Vec::new(), &key(), Some(plain.len() as u64)).is_err());

        let header_only = ct[..HEADER_LEN].to_vec();
        assert!(open_framed(Cursor::new(header_only), Vec::new(), &key(), Some(plain.len() as u64)).is_err());
    }

    #[test]
    fn wrong_key_rejected() {
        let mut ct = Vec::new();
        seal_framed(Cursor::new(b"secret".as_slice()), &mut ct, &key(), 16, 1024).unwrap();
        assert!(open_framed(Cursor::new(ct), Vec::new(), &[3u8; 32], None).is_err());
    }

    #[test]
    fn oversize_rejected() {
        let data = vec![7u8; 40];
        let err = seal_framed(Cursor::new(data), Vec::new(), &key(), 16, 20).unwrap_err();
        assert_eq!(err.code(), "INVALID");
    }

    #[test]
    fn wrap_roundtrip_and_wrong_key() {
        let ck = [4u8; 32];
        let wrap_key = [8u8; 32];
        let wrapped = wrap_with_key(&wrap_key, &ck).unwrap();
        assert_eq!(unwrap_with_key(&wrap_key, &wrapped).unwrap(), ck);
        assert!(unwrap_with_key(&[1u8; 32], &wrapped).is_err());
        assert!(unwrap_with_key(&wrap_key, "not-base64!!!").is_err());
    }

    #[test]
    fn pickup_code_is_six_digits_and_hash_uses_public_label() {
        let code = random_pickup_code();
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
        assert!(normalize_pickup_code("482 193").is_ok());
        assert!(normalize_pickup_code("12ab56").is_err());
        assert!(normalize_pickup_code("12345").is_err());

        let hash = pickup_code_hash("482193");
        assert_eq!(hash, pickup_code_hash("482193"));
        assert_ne!(hash, pickup_code_hash("482194"));
        assert_eq!(hash.len(), 64);
        assert_ne!(hash, "482193");

        let mut mac = <HmacSha256 as Mac>::new_from_slice(LABEL_LOCKER_CODE).unwrap();
        mac.update(b"482193");
        assert_eq!(hash, hex_encode(&mac.finalize().into_bytes()));

        let mk = crypto::MasterKey::from_bytes([2u8; 32]);
        let sub = mk.subkey(LABEL_LOCKER_CODE);
        let mut via_sub = <HmacSha256 as Mac>::new_from_slice(&sub).unwrap();
        via_sub.update(b"482193");
        assert_ne!(hash, hex_encode(&via_sub.finalize().into_bytes()));
    }

    #[test]
    fn share_link_keeps_the_original_filename_out_of_the_path() {
        let ck = [9u8; 32];
        let url = share_link("https://locker.example.com/", "aB3dE6gH9k", &ck, "trip.jpg", 8).unwrap();
        assert!(url.starts_with("https://locker.example.com/d/aB3dE6gH9k#"));
        let hash = url.split_once('#').unwrap().1;
        assert!(!url.split_once('#').unwrap().0.contains("trip"));
        assert_eq!(hash, "v2.CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk.8.dHJpcC5qcGc.s7Ue520jW4iJJyFDcD3MXf76XCiLj_vO9wfduVU_X_Q");
        let (key, name, size) = verify_share_fragment("https://locker.example.com", "aB3dE6gH9k", hash).unwrap();
        assert_eq!(key, ck);
        assert_eq!(name, "trip.jpg");
        assert_eq!(size, 8);
        assert!(verify_share_fragment("https://locker.example.com", "aB3dE6gH9k", &hash.replace(".8.", ".4.")).is_err());
        assert!(verify_share_fragment("https://other.example.com", "aB3dE6gH9k", hash).is_err());
        assert!(verify_share_fragment("https://locker.example.com", "0123456789", hash).is_err());
        assert!(verify_share_fragment("https://locker.example.com", "aB3dE6gH9k", &ck_fragment(&ck)).is_err());

        let from_path = share_link(
            "https://locker.example.com",
            "aB3dE6gH9k",
            &ck,
            r"C:\Users\a\scan.jpg",
            0,
        ).unwrap();
        let (_, name, size) = verify_share_fragment("https://locker.example.com", "aB3dE6gH9k", from_path.split_once('#').unwrap().1).unwrap();
        assert_eq!(name, "scan.jpg");
        assert_eq!(size, 0);
        assert_eq!(download_filename("..\\..\\secret.jpg"), "secret.jpg");
        assert_eq!(download_filename("..."), "download.bin");
    }

    #[test]
    fn slug_is_ten_base62() {
        let slug = random_slug();
        assert_eq!(slug.len(), 10);
        assert!(slug
            .bytes()
            .all(|b| b.is_ascii_alphanumeric()));
        assert_ne!(slug, random_slug());
    }

    #[test]
    fn ttl_expiry() {
        assert!(!is_expired(None, "2026-10-16T00:00:00Z"));
        assert!(!is_expired(Some(""), "2026-10-16T00:00:00Z"));
        assert!(!is_expired(
            Some("2026-10-17T00:00:00Z"),
            "2026-10-16T00:00:00Z"
        ));
        assert!(is_expired(
            Some("2026-10-16T00:00:00Z"),
            "2026-10-16T00:00:00Z"
        ));
        assert!(is_expired(
            Some("2026-10-15T00:00:00Z"),
            "2026-10-16T00:00:00Z"
        ));
    }

    #[test]
    fn pulls_decrement_and_burn_at_zero() {
        assert_eq!(after_successful_pull(Some(3)), (Some(2), false));
        assert_eq!(after_successful_pull(Some(1)), (Some(0), true));
        assert_eq!(after_successful_pull(Some(0)), (Some(0), true));
        assert_eq!(after_successful_pull(None), (None, false));
        assert!(pulls_exhausted(Some(0)));
        assert!(!pulls_exhausted(Some(1)));
        assert!(!pulls_exhausted(None));
    }

    #[test]
    fn put_policy_defaults_to_one_day_and_one_pull() {
        let now = time::OffsetDateTime::parse(
            "2026-10-16T00:00:00Z",
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap();
        let policy = resolve_put_policy(false, None, false, None, now).unwrap();
        assert_eq!(policy.expire_at.as_deref(), Some("2026-10-17T00:00:00Z"));
        assert_eq!(policy.max_pulls, Some(1));

        let forever = resolve_put_policy(true, Some(60), true, Some(3), now).unwrap();
        assert_eq!(forever.expire_at, None);
        assert_eq!(forever.max_pulls, None);

        let custom = resolve_put_policy(false, Some(3600), false, Some(3), now).unwrap();
        assert_eq!(custom.expire_at.as_deref(), Some("2026-10-16T01:00:00Z"));
        assert_eq!(custom.max_pulls, Some(3));
        assert!(resolve_put_policy(false, Some(0), false, None, now).is_err());
        assert!(resolve_put_policy(false, None, false, Some(0), now).is_err());
    }
}
