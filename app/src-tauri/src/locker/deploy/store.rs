//! 本机部署凭据：`data/locker-deploy.enc`。用恢复密钥派生的元数据子密钥加密。
//! 不进云同步打包清单（同步只认识 secrets / locker 等已知结构）。

use super::LockerDeployProgress;
use crate::error::{AppError, Result};
use crate::vault::crypto::{self, KEY_LEN, LABEL_METADATA, XNONCE_LEN};
use crate::vault::{atomic_write, Vault};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LockerDeployRecord {
    #[serde(default)]
    pub api_token: Option<String>,
    #[serde(default)]
    pub last_method: Option<String>,
    #[serde(default)]
    pub progress: Option<LockerDeployProgress>,
}

fn path(vault: &Vault) -> PathBuf {
    vault.root().join("data").join("locker-deploy.enc")
}

fn seal(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<Vec<u8>> {
    let nonce = crypto::new_nonce();
    let ct = crypto::aead_encrypt(key, &nonce, plaintext)?;
    let mut out = Vec::with_capacity(XNONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn open(key: &[u8; KEY_LEN], data: &[u8]) -> Result<Vec<u8>> {
    if data.len() < XNONCE_LEN {
        return Err(AppError::Crypto);
    }
    let (n, ct) = data.split_at(XNONCE_LEN);
    let mut nonce = [0u8; XNONCE_LEN];
    nonce.copy_from_slice(n);
    crypto::aead_decrypt(key, &nonce, ct)
}

pub fn load(vault: &Vault) -> Result<LockerDeployRecord> {
    crate::vault::recover_previous_if_missing(&path(vault));
    let p = path(vault);
    if !p.exists() {
        return Ok(LockerDeployRecord::default());
    }
    let key = vault.subkey(LABEL_METADATA)?;
    let raw = std::fs::read(p)?;
    let plain = open(&key, &raw)?;
    Ok(serde_json::from_slice(&plain)?)
}

pub fn save(vault: &Vault, rec: &LockerDeployRecord) -> Result<()> {
    let key = vault.subkey(LABEL_METADATA)?;
    let json = serde_json::to_vec(rec)?;
    let sealed = seal(&key, &json)?;
    atomic_write(&path(vault), &sealed)
}

pub fn upsert<F>(vault: &Vault, f: F) -> Result<LockerDeployRecord>
where
    F: FnOnce(&mut LockerDeployRecord),
{
    let mut rec = load(vault).unwrap_or_default();
    f(&mut rec);
    save(vault, &rec)?;
    Ok(rec)
}

pub fn token_last4(token: &str) -> String {
    let t = token.trim();
    if t.len() < 4 {
        String::new()
    } else {
        t[t.len() - 4..].to_string()
    }
}

pub fn has_token(rec: &LockerDeployRecord) -> bool {
    rec.api_token.as_deref().is_some_and(|s| !s.trim().is_empty())
}
