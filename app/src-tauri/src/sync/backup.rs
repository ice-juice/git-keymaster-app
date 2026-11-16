//! 本地加密备份导出与导入（M6）
//!
//! 离线通道：把整个工作空间（身份、密钥元数据、仓库、私钥密文、PAT/口令）
//! 打包成单个端到端加密的 `.gambackup` 文件，使用用户指定的备份密码加密保护。
//! 适合换机离线迁移、冷备份以及故障恢复。

use crate::error::{AppError, Result};
use crate::model::{
    collect_blob_hashes_all, AccountData, FileData, KeyRecord, LockerData, NoteData, QrHistoryData,
    Secrets, TotpData, VaultData,
};
use crate::store;
use crate::store::blob;
use crate::vault::crypto::{self, SALT_LEN, XNONCE_LEN};
use crate::vault::header::KdfParams;
use crate::vault::kdf;
use crate::vault::Vault;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

const BACKUP_MAGIC: &[u8] = b"GAMBACKUP\x01";

/// 导出的机密数据结构体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupPayload {
    pub version: u32,
    pub workspace_id: String,
    pub created_at: String,
    pub data: VaultData,
    pub secrets: Secrets,
    /// keyId -> base64(privateKeyBytes)
    pub private_keys: HashMap<String, String>,
    #[serde(default)]
    pub totp_data: TotpData,
    #[serde(default)]
    pub account_data: AccountData,
    /// iconHash -> base64(webp)
    #[serde(default)]
    pub icons: HashMap<String, String>,
    #[serde(default)]
    pub file_data: FileData,
    #[serde(default)]
    pub note_data: NoteData,
    /// 旧备份没有这份字段时为 None，导入时不拿空列表清掉本机二维码历史。
    #[serde(default)]
    pub qr_history: Option<QrHistoryData>,
    /// sha256 -> base64(明文 blob)
    #[serde(default)]
    pub blobs: HashMap<String, String>,
    /// Locker metadata and CKs are backed up; remote transient payloads are explicitly excluded.
    #[serde(default)]
    pub locker_data: Option<LockerData>,
    #[serde(default)]
    pub locker_content_keys: HashMap<String, String>,
}

/// 前端展示的备份摘要
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub workspace_id: String,
    pub created_at: String,
    pub identity_count: usize,
    pub key_count: usize,
    pub repo_count: usize,
    pub has_github_pat: bool,
    pub account_count: usize,
    pub totp_count: usize,
    pub file_count: usize,
    pub note_count: usize,
    pub blob_count: usize,
    pub locker_count: usize,
    pub complete: bool,
    pub locker_remote_files_included: bool,
}

fn iso_now() -> String {
    let now = time::OffsetDateTime::now_utc();
    let format = time::format_description::well_known::Rfc3339;
    now.format(&format).unwrap_or_else(|_| "unknown".into())
}

/// 导出加密备份包
/// 备份口令下限。这个文件是最容易被带走的一份完整机密，口令不能形同虚设。
pub const MIN_BACKUP_PASSWORD_LEN: usize = 8;

