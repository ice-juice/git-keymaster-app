//! Local durable operation journal and v2 receive orchestration. The journal and
//! resumable ciphertext are scoped to the encrypted workspace, never WebView storage.
use super::*;
use crate::model::{FileEntry, LockerService, LockerStorageBinding};
use crate::vault::crypto;
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

pub(super) static MUTATION: Mutex<()> = Mutex::new(());
const JOURNAL_LABEL: &[u8] = b"gam-locker-local-operations-v2";
thread_local! {static SESSION_EPOCH:Cell<Option<u64>>=const{Cell::new(None)};}
pub(super) struct SessionGuard(Option<u64>);
impl Drop for SessionGuard {
    fn drop(&mut self) {
        SESSION_EPOCH.with(|e| e.set(self.0));
    }
}
/// The IPC handlers here are synchronous bodies dispatched with command(async),
/// so this scoped guard cannot cross an await/thread boundary.
pub(super) fn capture(state: &AppState) -> Result<(SessionGuard, Vault)> {
    let locked = recover_lock(&state.vault);
    let vault = locked
        .as_ref()
        .filter(|v| v.is_unlocked())
        .ok_or(AppError::Locked)?
        .clone();
    let epoch = state.session_epoch.load(Ordering::SeqCst);
    let previous = SESSION_EPOCH.with(|e| e.replace(Some(epoch)));
    Ok((SessionGuard(previous), vault))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LockerSource {
    pub id: Option<String>,
    pub code: Option<String>,
    pub share_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LockerDestination {
    pub kind: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerLookup {
    pub id: String,
    pub name: String,
    pub original_name: String,
    pub size: u64,
    pub size_is_estimate: bool,
    pub expire_at: Option<String>,
    pub max_pulls: Option<u32>,
    pub pulls_left: Option<u32>,
    pub version: String,
    pub source: String,
    pub protocol_version: u32,
    pub legacy: bool,
    pub quota_origin: Option<String>,
    pub in_flight_claims: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerOperation {
    pub operation_id: String,
    pub kind: String,
    pub status: String,
    pub phase: String,
    pub item_id: Option<String>,
    pub name: Option<String>,
    pub dest_path: Option<String>,
    pub file_id: Option<String>,
    pub pulls_left: Option<u32>,
    pub cleanup_status: Option<String>,
    pub error: Option<String>,
    pub recoverable: bool,
    #[serde(default)]
    pub can_retarget: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct StoredOperation {
    pub view: LockerOperation,
    pub source: Option<LockerSource>,
    pub destination: Option<LockerDestination>,
    pub snapshot: String,
    pub fingerprint: String,
    pub entry: Option<LockerEntry>,
    pub lookup: Option<LockerLookup>,
    pub claim: Option<worker::V2Claim>,
    pub endpoint_base: Option<String>,
    pub public_slug: Option<String>,
    pub wrapped_key: Option<String>,
    pub content_ready: bool,
    pub output_hash: Option<String>,
    pub ttl_seconds: Option<u64>,
    pub permanent: bool,
    #[serde(default)]
    pub storage_binding: Option<LockerStorageBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Ended {
    pub id: String,
    pub name: String,
    pub original_name: String,
    pub mime: Option<String>,
    pub size: u64,
    pub created_at: String,
    pub expire_at: Option<String>,
    pub max_pulls: Option<u32>,
    pub pulls_left: Option<u32>,
    pub ended_at: String,
    pub reason: String,
    pub cleanup: String,
    pub error: Option<String>,
    // No code or key survives in history. Object routing is needed only while
    // cleanup is pending and is never returned to the UI.
    pub object_name: String,
    pub service: Option<LockerService>,
    #[serde(default)]
    pub storage_binding: Option<LockerStorageBinding>,
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct Journal {
    pub operations: HashMap<String, StoredOperation>,
    pub ended: Vec<Ended>,
    pub share_intents: HashMap<String, (String, String)>,
}

fn journal_path(vault: &Vault) -> PathBuf {
    vault.root().join("data/locker-runtime-v2.enc")
}
pub(super) fn read_journal(vault: &Vault) -> Result<Journal> {
    let path = journal_path(vault);
    crate::vault::recover_previous_if_missing(&path);
    if !path.exists() {
        return Ok(Journal::default());
    }
    let raw = std::fs::read(path)?;
    if raw.len() < crypto::XNONCE_LEN {
        return Err(AppError::Crypto);
    }
    let mut key = vault.subkey(JOURNAL_LABEL)?;
    let mut nonce = [0; crypto::XNONCE_LEN];
    nonce.copy_from_slice(&raw[..crypto::XNONCE_LEN]);
    let result = crypto::aead_decrypt(&key, &nonce, &raw[crypto::XNONCE_LEN..]);
    key.zeroize();
    let mut plain = result?;
    let data = serde_json::from_slice(&plain);
    plain.zeroize();
    Ok(data?)
}
pub(super) fn write_journal(vault: &Vault, data: &Journal) -> Result<()> {
    let mut data = data.clone();
    let cutoff = (time::OffsetDateTime::now_utc() - time::Duration::days(7))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    data.ended
        .retain(|e| e.cleanup != "cleaned" || e.ended_at >= cutoff);
    // Keep the small, secret-free operation binding after completion; even a
    // very late replay must not recreate a permanent/previously deleted upload.
    let mut key = vault.subkey(JOURNAL_LABEL)?;
    let nonce = crypto::new_nonce();
    let mut plain = serde_json::to_vec(&data)?;
    let sealed = crypto::aead_encrypt(&key, &nonce, &plain);
    key.zeroize();
    plain.zeroize();
    let mut out = nonce.to_vec();
    out.extend(sealed?);
    crate::vault::atomic_write(&journal_path(vault), &out)
}
pub(super) fn save_operation(vault: &Vault, op: &StoredOperation) -> Result<()> {
    let mut journal = read_journal(vault)?;
    journal
        .operations
        .insert(op.view.operation_id.clone(), op.clone());
    write_journal(vault, &journal)
}
fn valid_operation(id: &str) -> Result<()> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(AppError::Invalid("操作 ID 必须是 UUID".into()));
    }
    Ok(())
}
pub(super) fn cipher_path(vault: &Vault, operation_id: &str) -> Result<PathBuf> {
    valid_operation(operation_id)?;
    let dir = vault.root().join("data/locker-recovery");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{operation_id}.cipher")))
}
pub(super) fn set_phase(
    vault: &Vault,
    op: &mut StoredOperation,
    status: &str,
    phase: &str,
) -> Result<()> {
    op.view.status = status.into();
    op.view.phase = phase.into();
    op.view.updated_at = now();
    op.view.error = None;
    save_operation(vault, op)
}
pub(super) fn new_operation(id: &str, kind: &str) -> StoredOperation {
    StoredOperation {
        view: LockerOperation {
            operation_id: id.into(),
            kind: kind.into(),
            status: "prepared".into(),
            phase: "prepared".into(),
            item_id: None,
            name: None,
            dest_path: None,
            file_id: None,
            pulls_left: None,
            cleanup_status: None,
            error: None,
            recoverable: true,
            can_retarget: false,
            updated_at: now(),
        },
        source: None,
        destination: None,
        snapshot: String::new(),
        fingerprint: String::new(),
        entry: None,
        lookup: None,
        claim: None,
        endpoint_base: None,
        public_slug: None,
        wrapped_key: None,
        content_ready: false,
        output_hash: None,
        ttl_seconds: None,
        permanent: false,
        storage_binding: None,
    }
}

pub(super) fn ensure_current(state: &AppState, vault: &Vault) -> Result<()> {
    ensure_writes_allowed(state)?;
    ensure_identity(state, vault)
}
fn ensure_identity(state: &AppState, vault: &Vault) -> Result<()> {
    let live = recover_lock(&state.vault);
    if !live
        .as_ref()
        .is_some_and(|v| v.is_unlocked() && v.workspace_id() == vault.workspace_id())
    {
        return Err(AppError::Locked);
    }
    if SESSION_EPOCH.with(|e| {
        e.get()
            .is_some_and(|expected| expected != state.session_epoch.load(Ordering::SeqCst))
    }) {
        return Err(AppError::Locked);
    }
    Ok(())
}

pub(super) fn bound_endpoint(vault: &Vault, base: &str) -> Result<WorkerEndpoint> {
    let endpoint = require_share_worker(vault)?;
    if endpoint.base.trim_end_matches('/') != base.trim_end_matches('/') {
        return Err(AppError::Invalid(
            "该文件绑定的取件服务与当前配置不同，请恢复原服务配置后重试".into(),
        ));
    }
    Ok(endpoint)
}

fn binding(cfg: &crate::app_config::AppConfig) -> Result<LockerStorageBinding> {
    let sync = cfg
        .cloud_sync
        .as_ref()
        .ok_or_else(|| AppError::Invalid("请先配置云存储".into()))?;
    Ok(LockerStorageBinding {
        endpoint: sync.endpoint.trim().trim_end_matches('/').into(),
        bucket: sync.bucket.trim().into(),
        region: sync.region.trim().into(),
        prefix: sync.prefix.trim_matches('/').into(),
    })
}
fn open_bound_s3(
    state: &AppState,
    vault: &Vault,
    expected: Option<&LockerStorageBinding>,
) -> Result<S3Client> {
    let cfg = recover_lock(&state.config).clone();
    if let Some(expected) = expected {
        if &binding(&cfg)? != expected {
            return Err(AppError::Invalid(
                "原操作绑定的存储端点、存储桶或目录已改变，请恢复原配置后继续".into(),
            ));
        }
    }
    let mut sync = cfg
        .cloud_sync
        .clone()
        .ok_or_else(|| AppError::Invalid("请先配置云存储".into()))?;
    if sync.secret_access_key.trim().is_empty() {
        sync.secret_access_key = store::cloud_sync_secret(vault)?.unwrap_or_default();
    }
    if !sync.has_usable_secret() {
        return Err(AppError::Invalid("云存储凭据不可用".into()));
    }
    S3Client::from_app(sync, &cfg)
}
fn import_id(vault: &Vault, operation_id: &str) -> String {
    let hash = Sha256::digest(format!(
        "locker-receive-file:{}:{operation_id}",
        vault.workspace_id()
    ));
    let mut id = [0; 16];
    id.copy_from_slice(&hash[..16]);
    uuid::Uuid::from_bytes(id).to_string()
}

struct Resolved {
    lookup: LockerLookup,
    entry: Option<LockerEntry>,
    endpoint: Option<WorkerEndpoint>,
    slug: Option<String>,
    key: Option<[u8; 32]>,
}
impl Drop for Resolved {
    fn drop(&mut self) {
        if let Some(key) = self.key.as_mut() {
            key.zeroize();
        }
    }
}

fn parse_share(raw: &str) -> Result<(WorkerEndpoint, String, [u8; 32], String, u64)> {
    if raw.len() > 8192 {
        return Err(AppError::Invalid("分享链接过长".into()));
    }
    let mut url = reqwest::Url::parse(raw.trim())
        .map_err(|_| AppError::Invalid("分享链接格式不正确".into()))?;
    #[cfg(not(test))]
    if url.scheme() != "https" {
        return Err(AppError::Invalid("分享链接必须使用 HTTPS".into()));
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
        return Err(AppError::Invalid("分享链接不能包含用户名或查询参数".into()));
    }
    let fragment = url
        .fragment()
        .ok_or_else(|| AppError::Invalid("分享链接缺少 # 后的解密信息".into()))?
        .to_owned();
    let path = url.path().to_owned();
    let (prefix, slug) = path
        .rsplit_once("/d/")
        .ok_or_else(|| AppError::Invalid("不是有效的寄存分享链接".into()))?;
    if slug.len() != 10 || !slug.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(AppError::Invalid("分享短码不正确".into()));
    }
    let slug = slug.to_owned();
    url.set_fragment(None);
    url.set_path(prefix);
    let base = url.as_str().trim_end_matches('/').to_owned();
    let (key, filename, size) = locker::verify_share_fragment(&base, &slug, &fragment)?;
    Ok((
        WorkerEndpoint {
            base,
            secret: String::new(),
        },
        slug,
        key,
        filename,
        size,
    ))
}

fn source_shape(source: &LockerSource) -> Result<()> {
    let id = source.id.as_ref().is_some_and(|x| !x.trim().is_empty());
    let code = source.code.as_ref().is_some_and(|x| !x.trim().is_empty());
    let url = source
        .share_url
        .as_ref()
        .is_some_and(|x| !x.trim().is_empty());
    if (url && code && !id) || (!url && id && !code) || (!url && !id && code) {
        Ok(())
    } else {
        Err(AppError::Invalid(
            "请选择自己的文件/取件码，或完整分享链接与取件码".into(),
        ))
    }
}

fn resolve(state: &AppState, vault: &Vault, source: &LockerSource) -> Result<Resolved> {
    source_shape(source)?;
    let proxy = proxy_of(state);
    if let Some(url) = source.share_url.as_deref() {
        let (ep, slug, key, name, plain_size) = parse_share(url)?;
        let code = normalize_pickup_code(source.code.as_deref().unwrap_or(""))?;
        worker::v2_health(&ep, proxy.as_ref())?;
        let meta: worker::V2Metadata = worker::v2_json(
            &ep,
            "POST",
            &format!("/v2/shares/{slug}/lookup"),
            Some(&serde_json::json!({"code":code})),
            false,
            proxy.as_ref(),
        )?;
        if meta.status != "active" || meta.pulls_left == Some(0) {
            return Err(AppError::Invalid("该分享当前不可领取".into()));
        }
        return Ok(Resolved {
            lookup: LockerLookup {
                id: meta.item_id,
                name: name.clone(),
                original_name: name,
                size: plain_size,
                size_is_estimate: false,
                expire_at: meta.expire_at,
                max_pulls: meta.max_pulls,
                pulls_left: meta.pulls_left,
                version: meta.version,
                source: "share".into(),
                protocol_version: 2,
                legacy: false,
                quota_origin: Some("service".into()),
                in_flight_claims: meta.in_flight_claims,
            },
            entry: None,
            endpoint: Some(ep),
            slug: Some(slug),
            key: Some(key),
        });
    }
    let data = store::load_locker(vault)?;
    let entry = if let Some(id) = source.id.as_deref() {
        data.entries
            .iter()
            .find(|e| e.id == id)
            .cloned()
            .ok_or_else(|| AppError::Invalid("找不到该寄存文件".into()))?
    } else {
        data.entries[index_by_code(&data, source.code.as_deref().unwrap_or(""))?].clone()
    };
    if read_journal(vault)?.ended.iter().any(|e| e.id == entry.id) {
        return Err(AppError::Invalid("该寄存已结束，不能领取".into()));
    }
    if is_expired(entry.expire_at.as_deref(), &now()) || pulls_exhausted(entry.pulls_left) {
        return Err(AppError::Invalid("该寄存已到期或次数用尽".into()));
    }
    let (ep, meta) = if let Some(service) = &entry.service {
        let ep = bound_endpoint(vault, &service.base_url)?;
        worker::v2_health(&ep, proxy.as_ref())?;
        let meta: worker::V2Metadata = worker::v2_json(
            &ep,
            "POST",
            &format!("/v2/items/{}/lookup", entry.id),
            Some(&serde_json::json!({})),
            true,
            proxy.as_ref(),
        )?;
        if meta.item_id != entry.id
            || meta.version != service.version
            || meta.cipher_size != framed_ciphertext_len(entry.size, DEFAULT_CHUNK_SIZE)
        {
            return Err(AppError::Invalid(
                "服务文件版本与本机记录不匹配，请先同步确认".into(),
            ));
        }
        if meta.status != "active" || meta.pulls_left == Some(0) {
            return Err(AppError::Invalid(
                "该文件当前不可领取，可能已被其他设备占用".into(),
            ));
        }
        (Some(ep), Some(meta))
    } else {
        if entry.share.is_some() || entry.max_pulls.is_some() {
            return Err(AppError::Invalid(
                "这是旧规则的有限次数寄存，请先升级/迁移服务；已阻止旧版扣次领取".into(),
            ));
        }
        (None, None)
    };
    let lookup = LockerLookup {
        id: entry.id.clone(),
        name: entry.name.clone(),
        original_name: locker::download_filename(&entry.original_name),
        size: entry.size,
        size_is_estimate: false,
        expire_at: entry.expire_at.clone(),
        max_pulls: entry.max_pulls,
        pulls_left: meta.as_ref().and_then(|m| m.pulls_left),
        version: meta
            .as_ref()
            .map(|m| m.version.clone())
            .unwrap_or_else(|| format!("basic-{}", entry.id)),
        source: "own".into(),
        protocol_version: if meta.is_some() { 2 } else { 0 },
        legacy: entry.service.is_none(),
        quota_origin: entry
            .service
            .as_ref()
            .map(|s| s.origin.clone().unwrap_or_else(|| "service".into())),
        in_flight_claims: meta.as_ref().map(|m| m.in_flight_claims).unwrap_or(0),
    };
    Ok(Resolved {
        lookup,
        entry: Some(entry),
        endpoint: ep,
        slug: None,
        key: None,
    })
}

#[tauri::command(async)]
pub fn locker_lookup(
    state: State<'_, AppState>,
    source: LockerSource,
    password: Option<String>,
) -> Result<LockerLookup> {
    ensure_reveal_authorized(&state, password.as_deref())?;
    let (_session, vault) = capture(&state)?;
    let found = resolve(&state, &vault, &source)?;
    ensure_identity(&state, &vault)?;
    Ok(found.lookup.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerConnectionStatus {
    storage_configured: bool,
    service_configured: bool,
    protocol_version: Option<u32>,
    service_ready: bool,
    storage_verified: bool,
    service_verified: bool,
    checked_at: String,
    error: Option<String>,
}
#[tauri::command(async)]
pub fn locker_connection_status(
    state: State<'_, AppState>,
    verify: Option<bool>,
) -> Result<LockerConnectionStatus> {
    let (_session, vault) = capture(&state)?;
    let s3 = open_s3(&state, &vault);
    let ep = load_worker(&vault)?;
    let proxy = proxy_of(&state);
    let mut out = LockerConnectionStatus {
        storage_configured: s3.is_ok(),
        service_configured: ep.as_ref().is_some_and(|e| !e.secret.is_empty()),
        protocol_version: None,
        service_ready: false,
        storage_verified: false,
        service_verified: false,
        checked_at: now(),
        error: None,
    };
    if let Some(ep) = ep {
        match worker::v2_health(&ep, proxy.as_ref()) {
            Ok(()) => {
                out.protocol_version = Some(2);
                out.service_ready = out.service_configured;
            }
            Err(e) => out.error = Some(e.to_string()),
        }
        if verify == Some(true) {
            ensure_writes_allowed(&state)?;
            if let Ok(s3) = &s3 {
                let path = format!("locker-probes/{}", uuid::Uuid::new_v4());
                let bytes = b"locker-v2-binding-probe";
                let result = (|| -> Result<()> {
                    s3.put_object(&path, bytes)?;
                    out.storage_verified = true;
                    let value: serde_json::Value = worker::v2_json(
                        &ep,
                        "POST",
                        "/v2/probe",
                        Some(
                            &serde_json::json!({"objectKey":s3.full_key(&path),"cipherSize":bytes.len()}),
                        ),
                        true,
                        proxy.as_ref(),
                    )?;
                    if value.get("objectExists").and_then(|v| v.as_bool()) != Some(true) {
                        return Err(AppError::Invalid("服务绑定的存储桶未发现测试对象".into()));
                    }
                    out.service_verified = true;
                    Ok(())
                })();
                let cleaned = s3.delete_object(&path);
                if let Err(e) = result {
                    out.error = Some(e.to_string());
                    out.service_ready = false;
                }
                if let Err(e) = cleaned {
                    out.error = Some(format!("连接测试对象清理失败：{e}"));
                }
            } else {
                out.error = Some("请先配置云存储".into());
            }
        }
    } else if verify == Some(true) {
        if let Ok(s3) = s3 {
            match s3.test_connection() {
                Ok(_) => out.storage_verified = true,
                Err(e) => out.error = Some(e.to_string()),
            }
        }
    }
    ensure_identity(&state, &vault)?;
    Ok(out)
}

#[derive(Serialize)]
pub struct LockerSourceStat {
    name: String,
    size: u64,
}
#[tauri::command(async)]
pub fn locker_source_stat(state: State<'_, AppState>, path: String) -> Result<LockerSourceStat> {
    let (_session, _vault) = capture(&state)?;
    let p = Path::new(&path);
    let meta = std::fs::metadata(p)?;
    if !meta.is_file() || meta.len() > LOCKER_MAX_BYTES {
        return Err(AppError::Invalid("请选择不超过 100 MiB 的普通文件".into()));
    }
    Ok(LockerSourceStat {
        name: file_name_of(&path),
        size: meta.len(),
    })
}

fn destination_check(vault: &Vault, dest: &LockerDestination) -> Result<()> {
    if dest.kind == "vault" {
        if dest.path.is_some() {
            return Err(AppError::Invalid("保险库目标不接受文件路径".into()));
        }
        return Ok(());
    }
    if dest.kind != "disk" {
        return Err(AppError::Invalid("保存目标不正确".into()));
    }
    let p = Path::new(dest.path.as_deref().unwrap_or(""));
    if !p.is_absolute() || p.file_name().is_none() {
        return Err(AppError::Invalid("请选择完整的保存位置".into()));
    }
    if p.starts_with(vault.root()) {
        return Err(AppError::Invalid(
            "不能将明文文件写入加密工作空间目录".into(),
        ));
    }
    if p.exists() || std::fs::symlink_metadata(p).is_ok() {
        return Err(AppError::Invalid(
            "目标文件已存在，请选择一个新文件名，避免覆盖".into(),
        ));
    }
    let parent = p
        .parent()
        .ok_or_else(|| AppError::Invalid("保存目录无效".into()))?;
    std::fs::create_dir_all(parent)?;
    if parent
        .canonicalize()?
        .starts_with(vault.root().canonicalize()?)
    {
        return Err(AppError::Invalid("不能通过链接写入加密工作空间".into()));
    }
    Ok(())
}

fn operation_endpoint(vault: &Vault, op: &StoredOperation) -> Result<Option<WorkerEndpoint>> {
    match op.endpoint_base.as_deref() {
        None => Ok(None),
        Some(base) => {
            if op.public_slug.is_some() {
                Ok(Some(WorkerEndpoint {
                    base: base.into(),
                    secret: String::new(),
                }))
            } else {
                Ok(Some(bound_endpoint(vault, base)?))
            }
        }
    }
}
fn output_hash(path: &Path) -> Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buf = [0; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn commit_current<T>(
    state: &AppState,
    vault: &Vault,
    commit: impl FnOnce() -> Result<T>,
) -> Result<T> {
    ensure_writes_allowed(state)?;
    let live = recover_lock(&state.vault);
    if !live
        .as_ref()
        .is_some_and(|v| v.is_unlocked() && v.workspace_id() == vault.workspace_id())
        || SESSION_EPOCH.with(|e| {
            e.get()
                .is_some_and(|n| n != state.session_epoch.load(Ordering::SeqCst))
        })
    {
        return Err(AppError::Locked);
    }
    commit()
}

/// A remote request may finish after cloud sync changed the local collection.
/// Re-read under the store transaction and compare the exact item observed by
/// that request; never publish the pre-network collection snapshot wholesale.
fn commit_entry_patch(
    state: &AppState,
    vault: &Vault,
    expected: &LockerEntry,
    updated: &LockerEntry,
) -> Result<()> {
    commit_current(state, vault, || {
        store::transaction(vault, || {
            let mut current = store::load_locker(vault)?;
            if current.deleted_entries.contains_key(&expected.id) {
                return Err(AppError::Invalid("LOCKER_LOCAL_CONFLICT: 该寄存已被同步删除，未恢复旧记录；请刷新并核对远端操作结果".into()));
            }
            let item = current.entries.iter_mut().find(|e| e.id == expected.id)
            .ok_or_else(|| AppError::Invalid("LOCKER_LOCAL_CONFLICT: 该寄存已不存在，未恢复旧记录；请刷新并核对远端操作结果".into()))?;
            if item != expected {
                return Err(AppError::Invalid("LOCKER_LOCAL_CONFLICT: 该寄存已被另一操作或同步修改，未覆盖新版本；请刷新并核对远端操作结果".into()));
            }
            *item = updated.clone();
            store::save_locker(vault, &current)
        })
    })
}

fn commit_new_entry(state: &AppState, vault: &Vault, entry: &LockerEntry) -> Result<()> {
    commit_current(state, vault, || {
        store::transaction(vault, || {
            let mut current = store::load_locker(vault)?;
            if current.deleted_entries.contains_key(&entry.id) {
                return Err(AppError::Invalid(
                    "原寄存已被同步删除，不会重新登记旧对象".into(),
                ));
            }
            if let Some(existing) = current.entries.iter().find(|e| e.id == entry.id) {
                if existing != entry {
                    return Err(AppError::Invalid(
                        "原寄存已存在不同版本，请刷新核对，未覆盖当前内容".into(),
                    ));
                }
                return Ok(());
            }
            current.entries.push(entry.clone());
            store::save_locker(vault, &current)
        })
    })
}
fn publish_file(temp: &Path, target: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
        }
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        // WRITE_THROUGH only: no replace, no cross-volume copy fallback.
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 8) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::fs::hard_link(temp, target)?;
        if let Some(parent) = target.parent() {
            std::fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    }
}

fn save_plain(
    state: &AppState,
    vault: &Vault,
    op: &mut StoredOperation,
    key: &[u8; 32],
    cipher: &Path,
) -> Result<()> {
    ensure_current(state, vault)?;
    let dest = op
        .destination
        .clone()
        .ok_or_else(|| AppError::Invalid("缺少原保存目标".into()))?;
    let info = op
        .lookup
        .clone()
        .ok_or_else(|| AppError::Invalid("缺少原文件信息".into()))?;
    // Older journals only recorded an untrusted ciphertext-size estimate.
    // Never silently resume those operations without full-file integrity.
    if info.size_is_estimate {
        return Err(AppError::Invalid(
            "旧领取操作缺少完整性信息，请发送方重新复制分享链接后重新领取".into(),
        ));
    }
    if dest.kind == "vault" {
        let deterministic_id = import_id(vault, &op.view.operation_id);
        if let Some(existing) = store::load_files(vault)?
            .entries
            .iter()
            .find(|e| e.id == deterministic_id)
        {
            if op.output_hash.as_deref() != Some(existing.sha256.as_str()) {
                return Err(AppError::Invalid("原入库目标与保存凭据不匹配".into()));
            }
            op.view.file_id = Some(deterministic_id);
            return Ok(());
        }
        let mut plain = zeroize::Zeroizing::new(Vec::new());
        locker::open_framed(
            std::fs::File::open(cipher)?,
            &mut *plain,
            key,
            if info.size_is_estimate {
                None
            } else {
                Some(info.size)
            },
        )?;
        let limit = crate::app_config::attachment_per_file_limit_bytes(
            recover_lock(&state.config).attachment_per_file_limit_mb,
        )
        .min(LOCKER_MAX_BYTES);
        if plain.len() as u64 > limit {
            plain.zeroize();
            return Err(AppError::Invalid("文件超过保险库附件大小限制".into()));
        }
        commit_current(state, vault, || {
            store::transaction(vault, || {
                let written = blob::write_blob_limited(
                    vault,
                    Cursor::new(plain.as_slice()),
                    DEFAULT_CHUNK_SIZE,
                    limit,
                );
                let written = written?;
                op.output_hash = Some(written.sha256.clone());
                save_operation(vault, op)?;
                let stamp = now();
                let mut entry = FileEntry {
                    id: deterministic_id.clone(),
                    name: info.name,
                    original_name: info.original_name.clone(),
                    mime: guess_mime(&info.original_name),
                    size: written.size,
                    sha256: written.sha256.clone(),
                    attachments: vec![FileAttachment {
                        id: deterministic_id.clone(),
                        original_name: info.original_name.clone(),
                        mime: guess_mime(&info.original_name),
                        size: written.size,
                        sha256: written.sha256,
                    }],
                    group: None,
                    note: None,
                    icon: None,
                    sort_order: 0,
                    created_at: stamp.clone(),
                    updated_at: stamp,
                };
                entry.sync_summary();
                let mut files = store::load_files(vault)?;
                if !files.entries.iter().any(|e| e.id == entry.id) {
                    files.deleted_entries.remove(&entry.id);
                    files.entries.push(entry);
                    store::save_files(vault, &files)?;
                }
                Ok(())
            })
        })?;
        op.view.file_id = Some(deterministic_id);
    } else {
        let target = PathBuf::from(dest.path.as_deref().unwrap_or(""));
        if target.exists() {
            if op
                .output_hash
                .as_ref()
                .is_some_and(|hash| output_hash(&target).ok().as_ref() == Some(hash))
            {
                op.view.dest_path = Some(target.display().to_string());
                return Ok(());
            }
            return Err(AppError::Invalid(
                "保存位置已被其他文件占用，请保留原操作并检查目标".into(),
            ));
        }
        destination_check(vault, &dest)?;
        let temp_path = target
            .parent()
            .unwrap()
            .join(format!(".locker-{}.part", uuid::Uuid::new_v4()));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        let temp = TempPath(temp_path);
        let decoded = locker::open_framed(
            std::fs::File::open(cipher)?,
            &mut file,
            key,
            if info.size_is_estimate {
                None
            } else {
                Some(info.size)
            },
        )?;
        if decoded > LOCKER_MAX_BYTES {
            return Err(AppError::Invalid("文件超过 100 MiB 上限".into()));
        }
        file.flush()?;
        file.sync_all()?;
        drop(file);
        ensure_current(state, vault)?;
        op.output_hash = Some(output_hash(&temp.0)?);
        save_operation(vault, op)?;
        // Atomic no-replace publication. Windows also supports FAT/exFAT here.
        commit_current(state, vault, || publish_file(&temp.0, &target))?;
        op.view.dest_path = Some(target.display().to_string());
    }
    Ok(())
}

fn run_receive(state: &AppState, vault: &Vault, op: &mut StoredOperation) -> Result<()> {
    if op.view.status == "completed" {
        return Ok(());
    }
    let ep = operation_endpoint(vault, op)?;
    let proxy = proxy_of(state);
    let cipher = cipher_path(vault, &op.view.operation_id)?;
    if op.view.status != "saved" {
        ensure_current(state, vault)?;
        if !op.content_ready {
            if let Some(ep) = &ep {
                worker::v2_health(ep, proxy.as_ref())?;
                if let Some(claim) = &op.claim {
                    let current: worker::V2Claim = worker::v2_json(
                        ep,
                        "POST",
                        &format!("/v2/claims/{}/status", op.view.operation_id),
                        Some(&serde_json::json!({"token":claim.token})),
                        false,
                        proxy.as_ref(),
                    )?;
                    if current.operation_id != op.view.operation_id
                        || current.version != op.snapshot
                    {
                        return Err(AppError::Invalid("原领取状态与本机记录不匹配".into()));
                    }
                    if ["cancelled", "expired"].contains(&current.state.as_str()) {
                        op.view.recoverable = false;
                        return Err(AppError::Invalid("原领取已取消或恢复期限结束".into()));
                    }
                    op.view.pulls_left = current.pulls_left;
                    op.claim = Some(current);
                    save_operation(vault, op)?;
                }
                if op.claim.is_none() {
                    set_phase(vault, op, "unknown", "reserving")?;
                    let source = op.source.as_ref().unwrap();
                    let rel = if let Some(slug) = &op.public_slug {
                        format!("/v2/shares/{slug}/claims")
                    } else {
                        format!("/v2/items/{}/claims", op.lookup.as_ref().unwrap().id)
                    };
                    let body = serde_json::json!({"operationId":op.view.operation_id,"expectedVersion":op.snapshot,"code":source.code.as_deref().map(normalize_pickup_code).transpose()?});
                    let claim: worker::V2Claim = worker::v2_json(
                        ep,
                        "POST",
                        &rel,
                        Some(&body),
                        op.public_slug.is_none(),
                        proxy.as_ref(),
                    )?;
                    if claim.operation_id != op.view.operation_id
                        || claim.version != op.snapshot
                        || claim.item_id != op.lookup.as_ref().unwrap().id
                    {
                        return Err(AppError::Invalid("服务返回了不匹配的领取操作".into()));
                    }
                    op.view.pulls_left = claim.pulls_left;
                    op.claim = Some(claim);
                    save_operation(vault, op)?;
                }
                let claim = op.claim.as_ref().unwrap();
                if claim.state == "delivered" {
                    return Err(AppError::Invalid(
                        "服务显示已经交付，但本机缺少保存确认，请核对原目标文件".into(),
                    ));
                }
                let token = claim.token.clone();
                let size = claim.cipher_size;
                set_phase(vault, op, "unknown", "receiving")?;
                worker::v2_content(
                    ep,
                    &op.view.operation_id,
                    &token,
                    &cipher,
                    size,
                    proxy.as_ref(),
                )?;
            } else {
                set_phase(vault, op, "running", "receiving")?;
                let entry = op.entry.as_ref().unwrap();
                let s3 = open_bound_s3(state, vault, op.storage_binding.as_ref())?;
                if !s3.get_object_to_file(&object_subpath(&entry.object_name), &cipher)? {
                    return Err(AppError::Invalid("云端文件不存在".into()));
                }
            }
            op.content_ready = true;
            save_operation(vault, op)?;
        }
        set_phase(vault, op, "running", "saving")?;
        let mut key = if let Some(entry) = &op.entry {
            locker::unwrap_content_key(vault, &entry.wrap_self)?
        } else {
            locker::unwrap_content_key(vault, op.wrapped_key.as_deref().unwrap_or(""))?
        };
        let result = save_plain(state, vault, op, &key, &cipher);
        key.zeroize();
        result?;
        set_phase(vault, op, "saved", "confirming")?;
    }
    if let (Some(ep), Some(claim)) = (&ep, &op.claim) {
        let confirmed: worker::V2Claim = worker::v2_json(
            ep,
            "POST",
            &format!("/v2/claims/{}/ack", op.view.operation_id),
            Some(&serde_json::json!({"token":claim.token})),
            false,
            proxy.as_ref(),
        )?;
        op.view.pulls_left = confirmed.pulls_left;
        op.view.cleanup_status = confirmed.cleanup_status.clone();
        op.claim = Some(confirmed);
    }
    ensure_identity(state, vault)?;
    set_phase(vault, op, "completed", "completed")?;
    op.view.recoverable = false;
    op.view.can_retarget = false;
    op.source = None;
    op.entry = None;
    op.wrapped_key = None;
    op.claim = None;
    save_operation(vault, op)?;
    let _ = std::fs::remove_file(cipher);
    Ok(())
}

fn execute_receive(
    state: &AppState,
    vault: &Vault,
    mut op: StoredOperation,
) -> Result<LockerOperation> {
    if !op.view.recoverable {
        ensure_identity(state, vault)?;
        return Ok(op.view);
    }
    if let Err(e) = run_receive(state, vault, &mut op) {
        if op.view.status != "saved" {
            op.view.status = if op.claim.is_some() || op.view.status == "unknown" {
                "unknown"
            } else {
                "failed"
            }
            .into();
        }
        op.view.error = Some(e.to_string());
        op.view.updated_at = now();
        op.view.can_retarget = op.view.recoverable
            && op.view.status != "saved"
            && op.source.is_some()
            && op.lookup.is_some();
        save_operation(vault, &op)?;
    }
    ensure_identity(state, vault)?;
    Ok(op.view)
}

#[tauri::command(async)]
pub fn locker_receive(
    state: State<'_, AppState>,
    operation_id: String,
    source: LockerSource,
    snapshot_version: String,
    destination: LockerDestination,
    password: Option<String>,
) -> Result<LockerOperation> {
    ensure_writes_allowed(&state)?;
    ensure_reveal_authorized(&state, password.as_deref())?;
    valid_operation(&operation_id)?;
    let (_session, vault) = capture(&state)?;
    let _guard = recover_lock(&MUTATION);
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            &source,
            &snapshot_version,
            &destination
        ))?)
    );
    if let Some(existing) = read_journal(&vault)?.operations.remove(&operation_id) {
        if existing.view.kind != "receive" || existing.fingerprint != fingerprint {
            return Err(AppError::Invalid(
                "操作 ID 已绑定其他文件、版本或保存位置".into(),
            ));
        }
        return execute_receive(&state, &vault, existing);
    }
    let preflight = (|| {
        destination_check(&vault, &destination)?;
        let found = resolve(&state, &vault, &source)?;
        if found.lookup.version != snapshot_version {
            return Err(AppError::Invalid("查询结果已改变，请重新查询".into()));
        }
        Ok(found)
    })();
    let found = match preflight {
        Ok(found) => found,
        Err(e) => {
            let mut op = new_operation(&operation_id, "receive");
            op.fingerprint = fingerprint;
            op.view.status = "failed".into();
            op.view.phase = "validation".into();
            op.view.recoverable = false;
            op.view.error = Some(e.to_string());
            ensure_identity(&state, &vault)?;
            save_operation(&vault, &op)?;
            return Ok(op.view);
        }
    };
    let mut op = new_operation(&operation_id, "receive");
    op.fingerprint = fingerprint;
    op.view.item_id = Some(found.lookup.id.clone());
    op.view.name = Some(found.lookup.name.clone());
    op.source = Some(source);
    op.destination = Some(destination);
    op.snapshot = snapshot_version;
    op.entry = found.entry.clone();
    op.storage_binding = found.entry.as_ref().and_then(|e| e.storage_binding.clone());
    op.lookup = Some(found.lookup.clone());
    op.endpoint_base = found.endpoint.as_ref().map(|e| e.base.clone());
    op.public_slug = found.slug.clone();
    if let Some(key) = &found.key {
        op.wrapped_key = Some(locker::wrap_content_key(&vault, key)?);
    }
    save_operation(&vault, &op)?;
    execute_receive(&state, &vault, op)
}

#[tauri::command(async)]
pub fn locker_operation_status(
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<Option<LockerOperation>> {
    valid_operation(&operation_id)?;
    let (_session, vault) = capture(&state)?;
    let Some(op) = read_journal(&vault)?.operations.remove(&operation_id) else {
        return Ok(None);
    };
    let mut view = op.view.clone();
    if ["unknown", "failed"].contains(&view.status.as_str()) {
        if let (Some(ep), Some(claim)) = (operation_endpoint(&vault, &op)?, op.claim.as_ref()) {
            let status: Result<worker::V2Claim> = worker::v2_json(
                &ep,
                "POST",
                &format!("/v2/claims/{operation_id}/status"),
                Some(&serde_json::json!({"token":claim.token})),
                false,
                proxy_of(&state).as_ref(),
            );
            if let Ok(current) = status {
                view.pulls_left = current.pulls_left;
                view.cleanup_status = current.cleanup_status;
                if ["expired", "cancelled"].contains(&current.state.as_str()) {
                    view.recoverable = false;
                    view.error = Some("原领取已取消或恢复期限结束".into());
                }
            }
        }
    }
    ensure_identity(&state, &vault)?;
    Ok(Some(view))
}
#[derive(Serialize)]
pub struct LockerOperations {
    operations: Vec<LockerOperation>,
}
#[tauri::command(async)]
pub fn locker_operations_list(state: State<'_, AppState>) -> Result<LockerOperations> {
    let (_session, vault) = capture(&state)?;
    let mut operations: Vec<_> = read_journal(&vault)?
        .operations
        .into_values()
        .map(|o| o.view)
        .collect();
    operations.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    ensure_identity(&state, &vault)?;
    Ok(LockerOperations { operations })
}

#[tauri::command(async)]
pub fn locker_operation_resume(
    state: State<'_, AppState>,
    operation_id: String,
    password: Option<String>,
) -> Result<LockerOperation> {
    ensure_writes_allowed(&state)?;
    ensure_reveal_authorized(&state, password.as_deref())?;
    valid_operation(&operation_id)?;
    let (_session, vault) = capture(&state)?;
    let _guard = recover_lock(&MUTATION);
    let op = read_journal(&vault)?
        .operations
        .remove(&operation_id)
        .ok_or_else(|| AppError::Invalid("找不到原操作".into()))?;
    if !op.view.recoverable {
        ensure_identity(&state, &vault)?;
        return Ok(op.view);
    }
    if op.view.kind == "receive" {
        execute_receive(&state, &vault, op)
    } else {
        resume_put(&state, &vault, op)
    }
}

#[tauri::command(async)]
pub fn locker_operation_retarget(
    state: State<'_, AppState>,
    operation_id: String,
    destination: LockerDestination,
    password: Option<String>,
) -> Result<LockerOperation> {
    ensure_writes_allowed(&state)?;
    ensure_reveal_authorized(&state, password.as_deref())?;
    valid_operation(&operation_id)?;
    let (_session, vault) = capture(&state)?;
    let _guard = recover_lock(&MUTATION);
    let op = read_journal(&vault)?
        .operations
        .remove(&operation_id)
        .ok_or_else(|| AppError::Invalid("找不到原领取操作".into()))?;
    retarget(&state, &vault, op, destination)
}
fn retarget(
    state: &AppState,
    vault: &Vault,
    mut op: StoredOperation,
    destination: LockerDestination,
) -> Result<LockerOperation> {
    let operation_id = op.view.operation_id.clone();
    if op.view.kind != "receive"
        || !op.view.recoverable
        || !op.view.can_retarget
        || !["failed", "unknown"].contains(&op.view.status.as_str())
    {
        return Err(AppError::Invalid("该操作不能更改保存目标".into()));
    }
    // A durable target is the publication witness even if the saved journal
    // write was interrupted. Reconcile it before considering another target.
    let published = if let Some(old) = &op.destination {
        if old.kind == "disk" {
            old.path
                .as_deref()
                .and_then(|p| op.output_hash.as_ref().map(|hash| (p, hash)))
                .is_some_and(|(p, hash)| output_hash(Path::new(p)).ok().as_ref() == Some(hash))
        } else {
            store::load_files(&vault)?.entries.iter().any(|e| {
                e.id == import_id(&vault, &operation_id)
                    && op.output_hash.as_deref() == Some(e.sha256.as_str())
            })
        }
    } else {
        false
    };
    if published {
        let old = op.destination.as_ref().unwrap();
        if old.kind == "disk" {
            op.view.dest_path = old.path.clone();
        } else {
            op.view.file_id = Some(import_id(&vault, &operation_id));
        }
        op.view.can_retarget = false;
        set_phase(vault, &mut op, "saved", "confirming")?;
        return execute_receive(state, vault, op);
    }
    destination_check(vault, &destination)?;
    let source = op
        .source
        .as_ref()
        .ok_or_else(|| AppError::Invalid("原领取缺少来源记录".into()))?;
    op.fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(source, &op.snapshot, &destination))?)
    );
    op.destination = Some(destination);
    op.output_hash = None;
    op.view.dest_path = None;
    op.view.file_id = None;
    op.view.can_retarget = false;
    save_operation(vault, &op)?;
    execute_receive(state, vault, op)
}

