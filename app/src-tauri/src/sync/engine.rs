//! 端到端加密云端同步引擎（v1.1）
//!
//! 核心原则：
//! 1. 零知识端到端加密：云端永远只能看到经过 XChaCha20-Poly1305 加密的密文与 HMAC 随机化散列的对象名。
//! 2. 身份、密钥文件名、用户名、仓库地址等一律不出现在云端。
//! 3. 事务性原子提交："先传加密对象，后写 manifest" 保证网络异常时不损坏已有快照。
//! 4. SSH 分两层：本机 `ssh/config` 展开成当前工作空间绝对路径给 OpenSSH；
//!    云端 / 快照 / 比对只存 `%GAM_WORKSPACE%/ssh-keys/...`。换机重写不得原样上传。

use crate::error::{AppError, Result};
use crate::model::{
    collect_blob_hashes, collect_blob_hashes_all, collect_note_body_hashes, AccountData, FileData,
    LockerData, NoteData, QrHistoryData, Secrets, TotpData, VaultData,
};
use crate::store;
use crate::store::blob;
use crate::sync::backup::deploy_key_to_workspace;
use crate::sync::s3::S3Client;
use crate::vault::crypto::{self, KEY_LEN, LABEL_SYNC_OBJECT, XNONCE_LEN};
use crate::vault::envelope;
use crate::vault::header::VaultHeader;
use crate::vault::recovery;
use crate::vault::Vault;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// 始终保留的最近快照份数。
pub const MAX_RECENT_SNAPSHOTS: usize = 10;
/// 额外保留「每天第一份」的天数（含今天）。
pub const DAILY_SNAPSHOT_DAYS: i64 = 14;
const HISTORY_INDEX_KEY: &str = "history/index.enc";

/// 云端 manifest 文件名
const MANIFEST_FILE_KEY: &str = "manifest.enc";
/// 工作空间头部（仅信封，无明文机密）。固定路径，换机时尚无 MK，不能走 HMAC 对象名。
pub const VAULT_HEADER_KEY: &str = "vault-header.json";

/// 大 blob 上传/下载范围。即时发布只带正文，附件走周期或手动同步。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobSyncScope {
    All,
    NoteBodiesOnly,
    None,
}

/// 大对象传输进度（复用更新下载的事件模式）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobSyncProgress {
    pub phase: String,
    pub current: usize,
    pub total: usize,
}

/// 按触发源与护栏决定本次是否带附件 blob。
pub fn resolve_blob_scope(
    trigger: &str,
    wifi_only: bool,
    manual_only: bool,
    unmetered: bool,
) -> BlobSyncScope {
    match trigger {
        "edit" => BlobSyncScope::NoteBodiesOnly,
        "periodic" | "startup" => {
            if manual_only || (wifi_only && !unmetered) {
                BlobSyncScope::NoteBodiesOnly
            } else {
                BlobSyncScope::All
            }
        }
        _ => BlobSyncScope::All,
    }
}

