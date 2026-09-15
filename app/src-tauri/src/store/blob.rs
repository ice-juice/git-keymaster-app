//! 内容寻址的分块加密 blob 库（文件保险库附件 / 备忘录正文与图片）。
//!
//! 磁盘格式：
//! ```text
//! magic(4="GKB1") || version(1) || chunk_size(u32 LE)
//! [ nonce(24) || AEAD(chunk, aad = chunk_index u64 LE) ]*
//! ```
//! 峰值内存 ≈ 一个分块。明文 sha256 作为文件名，天然去重。

use crate::app_config;
use crate::error::{AppError, Result};
use crate::vault::crypto::{
    self, LABEL_FILE_BLOB, XNONCE_LEN,
};
use crate::vault::Vault;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zeroize::Zeroize;

pub const BLOB_MAGIC: &[u8; 4] = b"GKB1";
pub const BLOB_VERSION: u8 = 1;
pub const DEFAULT_CHUNK_SIZE: u32 = 1024 * 1024;
const HEADER_LEN: usize = 4 + 1 + 4;
const TAG_LEN: usize = 16;
const MIN_CHUNK_SIZE: u32 = 1;
const MAX_CHUNK_SIZE: u32 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobMeta {
    pub sha256: String,
    pub size: u64,
    /// 写入时本地已有同哈希 blob，跳过覆盖。
    pub existed: bool,
}

pub fn blobs_dir(vault: &Vault) -> PathBuf {
    vault.root().join("blobs")
}

pub fn blob_path(vault: &Vault, sha256: &str) -> PathBuf {
    blobs_dir(vault).join(format!("{sha256}.blob"))
}

pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn blob_exists(vault: &Vault, sha256: &str) -> bool {
    is_sha256_hex(sha256) && blob_path(vault, sha256).is_file()
}

/// 把云端直传的本地密文落到内容寻址路径（不再二次加密）。
pub fn install_blob_ciphertext(vault: &Vault, sha256: &str, ciphertext: &[u8]) -> Result<()> {
    if !is_sha256_hex(sha256) {
        return Err(AppError::Invalid("无效的附件哈希".into()));
    }
    if blob_exists(vault, sha256) {
        return Ok(());
    }
    std::fs::create_dir_all(blobs_dir(vault))?;
    crate::vault::atomic_write(&blob_path(vault, sha256), ciphertext)
}

pub fn default_max_bytes() -> u64 {
    app_config::attachment_per_file_limit_bytes(app_config::DEFAULT_ATTACHMENT_PER_FILE_LIMIT_MB)
}

pub fn write_blob<R: Read>(vault: &Vault, reader: R) -> Result<BlobMeta> {
    write_blob_limited(vault, reader, DEFAULT_CHUNK_SIZE, default_max_bytes())
}