#[tauri::command(async)]
pub fn locker_clear_history(state: State<'_, AppState>) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let (_session, vault) = capture(&state)?;
    let _guard = recover_lock(&MUTATION);
    let data = store::load_locker(&vault)?;
    for entry in data.entries.iter().filter(|e| e.service.is_some()) {
        let service = entry.service.as_ref().unwrap();
        let ep = bound_endpoint(&vault, &service.base_url)?;
        let meta: worker::V2Metadata = worker::v2_json(
            &ep,
            "GET",
            &format!("/v2/items/{}", entry.id),
            None,
            true,
            proxy_of(&state).as_ref(),
        )?;
        if meta.cleanup_status == "cleaned" && meta.in_flight_claims == 0 {
            // Retain same-machine received ciphertext if ACK succeeded remotely
            // but local disk save has not yet been confirmed.
            let pending = read_journal(&vault)?.operations.values().any(|o| {
                o.view.item_id.as_deref() == Some(&entry.id)
                    && o.view.recoverable
                    && o.view.status != "completed"
            });
            if !pending {
                end_item(&vault, entry, &meta.status, "cleaned", None)?;
            }
        }
    }
    let mut journal = read_journal(&vault)?;
    journal.ended.retain(|e| e.cleanup != "cleaned");
    write_journal(&vault, &journal)
}