pub(crate) fn blob_hashes_for_scope(
    files: &FileData,
    notes: &NoteData,
    accounts: &AccountData,
    scope: BlobSyncScope,
) -> HashSet<String> {
    match scope {
        BlobSyncScope::All => collect_blob_hashes_all(files, notes, accounts),
        BlobSyncScope::NoteBodiesOnly => collect_note_body_hashes(notes),
        BlobSyncScope::None => HashSet::new(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CloudVaultHeader {
    pub version: u32,
    pub header: VaultHeader,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRestorePreview {
    pub workspace_id: String,
    pub updated_at: Option<String>,
    pub identity_count: usize,
    pub key_count: usize,
    pub repo_count: usize,
    pub has_manifest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncManifest {
    pub version: u32,
    #[serde(default)]
    pub generation: u64,
    pub workspace_id: String,
    pub updated_at: String,
    pub client_name: String,
    /// 逻辑路径（如 "data/identities.json", "keys/k1.key"） -> 对象条目
    pub objects: HashMap<String, SyncObjectEntry>,
    #[serde(default)]
    pub header_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncObjectEntry {
    /// 云端散列对象名（HMAC-SHA256 结果）
    pub object_name: String,
    /// 明文 SHA256，用于快速对比一致性
    pub sha256: String,
    pub size: usize,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize)]
struct CommittedManifest {
    format: String,
    header: VaultHeader,
    ciphertext: String,
}

fn decode_manifest_bytes(key: &[u8; KEY_LEN], raw: &[u8]) -> Result<SyncManifest> {
    let (ciphertext, header_hash) =
        if let Ok(wrapper) = serde_json::from_slice::<CommittedManifest>(raw) {
            if wrapper.format != "gkm-sync-v2" {
                return Err(AppError::Invalid("未知同步提交格式".into()));
            }
            let hash = sha256_hex(&serde_json::to_vec(&wrapper.header)?);
            (
                B64.decode(&wrapper.ciphertext)
                    .map_err(|_| AppError::Crypto)?,
                Some(hash),
            )
        } else {
            (raw.to_vec(), None)
        };
    let plain = zeroize::Zeroizing::new(decrypt_payload(key, &ciphertext)?);
    let manifest: SyncManifest = serde_json::from_slice(&plain)?;
    if manifest.header_sha256 != header_hash {
        return Err(AppError::Invalid("恢复头部与同步提交不匹配".into()));
    }
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn manifest_anchor(manifest: &SyncManifest) -> Result<store::SyncAnchor> {
    // Explicit ordering is independent of serde_json's optional preserve_order feature.
    let objects: std::collections::BTreeMap<_, _> = manifest.objects.iter().collect();
    let canonical = serde_json::to_vec(&(
        manifest.version,
        manifest.generation,
        &manifest.workspace_id,
        &manifest.updated_at,
        &manifest.client_name,
        &manifest.header_sha256,
        objects,
    ))?;
    Ok(store::SyncAnchor {
        protocol: manifest.version,
        generation: manifest.generation,
        digest: sha256_hex(&canonical),
    })
}

fn verify_manifest_anchor(
    previous: Option<&store::SyncAnchor>,
    current: &store::SyncAnchor,
) -> Result<()> {
    if current.protocol >= 2 && current.generation == 0 {
        return Err(AppError::Invalid("同步提交代次无效".into()));
    }
    let Some(previous) = previous else {
        return Ok(());
    };
    if previous.protocol >= 2 {
        if current.protocol < 2 || current.generation < previous.generation {
            return Err(AppError::Invalid(
                "检测到云端回放旧同步版本，已保留本地数据并拒绝回退".into(),
            ));
        }
        if current.generation == previous.generation && current.digest != previous.digest {
            return Err(AppError::Invalid(
                "检测到相同代次的不同云端提交，可能存在多端分叉；已停止自动覆盖".into(),
            ));
        }
    }
    Ok(())
}

fn check_local_anchor(vault: &Vault, s3: &S3Client, manifest: &SyncManifest) -> Result<()> {
    if vault.root().as_os_str().is_empty() {
        return Ok(());
    } // first-device recovery preview
    verify_manifest_anchor(
        store::load_sync_anchor(vault, &s3.sync_scope_id())?.as_ref(),
        &manifest_anchor(manifest)?,
    )
}

/// 云同步状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncStatus {
    pub remote_exists: bool,
    pub remote_updated_at: Option<String>,
    pub remote_workspace_id: Option<String>,
    pub local_identity_count: usize,
    pub local_key_count: usize,
    pub local_repo_count: usize,
    pub status: String, // "synced" | "local_ahead" | "remote_ahead" | "not_synced" | "different_workspace"
    /// 云端是否已有换机恢复所需的工作空间头部。
    #[serde(default)]
    pub header_ready: bool,
}

/// 同步执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub synced_at: String,
    pub objects_transferred: usize,
    pub identity_count: usize,
    pub key_count: usize,
    pub repo_count: usize,
    pub message: String,
}

fn iso_now() -> String {
    let now = time::OffsetDateTime::now_utc();
    let format = time::format_description::well_known::Rfc3339;
    now.format(&format).unwrap_or_else(|_| "unknown".into())
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let mut s = String::with_capacity(64);
    for b in hasher.finalize() {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// 对称加密：nonce || ciphertext
fn encrypt_payload(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<Vec<u8>> {
    let nonce = crypto::new_nonce();
    let ct = crypto::aead_encrypt(key, &nonce, plaintext)?;
    let mut out = Vec::with_capacity(XNONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 对称解密
fn decrypt_payload(key: &[u8; KEY_LEN], data: &[u8]) -> Result<Vec<u8>> {
    if data.len() < XNONCE_LEN {
        return Err(AppError::Crypto);
    }
    let (n, ct) = data.split_at(XNONCE_LEN);
    let mut nonce = [0u8; XNONCE_LEN];
    nonce.copy_from_slice(n);
    crypto::aead_decrypt(key, &nonce, ct)
}

/// 读取并解密云端 manifest
pub fn fetch_remote_manifest(vault: &Vault, s3: &S3Client) -> Result<Option<SyncManifest>> {
    let key = zeroize::Zeroizing::new(vault.subkey(LABEL_SYNC_OBJECT)?);
    let manifest = fetch_remote_manifest_with_key(&key, s3)?;
    if let Some(manifest) = &manifest {
        check_local_anchor(vault, s3, manifest)?;
    } else if !vault.root().as_os_str().is_empty()
        && store::load_sync_anchor(vault, &s3.sync_scope_id())?.is_some_and(|a| a.protocol >= 2)
    {
        return Err(AppError::Invalid(
            "已验证的云端提交消失，已停止自动同步".into(),
        ));
    }
    Ok(manifest)
}

fn fetch_remote_manifest_with_key(
    key: &[u8; KEY_LEN],
    s3: &S3Client,
) -> Result<Option<SyncManifest>> {
    let raw = match s3.get_object(MANIFEST_FILE_KEY)? {
        Some(b) => b,
        None => return Ok(None),
    };

    let manifest = decode_manifest_bytes(key, &raw)?;
    Ok(Some(manifest))
}

fn fetch_remote_vault_data_with(
    s3: &S3Client,
    enc_key: &[u8; KEY_LEN],
    manifest: &SyncManifest,
) -> Result<Option<VaultData>> {
    fetch_remote_json(s3, enc_key, manifest, "data/identities.json", "身份数据")
}

fn decode_versioned_manifest(
    vault: &Vault,
    s3: &S3Client,
) -> Result<Option<(SyncManifest, String)>> {
    let Some((raw, etag)) = s3.get_object_versioned(MANIFEST_FILE_KEY)? else {
        if store::load_sync_anchor(vault, &s3.sync_scope_id())?.is_some_and(|a| a.protocol >= 2) {
            return Err(AppError::Invalid(
                "已验证的云端同步提交消失，拒绝当作空库覆盖；请检查存储权限或从独立备份恢复".into(),
            ));
        }
        return Ok(None);
    };
    let key = zeroize::Zeroizing::new(vault.subkey(LABEL_SYNC_OBJECT)?);
    let manifest = decode_manifest_bytes(&key, &raw)?;
    if manifest.workspace_id != vault.workspace_id() {
        return Err(AppError::Invalid("云端工作空间不一致，拒绝覆盖".into()));
    }
    validate_manifest(&manifest)?;
    check_local_anchor(vault, s3, &manifest)?;
    Ok(Some((manifest, etag)))
}

fn validate_manifest(manifest: &SyncManifest) -> Result<()> {
    if !(1..=2).contains(&manifest.version) {
        return Err(AppError::Invalid(
            "不支持的同步清单版本，请更新客户端".into(),
        ));
    }
    for entry in manifest.objects.values() {
        if !blob::is_sha256_hex(&entry.object_name) || !blob::is_sha256_hex(&entry.sha256) {
            return Err(AppError::Invalid("同步对象标识无效".into()));
        }
    }
    for required in ["data/identities.json", "data/secrets.json"] {
        if !manifest.objects.contains_key(required) {
            return Err(AppError::Invalid(format!(
                "同步清单缺少必要数据：{required}"
            )));
        }
    }
    if manifest.version >= 2 {
        for required in [
            "data/totp.json",
            "data/accounts.json",
            "data/files.json",
            "data/notes.json",
            "data/qr-history.json",
            "data/locker.json",
        ] {
            if !manifest.objects.contains_key(required) {
                return Err(AppError::Invalid(format!(
                    "同步提交缺少必要容器：{required}"
                )));
            }
        }
    }
    Ok(())
}

fn verify_sync_object(entry: &SyncObjectEntry, plain: &[u8]) -> Result<()> {
    if entry.size != plain.len() || entry.sha256 != sha256_hex(plain) {
        return Err(AppError::Invalid(
            "云端对象与已认证清单不匹配，已拒绝混代或损坏数据".into(),
        ));
    }
    Ok(())
}

fn fetch_remote_json<T: serde::de::DeserializeOwned>(
    s3: &S3Client,
    enc_key: &[u8; KEY_LEN],
    manifest: &SyncManifest,
    logical_path: &str,
    what: &str,
) -> Result<Option<T>> {
    let Some(entry) = manifest.objects.get(logical_path) else {
        return Ok(None);
    };
    let raw = s3
        .get_object(&format!("obj/{}", entry.object_name))?
        .ok_or_else(|| AppError::Invalid(format!("云端缺少清单引用的{what}")))?;
    let plain = decrypt_payload(enc_key, &raw)?;
    verify_sync_object(entry, &plain)?;
    let data = serde_json::from_slice(&plain)
        .map_err(|e| AppError::Invalid(format!("解析云端{what}失败: {e}")))?;
    Ok(Some(data))
}

fn parse_cloud_vault_header(raw: &[u8]) -> Result<VaultHeader> {
    if let Ok(wrapped) = serde_json::from_slice::<CloudVaultHeader>(raw) {
        return Ok(wrapped.header);
    }
    let header: VaultHeader = serde_json::from_slice(raw)
        .map_err(|e| AppError::Invalid(format!("云端工作空间头部损坏: {e}")))?;
    Ok(header)
}

/// 把本地 vault 头部上传到固定路径，供新设备用恢复密钥解开 MK。
pub fn upload_vault_header(vault: &Vault, s3: &S3Client) -> Result<()> {
    let payload = CloudVaultHeader {
        version: 1,
        header: vault.header().clone(),
    };
    let bytes = serde_json::to_vec(&payload)?;
    s3.put_object(VAULT_HEADER_KEY, &bytes)?;
    match s3.get_object(VAULT_HEADER_KEY)? {
        Some(got) if got == bytes => Ok(()),
        Some(_) => Err(AppError::Invalid(
            "云端换机头部已写入但回读内容不一致，请重试推送".into(),
        )),
        None => Err(AppError::Invalid(
            "云端换机头部上传后无法读回。请检查存储桶权限是否允许读取刚写入的对象".into(),
        )),
    }
}

pub fn vault_header_exists(s3: &S3Client) -> bool {
    fetch_vault_header(s3).is_ok()
}

pub fn fetch_vault_header(s3: &S3Client) -> Result<VaultHeader> {
    if let Some(raw) = s3.get_object(MANIFEST_FILE_KEY)? {
        if let Ok(wrapper) = serde_json::from_slice::<CommittedManifest>(&raw) {
            if wrapper.format != "gkm-sync-v2" {
                return Err(AppError::Invalid("未知同步提交格式".into()));
            }
            return Ok(wrapper.header);
        }
    }
    let raw = s3.get_object(VAULT_HEADER_KEY)?.ok_or_else(|| {
        AppError::Invalid(
            "云端没有工作空间头部，无法用恢复密钥换机还原。请确认旧设备已用本版本成功推送（成功提示应包含「换机恢复头部」），且新设备填写的 Bucket 与路径前缀与旧设备完全一致。"
                .into(),
        )
    })?;
    parse_cloud_vault_header(&raw)
}

fn unlock_header_with_recovery(
    header: &VaultHeader,
    recovery_key: &str,
) -> Result<crypto::MasterKey> {
    let secret = recovery::parse(recovery_key)?;
    envelope::unwrap_with_recovery(&header.envelopes.recovery, &secret)
}

/// 用恢复密钥验证云端头部并预览清单（不落盘）。
pub fn preview_cloud_restore(s3: &S3Client, recovery_key: &str) -> Result<CloudRestorePreview> {
    let header = fetch_vault_header(s3)?;
    let mk = unlock_header_with_recovery(&header, recovery_key)?;
    let workspace_id = header.workspace_id.clone();
    let vault = Vault::from_header_unlocked(header, mk);

    let manifest = fetch_remote_manifest(&vault, s3)?;

    let Some(manifest) = manifest else {
        return Ok(CloudRestorePreview {
            workspace_id,
            updated_at: None,
            identity_count: 0,
            key_count: 0,
            repo_count: 0,
            has_manifest: false,
        });
    };

    let key = zeroize::Zeroizing::new(vault.subkey(LABEL_SYNC_OBJECT)?);
    let data = fetch_remote_vault_data_with(s3, &key, &manifest)?
        .ok_or_else(|| AppError::Invalid("云端缺少身份数据".into()))?;
    let identity_count = data.identities.len();
    let key_count = data.keys.len();
    let repo_count = data.repos.len();

    Ok(CloudRestorePreview {
        workspace_id,
        updated_at: Some(manifest.updated_at),
        identity_count,
        key_count,
        repo_count,
        has_manifest: true,
    })
}

/// 在目标目录重建工作空间并拉取云端数据。
pub fn restore_from_cloud(
    root: &std::path::Path,
    new_password: &str,
    recovery_key: &str,
    s3: &S3Client,
    include_repos: bool,
) -> Result<(Vault, SyncResult)> {
    let header = fetch_vault_header(s3)?;
    let mk = unlock_header_with_recovery(&header, recovery_key)?;
    let mem = Vault::from_header_unlocked(header.clone(), mk.clone());
    if fetch_remote_manifest(&mem, s3)?.is_none() {
        return Err(AppError::Invalid(
            "已用恢复密钥解开云端头部，但尚未找到加密清单。请先在旧设备上完成一次云同步推送。"
                .into(),
        ));
    }

    if root.exists() && std::fs::read_dir(root)?.next().is_some() {
        return Err(AppError::Invalid(
            "恢复目标必须是空目录，现有文件不会被覆盖".into(),
        ));
    }
    let parent = root
        .parent()
        .ok_or_else(|| AppError::Invalid("恢复目录无效".into()))?;
    std::fs::create_dir_all(parent)?;
    let stage = parent.join(format!(".gkm-restore-{}", uuid::Uuid::new_v4()));
    let mut staged = Vault::restore(&stage, header, mk, new_password)?;
    let result = pull_from_cloud_inner(&staged, s3, false, include_repos, BlobSyncScope::All, None)
        .map(|(r, _)| r)
        .map_err(|e| {
            AppError::Invalid(format!(
                "恢复未完成，目标目录未修改；加密暂存位于 {}：{e}",
                stage.display()
            ))
        })?;
    staged.lock();
    if root.exists() {
        std::fs::remove_dir(root)?;
    } // only an empty directory can be removed
    std::fs::rename(&stage, root)?;
    let mut vault = Vault::load(root)?;
    vault.unlock_with_password(new_password)?;
    Ok((vault, result))
}

/// 仅本地资产计数，不访问云端。供页面首屏即时渲染。
pub fn local_sync_status(vault: &Vault, configured: bool) -> Result<CloudSyncStatus> {
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }
    let data = store::load_data(vault)?;
    let machine_id = crate::app_config::AppConfig::current_machine_id();
    Ok(CloudSyncStatus {
        remote_exists: false,
        remote_updated_at: None,
        remote_workspace_id: None,
        local_identity_count: data.identities.len(),
        local_key_count: data.keys.len(),
        local_repo_count: data
            .repos
            .iter()
            .filter(|r| r.machine_id == machine_id || r.machine_id.is_empty())
            .count(),
        status: if configured {
            "checking".into()
        } else {
            "unconfigured".into()
        },
        header_ready: false,
    })
}

/// 查询云端与本地同步比对状态（含完整方向判断，可能额外下载身份密文）。
pub fn get_sync_status(vault: &Vault, s3: &S3Client) -> Result<CloudSyncStatus> {
    get_sync_status_inner(vault, s3, false)
}

/// 轻量查询：只拉清单 + 探测头部，不下载身份密文。适合进页后台刷新。
pub fn get_sync_status_lite(vault: &Vault, s3: &S3Client) -> Result<CloudSyncStatus> {
    get_sync_status_inner(vault, s3, true)
}

fn get_sync_status_inner(vault: &Vault, s3: &S3Client, lite: bool) -> Result<CloudSyncStatus> {
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }

    let data = store::load_data(vault)?;
    let machine_id = crate::app_config::AppConfig::current_machine_id();
    let local_identity_count = data.identities.len();
    let local_key_count = data.keys.len();
    let local_repo_count = data
        .repos
        .iter()
        .filter(|r| r.machine_id == machine_id || r.machine_id.is_empty())
        .count();
    let enc_key = zeroize::Zeroizing::new(vault.subkey(LABEL_SYNC_OBJECT)?);

    // 头部探测与清单拉取并行，避免串行两次往返。
    let (header_ready, remote) = std::thread::scope(|scope| {
        let header_h = scope.spawn(|| vault_header_exists(s3));
        let remote_h = scope.spawn(|| fetch_remote_manifest_with_key(&enc_key, s3));
        let header_ready = header_h.join().unwrap_or(false);
        let remote = remote_h.join().unwrap_or(Ok(None));
        (header_ready, remote)
    });

    let remote = match remote {
        Ok(m) => m,
        Err(_) => {
            return Ok(CloudSyncStatus {
                remote_exists: false,
                remote_updated_at: None,
                remote_workspace_id: None,
                local_identity_count,
                local_key_count,
                local_repo_count,
                status: "not_synced".into(),
                header_ready,
            });
        }
    };

    if let Some(m) = remote {
        let is_same_ws = m.workspace_id == vault.workspace_id();
        let status = if !is_same_ws {
            "different_workspace".to_string()
        } else {
            let remote_data = if lite {
                None
            } else {
                fetch_remote_vault_data_with(s3, &enc_key, &m)
                    .ok()
                    .flatten()
            };

            if let Some(remote_data) = remote_data {
                // 构建本地数据在“推送到云端”时产生的预期云端 VaultData 结构：
                // 即：以本地数据为主，将云端其他机器的仓库记录（machine_id != current_machine_id）组合进来。
                let mut projected = crate::sys::vault_data_for_sync(&data);
                let (composed_repos, composed_deleted_repos) =
                    crate::model::compose_cloud_repos(&projected, &remote_data, &machine_id);
                projected.repos = composed_repos;
                projected.deleted_repos = composed_deleted_repos;

                let local_id_json = serde_json::to_vec(&projected)?;
                let local_id_hash = sha256_hex(&local_id_json);
                let remote_id_hash = m
                    .objects
                    .get("data/identities.json")
                    .map(|e| e.sha256.as_str())
                    .unwrap_or_default();

                let local_ssh = ssh_text_for_sync(vault).unwrap_or_default();
                let local_ssh_hash = sha256_hex(local_ssh.as_bytes());
                let remote_ssh_hash = m
                    .objects
                    .get("ssh/config")
                    .map(|e| e.sha256.as_str())
                    .unwrap_or_default();

                let ssh_matched =
                    m.objects.get("ssh/config").is_none() || local_ssh_hash == remote_ssh_hash;

                if local_id_hash == remote_id_hash
                    && ssh_matched
                    && !extra_objects_diverged(vault, &m)?
                {
                    "synced".to_string()
                } else if is_remote_ahead(&data, &remote_data, &machine_id) {
                    "remote_ahead".to_string()
                } else {
                    "local_ahead".to_string()
                }
            } else {
                let local_id_json = serde_json::to_vec(&crate::sys::vault_data_for_sync(&data))?;
                let local_id_hash = sha256_hex(&local_id_json);
                let remote_id_hash = m
                    .objects
                    .get("data/identities.json")
                    .map(|e| e.sha256.as_str())
                    .unwrap_or_default();

                if local_id_hash == remote_id_hash && !extra_objects_diverged(vault, &m)? {
                    "synced".to_string()
                } else {
                    "local_ahead".to_string()
                }
            }
        };

        Ok(CloudSyncStatus {
            remote_exists: true,
            remote_updated_at: Some(m.updated_at),
            remote_workspace_id: Some(m.workspace_id),
            local_identity_count,
            local_key_count,
            local_repo_count,
            status,
            header_ready,
        })
    } else {
        Ok(CloudSyncStatus {
            remote_exists: false,
            remote_updated_at: None,
            remote_workspace_id: None,
            local_identity_count,
            local_key_count,
            local_repo_count,
            status: "not_synced".into(),
            header_ready,
        })
    }
}

fn is_remote_ahead(local: &VaultData, remote: &VaultData, machine_id: &str) -> bool {
    // 1. 远程是否有本地缺失或更新的身份
    for remote_item in &remote.identities {
        if local.deleted_identities.contains_key(&remote_item.id) {
            continue;
        }
        match local.identities.iter().find(|i| i.id == remote_item.id) {
            None => return true,
            Some(local_item) => {
                if crate::model::timestamp_newer_or_eq(
                    &remote_item.updated_at,
                    &local_item.updated_at,
                ) && remote_item.updated_at != local_item.updated_at
                {
                    return true;
                }
            }
        }
    }

    // 2. 远程是否有本地缺失的密钥
    for remote_key in &remote.keys {
        if !local.keys.iter().any(|k| k.id == remote_key.id) {
            return true;
        }
    }

    // 3. 远程是否有本地尚未应用的删除墓碑（身份或本机器仓库）
    for (id, ts) in &remote.deleted_identities {
        if local.identities.iter().any(|i| i.id == *id) {
            return true;
        }
        match local.deleted_identities.get(id) {
            None => return true,
            Some(local_ts) if ts > local_ts => return true,
            _ => {}
        }
    }

    for (id, ts) in &remote.deleted_repos {
        if local
            .repos
            .iter()
            .any(|r| r.id == *id && (r.machine_id == machine_id || r.machine_id.is_empty()))
        {
            return true;
        }
        match local.deleted_repos.get(id) {
            None => return true,
            Some(local_ts) if ts > local_ts => return true,
            _ => {}
        }
    }

    // 4. 远程是否有属于本机器、但本地缺失的仓库登记
    for remote_repo in &remote.repos {
        if remote_repo.machine_id == machine_id {
            if !local.repos.iter().any(|r| r.id == remote_repo.id) {
                return true;
            }
        }
    }

    // 5. 远程是否有本地缺失的 clone_history
    for (k, _) in &remote.clone_history {
        if !local.clone_history.contains_key(k) {
            return true;
        }
    }

    false
}

/// 推送到云端（Push）。手动推送带全部 blob。
pub fn push_to_cloud(vault: &Vault, s3: &S3Client) -> Result<SyncResult> {
    push_to_cloud_with(vault, s3, BlobSyncScope::All, None)
}

/// 按 blob 范围推送。即时发布用 `NoteBodiesOnly`，避免大附件阻塞。
pub fn push_to_cloud_with(
    vault: &Vault,
    s3: &S3Client,
    blob_scope: BlobSyncScope,
    progress: Option<&dyn Fn(BlobSyncProgress)>,
) -> Result<SyncResult> {
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }

    let enc_key = zeroize::Zeroizing::new(vault.subkey(LABEL_SYNC_OBJECT)?);
    let now_str = iso_now();

    let (
        data,
        secrets,
        totp_data,
        account_data,
        file_data,
        note_data,
        qr_history,
        locker_data,
        private_keys,
        icons,
        ssh_config,
    ) = store::transaction(vault, || {
        // 1. 收集本地需同步对象（出机前先去掉本机盘符，避免换机路径互相覆盖）
        let mut data = store::load_data(vault)?;
        let original_keys = data.keys.clone();
        crate::sys::portableize_vault_data(&mut data);
        let machine_id = crate::app_config::AppConfig::current_machine_id();
        let repos_changed = crate::model::claim_unowned_repos(&mut data, &machine_id)
            | crate::model::keep_repos_for_machine(&mut data, &machine_id);
        if data.keys != original_keys || repos_changed {
            store::save_data(vault, &data)?;
        }
        let secrets = store::load_secrets(vault)?;
        let totp_data = store::load_totp(vault)?;
        let account_data = store::load_accounts(vault)?;
        let file_data = store::load_files(vault)?;
        let note_data = store::load_notes(vault)?;
        let qr_history = store::load_qr_history(vault)?;
        let locker_data = store::load_locker(vault)?;
        let private_keys = collect_private_keys(vault, &data)?;
        let icons = collect_icons(vault)?;
        let ssh_config = ssh_text_for_sync(vault);
        Ok((
            data,
            secrets,
            totp_data,
            account_data,
            file_data,
            note_data,
            qr_history,
            locker_data,
            private_keys,
            icons,
            ssh_config,
        ))
    })?;
    let machine_id = crate::app_config::AppConfig::current_machine_id();
    let remote_version = decode_versioned_manifest(vault, s3)?;
    let remote_etag = remote_version.as_ref().map(|(_, etag)| etag.as_str());
    if let Some(etag) = remote_etag {
        let observed =
            std::fs::read_to_string(vault.root().join("sync/remote-revision")).unwrap_or_default();
        if observed != etag {
            return Err(AppError::Invalid(
                "云端已有未合并的版本，请先拉取合并再推送（首次升级也需先同步）".into(),
            ));
        }
    }
    let remote_manifest = remote_version.as_ref().map(|(m, _)| m);
    store::validate_secret_references(&secrets, &totp_data, &account_data)?;

    let mut upload_data = data.clone();
    if let Some(manifest) = &remote_manifest {
        if let Some(remote_data) = fetch_remote_vault_data_with(s3, &enc_key, manifest)? {
            let (repos, deleted_repos) =
                crate::model::compose_cloud_repos(&upload_data, &remote_data, &machine_id);
            upload_data.repos = repos;
            upload_data.deleted_repos = deleted_repos;
        }
    }

    let mut logical_objects: HashMap<String, Vec<u8>> = HashMap::new();

    // (1) 身份与密钥元数据 + 各机器仓库全集（本机只嵌自己的那一份）
    logical_objects.insert(
        "data/identities.json".into(),
        serde_json::to_vec(&upload_data)?,
    );
    // (2) 机密口令
    logical_objects.insert("data/secrets.json".into(), serde_json::to_vec(&secrets)?);
    logical_objects.insert("data/totp.json".into(), serde_json::to_vec(&totp_data)?);
    logical_objects.insert(
        "data/accounts.json".into(),
        serde_json::to_vec(&account_data)?,
    );
    logical_objects.insert("data/files.json".into(), serde_json::to_vec(&file_data)?);
    logical_objects.insert("data/notes.json".into(), serde_json::to_vec(&note_data)?);
    logical_objects.insert(
        "data/qr-history.json".into(),
        serde_json::to_vec(&qr_history)?,
    );
    logical_objects.insert("data/locker.json".into(), serde_json::to_vec(&locker_data)?);
    for (hash, encoded) in &icons {
        let bytes = B64.decode(encoded).map_err(|_| AppError::Crypto)?;
        logical_objects.insert(format!("icons/{hash}.webp"), bytes);
    }
    for (id, encoded) in &private_keys {
        let bytes = B64.decode(encoded).map_err(|_| AppError::Crypto)?;
        logical_objects.insert(format!("keys/{id}.key"), bytes);
    }
    if let Some(portable) = ssh_config {
        if crate::sys::text_has_host_blocks(&portable) {
            logical_objects.insert("ssh/config".into(), portable.into_bytes());
        }
    }

    let mut manifest_objects = HashMap::new();
    let mut transferred_count = 0;

    // 2. 加密并上传每个对象（按 HMAC 散列命名）
    for (logical_path, plain_bytes) in &logical_objects {
        if !vault.is_unlocked() {
            return Err(AppError::Locked);
        }
        // Bind the immutable storage identity to both logical path and content revision.
        let hash = sha256_hex(plain_bytes);
        let obj_name = vault.object_name(&format!("v2:{logical_path}:{hash}"))?;
        let cloud_key = format!("obj/{}", obj_name);

        // 加密
        let encrypted = encrypt_payload(&enc_key, plain_bytes)?;
        s3.put_object(&cloud_key, &encrypted)?;
        transferred_count += 1;

        manifest_objects.insert(
            logical_path.clone(),
            SyncObjectEntry {
                object_name: obj_name,
                sha256: hash,
                size: plain_bytes.len(),
                updated_at: now_str.clone(),
            },
        );
    }

    let needed_blobs = blob_hashes_for_scope(&file_data, &note_data, &account_data, blob_scope);
    let mut live_blobs = if blob_scope == BlobSyncScope::All {
        collect_blob_hashes_all(&file_data, &note_data, &account_data)
    } else {
        needed_blobs.clone()
    };
    if blob_scope == BlobSyncScope::All {
        let index = load_snapshot_index(vault, s3)?;
        live_blobs.extend(snapshot_blob_refs(&index));
    }
    transferred_count += push_blob_objects(
        vault,
        s3,
        &needed_blobs,
        &live_blobs,
        remote_manifest,
        &now_str,
        &mut manifest_objects,
        blob_scope,
        progress,
    )?;

    if !manifest_objects.contains_key("ssh/config") {
        if let Some(prev) = remote_manifest
            .as_ref()
            .and_then(|m| m.objects.get("ssh/config"))
            .cloned()
        {
            manifest_objects.insert("ssh/config".into(), prev);
        }
    }

    // 3. 构建并上传 manifest.enc
    let manifest = SyncManifest {
        version: 2,
        generation: remote_manifest
            .map_or(0, |m| m.generation)
            .checked_add(1)
            .ok_or_else(|| AppError::Invalid("同步代次溢出，已拒绝提交".into()))?,
        workspace_id: vault.workspace_id().to_string(),
        updated_at: now_str.clone(),
        client_name: whoami_string(),
        objects: manifest_objects,
        header_sha256: Some(sha256_hex(&serde_json::to_vec(vault.header())?)),
    };

    let manifest_bytes = serde_json::to_vec(&manifest)?;
    let encrypted_manifest = serde_json::to_vec(&CommittedManifest {
        format: "gkm-sync-v2".into(),
        header: vault.header().clone(),
        ciphertext: B64.encode(encrypt_payload(&enc_key, &manifest_bytes)?),
    })?;
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }
    check_local_anchor(vault, s3, &manifest)?;
    s3.put_object_conditional(MANIFEST_FILE_KEY, &encrypted_manifest, remote_etag)?;
    let (committed_bytes, committed_etag) = s3
        .get_object_versioned(MANIFEST_FILE_KEY)?
        .ok_or_else(|| AppError::Invalid("云端提交结果未知，请先重新同步状态".into()))?;
    if committed_bytes != encrypted_manifest {
        return Err(AppError::Invalid(
            "云端在提交后又发生变化，请重新同步；不要重复覆盖".into(),
        ));
    }
    store::transaction(vault, || {
        check_local_anchor(vault, s3, &manifest)?;
        store::save_sync_revision(vault, &committed_etag)?;
        store::save_sync_anchor(vault, &s3.sync_scope_id(), &manifest_anchor(&manifest)?)
    })?;

    // 4. 保存本地同步快照
    let local_manifest_path = vault.root().join("sync").join(MANIFEST_FILE_KEY);
    crate::vault::atomic_write(&local_manifest_path, &encrypted_manifest)?;

    let history_status =
        match retain_push_snapshot(vault, s3, &now_str, &logical_objects, &manifest) {
            Ok(()) => "历史恢复点已保存".to_string(),
            Err(e) => format!("当前同步已提交，但历史恢复点未保存：{e}；请重试同步以补齐历史备份"),
        };

    Ok(SyncResult {
        synced_at: now_str,
        objects_transferred: transferred_count,
        identity_count: data.identities.len(),
        key_count: data.keys.len(),
        repo_count: data.repos.len(),
        message: format!(
            "已提交 {} 个加密对象及换机恢复头部；{}{}",
            transferred_count,
            history_status,
            if blob_scope == BlobSyncScope::All {
                ""
            } else {
                "；附件未全部同步，请执行完整同步后再用于换机恢复"
            }
        ),
    })
}

/// 从云端拉取并还原到本地（Pull）
pub fn pull_from_cloud(vault: &Vault, s3: &S3Client) -> Result<SyncResult> {
    pull_from_cloud_inner(vault, s3, true, false, BlobSyncScope::All, None).map(|(r, _)| r)
}

pub fn pull_from_cloud_with(
    vault: &Vault,
    s3: &S3Client,
    blob_scope: BlobSyncScope,
    progress: Option<&dyn Fn(BlobSyncProgress)>,
) -> Result<SyncResult> {
    pull_from_cloud_inner(vault, s3, true, false, blob_scope, progress).map(|(r, _)| r)
}

fn pull_from_cloud_inner(
    vault: &Vault,
    s3: &S3Client,
    apply_remote_ssh: bool,
    adopt_remote_repos: bool,
    blob_scope: BlobSyncScope,
    progress: Option<&dyn Fn(BlobSyncProgress)>,
) -> Result<(SyncResult, bool)> {
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }

    let enc_key = zeroize::Zeroizing::new(vault.subkey(LABEL_SYNC_OBJECT)?);
    let (manifest, remote_etag) = decode_versioned_manifest(vault, s3)?
        .ok_or_else(|| AppError::Invalid("云端尚未存在任何同步备份".into()))?;

    let local_identities_before = store::load_data(vault)?.identities;
    let mut transferred_count = 0;
    let mut remote_data_snap: Option<VaultData> = None;
    let mut remote_secrets_snap: Option<Secrets> = None;
    let mut remote_totp_snap: Option<crate::model::TotpData> = None;
    let mut remote_account_snap: Option<crate::model::AccountData> = None;
    let mut remote_file_snap: Option<FileData> = None;
    let mut remote_note_snap: Option<NoteData> = None;
    let mut remote_qr_snap: Option<QrHistoryData> = None;
    let mut remote_locker_snap: Option<LockerData> = None;
    let mut remote_ssh_snap: Option<String> = None;
    let mut pulled_key_ids: Vec<String> = Vec::new();
    let mut fetched_keys = Vec::new();
    let mut fetched_icons = Vec::new();

    for (logical_path, entry) in &manifest.objects {
        if logical_path.starts_with("blobs/") {
            continue;
        }
        let cloud_key = format!("obj/{}", entry.object_name);
        let raw_enc = match s3.get_object(&cloud_key)? {
            Some(b) => b,
            None => {
                return Err(AppError::Invalid(format!(
                    "云端缺失清单对象 {logical_path}，未修改本地数据"
                )));
            }
        };

        let plain = decrypt_payload(&enc_key, &raw_enc)?;
        verify_sync_object(entry, &plain)?;
        transferred_count += 1;

        if logical_path == "data/identities.json" {
            let remote_data: VaultData = serde_json::from_slice(&plain)
                .map_err(|e| AppError::Invalid(format!("解析云端身份数据失败: {e}")))?;
            remote_data_snap = Some(remote_data);
        } else if logical_path == "data/secrets.json" {
            let remote_secrets: Secrets = serde_json::from_slice(&plain)
                .map_err(|e| AppError::Invalid(format!("解析云端口令数据失败: {e}")))?;
            remote_secrets_snap = Some(remote_secrets);
        } else if logical_path == "data/totp.json" {
            remote_totp_snap = Some(
                serde_json::from_slice(&plain)
                    .map_err(|e| AppError::Invalid(format!("解析云端 TOTP 数据失败: {e}")))?,
            );
        } else if logical_path == "data/accounts.json" {
            remote_account_snap = Some(
                serde_json::from_slice(&plain)
                    .map_err(|e| AppError::Invalid(format!("解析云端账号数据失败: {e}")))?,
            );
        } else if logical_path == "data/files.json" {
            remote_file_snap = Some(
                serde_json::from_slice(&plain)
                    .map_err(|e| AppError::Invalid(format!("解析云端文件保险库数据失败: {e}")))?,
            );
        } else if logical_path == "data/notes.json" {
            remote_note_snap = Some(
                serde_json::from_slice(&plain)
                    .map_err(|e| AppError::Invalid(format!("解析云端备忘录数据失败: {e}")))?,
            );
        } else if logical_path == "data/qr-history.json" {
            remote_qr_snap = Some(
                serde_json::from_slice(&plain)
                    .map_err(|e| AppError::Invalid(format!("解析云端二维码历史失败: {e}")))?,
            );
        } else if logical_path == "data/locker.json" {
            remote_locker_snap = Some(
                serde_json::from_slice(&plain)
                    .map_err(|e| AppError::Invalid(format!("解析云端寄存柜数据失败: {e}")))?,
            );
        } else if let Some(hash) = logical_path
            .strip_prefix("icons/")
            .and_then(|s| s.strip_suffix(".webp"))
        {
            fetched_icons.push((hash.to_owned(), plain));
        } else if logical_path == "ssh/config" {
            remote_ssh_snap = Some(String::from_utf8_lossy(&plain).to_string());
        } else if let Some(key_id) = logical_path
            .strip_prefix("keys/")
            .and_then(|s| s.strip_suffix(".key"))
        {
            fetched_keys.push((key_id.to_owned(), plain));
            pulled_key_ids.push(key_id.to_string());
        }
    }

    if let Some(data) = &remote_data_snap {
        for key in &data.keys {
            if !manifest
                .objects
                .contains_key(&format!("keys/{}.key", key.id))
            {
                return Err(AppError::Invalid(format!("云端快照缺少私钥 {}", key.id)));
            }
        }
    }
    if let Some(secrets) = &remote_secrets_snap {
        if crate::model::secrets_incomplete_for_entries(
            secrets,
            remote_totp_snap.as_ref().unwrap_or(&TotpData::default()),
            remote_account_snap
                .as_ref()
                .unwrap_or(&AccountData::default()),
        ) {
            return Err(AppError::Invalid(
                "云端快照缺少密码或种子，未修改本地数据".into(),
            ));
        }
    }
    transferred_count += pull_missing_blobs(
        vault,
        s3,
        &manifest,
        remote_file_snap.as_ref().unwrap_or(&FileData::default()),
        remote_note_snap.as_ref().unwrap_or(&NoteData::default()),
        remote_account_snap
            .as_ref()
            .unwrap_or(&AccountData::default()),
        blob_scope,
        progress,
    )?;
    let (mut result, need_push, committed_data) = store::transaction(vault, || {
        check_local_anchor(vault, s3, &manifest)?;
        for (id, bytes) in &fetched_keys {
            store::save_key(vault, id, bytes)?;
        }
        for (hash, bytes) in &fetched_icons {
            store::save_icon(vault, hash, bytes)?;
        }
        // 网络往返后再读本地，避免同步期间的删除/编辑被旧快照盖回去。
        let mut current_data = store::load_data(vault)?;
        let machine_id = crate::app_config::AppConfig::current_machine_id();
        crate::model::claim_unowned_repos(&mut current_data, &machine_id);
        if let Some(remote_data) = remote_data_snap.clone() {
            current_data = crate::model::merge_vault_data(current_data, remote_data.clone());
            if adopt_remote_repos {
                crate::model::adopt_repos_as_machine(&mut current_data, &remote_data, &machine_id);
            }
        }
        crate::model::keep_repos_for_machine(&mut current_data, &machine_id);
        crate::sys::portableize_vault_data(&mut current_data);
        let mut current_secrets = store::load_secrets(vault)?;
        let local_totp = store::load_totp(vault)?;
        let local_acc = store::load_accounts(vault)?;
        if let Some(remote_secrets) = &remote_secrets_snap {
            reject_totp_conflicts(
                &current_secrets,
                remote_secrets,
                &local_totp,
                remote_totp_snap.as_ref().unwrap_or(&TotpData::default()),
            )?;
            current_secrets = crate::model::merge_secrets_with_meta(
                current_secrets,
                remote_secrets,
                Some(&local_totp),
                remote_totp_snap.as_ref(),
                Some(&local_acc),
                remote_account_snap.as_ref(),
            );
        }
        let merged_totp = if let Some(remote_totp) = remote_totp_snap.clone() {
            crate::model::merge_totp_data(local_totp.clone(), remote_totp)
        } else {
            local_totp.clone()
        };
        let merged_acc = if let Some(remote_acc) = remote_account_snap.clone() {
            crate::model::merge_account_data(local_acc.clone(), remote_acc)
        } else {
            local_acc.clone()
        };
        let local_files = store::load_files(vault)?;
        let local_notes = store::load_notes(vault)?;
        let merged_files = if let Some(remote_files) = remote_file_snap.clone() {
            crate::model::merge_file_data(local_files, remote_files)
        } else {
            local_files
        };
        let merged_notes = if let Some(remote_notes) = remote_note_snap.clone() {
            crate::model::merge_note_data(local_notes, remote_notes)
        } else {
            local_notes
        };
        let local_qr = store::load_qr_history(vault)?;
        let merged_qr = if let Some(remote_qr) = remote_qr_snap.clone() {
            crate::model::merge_qr_history(local_qr, remote_qr)
        } else {
            local_qr
        };
        let local_locker = store::load_locker(vault)?;
        let merged_locker = if let Some(remote_locker) = remote_locker_snap.clone() {
            crate::model::merge_locker_data(local_locker, remote_locker)
        } else {
            local_locker
        };
        // 云端旧快照会把已删钥匙的口令和密文一起拉下来。墓碑生效后把这两样清掉，避免列表和 ssh-keys/ 又长出来。
        for id in current_data.deleted_keys.keys() {
            current_secrets.key_passphrases.remove(id);
            if store::key_exists(vault, id) {
                store::delete_key(vault, id)?;
            }
        }
        // 先落机密与身份，再写 SSH。~/.ssh 被拒绝写入时不能把已拉下来的身份一起丢掉。
        store::save_secrets(vault, &current_secrets)?;
        store::save_totp(vault, &merged_totp)?;
        store::save_accounts(vault, &merged_acc)?;
        store::save_files(vault, &merged_files)?;
        store::save_notes(vault, &merged_notes)?;
        store::save_qr_history(vault, &merged_qr)?;
        store::save_locker(vault, &merged_locker)?;
        store::save_data(vault, &current_data)?;
        store::save_sync_revision(vault, &remote_etag)?;
        store::save_sync_anchor(vault, &s3.sync_scope_id(), &manifest_anchor(&manifest)?)?;
        let ssh_now = read_ssh_config_bytes(vault).unwrap_or_default();
        let remote_hash = match &remote_data_snap {
            Some(rd) => Some(stable_state_hash(
                &rd,
                remote_secrets_snap.as_ref().unwrap_or(&Secrets::default()),
                remote_ssh_snap.as_deref().unwrap_or(""),
                remote_totp_snap
                    .as_ref()
                    .unwrap_or(&crate::model::TotpData::default()),
                remote_account_snap
                    .as_ref()
                    .unwrap_or(&crate::model::AccountData::default()),
                remote_file_snap.as_ref().unwrap_or(&FileData::default()),
                remote_note_snap.as_ref().unwrap_or(&NoteData::default()),
                remote_qr_snap.as_ref().unwrap_or(&QrHistoryData::default()),
                remote_locker_snap
                    .as_ref()
                    .unwrap_or(&LockerData::default()),
            )),
            None => None,
        };
        let need_push = match remote_hash {
            Some(h) => {
                h != stable_state_hash(
                    &current_data,
                    &current_secrets,
                    &ssh_now,
                    &merged_totp,
                    &merged_acc,
                    &merged_files,
                    &merged_notes,
                    &merged_qr,
                    &merged_locker,
                )
            }
            None => local_has_syncable_assets(vault)?,
        };

        Ok((
            SyncResult {
                // 本次拉取完成的时刻。云端清单 updated_at 只在真正推送时前进，
                // 不能拿它当「这台设备刚刚同步过」的时间。
                synced_at: iso_now(),
                objects_transferred: transferred_count,
                identity_count: current_data.identities.len(),
                key_count: current_data.keys.len(),
                repo_count: current_data.repos.len(),
                message: format!("已成功从云端拉取并同步 {} 个加密对象", transferred_count),
            },
            need_push,
            current_data,
        ))
    })?;
    // External SSH deployment occurs only after the encrypted transaction committed.
    // A cloud restore stage must never point the user's SSH entry at a temporary directory.
    let staging = vault
        .root()
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.starts_with(".gkm-restore-"));
    if !staging && vault.is_unlocked() {
        for key_id in &pulled_key_ids {
            if let (Some(key_rec), Ok(raw)) = (
                committed_data.keys.iter().find(|k| k.id == *key_id),
                store::load_key(vault, key_id),
            ) {
                if let Err(e) = deploy_key_to_workspace(vault, key_rec, &raw) {
                    result.message.push_str(&format!("；SSH 部署未完成：{e}"));
                }
            }
        }

        if let Some(snapshot) = &remote_ssh_snap {
            if let Err(e) = apply_pulled_ssh(
                vault,
                snapshot,
                apply_remote_ssh,
                &local_identities_before,
                remote_data_snap.as_ref(),
                &committed_data,
            ) {
                // 身份/密钥已落盘。SSH 正本失败交给随后的 reconcile 按身份补齐，不能整段拉取报失败。
                result.message.push_str(&format!("；SSH 配置未完成：{e}"));
            }
        }
    }
    Ok((result, need_push))
}

fn whoami_string() -> String {
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".into());
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "pc".into());
    format!("{user}@{host}")
}

fn snapshot_id_from_time(iso: &str) -> String {
    iso.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '.' | '_' | '-' => c,
            _ => '-',
        })
        .collect()
}