pub fn write_blob_limited<R: Read>(
    vault: &Vault,
    reader: R,
    chunk_size: u32,
    max_bytes: u64,
) -> Result<BlobMeta> {
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }
    if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&chunk_size) {
        return Err(AppError::Invalid("无效的分块大小".into()));
    }
    let key = vault.subkey(LABEL_FILE_BLOB)?;
    let dir = blobs_dir(vault);
    std::fs::create_dir_all(&dir)?;

    let tmp = dir.join(format!(".{}.tmp-{}", "blob", uuid::Uuid::new_v4()));
    let result = write_blob_to_tmp(&tmp, reader, &key, chunk_size, max_bytes);
    match result {
        Ok((sha256, size)) => {
            let dest = blob_path(vault, &sha256);
            if dest.is_file() {
                let _ = std::fs::remove_file(&tmp);
                return Ok(BlobMeta {
                    sha256,
                    size,
                    existed: true,
                });
            }
            if let Err(e) = std::fs::rename(&tmp, &dest) {
                if let Err(copy_err) = std::fs::copy(&tmp, &dest) {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(AppError::Io(format!(
                        "写入 blob 失败：{e} / {copy_err}"
                    )));
                }
                let _ = std::fs::remove_file(&tmp);
            }
            Ok(BlobMeta {
                sha256,
                size,
                existed: false,
            })
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn write_blob_to_tmp<R: Read>(
    tmp: &Path,
    mut reader: R,
    key: &[u8; 32],
    chunk_size: u32,
    max_bytes: u64,
) -> Result<(String, u64)> {
    let mut out = std::fs::File::create(tmp)?;
    out.write_all(BLOB_MAGIC)?;
    out.write_all(&[BLOB_VERSION])?;
    out.write_all(&chunk_size.to_le_bytes())?;

    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut index = 0u64;
    let mut buf = vec![0u8; chunk_size as usize];

    loop {
        let n = read_exact_or_partial(&mut reader, &mut buf)?;
        if n == 0 {
            break;
        }
        let next = size.saturating_add(n as u64);
        if next > max_bytes {
            buf.zeroize();
            return Err(file_too_large(max_bytes));
        }
        hasher.update(&buf[..n]);
        size = next;

        let nonce = crypto::new_nonce();
        let aad = index.to_le_bytes();
        let ct = crypto::aead_encrypt_with_aad(key, &nonce, &buf[..n], &aad)?;
        out.write_all(&nonce)?;
        out.write_all(&ct)?;
        index += 1;
    }
    buf.zeroize();
    out.flush()?;
    Ok((hex_encode(&hasher.finalize()), size))
}

fn file_too_large(max_bytes: u64) -> AppError {
    let mb = (max_bytes / (1024 * 1024)).max(1);
    AppError::Invalid(format!("单个文件不能超过 {mb} MB"))
}

fn read_exact_or_partial<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<usize> {
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

pub fn read_blob_bytes(vault: &Vault, sha256: &str) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    read_blob(vault, sha256, &mut out)?;
    Ok(out)
}

pub fn blob_ciphertext_len(vault: &Vault, sha256: &str) -> Option<u64> {
    std::fs::metadata(blob_path(vault, sha256))
        .ok()
        .map(|m| m.len())
}

pub fn read_blob<W: Write>(vault: &Vault, sha256: &str, writer: W) -> Result<u64> {
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }
    if !is_sha256_hex(sha256) {
        return Err(AppError::Invalid("无效的附件哈希".into()));
    }
    let path = blob_path(vault, sha256);
    crate::vault::recover_previous_if_missing(&path);
    if !path.is_file() {
        return Err(AppError::Invalid("附件内容不存在".into()));
    }
    let key = vault.subkey(LABEL_FILE_BLOB)?;
    let file = std::fs::File::open(&path)?;
    let total = file.metadata()?.len();
    decrypt_blob_file(file, total, &key, sha256, writer)
}

fn decrypt_blob_file<R: Read, W: Write>(
    mut file: R,
    total: u64,
    key: &[u8; 32],
    expected_sha: &str,
    mut writer: W,
) -> Result<u64> {
    if total < HEADER_LEN as u64 {
        return Err(AppError::Crypto);
    }
    let mut header = [0u8; HEADER_LEN];
    file.read_exact(&mut header)?;
    if &header[..4] != BLOB_MAGIC {
        return Err(AppError::Crypto);
    }
    if header[4] != BLOB_VERSION {
        return Err(AppError::Invalid("不支持的附件格式版本".into()));
    }
    let chunk_size = u32::from_le_bytes(header[5..9].try_into().unwrap());
    if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&chunk_size) {
        return Err(AppError::Crypto);
    }

    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut index = 0u64;
    let mut pos = HEADER_LEN as u64;
    let full_on_disk = u64::from(XNONCE_LEN as u32 + chunk_size + TAG_LEN as u32);

    while pos < total {
        let left = total - pos;
        if left < (XNONCE_LEN + TAG_LEN) as u64 {
            return Err(AppError::Crypto);
        }
        let cipher_len = (left - XNONCE_LEN as u64).min(u64::from(chunk_size) + TAG_LEN as u64) as usize;
        let mut nonce = [0u8; XNONCE_LEN];
        file.read_exact(&mut nonce)?;
        let mut ct = vec![0u8; cipher_len];
        file.read_exact(&mut ct)?;
        pos += (XNONCE_LEN + cipher_len) as u64;
        if pos < total && (XNONCE_LEN + cipher_len) as u64 != full_on_disk {
            ct.zeroize();
            return Err(AppError::Crypto);
        }

        let aad = index.to_le_bytes();
        let mut plain = crypto::aead_decrypt_with_aad(key, &nonce, &ct, &aad)?;
        ct.zeroize();
        hasher.update(&plain);
        writer.write_all(&plain)?;
        size = size.saturating_add(plain.len() as u64);
        plain.zeroize();
        index += 1;
    }

    let got = hex_encode(&hasher.finalize());
    if got != expected_sha {
        return Err(AppError::Crypto);
    }
    writer.flush().ok();
    Ok(size)
}

pub fn list_blob_hashes(vault: &Vault) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(blobs_dir(vault)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for ent in rd.flatten() {
        let name = ent.file_name();
        let Some(s) = name.to_str() else { continue };
        if let Some(hash) = s.strip_suffix(".blob") {
            if is_sha256_hex(hash) {
                out.push(hash.to_string());
            }
        }
    }
    out.sort();
    out
}