#[tauri::command(async)]
pub fn locker_migrate_legacy(
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> Result<()> {
    ensure_writes_allowed(&state)?;
    ensure_reveal_authorized(&state, password.as_deref())?;
    let (_session, vault) = capture(&state)?;
    let _guard = recover_lock(&MUTATION);
    let mut data = store::load_locker(&vault)?;
    let entry = data
        .entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::Invalid("找不到旧寄存文件".into()))?;
    let expected = entry.clone();
    if entry.service.is_some() {
        return Ok(());
    }
    if is_expired(entry.expire_at.as_deref(), &now()) || entry.pulls_left == Some(0) {
        return Err(AppError::Invalid(
            "已到期或次数用尽的旧文件不能迁移增加名额".into(),
        ));
    }
    if read_journal(&vault)?
        .operations
        .values()
        .any(|op| op.view.item_id.as_deref() == Some(&id) && op.view.status != "completed")
    {
        return Err(AppError::Invalid(
            "该文件还有未确认操作，请先处理原操作".into(),
        ));
    }
    let ep = require_share_worker(&vault)?;
    let proxy = proxy_of(&state);
    worker::v2_health(&ep, proxy.as_ref())?;
    let storage_binding = binding(&recover_lock(&state.config))?;
    let s3 = open_bound_s3(&state, &vault, Some(&storage_binding))?;
    let version = format!(
        "{:x}",
        Sha256::digest(format!(
            "locker-migration:{}:{}",
            entry.id, entry.object_name
        ))
    );
    let operation = format!("migrate-{}", entry.id);
    let object = s3.full_key(&object_subpath(&entry.object_name));
    let size = framed_ciphertext_len(entry.size, DEFAULT_CHUNK_SIZE);
    let (meta, origin): (worker::V2Metadata, &str) = if let Some(share) = &entry.share {
        (
            worker::v2_json(
                &ep,
                "POST",
                &format!("/v2/migrate/{}", share.slug),
                Some(
                    &serde_json::json!({"operationId":operation,"itemId":entry.id,"version":version,"expectedObjectKey":object,"expectedCipherSize":size}),
                ),
                true,
                proxy.as_ref(),
            )?,
            "service",
        )
    } else {
        if let (Some(left), Some(max)) = (entry.pulls_left, entry.max_pulls) {
            if left > max {
                return Err(AppError::Invalid("旧寄存次数不一致，请先同步核对".into()));
            }
        }
        (
            worker::v2_json(
                &ep,
                "PUT",
                &format!("/v2/items/{}", entry.id),
                Some(
                    &serde_json::json!({"operationId":operation,"version":version,"objectKey":object,"cipherSize":size,"codeHash":entry.code_hash,"expireAt":entry.expire_at,"maxPulls":entry.max_pulls,"pullsLeft":entry.pulls_left}),
                ),
                true,
                proxy.as_ref(),
            )?,
            "legacyWorkspace",
        )
    };
    if meta.version != version || meta.item_id != entry.id || meta.cipher_size != size {
        return Err(AppError::Invalid(
            "迁移结果与原文件不匹配，已保留原记录".into(),
        ));
    }
    // Private migration must not mint more than its recorded local allowance.
    // Shared migration preserves the service's exact existing authority; stale
    // local estimates must not strand an already-applied remote migration.
    if origin == "legacyWorkspace"
        && entry
            .pulls_left
            .is_some_and(|left| meta.pulls_left.is_none_or(|remote| remote > left))
    {
        return Err(AppError::Invalid(
            "远端剩余次数高于本机记录，请同步核对迁移结果".into(),
        ));
    }
    entry.service = Some(LockerService {
        base_url: ep.base,
        version,
        origin: Some(origin.into()),
    });
    entry.storage_binding = Some(storage_binding);
    entry.pulls_left = meta.pulls_left;
    entry.expire_at = meta.expire_at;
    entry.share = None;
    commit_entry_patch(&state, &vault, &expected, entry)
}