fn history_object_key(id: &str) -> String {
    format!("history/{id}.enc")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotIndex {
    pub items: Vec<SnapshotMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub id: String,
    pub created_at: String,
    pub client_name: String,
    pub identity_count: usize,
    pub key_count: usize,
    pub repo_count: usize,
    /// 属于最近 N 份（列出时计算，不入库）。
    #[serde(default)]
    pub is_recent: bool,
    /// 近 14 天内该日第一份（列出时计算，不入库）。
    #[serde(default)]
    pub is_daily_first: bool,
    /// 该快照仍引用的内容寻址 blob，供云端 GC 保活。
    #[serde(default)]
    pub blob_hashes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnapshotPayload {
    pub meta: SnapshotMeta,
    pub data: VaultData,
    pub secrets: Secrets,
    pub private_keys: HashMap<String, String>,
    pub ssh_config: Option<String>,
    #[serde(default)]
    pub totp_data: crate::model::TotpData,
    #[serde(default)]
    pub account_data: crate::model::AccountData,
    #[serde(default)]
    pub icons: HashMap<String, String>,
    #[serde(default)]
    pub file_data: FileData,
    #[serde(default)]
    pub note_data: NoteData,
    /// 旧快照没有这份数据时保持 None，恢复时不拿空列表覆盖本机二维码历史。
    #[serde(default)]
    pub qr_history: Option<QrHistoryData>,
    #[serde(default)]
    pub locker_data: Option<LockerData>,
    #[serde(default)]
    pub note_bodies: HashMap<String, String>,
    #[serde(default)]
    pub blob_hashes: Vec<String>,
}

fn load_snapshot_index(vault: &Vault, s3: &S3Client) -> Result<SnapshotIndex> {
    let enc_key = zeroize::Zeroizing::new(vault.subkey(LABEL_SYNC_OBJECT)?);
    match s3.get_object(HISTORY_INDEX_KEY)? {
        Some(raw) => {
            let plain = decrypt_payload(&enc_key, &raw)
                .map_err(|_| AppError::Invalid("历史快照索引解密失败".into()))?;
            Ok(serde_json::from_slice(&plain)?)
        }
        None => Ok(SnapshotIndex { items: Vec::new() }),
    }
}

fn snapshot_date_key(iso: &str) -> String {
    iso.get(..10).unwrap_or(iso).to_string()
}

fn utc_date_key(dt: time::OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        dt.year(),
        u8::from(dt.month()),
        dt.day()
    )
}

fn daily_cutoff_key(now: time::OffsetDateTime, days: i64) -> String {
    let days = days.max(1);
    let start = now.saturating_sub(time::Duration::days(days - 1));
    utc_date_key(start)
}

fn snapshot_keep_ids(
    items: &[SnapshotMeta],
    now: time::OffsetDateTime,
    recent_keep: usize,
    daily_days: i64,
) -> (
    std::collections::HashSet<String>,
    std::collections::HashSet<String>,
    std::collections::HashSet<String>,
) {
    let mut sorted: Vec<&SnapshotMeta> = items.iter().collect();
    sorted.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    let mut recent = std::collections::HashSet::new();
    for item in sorted.iter().take(recent_keep) {
        recent.insert(item.id.clone());
    }

    let cutoff = daily_cutoff_key(now, daily_days);
    let mut earliest_by_day: HashMap<String, &SnapshotMeta> = HashMap::new();
    for item in items {
        let day = snapshot_date_key(&item.created_at);
        if day < cutoff {
            continue;
        }
        match earliest_by_day.get(&day) {
            Some(prev) if prev.created_at <= item.created_at => {}
            _ => {
                earliest_by_day.insert(day, item);
            }
        }
    }
    let daily: std::collections::HashSet<String> =
        earliest_by_day.values().map(|m| m.id.clone()).collect();

    let keep: std::collections::HashSet<String> = recent.union(&daily).cloned().collect();
    (keep, recent, daily)
}

/// 保留最近 10 份，以及近 14 天每天的第一份；返回被删除的 id。
pub fn prune_snapshot_index(items: &mut Vec<SnapshotMeta>) -> Vec<String> {
    prune_snapshot_index_at(
        items,
        time::OffsetDateTime::now_utc(),
        MAX_RECENT_SNAPSHOTS,
        DAILY_SNAPSHOT_DAYS,
    )
}

pub fn prune_snapshot_index_at(
    items: &mut Vec<SnapshotMeta>,
    now: time::OffsetDateTime,
    recent_keep: usize,
    daily_days: i64,
) -> Vec<String> {
    let (keep, recent, daily) = snapshot_keep_ids(items, now, recent_keep, daily_days);
    let dropped: Vec<String> = items
        .iter()
        .filter(|m| !keep.contains(&m.id))
        .map(|m| m.id.clone())
        .collect();
    items.retain(|m| keep.contains(&m.id));
    for m in items.iter_mut() {
        m.is_recent = recent.contains(&m.id);
        m.is_daily_first = daily.contains(&m.id);
    }
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    dropped
}

fn annotate_snapshot_roles(items: &mut [SnapshotMeta], now: time::OffsetDateTime) {
    let (_keep, recent, daily) =
        snapshot_keep_ids(items, now, MAX_RECENT_SNAPSHOTS, DAILY_SNAPSHOT_DAYS);
    for m in items.iter_mut() {
        m.is_recent = recent.contains(&m.id);
        m.is_daily_first = daily.contains(&m.id);
    }
}

fn collect_private_keys(vault: &Vault, data: &VaultData) -> Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    for key in &data.keys {
        out.insert(key.id.clone(), B64.encode(store::load_key(vault, &key.id)?));
    }
    Ok(out)
}