pub fn export_backup(vault: &Vault, dest_path: &Path, password: &str) -> Result<BackupSummary> {
    store::transaction(vault, || {
        // Validate the actual persisted containers; a warm plaintext cache must not
        // hide corruption while claiming the exported file is a complete backup.
        store::invalidate_plaintext_cache();
        if !vault.is_unlocked() {
            return Err(AppError::Locked);
        }
        // 前端也校验长度，但后端必须自己兜住：IPC 不是只有界面会调。
        if password.chars().count() < MIN_BACKUP_PASSWORD_LEN {
            return Err(AppError::Invalid(format!(
                "备份加密密码不能少于 {MIN_BACKUP_PASSWORD_LEN} 位"
            )));
        }

        let mut data = store::load_data(vault)?;
        crate::sys::portableize_vault_data(&mut data);
        let secrets = store::load_secrets(vault)?;

        let mut private_keys = HashMap::new();
        for key in &data.keys {
            private_keys.insert(key.id.clone(), B64.encode(store::load_key(vault, &key.id)?));
        }
        let totp_data = store::load_totp(vault)?;
        let account_data = store::load_accounts(vault)?;
        let file_data = store::load_files(vault)?;
        let note_data = store::load_notes(vault)?;
        let qr_history = store::load_qr_history(vault)?;
        let locker_data = store::load_locker(vault)?;
        let mut locker_content_keys = HashMap::new();
        for entry in &locker_data.entries {
            let ck = zeroize::Zeroizing::new(crate::locker::unwrap_content_key(
                vault,
                &entry.wrap_self,
            )?);
            locker_content_keys.insert(entry.id.clone(), B64.encode(&*ck));
        }
        let mut icons = HashMap::new();
        for hash in store::list_icon_hashes(vault) {
            icons.insert(hash.clone(), B64.encode(store::load_icon(vault, &hash)?));
        }
        let mut blobs = HashMap::new();
        for hash in collect_blob_hashes_all(&file_data, &note_data, &account_data) {
            blobs.insert(
                hash.clone(),
                B64.encode(blob::read_blob_bytes(vault, &hash)?),
            );
        }
        let payload = BackupPayload {
            version: 2,
            workspace_id: vault.workspace_id().to_string(),
            created_at: iso_now(),
            data,
            secrets,
            private_keys,
            totp_data,
            account_data,
            icons,
            file_data,
            note_data,
            qr_history: Some(qr_history),
            blobs,
            locker_data: Some(locker_data),
            locker_content_keys,
        };
        validate_payload(&payload)?;
        let summary = summarize(&payload);

        let payload_bytes = zeroize::Zeroizing::new(serde_json::to_vec(&payload)?);

        // KDF 派生
        let salt = crypto::new_salt();
        let nonce = crypto::new_nonce();
        // 对齐保险库自身的跨设备档位（128MiB / 4 轮）。原先是 32MiB/3 轮：
        // 最容易被拷走的一份完整机密，却用了全项目最弱的 KDF。
        // 参数随文件头走，手机端恢复仍能解（与 vault.json 同一上限）。
        let kdf_params = KdfParams::new(kdf::MEM_CEIL_MOBILE_SAFE_KIB, 4, 4);
        let kek =
            zeroize::Zeroizing::new(kdf::derive_kek(password.as_bytes(), &salt, &kdf_params)?);

        let ciphertext = crypto::aead_encrypt(&kek, &nonce, &payload_bytes)?;

        // 打包格式：
        // [MAGIC 10B] [MEM_KIB 4B] [ITERS 4B] [PAR 4B] [SALT 16B] [NONCE 24B] [CIPHERTEXT...]
        let mut out =
            Vec::with_capacity(BACKUP_MAGIC.len() + 12 + SALT_LEN + XNONCE_LEN + ciphertext.len());
        out.extend_from_slice(BACKUP_MAGIC);
        out.extend_from_slice(&kdf_params.mem_kib.to_le_bytes());
        out.extend_from_slice(&kdf_params.iters.to_le_bytes());
        out.extend_from_slice(&kdf_params.parallelism.to_le_bytes());
        out.extend_from_slice(&salt);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ciphertext);

        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if !vault.is_unlocked() {
            return Err(AppError::Locked);
        }
        crate::vault::atomic_write(dest_path, &out)?;

        Ok(summary)
    })
}