struct HashingReader<R> {
    inner: R,
    hash: Sha256,
}
impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.hash.update(&buf[..n]);
        Ok(n)
    }
}

pub(super) fn ingest<R: Read>(
    state: &AppState,
    vault: &Vault,
    _s3: &S3Client,
    original: &str,
    mime: Option<String>,
    reader: R,
    opts: Option<LockerPutOpts>,
) -> Result<LockerPutOut> {
    let opts = opts.unwrap_or(LockerPutOpts {
        operation_id: None,
        share_requested: false,
        name: None,
        ttl_secs: None,
        permanent: false,
        max_pulls: None,
        unlimited_pulls: false,
    });
    let operation_id = opts
        .operation_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    valid_operation(&operation_id)?;
    let _guard = recover_lock(&MUTATION);
    ensure_current(state, vault)?;
    let policy = resolve_put_policy(
        opts.permanent,
        opts.ttl_secs,
        opts.unlimited_pulls,
        opts.max_pulls,
        time::OffsetDateTime::now_utc(),
    )?;
    let endpoint = load_worker(vault)?.filter(|e| !e.secret.is_empty());
    let proxy = proxy_of(state);
    if policy.max_pulls.is_some() || opts.share_requested {
        let ep = endpoint.as_ref().ok_or_else(|| {
            AppError::Invalid(
                "有限次数寄存需要先连接协议 2 取件服务；仅有云存储时请选择不限次".into(),
            )
        })?;
        worker::v2_health(ep, proxy.as_ref())?;
    }
    let name = display_name(opts.name.clone(), original)?;
    let storage_binding = binding(&recover_lock(&state.config))?;
    let mut reader = HashingReader {
        inner: reader,
        hash: Sha256::new(),
    };
    let mut key = random_content_key();
    let candidate = temp_cipher();
    let size_result = locker::seal_framed_to_path(
        &mut reader,
        &key,
        DEFAULT_CHUNK_SIZE,
        LOCKER_MAX_BYTES,
        &candidate.0,
    );
    let size = match size_result {
        Ok(s) => s,
        Err(e) => {
            key.zeroize();
            return Err(e);
        }
    };
    let digest = format!("{:x}", reader.hash.finalize());
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            original,
            &name,
            &digest,
            opts.permanent,
            opts.ttl_secs,
            opts.unlimited_pulls,
            opts.max_pulls,
            opts.share_requested
        ))?)
    );
    let mut op = if let Some(existing) = read_journal(vault)?.operations.remove(&operation_id) {
        key.zeroize();
        if existing.view.kind != "put" || existing.fingerprint != fingerprint {
            return Err(AppError::Invalid("原操作已绑定不同的文件内容或规则".into()));
        }
        existing
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        let code = random_pickup_code();
        let wrapped = locker::wrap_content_key(vault, &key);
        key.zeroize();
        let service = if policy.max_pulls.is_some() || opts.share_requested {
            endpoint.as_ref().map(|ep| LockerService {
                base_url: ep.base.clone(),
                version: uuid::Uuid::new_v4().to_string(),
                origin: Some("service".into()),
            })
        } else {
            None
        };
        let entry = LockerEntry {
            id: id.clone(),
            name: name.clone(),
            original_name: original.into(),
            mime,
            size,
            object_name: vault.object_name(&logical_path(&id))?,
            pickup_code: code.clone(),
            code_hash: pickup_code_hash(&code),
            wrap_self: wrapped?,
            created_at: now(),
            expire_at: None,
            max_pulls: policy.max_pulls,
            pulls_left: policy.max_pulls,
            share: None,
            service,
            storage_binding: Some(storage_binding),
            share_requested: opts.share_requested,
            share_stopped: false,
            share_error: None,
        };
        let mut op = new_operation(&operation_id, "put");
        op.fingerprint = fingerprint;
        op.view.item_id = Some(id);
        op.view.name = Some(name);
        op.endpoint_base = entry.service.as_ref().map(|s| s.base_url.clone());
        op.entry = Some(entry);
        op.storage_binding = op.entry.as_ref().and_then(|e| e.storage_binding.clone());
        op.ttl_seconds = opts.ttl_secs;
        op.permanent = opts.permanent;
        std::fs::copy(&candidate.0, cipher_path(vault, &operation_id)?)?;
        save_operation(vault, &op)?;
        op
    };
    if op.view.status != "completed" {
        if !op.view.recoverable {
            return Err(AppError::Invalid("原寄存操作已结束，不能重新上传".into()));
        }
        if let Err(e) = run_put(state, vault, &mut op) {
            op.view.status = "unknown".into();
            op.view.error = Some(e.to_string());
            op.view.updated_at = now();
            save_operation(vault, &op)?;
            return Err(e);
        }
    }
    let id = op.view.item_id.clone().unwrap();
    let data = store::load_locker(vault)?;
    let entry = data
        .entries
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::Invalid("原寄存已结束，不能用相同操作再次上传".into()))?;
    ensure_current(state, vault)?;
    Ok(LockerPutOut {
        id,
        code: entry.pickup_code.clone(),
    })
}