fn apply_pulled_ssh(
    vault: &Vault,
    remote_ssh: &str,
    apply_remote_ssh: bool,
    local_identities_before: &[crate::model::Identity],
    remote_data: Option<&VaultData>,
    merged: &VaultData,
) -> Result<()> {
    if apply_remote_ssh {
        // persist 会按本机工作空间展开；云端正文本身必须是可移植形态。
        return crate::sys::persist_ssh_config(Some(vault.root()), remote_ssh);
    }
    let local_ssh = read_ssh_config_bytes(vault).unwrap_or_default();
    let local_canonical = crate::sys::canonical_ssh_for_sync(&local_ssh);
    let remote_canonical = crate::sys::canonical_ssh_for_sync(remote_ssh);
    let keep: HashSet<String> = merged
        .identities
        .iter()
        .map(|i| i.host_alias.clone())
        .collect();
    let mut text =
        crate::ssh::managed::merge_managed_prefer_local(&local_canonical, &remote_canonical, &keep);
    let mut drop_aliases = HashSet::new();
    for ident in local_identities_before
        .iter()
        .chain(remote_data.map(|d| d.identities.as_slice()).unwrap_or(&[]))
    {
        if merged.deleted_identities.contains_key(&ident.id) {
            drop_aliases.insert(ident.host_alias.clone());
        }
    }
    for alias in drop_aliases {
        text = crate::ssh::managed::remove(&text, &alias);
    }
    crate::sys::persist_ssh_config(Some(vault.root()), &text)
}