/// 解析并解密备份文件，返回摘要
pub fn inspect_backup(src_path: &Path, password: &str) -> Result<BackupPayload> {
    let raw = std::fs::read(src_path)?;
    let min_len = BACKUP_MAGIC.len() + 12 + SALT_LEN + XNONCE_LEN + 16;
    if raw.len() < min_len || !raw.starts_with(BACKUP_MAGIC) {
        return Err(AppError::Invalid("不是有效的本地加密备份文件".into()));
    }

    let mut cursor = BACKUP_MAGIC.len();

    let mem_kib = u32::from_le_bytes(raw[cursor..cursor + 4].try_into().unwrap());
    cursor += 4;
    let iters = u32::from_le_bytes(raw[cursor..cursor + 4].try_into().unwrap());
    cursor += 4;
    let parallelism = u32::from_le_bytes(raw[cursor..cursor + 4].try_into().unwrap());
    cursor += 4;

    // Reject unsupported resource requests; never silently change a stored KDF,
    // because that would derive a different key and make valid data unrecoverable.
    let kdf_params = KdfParams::new(mem_kib, iters, parallelism);
    kdf::ensure_affordable(&kdf_params)?;

    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&raw[cursor..cursor + SALT_LEN]);
    cursor += SALT_LEN;

    let mut nonce = [0u8; XNONCE_LEN];
    nonce.copy_from_slice(&raw[cursor..cursor + XNONCE_LEN]);
    cursor += XNONCE_LEN;

    let ciphertext = &raw[cursor..];

    let kek = zeroize::Zeroizing::new(kdf::derive_kek(password.as_bytes(), &salt, &kdf_params)?);
    let plaintext = zeroize::Zeroizing::new(
        crypto::aead_decrypt(&kek, &nonce, ciphertext)
            .map_err(|_| AppError::Invalid("备份密码错误或文件已损坏".into()))?,
    );

    let payload: BackupPayload = serde_json::from_slice(&plaintext)
        .map_err(|e| AppError::Invalid(format!("备份数据反序列化失败: {e}")))?;

    validate_payload(&payload)?;
    Ok(payload)
}