fn run_put(state: &AppState, vault: &Vault, op: &mut StoredOperation) -> Result<()> {
    if op.view.status == "completed" {
        return Ok(());
    }
    ensure_current(state, vault)?;
    let expected = op
        .storage_binding
        .as_ref()
        .ok_or_else(|| AppError::Invalid("原寄存缺少存储绑定，不能安全恢复".into()))?;
    let s3 = open_bound_s3(state, vault, Some(expected))?;
    let proxy = proxy_of(state);
    let cipher = cipher_path(vault, &op.view.operation_id)?;
    if op.view.phase == "prepared" || op.view.phase == "uploading" {
        set_phase(vault, op, "unknown", "uploading")?;
        let entry = op.entry.as_ref().unwrap();
        s3.put_object_file(&object_subpath(&entry.object_name), &cipher)?;
        let entry = op.entry.as_mut().unwrap();
        let policy = resolve_put_policy(
            op.permanent,
            op.ttl_seconds,
            entry.max_pulls.is_none(),
            entry.max_pulls,
            time::OffsetDateTime::now_utc(),
        )?;
        entry.created_at = now();
        entry.expire_at = policy.expire_at;
        set_phase(vault, op, "unknown", "registering")?;
    }
    if let Some(entry) = &op.entry {
        if let Some(service) = &entry.service {
            let ep = bound_endpoint(vault, &service.base_url)?;
            worker::v2_health(&ep, proxy.as_ref())?;
            let _: serde_json::Value = worker::v2_json(
                &ep,
                "PUT",
                &format!("/v2/items/{}", entry.id),
                Some(
                    &serde_json::json!({"operationId":op.view.operation_id,"version":service.version,"objectKey":s3.full_key(&object_subpath(&entry.object_name)),"cipherSize":framed_ciphertext_len(entry.size,DEFAULT_CHUNK_SIZE),"codeHash":entry.code_hash,"expireAt":entry.expire_at,"maxPulls":entry.max_pulls,"pullsLeft":entry.pulls_left}),
                ),
                true,
                proxy.as_ref(),
            )?;
        }
    }
    ensure_current(state, vault)?;
    let entry = op.entry.as_ref().unwrap().clone();
    commit_new_entry(state, vault, &entry)?;
    set_phase(vault, op, "completed", "completed")?;
    op.view.recoverable = false;
    op.view.can_retarget = false;
    op.entry = None;
    save_operation(vault, op)?;
    let _ = std::fs::remove_file(cipher);
    Ok(())
}

fn resume_put(state: &AppState, vault: &Vault, mut op: StoredOperation) -> Result<LockerOperation> {
    if op.view.status == "completed" {
        return Ok(op.view);
    }
    if let Err(e) = run_put(state, vault, &mut op) {
        op.view.status = "unknown".into();
        op.view.error = Some(e.to_string());
        op.view.updated_at = now();
        save_operation(vault, &op)?;
    }
    ensure_identity(state, vault)?;
    Ok(op.view)
}

pub(super) fn put_result(
    state: &AppState,
    vault: &Vault,
    operation_id: Option<&str>,
    result: Result<LockerPutOut>,
) -> Result<LockerPutOut> {
    let _guard = recover_lock(&MUTATION);
    if let (Some(id), Err(error)) = (operation_id, &result) {
        if valid_operation(id).is_ok() && !read_journal(vault)?.operations.contains_key(id) {
            ensure_current(state, vault)?;
            let mut op = new_operation(id, "put");
            op.view.status = "failed".into();
            op.view.phase = "validation".into();
            op.view.recoverable = false;
            op.view.error = Some(error.to_string());
            save_operation(vault, &op)?;
        }
    }
    result
}

pub(super) fn end_item(
    vault: &Vault,
    entry: &LockerEntry,
    reason: &str,
    cleanup: &str,
    error: Option<String>,
) -> Result<()> {
    store::transaction(vault, || {
        end_item_transaction(vault, entry, reason, cleanup, error)
    })
}

fn end_item_transaction(
    vault: &Vault,
    entry: &LockerEntry,
    reason: &str,
    cleanup: &str,
    error: Option<String>,
) -> Result<()> {
    let mut data = store::load_locker(vault)?;
    if let Some(current) = data.entries.iter().find(|e| e.id == entry.id) {
        if current != entry {
            return Err(AppError::Invalid(
                "寄存已被同步修改，未删除变更后的文件，请刷新核对".into(),
            ));
        }
    }
    let mut journal = read_journal(vault)?;
    if let Some(found) = journal.ended.iter_mut().find(|e| e.id == entry.id) {
        found.cleanup = cleanup.into();
        found.error = error;
    } else {
        journal.ended.push(Ended {
            id: entry.id.clone(),
            name: entry.name.clone(),
            original_name: entry.original_name.clone(),
            mime: entry.mime.clone(),
            size: entry.size,
            created_at: entry.created_at.clone(),
            expire_at: entry.expire_at.clone(),
            max_pulls: entry.max_pulls,
            pulls_left: entry.pulls_left,
            ended_at: now(),
            reason: reason.into(),
            cleanup: cleanup.into(),
            error,
            object_name: entry.object_name.clone(),
            service: entry.service.clone(),
            storage_binding: entry.storage_binding.clone(),
        });
    }
    journal.share_intents.remove(&entry.id);
    for op in journal
        .operations
        .values_mut()
        .filter(|op| op.view.item_id.as_deref() == Some(&entry.id))
    {
        op.source = None;
        op.entry = None;
        op.wrapped_key = None;
        op.claim = None;
        op.view.recoverable = false;
        if op.view.status != "completed" {
            op.view.status = "failed".into();
            op.view.phase = "deleted".into();
            op.view.error = Some("寄存文件已删除，原领取恢复已停止".into());
        }
        if let Ok(path) = cipher_path(vault, &op.view.operation_id) {
            let _ = std::fs::remove_file(path);
        }
    }
    write_journal(vault, &journal)?;
    data.entries.retain(|e| e.id != entry.id);
    data.deleted_entries.insert(entry.id.clone(), now());
    store::save_locker(vault, &data)
}

fn ended_view(e: &Ended) -> LockerView {
    LockerView {
        id: e.id.clone(),
        name: e.name.clone(),
        original_name: e.original_name.clone(),
        mime: e.mime.clone(),
        size: e.size,
        created_at: e.created_at.clone(),
        expire_at: e.expire_at.clone(),
        max_pulls: e.max_pulls,
        pulls_left: e.pulls_left,
        share: None,
        access_status: e.reason.clone(),
        cleanup_status: e.cleanup.clone(),
        sync_status: if e.error.is_some() {
            "unknown"
        } else {
            "confirmed"
        }
        .into(),
        legacy: e.service.is_none(),
        ended_at: Some(e.ended_at.clone()),
        last_error: e.error.clone(),
        quota_origin: e
            .service
            .as_ref()
            .map(|s| s.origin.clone().unwrap_or_else(|| "service".into())),
        in_flight_claims: 0,
        share_status: "stopped".into(),
        share_requested: false,
        share_error: None,
    }
}