fn read_ssh_config_bytes(vault: &Vault) -> Option<String> {
    let ws = crate::sys::workspace_ssh_config(vault.root());
    if let Ok(t) = std::fs::read_to_string(&ws) {
        return Some(t);
    }
    std::fs::read_to_string(crate::sys::ssh_dir().join("config")).ok()
}

/// 出机 SSH 正文：本机绝对路径先收成占位符，再上传或写入快照。
fn ssh_text_for_sync(vault: &Vault) -> Option<String> {
    read_ssh_config_bytes(vault).map(|text| crate::sys::canonical_ssh_for_sync(&text))
}

/// Preserve both devices when no seed-history UI exists. Tombstoned records do not conflict.
pub(crate) fn reject_totp_conflicts(
    local: &Secrets,
    remote: &Secrets,
    local_data: &TotpData,
    remote_data: &TotpData,
) -> Result<()> {
    for (id, seed) in &local.totp_seeds {
        if local_data.deleted_entries.contains_key(id)
            || remote_data.deleted_entries.contains_key(id)
        {
            continue;
        }
        if remote.totp_seeds.get(id).is_some_and(|other| other != seed)
            && local_data.entries.iter().any(|entry| &entry.id == id)
            && remote_data.entries.iter().any(|entry| &entry.id == id)
        {
            return Err(AppError::Invalid("同一 2FA 条目存在不同种子，已保留两端数据并停止自动合并；请先分别导出备份，再明确保留或另存冲突条目".into()));
        }
    }
    Ok(())
}

fn snapshot_json<T: serde::de::DeserializeOwned>(
    objects: &HashMap<String, Vec<u8>>,
    path: &str,
) -> Result<T> {
    let bytes = objects
        .get(path)
        .ok_or_else(|| AppError::Invalid(format!("同步快照缺少 {path}")))?;
    Ok(serde_json::from_slice(bytes)?)
}

fn retain_push_snapshot(
    vault: &Vault,
    s3: &S3Client,
    now_str: &str,
    objects: &HashMap<String, Vec<u8>>,
    committed_manifest: &SyncManifest,
) -> Result<()> {
    let id = format!(
        "{}-{}",
        snapshot_id_from_time(now_str),
        uuid::Uuid::new_v4()
    );
    let data: VaultData = snapshot_json(objects, "data/identities.json")?;
    let file_data: FileData = snapshot_json(objects, "data/files.json")?;
    let note_data: NoteData = snapshot_json(objects, "data/notes.json")?;
    let account_data: AccountData = snapshot_json(objects, "data/accounts.json")?;
    let blob_hashes: Vec<String> = collect_blob_hashes_all(&file_data, &note_data, &account_data)
        .into_iter()
        .collect();
    if blob_hashes.iter().any(|hash| {
        !committed_manifest
            .objects
            .contains_key(&blob_logical_path(hash))
    }) {
        return Err(AppError::Invalid(
            "附件尚未全部同步，未创建不完整历史恢复点".into(),
        ));
    }
    let meta = SnapshotMeta {
        id: id.clone(),
        created_at: now_str.to_string(),
        client_name: whoami_string(),
        identity_count: data.identities.len(),
        key_count: data.keys.len(),
        repo_count: data.repos.len(),
        is_recent: false,
        is_daily_first: false,
        blob_hashes: blob_hashes.clone(),
    };
    let mut note_bodies = HashMap::new();
    for entry in &note_data.entries {
        let bytes = blob::read_blob_bytes(vault, &entry.body_sha256)?;
        note_bodies.insert(
            entry.id.clone(),
            String::from_utf8(bytes).map_err(|_| AppError::Crypto)?,
        );
    }
    let mut private_keys = HashMap::new();
    let mut icons = HashMap::new();
    for (path, bytes) in objects {
        if let Some(id) = path
            .strip_prefix("keys/")
            .and_then(|p| p.strip_suffix(".key"))
        {
            private_keys.insert(id.to_owned(), B64.encode(bytes));
        }
        if let Some(hash) = path
            .strip_prefix("icons/")
            .and_then(|p| p.strip_suffix(".webp"))
        {
            icons.insert(hash.to_owned(), B64.encode(bytes));
        }
    }
    let payload = SnapshotPayload {
        meta: meta.clone(),
        data,
        secrets: snapshot_json(objects, "data/secrets.json")?,
        private_keys,
        ssh_config: objects
            .get("ssh/config")
            .map(|b| String::from_utf8_lossy(b).into_owned()),
        totp_data: snapshot_json(objects, "data/totp.json")?,
        account_data,
        icons,
        file_data,
        note_data,
        qr_history: Some(snapshot_json(objects, "data/qr-history.json")?),
        locker_data: Some(snapshot_json(objects, "data/locker.json")?),
        note_bodies,
        blob_hashes,
    };
    let enc_key = zeroize::Zeroizing::new(vault.subkey(LABEL_SYNC_OBJECT)?);
    let encrypted = encrypt_payload(&enc_key, &serde_json::to_vec(&payload)?)?;
    s3.put_object(&history_object_key(&id), &encrypted)?;

    let previous = s3.get_object_versioned(HISTORY_INDEX_KEY)?;
    let mut index: SnapshotIndex = match &previous {
        Some((raw, _)) => serde_json::from_slice(&decrypt_payload(&enc_key, raw)?)?,
        None => SnapshotIndex { items: Vec::new() },
    };
    index.items.retain(|m| m.id != id);
    index.items.push(meta);
    // Retention changes only the visible index. Never destroy an immutable recovery
    // object while another reader may still hold an older index.
    prune_snapshot_index(&mut index.items);
    let bytes = encrypt_payload(&enc_key, &serde_json::to_vec(&index)?)?;
    s3.put_object_conditional(
        HISTORY_INDEX_KEY,
        &bytes,
        previous.as_ref().map(|(_, etag)| etag.as_str()),
    )?;
    Ok(())
}