pub fn gc_unreferenced_blobs(vault: &Vault, referenced: &HashSet<String>) -> Result<usize> {
    let mut removed = 0usize;
    for hash in list_blob_hashes(vault) {
        if referenced.contains(&hash) {
            continue;
        }
        let path = blob_path(vault, &hash);
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::header::KdfParams;
    use crate::vault::kdf::{ITERS_FLOOR, MEM_FLOOR_KIB};
    use std::io::Cursor;

    fn unlocked_vault() -> (Vault, PathBuf) {
        let root = std::env::temp_dir().join(format!("gam-blob-{}", uuid::Uuid::new_v4()));
        let kdf = KdfParams::new(MEM_FLOOR_KIB, ITERS_FLOOR, 1);
        let (v, _rec) = Vault::init(&root, "pw", kdf).unwrap();
        (v, root)
    }

    fn sha256_hex(data: &[u8]) -> String {
        hex_encode(&Sha256::digest(data))
    }

    #[test]
    fn chunked_roundtrip_and_plaintext_absent() {
        let (v, root) = unlocked_vault();
        let plain = b"hello file vault across two chunks!!".repeat(3);
        let meta = write_blob_limited(&v, Cursor::new(plain.clone()), 16, 10 * 1024).unwrap();
        assert_eq!(meta.size, plain.len() as u64);
        assert_eq!(meta.sha256, sha256_hex(&plain));
        assert!(!meta.existed);
        assert!(blob_exists(&v, &meta.sha256));

        let raw = std::fs::read(blob_path(&v, &meta.sha256)).unwrap();
        assert!(raw.starts_with(BLOB_MAGIC));
        assert!(!raw.windows(5).any(|w| w == b"hello"));

        let mut out = Vec::new();
        let size = read_blob(&v, &meta.sha256, &mut out).unwrap();
        assert_eq!(size, plain.len() as u64);
        assert_eq!(out, plain);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn empty_blob_roundtrip() {
        let (v, root) = unlocked_vault();
        let meta = write_blob_limited(&v, Cursor::new(&[] as &[u8]), 16, 1024).unwrap();
        assert_eq!(meta.size, 0);
        assert_eq!(meta.sha256, sha256_hex(b""));
        let mut out = Vec::new();
        assert_eq!(read_blob(&v, &meta.sha256, &mut out).unwrap(), 0);
        assert!(out.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn content_addressed_dedup() {
        let (v, root) = unlocked_vault();
        let data = b"same-bytes-twice";
        let a = write_blob_limited(&v, Cursor::new(data.as_slice()), 8, 1024).unwrap();
        let b = write_blob_limited(&v, Cursor::new(data.as_slice()), 8, 1024).unwrap();
        assert_eq!(a.sha256, b.sha256);
        assert!(!a.existed);
        assert!(b.existed);
        assert_eq!(list_blob_hashes(&v).len(), 1);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_over_size_limit() {
        let (v, root) = unlocked_vault();
        let data = vec![7u8; 101];
        let err = write_blob_limited(&v, Cursor::new(data), 32, 100).unwrap_err();
        assert_eq!(err.code(), "INVALID");
        assert!(err.to_string().contains("不能超过"));
        assert!(list_blob_hashes(&v).is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn tamper_and_truncate_rejected() {
        let (v, root) = unlocked_vault();
        let plain = b"integrity-check-payload-0123456789";
        let meta = write_blob_limited(&v, Cursor::new(plain.as_slice()), 12, 1024).unwrap();
        let path = blob_path(&v, &meta.sha256);

        let mut raw = std::fs::read(&path).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x5a;
        std::fs::write(&path, &raw).unwrap();
        assert!(read_blob(&v, &meta.sha256, Vec::new()).is_err());

        raw.truncate(raw.len() - 8);
        std::fs::write(&path, &raw).unwrap();
        assert!(read_blob(&v, &meta.sha256, Vec::new()).is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn swapped_chunks_rejected_by_aad() {
        let (v, root) = unlocked_vault();
        let plain = vec![1u8; 48];
        let meta = write_blob_limited(&v, Cursor::new(plain), 16, 1024).unwrap();
        let path = blob_path(&v, &meta.sha256);
        let mut raw = std::fs::read(&path).unwrap();
        let chunk_on_disk = XNONCE_LEN + 16 + TAG_LEN;
        let start = HEADER_LEN;
        let a = raw[start..start + chunk_on_disk].to_vec();
        let b = raw[start + chunk_on_disk..start + 2 * chunk_on_disk].to_vec();
        raw[start..start + chunk_on_disk].copy_from_slice(&b);
        raw[start + chunk_on_disk..start + 2 * chunk_on_disk].copy_from_slice(&a);
        std::fs::write(&path, raw).unwrap();
        assert!(read_blob(&v, &meta.sha256, Vec::new()).is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn gc_keeps_referenced_only() {
        let (v, root) = unlocked_vault();
        let keep = write_blob_limited(&v, Cursor::new(b"keep-me"), 8, 1024).unwrap();
        let drop = write_blob_limited(&v, Cursor::new(b"drop-me"), 8, 1024).unwrap();
        let mut refs = HashSet::new();
        refs.insert(keep.sha256.clone());
        assert_eq!(gc_unreferenced_blobs(&v, &refs).unwrap(), 1);
        assert!(blob_exists(&v, &keep.sha256));
        assert!(!blob_exists(&v, &drop.sha256));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn default_limit_is_100_mib() {
        assert_eq!(default_max_bytes(), 100 * 1024 * 1024);
    }
}