/// 导入备份到当前解锁的 Vault
pub fn import_backup(
    vault: &Vault,
    src_path: &Path,
    password: &str,
    merge: bool,
) -> Result<BackupSummary> {
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }

    let payload = inspect_backup(src_path, password)?;
    let summary = summarize(&payload);
    // Immutable blobs are prepared and verified before changing any live metadata.
    for (hash, b64) in &payload.blobs {
        let bytes = B64
            .decode(b64)
            .map_err(|_| AppError::Invalid("备份附件编码无效".into()))?;
        let meta = blob::write_blob(vault, std::io::Cursor::new(bytes))?;
        if meta.sha256 != *hash {
            return Err(AppError::Crypto);
        }
        blob::read_blob(vault, hash, std::io::sink())?;
    }
    let _checkpoint = store::create_recovery_checkpoint(vault)?;
    store::transaction(vault, || {
        let mut current_data = if merge {
            store::load_data(vault)?
        } else {
            VaultData::default()
        };
        let mut current_secrets = if merge {
            store::load_secrets(vault)?
        } else {
            Secrets::default()
        };

        // 1. 恢复私钥与密码
        for (key_id, b64_bytes) in &payload.private_keys {
            let key_bytes = B64
                .decode(b64_bytes)
                .map_err(|_| AppError::Invalid("备份私钥编码无效".into()))?;
            store::save_key(vault, key_id, &key_bytes)?;
        }
        for (key_id, pass) in &payload.secrets.key_passphrases {
            current_secrets
                .key_passphrases
                .insert(key_id.clone(), pass.clone());
        }
        if payload.secrets.github_pat.is_some() && (!merge || current_secrets.github_pat.is_none())
        {
            current_secrets.github_pat = payload.secrets.github_pat.clone();
        }
        if payload.secrets.gitlab_pat.is_some() && (!merge || current_secrets.gitlab_pat.is_none())
        {
            current_secrets.gitlab_pat = payload.secrets.gitlab_pat.clone();
        }
        if payload.secrets.gitee_pat.is_some() && (!merge || current_secrets.gitee_pat.is_none()) {
            current_secrets.gitee_pat = payload.secrets.gitee_pat.clone();
        }
        let current_totp = if merge {
            store::load_totp(vault)?
        } else {
            TotpData::default()
        };
        let current_acc = if merge {
            store::load_accounts(vault)?
        } else {
            AccountData::default()
        };
        if merge {
            crate::sync::engine::reject_totp_conflicts(
                &current_secrets,
                &payload.secrets,
                &current_totp,
                &payload.totp_data,
            )?;
        }
        current_secrets = crate::model::merge_secrets_with_meta(
            current_secrets,
            &payload.secrets,
            Some(&current_totp),
            Some(&payload.totp_data),
            Some(&current_acc),
            Some(&payload.account_data),
        );
        store::save_secrets(vault, &current_secrets)?;
        store::save_totp(
            vault,
            &crate::model::merge_totp_data(current_totp, payload.totp_data.clone()),
        )?;
        store::save_accounts(
            vault,
            &crate::model::merge_account_data(current_acc, payload.account_data.clone()),
        )?;
        let current_files = if merge {
            store::load_files(vault)?
        } else {
            FileData::default()
        };
        let current_notes = if merge {
            store::load_notes(vault)?
        } else {
            NoteData::default()
        };
        store::save_files(
            vault,
            &crate::model::merge_file_data(current_files, payload.file_data.clone()),
        )?;
        store::save_notes(
            vault,
            &crate::model::merge_note_data(current_notes, payload.note_data.clone()),
        )?;
        if let Some(remote_qr) = payload.qr_history.clone() {
            let current_qr = if merge {
                store::load_qr_history(vault)?
            } else {
                QrHistoryData::default()
            };
            store::save_qr_history(
                vault,
                &crate::model::merge_qr_history(current_qr, remote_qr),
            )?;
        }
        for (hash, b64) in &payload.icons {
            let bytes = B64
                .decode(b64)
                .map_err(|_| AppError::Invalid("备份图标编码无效".into()))?;
            store::save_icon(vault, hash, &bytes)?;
        }
        if let Some(mut locker) = payload.locker_data.clone() {
            for entry in &mut locker.entries {
                let bytes = B64
                    .decode(
                        payload
                            .locker_content_keys
                            .get(&entry.id)
                            .ok_or_else(|| AppError::Invalid("备份缺少寄存文件内容密钥".into()))?,
                    )
                    .map_err(|_| AppError::Invalid("寄存文件内容密钥编码无效".into()))?;
                let ck = zeroize::Zeroizing::new(
                    <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| AppError::Crypto)?,
                );
                entry.wrap_self = crate::locker::wrap_content_key(vault, &ck)?;
            }
            let current = if merge {
                store::load_locker(vault)?
            } else {
                LockerData::default()
            };
            store::save_locker(vault, &crate::model::merge_locker_data(current, locker))?;
        }

        // 2. 恢复 keys
        for key in payload.data.keys {
            if let Some(existing) = current_data.keys.iter_mut().find(|k| k.id == key.id) {
                *existing = key;
            } else {
                current_data.keys.push(key);
            }
        }

        // 3. 恢复 identities
        for ident in payload.data.identities {
            if let Some(existing) = current_data
                .identities
                .iter_mut()
                .find(|i| i.id == ident.id)
            {
                *existing = ident;
            } else {
                current_data.identities.push(ident);
            }
        }

        // 4. 恢复 repos
        for repo in payload.data.repos {
            if let Some(existing) = current_data.repos.iter_mut().find(|r| r.id == repo.id) {
                *existing = repo;
            } else {
                current_data.repos.push(repo);
            }
        }

        // 5. 恢复 clone_history
        for (k, v) in payload.data.clone_history {
            current_data.clone_history.insert(k, v);
        }

        crate::sys::portableize_vault_data(&mut current_data);
        let machine_id = crate::app_config::AppConfig::current_machine_id();
        for repo in &mut current_data.repos {
            repo.machine_id = machine_id.clone();
        }
        store::save_data(vault, &current_data)?;

        // Deployment is an explicit post-restore operation. A backup import must not
        // export plaintext keys or partially rewrite the user's SSH environment.
        let mut restored = summary;
        restored.identity_count = current_data.identities.len();
        restored.key_count = current_data.keys.len();
        restored.repo_count = current_data.repos.len();
        restored.has_github_pat = current_secrets.github_pat.is_some();
        Ok(restored)
    })
}