/// 列出云端滚动历史快照（新→旧）。
pub fn list_snapshots(vault: &Vault, s3: &S3Client) -> Result<Vec<SnapshotMeta>> {
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }
    let mut index = load_snapshot_index(vault, s3)?;
    index.items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    annotate_snapshot_roles(&mut index.items, time::OffsetDateTime::now_utc());
    Ok(index.items)
}

/// 用指定历史快照覆盖身份/密钥/口令与 SSH config（仓库记录合并保留本机路径）。
pub fn restore_snapshot(vault: &Vault, s3: &S3Client, snapshot_id: &str) -> Result<SyncResult> {
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }
    let id = snapshot_id.trim();
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(AppError::Invalid("无效的快照编号".into()));
    }
    let enc_key = zeroize::Zeroizing::new(vault.subkey(LABEL_SYNC_OBJECT)?);
    let raw = s3
        .get_object(&history_object_key(id))?
        .ok_or_else(|| AppError::Invalid("云端找不到该历史快照".into()))?;
    let plain = decrypt_payload(&enc_key, &raw)
        .map_err(|_| AppError::Invalid("历史快照解密失败".into()))?;
    let payload: SnapshotPayload = serde_json::from_slice(&plain)?;
    if payload.meta.id != id && payload.meta.created_at != id {
        return Err(AppError::Invalid("快照编号与内容不一致".into()));
    }

    for (id, body) in &payload.note_bodies {
        let expected = payload
            .note_data
            .entries
            .iter()
            .find(|e| &e.id == id)
            .ok_or_else(|| AppError::Invalid("快照笔记正文没有对应记录".into()))?;
        let written = blob::write_blob(vault, std::io::Cursor::new(body.as_bytes()))?;
        if written.sha256 != expected.body_sha256 {
            return Err(AppError::Crypto);
        }
    }
    let manifest = fetch_remote_manifest(vault, s3)?
        .ok_or_else(|| AppError::Invalid("恢复缺少附件清单".into()))?;
    pull_missing_blobs(
        vault,
        s3,
        &manifest,
        &payload.file_data,
        &payload.note_data,
        &payload.account_data,
        BlobSyncScope::All,
        None,
    )?;
    for key in &payload.data.keys {
        if !payload.private_keys.contains_key(&key.id) {
            return Err(AppError::Invalid(format!("历史快照缺少私钥 {}", key.id)));
        }
    }
    if crate::model::secrets_incomplete_for_entries(
        &payload.secrets,
        &payload.totp_data,
        &payload.account_data,
    ) {
        return Err(AppError::Invalid("历史快照缺少密码或 TOTP 种子".into()));
    }
    let checkpoint = store::create_recovery_checkpoint(vault)?;
    store::transaction(vault, || {
        let mut current_repos = store::load_data(vault)?.repos;
        let mut data = payload.data;
        crate::sys::portableize_vault_data(&mut data);
        for repo in data.repos.drain(..) {
            if let Some(existing) = current_repos.iter_mut().find(|r| r.id == repo.id) {
                *existing = repo;
            } else {
                current_repos.push(repo);
            }
        }
        data.repos = current_repos;
        let machine_id = crate::app_config::AppConfig::current_machine_id();
        crate::model::claim_unowned_repos(&mut data, &machine_id);
        crate::model::keep_repos_for_machine(&mut data, &machine_id);

        store::save_data(vault, &data)?;
        store::save_secrets(vault, &payload.secrets)?;
        store::save_totp(vault, &payload.totp_data)?;
        store::save_accounts(vault, &payload.account_data)?;
        store::save_files(vault, &payload.file_data)?;
        store::save_notes(vault, &payload.note_data)?;
        if let Some(qr_history) = &payload.qr_history {
            store::save_qr_history(vault, qr_history)?;
        }
        if let Some(locker) = &payload.locker_data {
            store::save_locker(vault, locker)?;
        }
        for (hash, b64) in &payload.icons {
            let bytes = B64
                .decode(b64)
                .map_err(|_| AppError::Invalid("快照图标编码损坏".into()))?;
            store::save_icon(vault, hash, &bytes)?;
        }
        for (key_id, b64) in &payload.private_keys {
            let bytes = B64
                .decode(b64)
                .map_err(|_| AppError::Invalid("快照私钥编码损坏".into()))?;
            store::save_key(vault, key_id, &bytes)?;
        }
        // SSH deployment is repaired explicitly after restoring the encrypted state.
        let created_at = payload.meta.created_at.clone();
        Ok(SyncResult {
            synced_at: created_at.clone(),
            objects_transferred: 1,
            identity_count: data.identities.len(),
            key_count: data.keys.len(),
            repo_count: data.repos.len(),
            message: format!(
                "已完整验证并从历史快照 {created_at} 恢复；恢复前加密副本：{}；SSH 部署可在身份页重新应用", checkpoint.display()
            ),
        })
    })
}

fn blob_logical_path(sha: &str) -> String {
    format!("blobs/{sha}")
}

pub(crate) fn should_skip_blob_upload(remote: Option<&SyncManifest>, sha: &str) -> bool {
    remote
        .and_then(|m| m.objects.get(&blob_logical_path(sha)))
        .is_some_and(|e| e.sha256 == sha)
}

fn snapshot_blob_refs(index: &SnapshotIndex) -> HashSet<String> {
    let mut set = HashSet::new();
    for item in &index.items {
        for h in &item.blob_hashes {
            if !h.is_empty() {
                set.insert(h.clone());
            }
        }
    }
    set
}

fn push_blob_objects(
    vault: &Vault,
    s3: &S3Client,
    needed: &HashSet<String>,
    live: &HashSet<String>,
    remote: Option<&SyncManifest>,
    now_str: &str,
    manifest_objects: &mut HashMap<String, SyncObjectEntry>,
    scope: BlobSyncScope,
    progress: Option<&dyn Fn(BlobSyncProgress)>,
) -> Result<usize> {
    if scope != BlobSyncScope::All {
        if let Some(remote) = remote {
            for (logical, entry) in &remote.objects {
                if logical.starts_with("blobs/") {
                    manifest_objects
                        .entry(logical.clone())
                        .or_insert_with(|| entry.clone());
                }
            }
        }
        if scope == BlobSyncScope::None {
            return Ok(0);
        }
    }

    let upload_set: HashSet<String> = match scope {
        BlobSyncScope::All => live.iter().cloned().collect(),
        BlobSyncScope::NoteBodiesOnly => needed.iter().cloned().collect(),
        BlobSyncScope::None => HashSet::new(),
    };
    let pending: Vec<String> = upload_set
        .iter()
        .filter(|sha| !should_skip_blob_upload(remote, sha) && blob::blob_exists(vault, sha))
        .cloned()
        .collect();
    let total = pending.len();
    let mut transferred = 0usize;

    for sha in &upload_set {
        let logical = blob_logical_path(sha);
        if should_skip_blob_upload(remote, sha) {
            if let Some(prev) = remote.and_then(|m| m.objects.get(&logical)).cloned() {
                manifest_objects.insert(logical, prev);
            }
            continue;
        }
        if blob::blob_exists(vault, sha) {
            if let Some(cb) = progress {
                cb(BlobSyncProgress {
                    phase: "upload".into(),
                    current: transferred + 1,
                    total,
                });
            }
            let path = blob::blob_path(vault, sha);
            blob::verify_blob_ciphertext(vault, &path, sha)?;
            let obj_name = vault.object_name(&logical)?;
            s3.put_object_file(&format!("obj/{obj_name}"), &path)?;
            transferred += 1;
            manifest_objects.insert(
                logical,
                SyncObjectEntry {
                    object_name: obj_name,
                    sha256: sha.clone(),
                    size: blob::blob_ciphertext_len(vault, sha).unwrap_or(0) as usize,
                    updated_at: now_str.to_string(),
                },
            );
        } else if let Some(prev) = remote.and_then(|m| m.objects.get(&logical)).cloned() {
            manifest_objects.insert(logical, prev);
        } else if needed.contains(sha) {
            return Err(AppError::Invalid(format!(
                "本地缺少附件 {sha}，已阻止不完整同步"
            )));
        }
    }
    // Physical GC is intentionally separate from synchronization. Keep older immutable
    // references until a dedicated retention job can prove no snapshot/client needs them.
    if let Some(remote) = remote {
        for (logical, entry) in &remote.objects {
            if logical.starts_with("blobs/") {
                manifest_objects
                    .entry(logical.clone())
                    .or_insert_with(|| entry.clone());
            }
        }
    }
    Ok(transferred)
}

fn pull_missing_blobs(
    vault: &Vault,
    s3: &S3Client,
    manifest: &SyncManifest,
    files: &FileData,
    notes: &NoteData,
    accounts: &AccountData,
    scope: BlobSyncScope,
    progress: Option<&dyn Fn(BlobSyncProgress)>,
) -> Result<usize> {
    let wanted = blob_hashes_for_scope(files, notes, accounts, scope);
    let total = wanted.len();
    let mut transferred = 0;
    for sha in wanted {
        if !vault.is_unlocked() {
            return Err(AppError::Locked);
        }
        if !blob::is_sha256_hex(&sha) {
            return Err(AppError::Invalid("云端附件标识无效".into()));
        }
        if blob::blob_exists(vault, &sha) {
            blob::read_blob(vault, &sha, std::io::sink())?;
            continue;
        }
        let entry = manifest
            .objects
            .get(&blob_logical_path(&sha))
            .ok_or_else(|| AppError::Invalid(format!("云端快照缺少附件 {sha}，未修改现用数据")))?;
        if entry.sha256 != sha {
            return Err(AppError::Crypto);
        }
        if let Some(cb) = progress {
            cb(BlobSyncProgress {
                phase: "download".into(),
                current: transferred + 1,
                total,
            });
        }
        let dir = blob::blobs_dir(vault);
        std::fs::create_dir_all(&dir)?;
        let tmp = dir.join(format!(".download-{}", uuid::Uuid::new_v4()));
        let installed = (|| -> Result<()> {
            if !s3.get_object_to_file(&format!("obj/{}", entry.object_name), &tmp)? {
                return Err(AppError::Invalid(format!("云端附件 {sha} 不存在")));
            }
            if std::fs::metadata(&tmp)?.len() != entry.size as u64 {
                return Err(AppError::Crypto);
            }
            blob::verify_blob_ciphertext(vault, &tmp, &sha)?;
            if !vault.is_unlocked() {
                return Err(AppError::Locked);
            }
            std::fs::rename(&tmp, blob::blob_path(vault, &sha))?;
            Ok(())
        })();
        if installed.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        installed?;
        transferred += 1;
    }
    Ok(transferred)
}

fn extra_objects_diverged(vault: &Vault, manifest: &SyncManifest) -> Result<bool> {
    let totp = store::load_totp(vault)?;
    let accounts = store::load_accounts(vault)?;
    let files = store::load_files(vault)?;
    let notes = store::load_notes(vault)?;
    let qr_history = store::load_qr_history(vault)?;
    let totp_hash = sha256_hex(&serde_json::to_vec(&totp).unwrap_or_default());
    let acc_hash = sha256_hex(&serde_json::to_vec(&accounts).unwrap_or_default());
    let files_hash = sha256_hex(&serde_json::to_vec(&files).unwrap_or_default());
    let notes_hash = sha256_hex(&serde_json::to_vec(&notes).unwrap_or_default());
    let qr_hash = sha256_hex(&serde_json::to_vec(&qr_history).unwrap_or_default());
    let remote_totp = manifest
        .objects
        .get("data/totp.json")
        .map(|e| e.sha256.as_str())
        .unwrap_or("");
    let remote_acc = manifest
        .objects
        .get("data/accounts.json")
        .map(|e| e.sha256.as_str())
        .unwrap_or("");
    let remote_files = manifest
        .objects
        .get("data/files.json")
        .map(|e| e.sha256.as_str())
        .unwrap_or("");
    let remote_notes = manifest
        .objects
        .get("data/notes.json")
        .map(|e| e.sha256.as_str())
        .unwrap_or("");
    let remote_qr = manifest
        .objects
        .get("data/qr-history.json")
        .map(|e| e.sha256.as_str())
        .unwrap_or("");
    let qr_nonempty = !qr_history.scans.is_empty()
        || !qr_history.generations.is_empty()
        || !qr_history.deleted_scans.is_empty()
        || !qr_history.deleted_generations.is_empty();
    let needed = collect_blob_hashes_all(&files, &notes, &accounts);
    let blobs_missing_or_changed = needed.iter().any(|sha| {
        manifest
            .objects
            .get(&blob_logical_path(sha))
            .map(|e| e.sha256 != *sha)
            .unwrap_or(true)
    });
    Ok((!totp.entries.is_empty() && totp_hash != remote_totp)
        || (!accounts.entries.is_empty() && acc_hash != remote_acc)
        || (!files.entries.is_empty() && files_hash != remote_files)
        || (!notes.entries.is_empty() && notes_hash != remote_notes)
        || (qr_nonempty && qr_hash != remote_qr)
        || (manifest.objects.contains_key("data/totp.json") && totp_hash != remote_totp)
        || (manifest.objects.contains_key("data/accounts.json") && acc_hash != remote_acc)
        || (manifest.objects.contains_key("data/files.json") && files_hash != remote_files)
        || (manifest.objects.contains_key("data/notes.json") && notes_hash != remote_notes)
        || (manifest.objects.contains_key("data/qr-history.json") && qr_hash != remote_qr)
        || blobs_missing_or_changed)
}