pub(super) fn list(state: &AppState, vault: &Vault) -> Result<LockerListOut> {
    // Listing never deletes remote data. Cleanup is explicit/retried separately;
    // the service's TTL gate remains authoritative even while the client is off.
    let data = store::load_locker(vault)?;
    let journal = read_journal(vault)?;
    let proxy = proxy_of(state);
    let mut entries = Vec::new();
    let mut retired = Vec::new();
    for entry in &data.entries {
        if journal.ended.iter().any(|e| e.id == entry.id) {
            continue;
        }
        let mut view = view_of(entry);
        if let Some(service) = &entry.service {
            let fetched = (|| -> Result<worker::V2Metadata> {
                let ep = bound_endpoint(vault, &service.base_url)?;
                worker::v2_json(
                    &ep,
                    "GET",
                    &format!("/v2/items/{}", entry.id),
                    None,
                    true,
                    proxy.as_ref(),
                )
            })();
            match fetched {
                Ok(meta) => {
                    if meta.item_id != entry.id || meta.version != service.version {
                        view.sync_status = "unknown".into();
                        view.last_error = Some("服务端文件版本与本机记录不匹配".into());
                        entries.push(view);
                        continue;
                    }
                    view.pulls_left = meta.pulls_left;
                    view.in_flight_claims = meta.in_flight_claims;
                    view.access_status = meta.status;
                    view.cleanup_status = meta.cleanup_status;
                    view.sync_status = "confirmed".into();
                    view.share = meta.share_slug.map(|slug| ShareMeta {
                        slug,
                        registered_at: entry
                            .share
                            .as_ref()
                            .map(|s| s.registered_at.clone())
                            .unwrap_or_else(now),
                    });
                    if view.share.is_some() {
                        view.share_status = "active".into();
                        view.share_error = None;
                    } else if view.share_status == "active" {
                        view.share_status = "stopped".into();
                    }
                    if view.access_status != "active" {
                        view.ended_at = Some(entry.expire_at.clone().unwrap_or_else(now));
                    }
                    if view.cleanup_status == "cleaned" && view.in_flight_claims == 0 {
                        retired.push((entry.clone(), view.access_status.clone()));
                    }
                }
                Err(e) => {
                    view.last_error = Some(e.to_string());
                    view.sync_status = "unknown".into();
                }
            }
        } else if view.access_status != "active" {
            view.cleanup_status = "pending".into();
            view.ended_at = Some(entry.expire_at.clone().unwrap_or_else(now));
        }
        entries.push(view);
    }
    let cutoff = (time::OffsetDateTime::now_utc() - time::Duration::days(7))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    if let Ok(_guard) = MUTATION.try_lock() {
        if ensure_current(state, vault).is_ok() {
            for (entry, reason) in retired {
                let pending = read_journal(vault)?.operations.values().any(|o| {
                    o.view.item_id.as_deref() == Some(&entry.id)
                        && o.view.recoverable
                        && o.view.status != "completed"
                });
                if !pending {
                    end_item(vault, &entry, &reason, "cleaned", None)?;
                    entries.retain(|e| e.id != entry.id);
                }
            }
        }
    }
    let journal = read_journal(vault)?;
    entries.extend(
        journal
            .ended
            .iter()
            .filter(|e| e.cleanup != "cleaned" || e.ended_at >= cutoff)
            .map(ended_view),
    );
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    ensure_identity(state, vault)?;
    Ok(LockerListOut { entries })
}

pub(super) fn stop_share(state: &AppState, vault: &Vault, id: &str) -> Result<()> {
    let _guard = recover_lock(&MUTATION);
    ensure_current(state, vault)?;
    let mut data = store::load_locker(vault)?;
    let entry = data
        .entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::Invalid("找不到该寄存文件".into()))?;
    let expected = entry.clone();
    if entry.share.is_none() && entry.service.is_none() {
        return Ok(());
    }
    let service = entry.service.as_ref().ok_or_else(|| {
        AppError::Invalid("旧分享服务的吊销会删除文件。请先迁移到协议 2，当前未执行任何删除".into())
    })?;
    let ep = bound_endpoint(vault, &service.base_url)?;
    let proxy = proxy_of(state);
    worker::v2_health(&ep, proxy.as_ref())?;
    let meta: worker::V2Metadata = worker::v2_json(
        &ep,
        "GET",
        &format!("/v2/items/{}", entry.id),
        None,
        true,
        proxy.as_ref(),
    )?;
    let Some(slug) = meta.share_slug else {
        entry.share = None;
        entry.share_requested = false;
        entry.share_stopped = true;
        entry.share_error = None;
        return commit_entry_patch(state, vault, &expected, entry);
    };
    let opid = format!("stop-{}-{slug}", entry.id);
    let _: serde_json::Value = worker::v2_json(
        &ep,
        "DELETE",
        &format!("/v2/items/{}/share", entry.id),
        Some(&serde_json::json!({"operationId":opid})),
        true,
        proxy.as_ref(),
    )?;
    ensure_current(state, vault)?;
    entry.share = None;
    entry.share_requested = false;
    entry.share_stopped = true;
    entry.share_error = None;
    commit_entry_patch(state, vault, &expected, entry)?;
    let mut journal = read_journal(vault)?;
    journal.share_intents.remove(id);
    write_journal(vault, &journal)
}

pub(super) fn delete(state: &AppState, vault: &Vault, id: &str) -> Result<()> {
    let _guard = recover_lock(&MUTATION);
    ensure_current(state, vault)?;
    let data = store::load_locker(vault)?;
    if let Some(entry) = data.entries.iter().find(|e| e.id == id) {
        if entry.share.is_some() && entry.service.is_none() {
            return Err(AppError::Invalid(
                "旧分享项需先迁移取件服务再删除，避免删除状态无法确认".into(),
            ));
        }
        // Durable intent hides secrets and prevents new local reads before remote
        // work. A failed request stays visible as pending cleanup, never success.
        end_item(vault, entry, "deleted", "pending", None)?;
    }
    cleanup(state, vault, id)
}

fn cleanup(state: &AppState, vault: &Vault, id: &str) -> Result<()> {
    let mut journal = read_journal(vault)?;
    let Some(index) = journal.ended.iter().position(|e| e.id == id) else {
        return Ok(());
    };
    let ended = journal.ended[index].clone();
    let result = (|| -> Result<String> {
        if let Some(service) = &ended.service {
            let ep = bound_endpoint(vault, &service.base_url)?;
            let proxy = proxy_of(state);
            worker::v2_health(&ep, proxy.as_ref())?;
            let result: serde_json::Value = worker::v2_json(
                &ep,
                "DELETE",
                &format!("/v2/items/{}", ended.id),
                Some(&serde_json::json!({"operationId":format!("delete-{}",ended.id)})),
                true,
                proxy.as_ref(),
            )?;
            Ok(result
                .get("cleanupStatus")
                .and_then(|v| v.as_str())
                .unwrap_or("pending")
                .into())
        } else {
            open_bound_s3(state, vault, ended.storage_binding.as_ref())?
                .delete_object(&object_subpath(&ended.object_name))?;
            Ok("cleaned".into())
        }
    })();
    match result {
        Ok(status) => {
            journal.ended[index].cleanup = status;
            journal.ended[index].error = None;
        }
        Err(e) => {
            journal.ended[index].cleanup = "failed".into();
            journal.ended[index].error = Some(e.to_string());
        }
    }
    write_journal(vault, &journal)
}

pub(super) fn share(
    state: &AppState,
    vault: &Vault,
    id: &str,
    password: Option<&str>,
) -> Result<LockerShareOut> {
    let _guard = recover_lock(&MUTATION);
    ensure_current(state, vault)?;
    let mut data = store::load_locker(vault)?;
    let entry = data
        .entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::Invalid("找不到该寄存文件".into()))?;
    let expected = entry.clone();
    if is_expired(entry.expire_at.as_deref(), &now()) || entry.pulls_left == Some(0) {
        return Err(AppError::Invalid("该寄存已到期或次数用尽".into()));
    }
    if entry.share.is_some() {
        ensure_reveal_authorized(state, password)?;
    }
    let ep = require_share_worker(vault)?;
    let proxy = proxy_of(state);
    worker::v2_health(&ep, proxy.as_ref())?;
    if entry.service.is_none() {
        if entry.max_pulls.is_some() {
            return Err(AppError::Invalid(
                "旧有限次数寄存无法用本地旧次数创建新权威记录，请先迁移".into(),
            ));
        }
        let service = LockerService {
            base_url: ep.base.clone(),
            version: format!(
                "{:x}",
                Sha256::digest(format!("locker-upgrade:{}:{}", entry.id, entry.object_name))
            ),
            origin: Some("service".into()),
        };
        let s3 = open_bound_s3(state, vault, entry.storage_binding.as_ref())?;
        let _: serde_json::Value = worker::v2_json(
            &ep,
            "PUT",
            &format!("/v2/items/{}", entry.id),
            Some(
                &serde_json::json!({"operationId":format!("upgrade-{}",entry.id),"version":service.version,"objectKey":s3.full_key(&object_subpath(&entry.object_name)),"cipherSize":framed_ciphertext_len(entry.size,DEFAULT_CHUNK_SIZE),"codeHash":entry.code_hash,"expireAt":entry.expire_at,"maxPulls":entry.max_pulls,"pullsLeft":entry.pulls_left}),
            ),
            true,
            proxy.as_ref(),
        )?;
        entry.service = Some(service);
        commit_entry_patch(state, vault, &expected, entry)?;
        return share_locked(state, vault, id, password);
    }
    share_with_data(state, vault, &mut data, id)
}
fn share_locked(
    state: &AppState,
    vault: &Vault,
    id: &str,
    _password: Option<&str>,
) -> Result<LockerShareOut> {
    let mut data = store::load_locker(vault)?;
    share_with_data(state, vault, &mut data, id)
}
fn share_with_data(
    state: &AppState,
    vault: &Vault,
    data: &mut crate::model::LockerData,
    id: &str,
) -> Result<LockerShareOut> {
    let entry = data.entries.iter_mut().find(|e| e.id == id).unwrap();
    let expected = entry.clone();
    let service = entry.service.as_ref().unwrap();
    let ep = bound_endpoint(vault, &service.base_url)?;
    let proxy = proxy_of(state);
    let meta: worker::V2Metadata = worker::v2_json(
        &ep,
        "GET",
        &format!("/v2/items/{}", id),
        None,
        true,
        proxy.as_ref(),
    )?;
    let mut journal = read_journal(vault)?;
    let slug = if let Some(slug) = meta.share_slug {
        journal.share_intents.remove(id);
        write_journal(vault, &journal)?;
        slug
    } else {
        let (operation, slug) = journal
            .share_intents
            .entry(id.into())
            .or_insert_with(|| (uuid::Uuid::new_v4().to_string(), random_slug()))
            .clone();
        write_journal(vault, &journal)?;
        let result: Result<serde_json::Value> = worker::v2_json(
            &ep,
            "POST",
            &format!("/v2/items/{id}/share"),
            Some(&serde_json::json!({"operationId":operation,"slug":slug})),
            true,
            proxy.as_ref(),
        );
        if result
            .as_ref()
            .is_err_and(|e| e.to_string().contains("share_stopped"))
        {
            journal.share_intents.remove(id);
            write_journal(vault, &journal)?;
        }
        result?;
        journal.share_intents.remove(id);
        write_journal(vault, &journal)?;
        slug
    };
    let mut key = locker::unwrap_content_key(vault, &entry.wrap_self)?;
    let url = share_link(&ep.base, &slug, &key, &entry.original_name, entry.size)?;
    key.zeroize();
    entry.share = Some(ShareMeta {
        slug: slug.clone(),
        registered_at: now(),
    });
    entry.share_requested = true;
    entry.share_stopped = false;
    entry.share_error = None;
    ensure_current(state, vault)?;
    commit_entry_patch(state, vault, &expected, entry)?;
    Ok(LockerShareOut { url, slug })
}