pub fn summarize(payload: &BackupPayload) -> BackupSummary {
    BackupSummary {
        workspace_id: payload.workspace_id.clone(),
        created_at: payload.created_at.clone(),
        identity_count: payload.data.identities.len(),
        key_count: payload.data.keys.len(),
        repo_count: payload.data.repos.len(),
        has_github_pat: payload.secrets.github_pat.is_some(),
        account_count: payload.account_data.entries.len(),
        totp_count: payload.totp_data.entries.len(),
        file_count: payload.file_data.entries.len(),
        note_count: payload.note_data.entries.len(),
        blob_count: payload.blobs.len(),
        locker_count: payload.locker_data.as_ref().map_or(0, |d| d.entries.len()),
        complete: true,
        locker_remote_files_included: false,
    }
}

fn validate_payload(payload: &BackupPayload) -> Result<()> {
    use sha2::{Digest, Sha256};
    if !(1..=2).contains(&payload.version) {
        return Err(AppError::Invalid("不支持的备份版本".into()));
    }
    store::validate_secret_references(&payload.secrets, &payload.totp_data, &payload.account_data)?;
    for key in &payload.data.keys {
        let bytes = payload
            .private_keys
            .get(&key.id)
            .ok_or_else(|| AppError::Invalid(format!("备份缺少私钥 {}", key.id)))?;
        B64.decode(bytes)
            .map_err(|_| AppError::Invalid("备份私钥编码损坏".into()))?;
    }
    for hash in collect_blob_hashes_all(
        &payload.file_data,
        &payload.note_data,
        &payload.account_data,
    ) {
        let b64 = payload
            .blobs
            .get(&hash)
            .ok_or_else(|| AppError::Invalid(format!("备份不完整：缺少附件 {hash}")))?;
        let bytes = B64
            .decode(b64)
            .map_err(|_| AppError::Invalid("备份附件编码损坏".into()))?;
        let got = format!("{:x}", Sha256::digest(&bytes));
        if got != hash {
            return Err(AppError::Invalid("备份附件摘要不匹配".into()));
        }
    }
    if let Some(locker) = &payload.locker_data {
        for entry in &locker.entries {
            let key = payload
                .locker_content_keys
                .get(&entry.id)
                .ok_or_else(|| AppError::Invalid("备份缺少寄存内容密钥".into()))?;
            if B64.decode(key).map_err(|_| AppError::Crypto)?.len() != 32 {
                return Err(AppError::Crypto);
            }
        }
    }
    for bytes in payload.icons.values() {
        B64.decode(bytes)
            .map_err(|_| AppError::Invalid("备份图标编码损坏".into()))?;
    }
    Ok(())
}