fn collect_icons(vault: &Vault) -> Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    for hash in store::list_icon_hashes(vault) {
        out.insert(hash.clone(), B64.encode(store::load_icon(vault, &hash)?));
    }
    Ok(out)
}

fn qr_state_json(data: &QrHistoryData) -> serde_json::Value {
    let mut scans = data.scans.clone();
    scans.sort_by(|a, b| a.id.cmp(&b.id));
    let mut generations = data.generations.clone();
    generations.sort_by(|a, b| a.id.cmp(&b.id));
    let mut deleted_scans: Vec<_> = data.deleted_scans.iter().collect();
    deleted_scans.sort_by(|a, b| a.0.cmp(b.0));
    let mut deleted_generations: Vec<_> = data.deleted_generations.iter().collect();
    deleted_generations.sort_by(|a, b| a.0.cmp(b.0));
    serde_json::json!({
        "scans": scans,
        "generations": generations,
        "deletedScans": deleted_scans,
        "deletedGenerations": deleted_generations,
    })
}

fn stable_state_hash(
    data: &VaultData,
    secrets: &Secrets,
    ssh: &str,
    totp: &crate::model::TotpData,
    accounts: &crate::model::AccountData,
    files: &FileData,
    notes: &NoteData,
    qr_history: &QrHistoryData,
    locker: &LockerData,
) -> String {
    let mut identities: Vec<&_> = data.identities.iter().collect();
    identities.sort_by(|a, b| a.id.cmp(&b.id));
    let mut keys: Vec<crate::model::KeyRecord> = data.keys.clone();
    for key in &mut keys {
        if let Some(p) = &key.deployed_path {
            key.deployed_path = Some(crate::sys::portable_deployed_path(p));
        }
    }
    keys.sort_by(|a, b| a.id.cmp(&b.id));
    let mut history: Vec<(&String, &String)> = data.clone_history.iter().collect();
    history.sort_by(|a, b| a.0.cmp(b.0));
    let mut passes: Vec<(&String, &String)> = secrets.key_passphrases.iter().collect();
    passes.sort_by(|a, b| a.0.cmp(b.0));
    let mut seeds: Vec<(&String, &String)> = secrets.totp_seeds.iter().collect();
    seeds.sort_by(|a, b| a.0.cmp(b.0));
    let mut account_secrets: Vec<_> = secrets.account_secrets.iter().collect();
    account_secrets.sort_by(|a, b| a.0.cmp(b.0));
    let mut totp_entries = totp.entries.clone();
    totp_entries.sort_by(|a, b| a.id.cmp(&b.id));
    let mut account_entries = accounts.entries.clone();
    account_entries.sort_by(|a, b| a.id.cmp(&b.id));
    let mut file_entries = files.entries.clone();
    file_entries.sort_by(|a, b| a.id.cmp(&b.id));
    let mut note_entries = notes.entries.clone();
    note_entries.sort_by(|a, b| a.id.cmp(&b.id));
    let mut blob_hashes: Vec<String> = collect_blob_hashes_all(files, notes, accounts)
        .into_iter()
        .collect();
    blob_hashes.sort();
    let mut locker_entries = locker.entries.clone();
    locker_entries.sort_by(|a, b| a.id.cmp(&b.id));
    let mut locker_deleted: Vec<(&String, &String)> = locker.deleted_entries.iter().collect();
    locker_deleted.sort_by(|a, b| a.0.cmp(b.0));
    let payload = serde_json::json!({
        "identities": identities,
        "keys": keys,
        "cloneHistory": history,
        "passphrases": passes,
        "githubPat": secrets.github_pat,
        "gitlabPat": secrets.gitlab_pat,
        "giteePat": secrets.gitee_pat,
        "totpSeeds": seeds,
        "accountSecrets": account_secrets,
        "totpEntries": totp_entries,
        "accountEntries": account_entries,
        "fileEntries": file_entries,
        "noteEntries": note_entries,
        "qrHistory": qr_state_json(qr_history),
        "lockerEntries": locker_entries,
        "lockerDeleted": locker_deleted,
        "blobHashes": blob_hashes,
        "ssh": crate::sys::canonical_ssh_for_sync(ssh),
    });
    sha256_hex(payload.to_string().as_bytes())
}

fn local_has_syncable_assets(vault: &Vault) -> Result<bool> {
    let data = store::load_data(vault)?;
    let totp = store::load_totp(vault)?;
    let accounts = store::load_accounts(vault)?;
    let files = store::load_files(vault)?;
    let notes = store::load_notes(vault)?;
    let qr_history = store::load_qr_history(vault)?;
    let locker = store::load_locker(vault)?;
    Ok(!data.identities.is_empty()
        || !data.keys.is_empty()
        || !data.repos.is_empty()
        || !totp.entries.is_empty()
        || !accounts.entries.is_empty()
        || !files.entries.is_empty()
        || !notes.entries.is_empty()
        || !qr_history.scans.is_empty()
        || !qr_history.generations.is_empty()
        || !qr_history.deleted_scans.is_empty()
        || !qr_history.deleted_generations.is_empty()
        || !locker.entries.is_empty()
        || !locker.deleted_entries.is_empty())
}

/// 合并结果和云端不一致才上传。
/// 云端已经有备份不是拒绝推送的理由；结果一致时不推，避免用空本地盖掉云端。
pub(crate) fn should_upload_after_pull(need_push: bool) -> bool {
    need_push
}

/// 先拉取再按需推送。空本地不会覆盖已有云端。
pub fn pull_then_maybe_push(vault: &Vault, s3: &S3Client) -> Result<SyncResult> {
    pull_then_maybe_push_with(vault, s3, BlobSyncScope::All, None)
}

pub fn pull_then_maybe_push_with(
    vault: &Vault,
    s3: &S3Client,
    blob_scope: BlobSyncScope,
    progress: Option<&dyn Fn(BlobSyncProgress)>,
) -> Result<SyncResult> {
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }
    let remote_before = fetch_remote_manifest(vault, s3)?;
    if remote_before
        .as_ref()
        .is_some_and(|m| m.workspace_id != vault.workspace_id())
    {
        return Err(AppError::Invalid(
            "云端工作空间与本地不一致，已跳过自动同步，请手动确认".into(),
        ));
    }

    if remote_before.is_some() {
        let (pulled, need_push) =
            pull_from_cloud_inner(vault, s3, false, false, blob_scope, progress)?;
        let header_changed = remote_before
            .as_ref()
            .and_then(|m| m.header_sha256.as_deref())
            != Some(sha256_hex(&serde_json::to_vec(vault.header())?).as_str());
        if should_upload_after_pull(need_push || header_changed) {
            let pushed = push_to_cloud_with(vault, s3, blob_scope, progress)?;
            return Ok(SyncResult {
                message: format!("已拉取并推送：{}", pushed.message),
                ..pushed
            });
        }
        return Ok(SyncResult {
            message: format!("已从云端拉取，本地无待推送变更。{}", pulled.message),
            ..pulled
        });
    }

    if local_has_syncable_assets(vault)? {
        let pushed = push_to_cloud_with(vault, s3, blob_scope, progress)?;
        return Ok(SyncResult {
            message: format!("云端尚无备份，已推送：{}", pushed.message),
            ..pushed
        });
    }

    let data = store::load_data(vault)?;
    Ok(SyncResult {
        synced_at: iso_now(),
        objects_transferred: 0,
        identity_count: data.identities.len(),
        key_count: data.keys.len(),
        repo_count: data.repos.len(),
        message: "本地为空且云端无备份，已跳过".into(),
    })
}

/// 本地编辑后：先合并云端新增（不覆盖刚写的 SSH config），再立刻推送。
/// 大 blob 默认不跟这次走，避免每加一个附件就阻塞。
pub fn publish_after_edit(vault: &Vault, s3: &S3Client) -> Result<SyncResult> {
    publish_after_edit_with(vault, s3, BlobSyncScope::NoteBodiesOnly, None)
}