pub(super) fn share_failed(state: &AppState, vault: &Vault, id: &str, error: &AppError) {
    if matches!(error, AppError::Invalid(message) if message.starts_with("LOCKER_LOCAL_CONFLICT:"))
        || matches!(
            error,
            AppError::NeedReauth | AppError::Locked | AppError::Busy
        )
    {
        return;
    }
    let _guard = recover_lock(&MUTATION);
    if ensure_current(state, vault).is_err() {
        return;
    }
    let _ = store::transaction(vault, || {
        let mut data = store::load_locker(vault)?;
        if let Some(entry) = data.entries.iter_mut().find(|e| e.id == id) {
            entry.share_requested = true;
            entry.share_error = Some(error.to_string());
            store::save_locker(vault, &data)?;
        }
        Ok(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::thread;

    struct Fixture {
        root: PathBuf,
        vault: Vault,
        state: AppState,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("locker-v2-test-{}", uuid::Uuid::new_v4()));
            let (vault, _) = Vault::init(
                &root.join("vault"),
                "test-only-password",
                crate::vault::header::KdfParams::new(
                    crate::vault::kdf::MEM_FLOOR_KIB,
                    crate::vault::kdf::ITERS_FLOOR,
                    1,
                ),
            )
            .unwrap();
            let state = AppState::new();
            *recover_lock(&state.config) = crate::app_config::AppConfig::default();
            *recover_lock(&state.vault) = Some(vault.clone());
            Self { root, vault, state }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            assert!(self
                .root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("locker-v2-test-"));
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn serve(
        responses: Vec<(String, u16, Vec<u8>)>,
    ) -> (String, Arc<AtomicUsize>, thread::JoinHandle<()>) {
        serve_hook(responses, |_| {})
    }
    fn serve_hook(
        responses: Vec<(String, u16, Vec<u8>)>,
        before_response: impl Fn(&str) + Send + 'static,
    ) -> (String, Arc<AtomicUsize>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let count = Arc::new(AtomicUsize::new(0));
        let n = count.clone();
        let handle = thread::spawn(move || {
            for (route, status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                    .unwrap();
                let mut received = Vec::new();
                let mut byte = [0];
                while !received.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    received.push(byte[0]);
                }
                let head = String::from_utf8(received).unwrap();
                assert_eq!(
                    head.lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap(),
                    route
                );
                let length = head
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                let mut request_body = vec![0; length];
                stream.read_exact(&mut request_body).unwrap();
                before_response(&route);
                n.fetch_add(1, Ordering::SeqCst);
                write!(stream,"HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                stream.write_all(&body).unwrap();
                stream.flush().unwrap();
            }
        });
        (base, count, handle)
    }
    fn json(v: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&v).unwrap()
    }
    fn test_op(f: &Fixture, base: &str, kind: &str) -> (StoredOperation, [u8; 32], Vec<u8>) {
        let id = uuid::Uuid::new_v4().to_string();
        let mut op = new_operation(&id, "receive");
        let key = [7; 32];
        let plain = "synthetic secret 内容\n".as_bytes().to_vec();
        let info = LockerLookup {
            id: "test-item-123".into(),
            name: "测试文件".into(),
            original_name: "test.txt".into(),
            size: plain.len() as u64,
            size_is_estimate: false,
            expire_at: None,
            max_pulls: Some(1),
            pulls_left: Some(1),
            version: "version-test-123".into(),
            source: "share".into(),
            protocol_version: 2,
            legacy: false,
            quota_origin: Some("service".into()),
            in_flight_claims: 0,
        };
        op.source = Some(LockerSource {
            id: None,
            code: Some("123456".into()),
            share_url: Some(
                share_link(&base, "ABCDEFGHIJ", &key, "test.txt", plain.len() as u64).unwrap(),
            ),
        });
        op.snapshot = info.version.clone();
        op.view.item_id = Some(info.id.clone());
        op.lookup = Some(info);
        op.endpoint_base = Some(base.into());
        op.public_slug = Some("ABCDEFGHIJ".into());
        op.wrapped_key = Some(locker::wrap_content_key(&f.vault, &key).unwrap());
        op.destination = Some(LockerDestination {
            kind: kind.into(),
            path: if kind == "disk" {
                Some(f.root.join("saved.txt").display().to_string())
            } else {
                None
            },
        });
        (op, key, plain)
    }

    #[test]
    fn journal_is_encrypted_and_bound_to_workspace() {
        let f = Fixture::new();
        let (op, _, _) = test_op(&f, "https://example.invalid", "disk");
        save_operation(&f.vault, &op).unwrap();
        let raw = std::fs::read(journal_path(&f.vault)).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("123456"));
        assert!(!String::from_utf8_lossy(&raw).contains("example.invalid"));
        assert_eq!(read_journal(&f.vault).unwrap().operations.len(), 1);
        let other = Fixture::new();
        std::fs::copy(journal_path(&f.vault), journal_path(&other.vault)).unwrap();
        assert!(read_journal(&other.vault).is_err());
    }

    #[test]
    fn durable_file_then_lost_ack_resumes_without_second_content_request() {
        let f = Fixture::new();
        let (mut op, key, plain) = test_op(&f, "http://localhost", "disk");
        let mut cipher = Vec::new();
        locker::seal_framed(
            Cursor::new(&plain),
            &mut cipher,
            &key,
            DEFAULT_CHUNK_SIZE,
            LOCKER_MAX_BYTES,
        )
        .unwrap();
        let claim = serde_json::json!({"operationId":op.view.operation_id,"token":"abcd1234","itemId":"test-item-123","version":"version-test-123","state":"reserved","recoveryUntil":"2099-01-01T00:00:00Z","attempts":0,"pullsLeft":0,"cipherSize":cipher.len(),"cleanupStatus":"none"});
        let mut ack = claim.clone();
        ack["state"] = "delivered".into();
        ack["cleanupStatus"] = "cleaned".into();
        let (base, count, server) = serve(vec![
            (
                "/v2/health".into(),
                200,
                json(
                    serde_json::json!({"service":"file-locker","ok":true,"protocolVersion":2,"schemaVersion":2,"capabilities":["private-items","lookup","claims","resume","stop-share","cleanup-status"]}),
                ),
            ),
            ("/v2/shares/ABCDEFGHIJ/claims".into(), 200, json(claim)),
            (
                format!("/v2/claims/{}/content", op.view.operation_id),
                200,
                cipher,
            ),
            (
                format!("/v2/claims/{}/ack", op.view.operation_id),
                503,
                json(serde_json::json!({"error":"temporary"})),
            ),
            (
                format!("/v2/claims/{}/ack", op.view.operation_id),
                200,
                json(ack),
            ),
        ]);
        op.endpoint_base = Some(base);
        save_operation(&f.vault, &op).unwrap();
        let first = execute_receive(&f.state, &f.vault, op.clone()).unwrap();
        assert_eq!(first.status, "saved");
        assert!(first.error.is_some());
        assert_eq!(std::fs::read(f.root.join("saved.txt")).unwrap(), plain);
        // Process-style recovery loads only encrypted persisted operation state.
        let resumed = read_journal(&f.vault)
            .unwrap()
            .operations
            .remove(&op.view.operation_id)
            .unwrap();
        let done = execute_receive(&f.state, &f.vault, resumed).unwrap();
        assert_eq!(done.status, "completed");
        assert_eq!(done.cleanup_status.as_deref(), Some("cleaned"));
        server.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 5);
        let closed = read_journal(&f.vault)
            .unwrap()
            .operations
            .remove(&op.view.operation_id)
            .unwrap();
        assert!(closed.wrapped_key.is_none());
        assert!(closed.source.is_none());
        assert!(closed.claim.is_none());
        assert!(!cipher_path(&f.vault, &op.view.operation_id)
            .unwrap()
            .exists());
    }

    #[test]
    fn direct_vault_import_is_idempotent_and_survives_journal_gap() {
        let f = Fixture::new();
        let (mut op, key, plain) = test_op(&f, "http://localhost", "vault");
        let cipher = cipher_path(&f.vault, &op.view.operation_id).unwrap();
        locker::seal_framed_to_path(
            Cursor::new(&plain),
            &key,
            DEFAULT_CHUNK_SIZE,
            LOCKER_MAX_BYTES,
            &cipher,
        )
        .unwrap();
        save_plain(&f.state, &f.vault, &mut op, &key, &cipher).unwrap();
        let first = op.view.file_id.clone();
        op.view.file_id = None;
        save_plain(&f.state, &f.vault, &mut op, &key, &cipher).unwrap();
        assert_eq!(first, op.view.file_id);
        let files = store::load_files(&f.vault).unwrap();
        assert_eq!(files.entries.len(), 1);
        let bytes = blob::read_blob_bytes(&f.vault, &files.entries[0].sha256).unwrap();
        assert_eq!(bytes, plain);
    }

    #[test]
    fn file_target_never_overwrites_existing_content_and_lock_blocks_save() {
        let f = Fixture::new();
        let (mut op, key, plain) = test_op(&f, "http://localhost", "disk");
        let cipher = cipher_path(&f.vault, &op.view.operation_id).unwrap();
        locker::seal_framed_to_path(
            Cursor::new(&plain),
            &key,
            DEFAULT_CHUNK_SIZE,
            LOCKER_MAX_BYTES,
            &cipher,
        )
        .unwrap();
        std::fs::write(f.root.join("saved.txt"), b"keep user's existing data").unwrap();
        assert!(save_plain(&f.state, &f.vault, &mut op, &key, &cipher).is_err());
        assert_eq!(
            std::fs::read(f.root.join("saved.txt")).unwrap(),
            b"keep user's existing data"
        );
        std::fs::remove_file(f.root.join("saved.txt")).unwrap();
        recover_lock(&f.state.vault).as_mut().unwrap().lock();
        assert!(save_plain(&f.state, &f.vault, &mut op, &key, &cipher).is_err());
        assert!(!f.root.join("saved.txt").exists());
    }

    #[test]
    fn rapid_lock_and_reunlock_invalidates_old_operation_epoch() {
        let f = Fixture::new();
        let (_session, snapshot) = capture(&f.state).unwrap();
        assert!(ensure_current(&f.state, &snapshot).is_ok());
        {
            let mut live = recover_lock(&f.state.vault);
            f.state.session_epoch.fetch_add(1, Ordering::SeqCst);
            live.as_mut().unwrap().lock();
            *live = Some(f.vault.clone());
        }
        assert!(matches!(
            ensure_current(&f.state, &snapshot),
            Err(AppError::Locked)
        ));
    }

    #[test]
    fn external_link_parser_preserves_fragment_locally_and_rejects_ambiguous_sources() {
        let key = [19; 32];
        let url = share_link(
            "https://example.com/prefix",
            "ABCDEFGHIJ",
            &key,
            "../../文件.txt",
            123,
        )
        .unwrap();
        let (ep, slug, decoded, name, size) = parse_share(&url).unwrap();
        assert_eq!(ep.base, "https://example.com/prefix");
        assert_eq!(slug, "ABCDEFGHIJ");
        assert_eq!(decoded, key);
        assert_eq!(name, "文件.txt");
        assert_eq!(size, 123);
        assert!(!ep.base.contains('#'));
        assert!(parse_share("https://example.com/d/ABCDEFGHIJ").is_err());
        assert!(parse_share(&url.replace("example.com", "user:password@example.com")).is_err());
        assert!(source_shape(&LockerSource {
            id: Some("x".into()),
            code: Some("123456".into()),
            share_url: None
        })
        .is_err());
        assert_eq!(normalize_pickup_code("１２３ ４５６").unwrap(), "123456");
        assert!(normalize_pickup_code("a123456").is_err());
    }

    fn entry(base: &str, key: &[u8; 32], vault: &Vault) -> LockerEntry {
        LockerEntry {
            id: uuid::Uuid::new_v4().to_string(),
            name: "handoff".into(),
            original_name: "handoff.txt".into(),
            mime: None,
            size: 4,
            object_name: "opaque-object".into(),
            pickup_code: "123456".into(),
            code_hash: pickup_code_hash("123456"),
            wrap_self: locker::wrap_content_key(vault, key).unwrap(),
            created_at: now(),
            expire_at: None,
            max_pulls: Some(3),
            pulls_left: Some(2),
            share: Some(ShareMeta {
                slug: "ABCDEFGHIJ".into(),
                registered_at: now(),
            }),
            service: Some(LockerService {
                base_url: base.into(),
                version: "item-version-123".into(),
                origin: Some("service".into()),
            }),
            storage_binding: None,
            share_requested: true,
            share_stopped: false,
            share_error: None,
        }
    }
    fn health() -> Vec<u8> {
        json(
            serde_json::json!({"service":"file-locker","ok":true,"protocolVersion":2,"schemaVersion":2,"capabilities":["private-items","lookup","claims","resume","stop-share","cleanup-status"]}),
        )
    }

    #[test]
    fn stop_sharing_uses_safe_route_keeps_file_key_and_rejects_legacy_service() {
        let f = Fixture::new();
        let mut e = entry("http://localhost", &[8; 32], &f.vault);
        let meta = serde_json::json!({"itemId":e.id,"version":"item-version-123","cipherSize":53,"expireAt":null,"maxPulls":3,"pullsLeft":2,"status":"active","cleanupStatus":"none","shareSlug":"ABCDEFGHIJ"});
        let (base, count, server) = serve(vec![
            ("/v2/health".into(), 200, health()),
            (format!("/v2/items/{}", e.id), 200, json(meta)),
            (
                format!("/v2/items/{}/share", e.id),
                200,
                json(serde_json::json!({"ok":true})),
            ),
        ]);
        e.service.as_mut().unwrap().base_url = base.clone();
        let mut secrets = store::load_secrets(&f.vault).unwrap();
        secrets.locker_worker_base_url = Some(base);
        secrets.locker_worker_secret = Some("test-service-owner-secret".into());
        store::save_secrets(&f.vault, &secrets).unwrap();
        let mut data = store::load_locker(&f.vault).unwrap();
        data.entries.push(e.clone());
        store::save_locker(&f.vault, &data).unwrap();
        stop_share(&f.state, &f.vault, &e.id).unwrap();
        server.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 3);
        let current = store::load_locker(&f.vault).unwrap().entries.remove(0);
        assert!(current.share.is_none());
        assert_eq!(current.wrap_self, e.wrap_self);
        assert_eq!(current.object_name, e.object_name);
        assert_eq!(current.pulls_left, Some(2));
        e.service = None;
        data.entries = vec![e.clone()];
        store::save_locker(&f.vault, &data).unwrap();
        assert!(stop_share(&f.state, &f.vault, &e.id).is_err());
        assert!(store::load_locker(&f.vault).unwrap().entries[0]
            .share
            .is_some());
    }

    #[test]
    fn explicit_delete_retires_pending_operation_secrets_and_encrypted_recovery() {
        let f = Fixture::new();
        let e = entry("https://example.invalid", &[8; 32], &f.vault);
        let mut data = store::load_locker(&f.vault).unwrap();
        data.entries.push(e.clone());
        store::save_locker(&f.vault, &data).unwrap();
        let (mut op, _, _) = test_op(&f, "https://example.invalid", "disk");
        op.view.item_id = Some(e.id.clone());
        op.entry = Some(e.clone());
        save_operation(&f.vault, &op).unwrap();
        let path = cipher_path(&f.vault, &op.view.operation_id).unwrap();
        std::fs::write(&path, b"encrypted fixture").unwrap();
        end_item(&f.vault, &e, "deleted", "pending", None).unwrap();
        let journal = read_journal(&f.vault).unwrap();
        let retired = journal.operations.get(&op.view.operation_id).unwrap();
        assert!(!retired.view.recoverable);
        assert!(retired.entry.is_none());
        assert!(retired.source.is_none());
        assert!(retired.wrapped_key.is_none());
        assert!(!path.exists());
        assert!(store::load_locker(&f.vault).unwrap().entries.is_empty());
        assert!(!serde_json::to_string(&journal).unwrap().contains("123456"));
        assert_eq!(journal.ended[0].cleanup, "pending");
    }

    #[test]
    fn definitive_put_validation_failure_has_nonrecoverable_record() {
        let f = Fixture::new();
        let id = uuid::Uuid::new_v4().to_string();
        let result = put_result(
            &f.state,
            &f.vault,
            Some(&id),
            Err(AppError::Invalid("file missing".into())),
        );
        assert!(result.is_err());
        let op = read_journal(&f.vault)
            .unwrap()
            .operations
            .remove(&id)
            .unwrap();
        assert_eq!(op.view.status, "failed");
        assert_eq!(op.view.phase, "validation");
        assert!(!op.view.recoverable);
        assert!(op.entry.is_none());
    }

    #[test]
    fn remote_stop_completion_preserves_concurrent_sync_addition_and_deletion() {
        let f = Fixture::new();
        let mut target = entry("http://localhost", &[8; 32], &f.vault);
        let unrelated = entry("https://unrelated.invalid", &[5; 32], &f.vault);
        let added = entry("https://new.invalid", &[6; 32], &f.vault);
        let added_id = added.id.clone();
        let unrelated_id = unrelated.id.clone();
        let vault = f.vault.clone();
        let removed = unrelated_id.clone();
        let meta = serde_json::json!({"itemId":target.id,"version":"item-version-123","cipherSize":53,"expireAt":null,"maxPulls":3,"pullsLeft":2,"status":"active","cleanupStatus":"none","shareSlug":"ABCDEFGHIJ"});
        let (base, _, server) = serve_hook(
            vec![
                ("/v2/health".into(), 200, health()),
                (format!("/v2/items/{}", target.id), 200, json(meta)),
                (
                    format!("/v2/items/{}/share", target.id),
                    200,
                    json(serde_json::json!({"ok":true})),
                ),
            ],
            move |route| {
                if route.ends_with("/share") {
                    store::transaction(&vault, || {
                        let mut latest = store::load_locker(&vault)?;
                        latest.entries.retain(|e| e.id != removed);
                        latest.deleted_entries.insert(removed.clone(), now());
                        latest.entries.push(added.clone());
                        store::save_locker(&vault, &latest)
                    })
                    .unwrap();
                }
            },
        );
        target.service.as_mut().unwrap().base_url = base.clone();
        let mut secrets = store::load_secrets(&f.vault).unwrap();
        secrets.locker_worker_base_url = Some(base);
        secrets.locker_worker_secret = Some("test-owner-secret".into());
        store::save_secrets(&f.vault, &secrets).unwrap();
        let mut data = store::load_locker(&f.vault).unwrap();
        data.entries = vec![target.clone(), unrelated];
        store::save_locker(&f.vault, &data).unwrap();
        stop_share(&f.state, &f.vault, &target.id).unwrap();
        server.join().unwrap();
        let final_data = store::load_locker(&f.vault).unwrap();
        assert!(final_data.entries.iter().any(|e| e.id == added_id));
        assert!(!final_data.entries.iter().any(|e| e.id == unrelated_id));
        assert!(final_data.deleted_entries.contains_key(&unrelated_id));
        assert!(final_data
            .entries
            .iter()
            .find(|e| e.id == target.id)
            .unwrap()
            .share
            .is_none());
    }

    #[test]
    fn remote_share_completion_does_not_resurrect_sync_deleted_item() {
        let f = Fixture::new();
        let mut target = entry("http://localhost", &[8; 32], &f.vault);
        target.share = None;
        let id = target.id.clone();
        let vault = f.vault.clone();
        let removed = id.clone();
        let meta = serde_json::json!({"itemId":id,"version":"item-version-123","cipherSize":53,"expireAt":null,"maxPulls":3,"pullsLeft":2,"status":"active","cleanupStatus":"none","shareSlug":null});
        let (base, _, server) = serve_hook(
            vec![
                ("/v2/health".into(), 200, health()),
                (format!("/v2/items/{id}"), 200, json(meta)),
                (
                    format!("/v2/items/{id}/share"),
                    200,
                    json(serde_json::json!({"ok":true})),
                ),
            ],
            move |route| {
                if route.ends_with("/share") {
                    store::transaction(&vault, || {
                        let mut latest = store::load_locker(&vault)?;
                        latest.entries.retain(|e| e.id != removed);
                        latest.deleted_entries.insert(removed.clone(), now());
                        store::save_locker(&vault, &latest)
                    })
                    .unwrap();
                }
            },
        );
        target.service.as_mut().unwrap().base_url = base.clone();
        let mut secrets = store::load_secrets(&f.vault).unwrap();
        secrets.locker_worker_base_url = Some(base);
        secrets.locker_worker_secret = Some("test-owner-secret".into());
        store::save_secrets(&f.vault, &secrets).unwrap();
        let mut data = store::load_locker(&f.vault).unwrap();
        data.entries.push(target);
        store::save_locker(&f.vault, &data).unwrap();
        let error = share(&f.state, &f.vault, &id, None).err().unwrap();
        server.join().unwrap();
        assert!(error.to_string().contains("LOCKER_LOCAL_CONFLICT"));
        share_failed(&f.state, &f.vault, &id, &error);
        let final_data = store::load_locker(&f.vault).unwrap();
        assert!(final_data.entries.is_empty());
        assert!(final_data.deleted_entries.contains_key(&id));
    }

    #[test]
    fn migration_patch_rejects_changed_item_version_and_preserves_latest_fields() {
        let f = Fixture::new();
        let original = entry("https://example.invalid", &[8; 32], &f.vault);
        let mut data = store::load_locker(&f.vault).unwrap();
        data.entries.push(original.clone());
        store::save_locker(&f.vault, &data).unwrap();
        let mut latest = original.clone();
        latest.service.as_mut().unwrap().version = "changed-by-sync".into();
        latest.name = "newer synced name".into();
        data.entries[0] = latest.clone();
        store::save_locker(&f.vault, &data).unwrap();
        let mut updated = original.clone();
        updated.share = None;
        assert!(commit_entry_patch(&f.state, &f.vault, &original, &updated).is_err());
        assert_eq!(store::load_locker(&f.vault).unwrap().entries[0], latest);
        data.entries.clear();
        data.deleted_entries.insert(original.id.clone(), now());
        store::save_locker(&f.vault, &data).unwrap();
        assert!(commit_new_entry(&f.state, &f.vault, &original).is_err());
        assert!(store::load_locker(&f.vault).unwrap().entries.is_empty());
    }

    #[test]
    fn changed_cloud_bucket_blocks_original_upload_without_network_mutation() {
        let f = Fixture::new();
        let cfg = crate::sync::s3::S3Config {
            endpoint: "https://storage.example.invalid".into(),
            bucket: "bucket-a".into(),
            region: "auto".into(),
            prefix: "prefix-a".into(),
            access_key_id: "test-id".into(),
            secret_access_key: "test-secret".into(),
        };
        recover_lock(&f.state.config).cloud_sync = Some(cfg);
        let expected = binding(&recover_lock(&f.state.config)).unwrap();
        recover_lock(&f.state.config)
            .cloud_sync
            .as_mut()
            .unwrap()
            .bucket = "bucket-b".into();
        assert!(open_bound_s3(&f.state, &f.vault, Some(&expected))
            .err()
            .unwrap()
            .to_string()
            .contains("已改变"));
    }

    #[test]
    fn explicit_retarget_reuses_cached_ciphertext_and_same_operation() {
        let f = Fixture::new();
        let (mut op, key, plain) = test_op(&f, "https://example.invalid", "disk");
        op.endpoint_base = None;
        op.public_slug = None;
        op.entry = Some(entry("https://example.invalid", &key, &f.vault));
        op.content_ready = true;
        let cipher = cipher_path(&f.vault, &op.view.operation_id).unwrap();
        locker::seal_framed_to_path(
            Cursor::new(&plain),
            &key,
            DEFAULT_CHUNK_SIZE,
            LOCKER_MAX_BYTES,
            &cipher,
        )
        .unwrap();
        std::fs::write(f.root.join("saved.txt"), b"unrelated existing file").unwrap();
        let failed = execute_receive(&f.state, &f.vault, op.clone()).unwrap();
        assert!(failed.can_retarget);
        let stored = read_journal(&f.vault)
            .unwrap()
            .operations
            .remove(&op.view.operation_id)
            .unwrap();
        let next = f.root.join("retargeted.txt");
        let done = retarget(
            &f.state,
            &f.vault,
            stored,
            LockerDestination {
                kind: "disk".into(),
                path: Some(next.display().to_string()),
            },
        )
        .unwrap();
        assert_eq!(done.operation_id, op.view.operation_id);
        assert_eq!(done.status, "completed");
        assert_eq!(std::fs::read(next).unwrap(), plain);
        assert_eq!(
            std::fs::read(f.root.join("saved.txt")).unwrap(),
            b"unrelated existing file"
        );
    }

    #[test]
    fn existing_publication_witness_refuses_duplicate_target_on_recovery() {
        let f = Fixture::new();
        let (mut op, key, plain) = test_op(&f, "https://example.invalid", "disk");
        op.endpoint_base = None;
        op.public_slug = None;
        op.content_ready = true;
        let cipher = cipher_path(&f.vault, &op.view.operation_id).unwrap();
        locker::seal_framed_to_path(
            Cursor::new(&plain),
            &key,
            DEFAULT_CHUNK_SIZE,
            LOCKER_MAX_BYTES,
            &cipher,
        )
        .unwrap();
        save_plain(&f.state, &f.vault, &mut op, &key, &cipher).unwrap();
        // Simulate a crash after target publication but before saved journal.
        op.view.status = "unknown".into();
        op.view.can_retarget = true;
        save_operation(&f.vault, &op).unwrap();
        let other = f.root.join("must-not-create.txt");
        let done = retarget(
            &f.state,
            &f.vault,
            op,
            LockerDestination {
                kind: "disk".into(),
                path: Some(other.display().to_string()),
            },
        )
        .unwrap();
        assert_eq!(done.status, "completed");
        assert!(!other.exists());
        assert_eq!(std::fs::read(f.root.join("saved.txt")).unwrap(), plain);
    }
}