/// 把恢复或拉取的密钥写入工作空间 `ssh-keys/` 并收紧 ACL
pub fn deploy_key_to_workspace(vault: &Vault, key: &KeyRecord, _priv_bytes: &[u8]) -> Result<()> {
    crate::commands::write::deploy_openssh_files(vault, key, "", false).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::KeyRecord;
    use std::path::PathBuf;

    fn test_vault() -> (Vault, PathBuf) {
        let dir = std::env::temp_dir().join(format!("gam-test-backup-{}", uuid::Uuid::new_v4()));
        let kdf = KdfParams::new(crate::vault::kdf::MEM_FLOOR_KIB, 2, 1);
        let (v, _) = Vault::init(&dir, "testpass123", kdf).unwrap();
        (v, dir)
    }

    #[test]
    fn export_rejects_corrupt_metadata_without_creating_backup() {
        let (vault, root) = test_vault();
        std::fs::write(root.join("data/accounts.enc"), b"corrupt ciphertext").unwrap();
        store::invalidate_plaintext_cache();
        let output = root.join("bad.gambackup");
        assert!(export_backup(&vault, &output, "backup-test-password").is_err());
        assert!(!output.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incomplete_backup_payload_is_rejected_before_import() {
        let payload: BackupPayload = serde_json::from_value(serde_json::json!({
            "version": 2, "workspace_id": "test", "created_at": "2026-11-15",
            "data": VaultData::default(), "secrets": Secrets::default(), "private_keys": {},
            "account_data": { "groups": [], "entries": [{
                "id": "a", "platform": "example", "username": "user", "tags": [],
                "pinned": false, "sortOrder": 0, "createdAt": "now", "updatedAt": "now"
            }] }
        }))
        .unwrap();
        assert!(validate_payload(&payload).is_err());
    }

    #[test]
    fn orphan_secrets_reject_missing_containers_but_tombstones_and_legacy_empty_are_valid() {
        let mut payload: BackupPayload = serde_json::from_value(serde_json::json!({
            "version": 1, "workspace_id": "legacy", "created_at": "2026-11-15",
            "data": VaultData::default(), "secrets": Secrets::default(), "private_keys": {}
        }))
        .unwrap();
        // Before TOTP/accounts existed, genuinely empty legacy containers were omitted.
        assert!(validate_payload(&payload).is_ok());
        payload.secrets.account_secrets.insert(
            "account-a".into(),
            crate::model::AccountSecret {
                password: "synthetic-password".into(),
                ..Default::default()
            },
        );
        assert!(validate_payload(&payload).is_err());
        payload
            .account_data
            .deleted_entries
            .insert("account-a".into(), "deleted".into());
        assert!(
            validate_payload(&payload).is_ok(),
            "a pending-GC secret with an explicit deletion tombstone is legitimate"
        );
        payload
            .secrets
            .totp_seeds
            .insert("totp-a".into(), "JBSWY3DPEHPK3PXP".into());
        assert!(validate_payload(&payload).is_err());
        payload
            .totp_data
            .deleted_entries
            .insert("totp-a".into(), "deleted".into());
        assert!(validate_payload(&payload).is_ok());
    }

    #[test]
    fn test_export_and_import_roundtrip() {
        let (vault, dir1) = test_vault();
        let mut data = store::load_data(&vault).unwrap();
        data.keys.push(KeyRecord {
            id: "key-1".into(),
            name: "id_ed25519".into(),
            algorithm: "ed25519".into(),
            fingerprint: "SHA256:test".into(),
            public_openssh: "ssh-ed25519 AAA... test".into(),
            bits: Some(256),
            has_passphrase: false,
            weak: false,
            source_path: None,
            deployed_path: None,
            imported_at: "2026-09-09".into(),
            purpose_intent: String::new(),
        });
        store::save_data(&vault, &data).unwrap();
        store::save_key(&vault, "key-1", b"fake-private-key").unwrap();

        let backup_dir =
            std::env::temp_dir().join(format!("gam-test-dest-{}", uuid::Uuid::new_v4()));
        let backup_file = backup_dir.join("backup.gambackup");

        // 导出
        let summary = export_backup(&vault, &backup_file, "backup-password-123").unwrap();
        assert_eq!(summary.key_count, 1);
        assert!(backup_file.exists());

        // 查看
        let inspected = inspect_backup(&backup_file, "backup-password-123").unwrap();
        assert_eq!(inspected.data.keys.len(), 1);
        assert_eq!(
            inspected.private_keys.get("key-1").unwrap(),
            &B64.encode(b"fake-private-key")
        );

        // 错误密码拒绝
        assert!(inspect_backup(&backup_file, "wrong-password").is_err());

        // 导入到全新 vault
        let (vault2, dir2) = test_vault();
        let import_summary =
            import_backup(&vault2, &backup_file, "backup-password-123", false).unwrap();
        assert_eq!(import_summary.key_count, 1);

        let data2 = store::load_data(&vault2).unwrap();
        assert_eq!(data2.keys.len(), 1);
        assert_eq!(data2.keys[0].name, "id_ed25519");
        assert_eq!(
            store::load_key(&vault2, "key-1").unwrap(),
            b"fake-private-key"
        );

        let _ = std::fs::remove_dir_all(&dir1);
        let _ = std::fs::remove_dir_all(&dir2);
        let _ = std::fs::remove_dir_all(&backup_dir);
    }
}