pub fn publish_after_edit_with(
    vault: &Vault,
    s3: &S3Client,
    blob_scope: BlobSyncScope,
    progress: Option<&dyn Fn(BlobSyncProgress)>,
) -> Result<SyncResult> {
    if !vault.is_unlocked() {
        return Err(AppError::Locked);
    }
    if !local_has_syncable_assets(vault)? {
        return Ok(SyncResult {
            synced_at: iso_now(),
            objects_transferred: 0,
            identity_count: 0,
            key_count: 0,
            repo_count: 0,
            message: "本地无身份数据，已跳过推送".into(),
        });
    }
    let remote = fetch_remote_manifest(vault, s3)?;
    if remote
        .as_ref()
        .is_some_and(|m| m.workspace_id != vault.workspace_id())
    {
        return Err(AppError::Invalid(
            "云端工作空间与本地不一致，已跳过自动推送，请手动确认".into(),
        ));
    }
    if remote.is_some() {
        let _ = pull_from_cloud_inner(vault, s3, false, false, blob_scope, progress)?;
    }
    let pushed = push_to_cloud_with(vault, s3, blob_scope, progress)?;
    Ok(SyncResult {
        message: format!("已保存并推送到云端：{}", pushed.message),
        ..pushed
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::crypto::MasterKey;

    #[test]
    fn local_sync_anchor_rejects_replay_and_forks_but_allows_upgrade_and_next() {
        let anchor = |protocol, generation, digest: &str| store::SyncAnchor {
            protocol,
            generation,
            digest: digest.into(),
        };
        let legacy = anchor(1, 0, "legacy-a");
        let first = anchor(2, 1, "one");
        let second = anchor(2, 2, "two");
        assert!(verify_manifest_anchor(None, &legacy).is_ok());
        assert!(verify_manifest_anchor(Some(&legacy), &anchor(1, 0, "legacy-b")).is_ok());
        assert!(verify_manifest_anchor(Some(&legacy), &first).is_ok());
        assert!(verify_manifest_anchor(Some(&first), &second).is_ok());
        assert!(verify_manifest_anchor(Some(&second), &second).is_ok());
        assert!(
            verify_manifest_anchor(Some(&second), &first).is_err(),
            "complete authentic old commit must not roll local state back"
        );
        assert!(verify_manifest_anchor(Some(&second), &anchor(2, 2, "fork")).is_err());
        assert!(verify_manifest_anchor(Some(&second), &legacy).is_err());
        assert!(verify_manifest_anchor(None, &anchor(2, 0, "invalid")).is_err());
        assert!(
            verify_manifest_anchor(None, &second).is_ok(),
            "new device must establish its first anchor from authenticated recovery"
        );
    }

    #[test]
    fn manifest_anchor_is_independent_of_hashmap_insertion_order() {
        let mut first = SyncManifest {
            version: 2,
            generation: 7,
            workspace_id: "w".into(),
            updated_at: "now".into(),
            client_name: "test".into(),
            objects: HashMap::new(),
            header_sha256: None,
        };
        let entry = SyncObjectEntry {
            object_name: "ab".repeat(32),
            sha256: "cd".repeat(32),
            size: 10,
            updated_at: "now".into(),
        };
        first.objects.insert("b".into(), entry.clone());
        first.objects.insert("a".into(), entry.clone());
        let mut second = first.clone();
        second.objects.clear();
        second.objects.insert("a".into(), entry.clone());
        second.objects.insert("b".into(), entry);
        assert_eq!(
            manifest_anchor(&first).unwrap(),
            manifest_anchor(&second).unwrap()
        );
        second.client_name = "different authenticated content".into();
        assert_ne!(
            manifest_anchor(&first).unwrap(),
            manifest_anchor(&second).unwrap()
        );
    }

    #[test]
    fn immutable_object_names_change_with_content_and_reject_mixed_generation() {
        let mk = MasterKey::random();
        let old = b"old secret";
        let new = b"new secret";
        let name =
            |bytes: &[u8]| mk.object_name(&format!("v2:data/secrets.json:{}", sha256_hex(bytes)));
        assert_ne!(name(old), name(new));
        let entry = SyncObjectEntry {
            object_name: name(old),
            sha256: sha256_hex(old),
            size: old.len(),
            updated_at: String::new(),
        };
        assert!(verify_sync_object(&entry, old).is_ok());
        assert!(verify_sync_object(&entry, new).is_err());
        assert!(verify_sync_object(&entry, &old[..3]).is_err());
    }

    #[test]
    fn committed_manifest_authenticates_recovery_header() {
        let root = std::env::temp_dir().join(format!("gkm-header-bind-{}", uuid::Uuid::new_v4()));
        let (vault, _) = Vault::init(
            &root,
            "test-password",
            crate::vault::header::KdfParams::new(crate::vault::kdf::MEM_FLOOR_KIB, 2, 1),
        )
        .unwrap();
        let key = vault.subkey(LABEL_SYNC_OBJECT).unwrap();
        let mut objects = HashMap::new();
        for path in [
            "data/identities.json",
            "data/secrets.json",
            "data/totp.json",
            "data/accounts.json",
            "data/files.json",
            "data/notes.json",
            "data/qr-history.json",
            "data/locker.json",
        ] {
            objects.insert(
                path.into(),
                SyncObjectEntry {
                    object_name: "ab".repeat(32),
                    sha256: sha256_hex(b"{}"),
                    size: 2,
                    updated_at: "now".into(),
                },
            );
        }
        let manifest = SyncManifest {
            version: 2,
            generation: 1,
            workspace_id: vault.workspace_id().into(),
            updated_at: "now".into(),
            client_name: "test".into(),
            objects,
            header_sha256: Some(sha256_hex(&serde_json::to_vec(vault.header()).unwrap())),
        };
        let mut wrapper = CommittedManifest {
            format: "gkm-sync-v2".into(),
            header: vault.header().clone(),
            ciphertext: B64
                .encode(encrypt_payload(&key, &serde_json::to_vec(&manifest).unwrap()).unwrap()),
        };
        assert!(decode_manifest_bytes(&key, &serde_json::to_vec(&wrapper).unwrap()).is_ok());
        wrapper.header.created_at = "tampered".into();
        assert!(decode_manifest_bytes(&key, &serde_json::to_vec(&wrapper).unwrap()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remote_presence_does_not_block_upload_of_local_delta() {
        assert!(
            should_upload_after_pull(true),
            "合并后和云端不一致时必须推送，不能因为云端已有数据就跳过"
        );
        assert!(
            !should_upload_after_pull(false),
            "合并结果已与云端一致时不推，避免空本地覆盖云端"
        );
    }

    #[test]
    fn test_sync_object_hmac_and_encryption() {
        let mk = MasterKey::random();
        let enc_key = mk.subkey(LABEL_SYNC_OBJECT);

        let name1 = mk.object_name("data/identities.json");
        let name2 = mk.object_name("data/identities.json");
        let name3 = mk.object_name("keys/k1.key");
        assert_eq!(name1, name2, "相同逻辑路径 HMAC 名称应确定");
        assert_ne!(name1, name3, "不同逻辑路径 HMAC 名称应不同");
        assert!(!name1.contains("identities"), "HMAC 名称绝不含明文特征");

        let plain = b"{\"identities\":[{\"id\":\"1\"}]}";
        let enc = encrypt_payload(&enc_key, plain).unwrap();
        assert_ne!(&enc[..], &plain[..]);

        let dec = decrypt_payload(&enc_key, &enc).unwrap();
        assert_eq!(dec, plain);
    }

    #[test]
    fn qr_history_sync_payload_is_encrypted() {
        let mk = MasterKey::random();
        let enc_key = mk.subkey(LABEL_SYNC_OBJECT);
        let name = mk.object_name("data/qr-history.json");
        assert!(!name.contains("qr-history"), "对象名不能带出逻辑路径");
        assert!(!name.contains("secret-plain"));

        let data = QrHistoryData {
            scans: vec![crate::model::QrHistoryEntry {
                id: "s1".into(),
                text: "otpauth://totp/secret-plain".into(),
                at: 1,
                updated_at: "2026-01-01T00:00:00Z".into(),
            }],
            generations: vec![crate::model::QrHistoryEntry {
                id: "g1".into(),
                text: "生成原文 secret-plain".into(),
                at: 2,
                updated_at: "2026-01-01T00:00:01Z".into(),
            }],
            ..QrHistoryData::default()
        };
        let plain = serde_json::to_vec(&data).unwrap();
        assert!(plain.windows(12).any(|w| w == b"secret-plain"));
        let enc = encrypt_payload(&enc_key, &plain).unwrap();
        let enc_text = String::from_utf8_lossy(&enc);
        assert!(!enc_text.contains("secret-plain"));
        assert!(!enc_text.contains("otpauth"));
        assert!(!enc_text.contains("qr-history"));
        let back: QrHistoryData =
            serde_json::from_slice(&decrypt_payload(&enc_key, &enc).unwrap()).unwrap();
        assert_eq!(back.scans[0].text, "otpauth://totp/secret-plain");
        assert_eq!(back.generations[0].text, "生成原文 secret-plain");
        assert_eq!(back.scans.len(), 1);
        assert_eq!(back.generations.len(), 1);
    }

    fn meta(id: &str, created_at: &str) -> SnapshotMeta {
        SnapshotMeta {
            id: id.into(),
            created_at: created_at.into(),
            client_name: "t".into(),
            identity_count: 1,
            key_count: 0,
            repo_count: 0,
            is_recent: false,
            is_daily_first: false,
            blob_hashes: Vec::new(),
        }
    }

    #[test]
    fn prune_keeps_recent_and_daily_first() {
        let now = time::OffsetDateTime::parse(
            "2026-01-15T18:00:00Z",
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap();
        // 1 月 1 日到 15 日每天一份，另加 15 日下午一份。
        let mut items: Vec<SnapshotMeta> = (1..=15)
            .map(|i| meta(&format!("d{i:02}"), &format!("2026-01-{i:02}T01:00:00Z")))
            .collect();
        items.push(meta("d15b", "2026-01-15T12:00:00Z"));

        let dropped = prune_snapshot_index_at(&mut items, now, 10, 14);
        // 近 14 天（1/2–1/15）的每日首份 + 最近 10 份，1 月 1 日应被丢掉。
        assert!(dropped.contains(&"d01".into()));
        assert!(!items.iter().any(|m| m.id == "d01"));
        assert!(items.iter().any(|m| m.id == "d02" && m.is_daily_first));
        assert!(items.iter().any(|m| m.id == "d15" && m.is_daily_first));
        assert!(items.iter().any(|m| m.id == "d15b" && m.is_recent));
        assert!(items.len() >= 14);
        assert!(items.len() <= 16);
    }

    #[test]
    fn prune_daily_first_is_earliest_of_that_day() {
        let now = time::OffsetDateTime::parse(
            "2026-09-09T20:00:00Z",
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap();
        let mut items: Vec<SnapshotMeta> = (0..12)
            .map(|i| meta(&format!("n{i}"), &format!("2026-09-09T{:02}:00:00Z", 8 + i)))
            .collect();
        items.push(meta("old", "2026-08-01T08:00:00Z"));
        let dropped = prune_snapshot_index_at(&mut items, now, 10, 14);
        assert!(dropped.contains(&"old".into()));
        let first = items.iter().find(|m| m.is_daily_first).unwrap();
        assert_eq!(first.id, "n0");
        assert!(first.created_at.starts_with("2026-09-09T08:"));
        assert!(items.iter().any(|m| m.id == "n11" && m.is_recent));
    }

    #[test]
    fn empty_local_ssh_is_not_uploadable() {
        assert!(!crate::sys::text_has_host_blocks(""));
        assert!(!crate::sys::text_has_host_blocks(
            "# comment\nInclude git-account-manager.config\n"
        ));
        assert!(crate::sys::text_has_host_blocks(
            "Host github-a\n    HostName github.com\n    User git\n"
        ));
    }

    #[test]
    fn skip_blob_when_manifest_sha_matches() {
        let sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let mut objects = HashMap::new();
        objects.insert(
            blob_logical_path(sha),
            SyncObjectEntry {
                object_name: "obj".into(),
                sha256: sha.into(),
                size: 12,
                updated_at: "t".into(),
            },
        );
        let remote = SyncManifest {
            version: 1,
            generation: 0,
            workspace_id: "w".into(),
            updated_at: "t".into(),
            client_name: "c".into(),
            objects,
            header_sha256: None,
        };
        assert!(should_skip_blob_upload(Some(&remote), sha));
        assert!(!should_skip_blob_upload(Some(&remote), &"ab".repeat(32)));
        assert!(!should_skip_blob_upload(None, sha));
    }

    #[test]
    fn collect_blob_logical_paths_from_metadata() {
        let mut files = FileData::default();
        files.entries.push(crate::model::FileEntry {
            id: "f1".into(),
            name: "a".into(),
            original_name: "a.bin".into(),
            mime: None,
            size: 3,
            sha256: "aa".repeat(32),
            attachments: vec![],
            group: None,
            note: None,
            icon: None,
            sort_order: 0,
            created_at: "t".into(),
            updated_at: "t".into(),
        });
        let mut notes = NoteData::default();
        notes.entries.push(crate::model::NoteEntry {
            id: "n1".into(),
            title: "t".into(),
            format: "markdown".into(),
            group: None,
            tags: vec![],
            icon: None,
            pinned: false,
            sort_order: 0,
            excerpt: None,
            body_sha256: "bb".repeat(32),
            asset_hashes: vec!["cc".repeat(32)],
            created_at: "t".into(),
            updated_at: "t".into(),
        });
        let hashes = collect_blob_hashes(&files, &notes);
        assert_eq!(hashes.len(), 3);
        assert!(hashes.contains(&"aa".repeat(32)));
        assert!(hashes.contains(&"bb".repeat(32)));
        assert!(hashes.contains(&"cc".repeat(32)));
        let bodies = blob_hashes_for_scope(
            &files,
            &notes,
            &AccountData::default(),
            BlobSyncScope::NoteBodiesOnly,
        );
        assert_eq!(bodies.len(), 1);
        assert!(bodies.contains(&"bb".repeat(32)));
        assert!(!bodies.contains(&"aa".repeat(32)));
        assert!(!bodies.contains(&"cc".repeat(32)));
    }

    #[test]
    fn resolve_blob_scope_defers_attachments() {
        assert_eq!(
            resolve_blob_scope("edit", true, false, true),
            BlobSyncScope::NoteBodiesOnly
        );
        assert_eq!(
            resolve_blob_scope("periodic", true, false, false),
            BlobSyncScope::NoteBodiesOnly
        );
        assert_eq!(
            resolve_blob_scope("periodic", false, true, true),
            BlobSyncScope::NoteBodiesOnly
        );
        assert_eq!(
            resolve_blob_scope("periodic", true, false, true),
            BlobSyncScope::All
        );
        assert_eq!(
            resolve_blob_scope("manual", true, true, false),
            BlobSyncScope::All
        );
        assert_eq!(
            resolve_blob_scope("startup", true, false, false),
            BlobSyncScope::NoteBodiesOnly
        );
    }

    #[test]
    fn snapshot_id_sanitizes_rfc3339() {
        assert_eq!(
            snapshot_id_from_time("2026-09-09T12:05:28Z"),
            "2026-09-09T12-05-28Z"
        );
    }

    #[test]
    fn cloud_vault_header_roundtrip_and_bare_fallback() {
        use crate::vault::header::KdfParams;
        use crate::vault::kdf::{ITERS_FLOOR, MEM_FLOOR_KIB};
        let root = std::env::temp_dir().join(format!("gam-hdr-{}", uuid::Uuid::new_v4()));
        let kdf = KdfParams::new(MEM_FLOOR_KIB, ITERS_FLOOR, 1);
        let (v, rec) = crate::vault::Vault::init(&root, "pw", kdf).unwrap();
        let wrapped = CloudVaultHeader {
            version: 1,
            header: v.header().clone(),
        };
        let raw = serde_json::to_vec(&wrapped).unwrap();
        let parsed = parse_cloud_vault_header(&raw).unwrap();
        assert_eq!(parsed.workspace_id, v.workspace_id());
        let mk = unlock_header_with_recovery(&parsed, &rec).unwrap();
        assert_eq!(mk.as_bytes(), v.master_key_bytes().unwrap().as_ref());

        let bare = serde_json::to_vec(v.header()).unwrap();
        let parsed_bare = parse_cloud_vault_header(&bare).unwrap();
        assert_eq!(parsed_bare.workspace_id, v.workspace_id());
        std::fs::remove_dir_all(&root).ok();
    }
}
