//! 文件寄存柜：加密对象放在用户自己的 R2，元数据进 locker.enc。
//! 已分享项的次数只通过用户自建的 Worker 递减，未配置地址时不会改走本地计数。

use crate::commands::{clone_unlocked_vault, ensure_reveal_authorized, ensure_writes_allowed, recover_lock, AppState};
use crate::error::{AppError, Result};
use crate::locker::worker::{self, RegisterBody, WorkerEndpoint};
use crate::locker::{
    self, after_successful_pull, framed_ciphertext_len, is_expired, logical_path, normalize_pickup_code,
    object_subpath, pickup_code_hash, pulls_exhausted, random_content_key, random_pickup_code, random_slug,
    resolve_put_policy, share_link, LOCKER_MAX_BYTES,
};
use crate::model::{FileAttachment, LockerEntry, ShareMeta};
use crate::net::for_cloud_sync;
use crate::store::blob::{self, DEFAULT_CHUNK_SIZE};
use crate::store;
use crate::sync::s3::S3Client;
use crate::util;
use crate::vault::Vault;
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use zeroize::Zeroize;

fn publish(app: AppHandle) {
    crate::sync::scheduler::kick_publish(app);
}

fn now() -> String {
    util::now_rfc3339()
}

struct TempPath(PathBuf);

impl Drop for TempPath {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp_cipher() -> TempPath {
    TempPath(std::env::temp_dir().join(format!("gam-locker-{}.bin", uuid::Uuid::new_v4())))
}

fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerPutOpts {
    pub name: Option<String>,
    pub ttl_secs: Option<u64>,
    #[serde(default)]
    pub permanent: bool,
    pub max_pulls: Option<u32>,
    #[serde(default)]
    pub unlimited_pulls: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerView {
    pub id: String,
    pub name: String,
    pub original_name: String,
    pub mime: Option<String>,
    pub size: u64,
    pub created_at: String,
    pub expire_at: Option<String>,
    pub max_pulls: Option<u32>,
    pub pulls_left: Option<u32>,
    pub share: Option<ShareMeta>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerListOut {
    pub entries: Vec<LockerView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerPutOut {
    pub id: String,
    pub code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerCodeOut {
    pub code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerPullOut {
    pub id: String,
    pub name: String,
    pub original_name: String,
    pub dest_path: String,
    pub pulls_left: Option<u32>,
    pub burned: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerPullBytesOut {
    pub id: String,
    pub name: String,
    pub original_name: String,
    pub bytes: Vec<u8>,
    pub pulls_left: Option<u32>,
    pub burned: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerShareOut {
    pub url: String,
    pub slug: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerWorkerView {
    pub base_url: String,
    pub has_secret: bool,
}

fn view_of(entry: &LockerEntry) -> LockerView {
    LockerView {
        id: entry.id.clone(),
        name: entry.name.clone(),
        original_name: entry.original_name.clone(),
        mime: entry.mime.clone(),
        size: entry.size,
        created_at: entry.created_at.clone(),
        expire_at: entry.expire_at.clone(),
        max_pulls: entry.max_pulls,
        pulls_left: entry.pulls_left,
        share: entry.share.clone(),
    }
}

fn proxy_of(state: &AppState) -> Option<crate::app_config::NetworkProxy> {
    let cfg = recover_lock(&state.config);
    for_cloud_sync(&cfg)
}

fn open_s3(state: &AppState, vault: &Vault) -> Result<S3Client> {
    let app_cfg = recover_lock(&state.config).clone();
    let mut sync = app_cfg.cloud_sync.clone().ok_or_else(|| {
        AppError::Invalid("请先在云同步里填写存储桶，寄存柜使用同一套凭据".into())
    })?;
    if sync.secret_access_key.trim().is_empty() {
        sync.secret_access_key = store::cloud_sync_secret(vault)?.unwrap_or_default();
    }
    if !sync.has_usable_secret() {
        return Err(AppError::Invalid(
            "请先在云同步里填写存储桶和访问密钥".into(),
        ));
    }
    S3Client::from_app(sync, &app_cfg)
}

fn load_worker(vault: &Vault) -> Result<Option<WorkerEndpoint>> {
    let secrets = store::load_secrets(vault)?;
    let base = secrets
        .locker_worker_base_url
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/')
        .to_string();
    if base.is_empty() {
        return Ok(None);
    }
    let secret = secrets.locker_worker_secret.unwrap_or_default();
    Ok(Some(WorkerEndpoint { base, secret }))
}

fn require_share_worker(vault: &Vault) -> Result<WorkerEndpoint> {
    let Some(ep) = load_worker(vault)? else {
        return Err(AppError::Invalid(
            "未配置分享服务地址，无法生成或吊销分享链接".into(),
        ));
    };
    if ep.secret.trim().is_empty() {
        return Err(AppError::Invalid(
            "未配置分享服务的共享密钥，无法生成或吊销分享链接".into(),
        ));
    }
    Ok(ep)
}

fn require_shared_pull_worker(vault: &Vault) -> Result<WorkerEndpoint> {
    load_worker(vault)?.ok_or_else(|| {
        AppError::Invalid("这份文件已经分享，但没有配置分享服务地址，无法同步取出次数".into())
    })
}

fn guess_mime(name: &str) -> Option<String> {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.trim().to_ascii_lowercase())?;
    Some(
        match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "pdf" => "application/pdf",
            "zip" => "application/zip",
            "txt" | "md" | "log" => "text/plain",
            "json" => "application/json",
            _ => return None,
        }
        .into(),
    )
}

fn display_name(preferred: Option<String>, original: &str) -> Result<String> {
    let name = preferred
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| original.trim().to_string());
    if name.is_empty() {
        return Err(AppError::Invalid("请填写文件名称".into()));
    }
    Ok(name)
}

fn file_name_of(path: &str) -> String {
    path.trim()
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or("file")
        .to_string()
}

fn sweep(
    vault: &Vault,
    s3: Option<&S3Client>,
    endpoint: Option<&WorkerEndpoint>,
    proxy: Option<&crate::app_config::NetworkProxy>,
) -> Result<bool> {
    let mut data = store::load_locker(vault)?;
    let stamp = now();
    let mut keep = Vec::new();
    let mut changed = false;
    for mut entry in std::mem::take(&mut data.entries) {
        // 别人用分享链接取走后，Worker 会销毁登记。本地次数不会自己变，打开列表时核对一次。
        if let (Some(share), Some(ep)) = (entry.share.as_ref(), endpoint) {
            if !ep.base.trim().is_empty() {
                match worker::probe_share(ep, &share.slug, proxy) {
                    Ok(worker::SharePresence::Gone) => entry.pulls_left = Some(0),
                    Ok(worker::SharePresence::Alive) => {}
                    Err(e) => log::warn!("核对分享状态失败，保留本地记录: {e}"),
                }
            }
        }
        let dead = is_expired(entry.expire_at.as_deref(), &stamp) || pulls_exhausted(entry.pulls_left);
        if !dead {
            keep.push(entry);
            continue;
        }
        let Some(s3) = s3 else {
            keep.push(entry);
            continue;
        };
        if let Err(e) = s3.delete_object(&object_subpath(&entry.object_name)) {
            log::warn!("焚毁过期寄存对象失败，下次再试: {e}");
            keep.push(entry);
            continue;
        }
        if let (Some(share), Some(ep)) = (&entry.share, endpoint) {
            if !ep.secret.trim().is_empty() {
                if let Err(e) = worker::revoke(ep, &share.slug, proxy) {
                    log::warn!("吊销已过期分享失败（对象已删除）: {e}");
                }
            }
        }
        data.deleted_entries.insert(entry.id.clone(), stamp.clone());
        changed = true;
    }
    data.entries = keep;
    if changed {
        store::save_locker(vault, &data)?;
    }
    Ok(changed)
}

fn ingest_reader<R: Read>(
    vault: &Vault,
    s3: &S3Client,
    original_name: &str,
    mime: Option<String>,
    reader: R,
    opts: Option<LockerPutOpts>,
) -> Result<LockerPutOut> {
    let opts = opts.unwrap_or(LockerPutOpts {
        name: None,
        ttl_secs: None,
        permanent: false,
        max_pulls: None,
        unlimited_pulls: false,
    });
    let name = display_name(opts.name, original_name)?;
    let policy = resolve_put_policy(
        opts.permanent,
        opts.ttl_secs,
        opts.unlimited_pulls,
        opts.max_pulls,
        time::OffsetDateTime::now_utc(),
    )?;
    let id = uuid::Uuid::new_v4().to_string();
    let code = random_pickup_code();
    let mut ck = random_content_key();
    let temp = temp_cipher();
    let stored = (|| -> Result<LockerPutOut> {
        let plain_size =
            locker::seal_framed_to_path(reader, &ck, DEFAULT_CHUNK_SIZE, LOCKER_MAX_BYTES, &temp.0)?;
        let object_name = vault.object_name(&logical_path(&id))?;
        s3.put_object_file(&object_subpath(&object_name), &temp.0)?;
        let wrap_self = locker::wrap_content_key(vault, &ck)?;
        let stamp = now();
        let entry = LockerEntry {
            id: id.clone(),
            name,
            original_name: original_name.trim().to_string(),
            mime,
            size: plain_size,
            object_name: object_name.clone(),
            pickup_code: code.clone(),
            code_hash: pickup_code_hash(&code),
            wrap_self,
            created_at: stamp,
            expire_at: policy.expire_at,
            max_pulls: policy.max_pulls,
            pulls_left: policy.max_pulls,
            share: None,
        };
        let mut data = store::load_locker(vault)?;
        data.deleted_entries.remove(&entry.id);
        data.entries.push(entry);
        if let Err(e) = store::save_locker(vault, &data) {
            let _ = s3.delete_object(&object_subpath(&object_name));
            return Err(e);
        }
        Ok(LockerPutOut { id, code })
    })();
    ck.zeroize();
    stored
}

struct Taken {
    id: String,
    name: String,
    original_name: String,
    pulls_left: Option<u32>,
    burned: bool,
}

fn index_by_code(data: &crate::model::LockerData, code: &str) -> Result<usize> {
    let norm = normalize_pickup_code(code)?;
    let hash = pickup_code_hash(&norm);
    data.entries
        .iter()
        .position(|e| ct_eq(&e.code_hash, &hash))
        .ok_or_else(|| AppError::Invalid("取件码不正确".into()))
}

fn burn_local(vault: &Vault, id: &str) -> Result<()> {
    let mut data = store::load_locker(vault)?;
    if let Some(pos) = data.entries.iter().position(|e| e.id == id) {
        let entry = data.entries.remove(pos);
        data.deleted_entries.insert(entry.id, now());
        store::save_locker(vault, &data)?;
    }
    Ok(())
}

fn write_pull<W: Write>(
    vault: &Vault,
    s3: &S3Client,
    endpoint_for_share: Option<&WorkerEndpoint>,
    proxy: Option<&crate::app_config::NetworkProxy>,
    code: &str,
    mut writer: W,
) -> Result<Taken> {
    let data = store::load_locker(vault)?;
    let index = index_by_code(&data, code)?;
    let entry = data.entries[index].clone();
    let stamp = now();
    if is_expired(entry.expire_at.as_deref(), &stamp) || pulls_exhausted(entry.pulls_left) {
        let _ = s3.delete_object(&object_subpath(&entry.object_name));
        burn_local(vault, &entry.id)?;
        return Err(AppError::Invalid("这份寄存已过期或次数已用完".into()));
    }

    let temp = temp_cipher();
    let (pulls_left, burned) = if entry.share.is_some() {
        let ep = endpoint_for_share.ok_or_else(|| {
            AppError::Invalid("这份文件已经分享，但没有配置分享服务地址，无法同步取出次数".into())
        })?;
        let slug = entry.share.as_ref().map(|s| s.slug.clone()).unwrap_or_default();
        let shared = worker::pull_shared(ep, &slug, &normalize_pickup_code(code)?, &temp.0, proxy, LOCKER_MAX_BYTES)?;
        let (pulls_left, burned) = if shared.pulls_known {
            (shared.pulls_left, shared.burned || shared.pulls_left == Some(0))
        } else {
            after_successful_pull(entry.pulls_left)
        };
        apply_pull_bookkeeping(vault, s3, &entry, pulls_left, burned)?;
        let mut ck = locker::unwrap_content_key(vault, &entry.wrap_self)?;
        let decoded = locker::open_framed(
            std::fs::File::open(&temp.0)?,
            &mut writer,
            &ck,
            Some(entry.size),
        );
        ck.zeroize();
        decoded?;
        (pulls_left, burned)
    } else {
        let found = s3.get_object_to_file(&object_subpath(&entry.object_name), &temp.0)?;
        if !found {
            burn_local(vault, &entry.id)?;
            return Err(AppError::Invalid("云端对象已不在，这份寄存视为已焚毁".into()));
        }
        let mut ck = locker::unwrap_content_key(vault, &entry.wrap_self)?;
        let decoded = locker::open_framed(
            std::fs::File::open(&temp.0)?,
            &mut writer,
            &ck,
            Some(entry.size),
        );
        ck.zeroize();
        decoded?;
        let (pulls_left, burned) = after_successful_pull(entry.pulls_left);
        apply_pull_bookkeeping(vault, s3, &entry, pulls_left, burned)?;
        (pulls_left, burned)
    };
    writer.flush().ok();
    Ok(Taken {
        id: entry.id,
        name: entry.name,
        original_name: entry.original_name,
        pulls_left,
        burned,
    })
}

fn apply_pull_bookkeeping(
    vault: &Vault,
    s3: &S3Client,
    entry: &LockerEntry,
    pulls_left: Option<u32>,
    burned: bool,
) -> Result<()> {
    if burned {
        let _ = s3.delete_object(&object_subpath(&entry.object_name));
        burn_local(vault, &entry.id)?;
        return Ok(());
    }
    let mut data = store::load_locker(vault)?;
    if let Some(found) = data.entries.iter_mut().find(|e| e.id == entry.id) {
        found.pulls_left = pulls_left;
        store::save_locker(vault, &data)?;
    }
    Ok(())
}

fn attachment_of<'a>(
    atts: &'a [FileAttachment],
    attachment_id: Option<&str>,
) -> Result<&'a FileAttachment> {
    if atts.is_empty() {
        return Err(AppError::Invalid("该条目没有可寄出的附件".into()));
    }
    if let Some(aid) = attachment_id.map(str::trim).filter(|s| !s.is_empty()) {
        return atts
            .iter()
            .find(|a| a.id == aid || a.sha256 == aid)
            .ok_or_else(|| AppError::Invalid("找不到要寄出的附件".into()));
    }
    if atts.len() == 1 {
        return Ok(&atts[0]);
    }
    Err(AppError::Invalid("请选择要寄出的附件".into()))
}

#[tauri::command]
pub fn locker_list(app: AppHandle, state: State<'_, AppState>) -> Result<LockerListOut> {
    let vault = clone_unlocked_vault(&state)?;
    let s3 = open_s3(&state, &vault).ok();
    let endpoint = load_worker(&vault).ok().flatten();
    let proxy = proxy_of(&state);
    let changed = sweep(&vault, s3.as_ref(), endpoint.as_ref(), proxy.as_ref())?;
    let mut data = store::load_locker(&vault)?;
    data.entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    if changed {
        publish(app);
    }
    Ok(LockerListOut {
        entries: data.entries.iter().map(view_of).collect(),
    })
}

#[tauri::command]
pub fn locker_put_from_path(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    opts: Option<LockerPutOpts>,
) -> Result<LockerPutOut> {
    ensure_writes_allowed(&state)?;
    let vault = clone_unlocked_vault(&state)?;
    let s3 = open_s3(&state, &vault)?;
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err(AppError::Invalid("请选择要寄存的文件".into()));
    }
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err(AppError::Invalid("找不到所选文件".into()));
    }
    let size = std::fs::metadata(&src)?.len();
    if size > LOCKER_MAX_BYTES {
        return Err(AppError::Invalid("单个文件不能超过 100 MB".into()));
    }
    let original = file_name_of(&path);
    let mime = guess_mime(&original);
    let file = std::fs::File::open(&src)?;
    let out = ingest_reader(&vault, &s3, &original, mime, file, opts)?;
    util::audit(vault.root(), "寄存文件");
    publish(app);
    Ok(out)
}

#[tauri::command]
pub fn locker_put_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    original_name: String,
    bytes: Vec<u8>,
    opts: Option<LockerPutOpts>,
) -> Result<LockerPutOut> {
    ensure_writes_allowed(&state)?;
    let vault = clone_unlocked_vault(&state)?;
    let s3 = open_s3(&state, &vault)?;
    if bytes.len() as u64 > LOCKER_MAX_BYTES {
        return Err(AppError::Invalid("单个文件不能超过 100 MB".into()));
    }
    let original = original_name.trim();
    if original.is_empty() {
        return Err(AppError::Invalid("缺少原始文件名".into()));
    }
    let mime = guess_mime(original);
    let mut bytes = bytes;
    let stored = ingest_reader(&vault, &s3, original, mime, Cursor::new(bytes.as_slice()), opts);
    bytes.zeroize();
    let out = stored?;
    util::audit(vault.root(), "寄存文件字节");
    publish(app);
    Ok(out)
}

#[tauri::command]
pub fn locker_put_from_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    entry_id: String,
    attachment_id: Option<String>,
    password: Option<String>,
    opts: Option<LockerPutOpts>,
) -> Result<LockerPutOut> {
    ensure_writes_allowed(&state)?;
    ensure_reveal_authorized(&state, password.as_deref())?;
    let vault = clone_unlocked_vault(&state)?;
    let s3 = open_s3(&state, &vault)?;
    let files = store::load_files(&vault)?;
    let entry = files
        .entries
        .iter()
        .find(|e| e.id == entry_id)
        .ok_or_else(|| AppError::Invalid("文件不存在".into()))?;
    let atts = entry.resolved_attachments();
    let att = attachment_of(&atts, attachment_id.as_deref())?;
    let mut plain = blob::read_blob_bytes(&vault, &att.sha256)?;
    let original = att.original_name.clone();
    let mime = att.mime.clone().or_else(|| guess_mime(&original));
    let stored = ingest_reader(&vault, &s3, &original, mime, Cursor::new(plain.as_slice()), opts);
    plain.zeroize();
    let out = stored?;
    util::audit(vault.root(), "从保险库寄出");
    publish(app);
    Ok(out)
}

fn code_by_id(data: &crate::model::LockerData, id: &str) -> Result<String> {
    data.entries
        .iter()
        .find(|e| e.id == id)
        .map(|e| e.pickup_code.clone())
        .ok_or_else(|| AppError::Invalid("找不到这份寄存".into()))
}

#[tauri::command]
pub fn locker_reveal_code(
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> Result<LockerCodeOut> {
    ensure_reveal_authorized(&state, password.as_deref())?;
    let vault = clone_unlocked_vault(&state)?;
    let data = store::load_locker(&vault)?;
    Ok(LockerCodeOut {
        code: code_by_id(&data, id.trim())?,
    })
}

#[tauri::command]
pub fn locker_pull_by_id(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    dest_path: String,
    password: Option<String>,
) -> Result<LockerPullOut> {
    let vault = clone_unlocked_vault(&state)?;
    let data = store::load_locker(&vault)?;
    let code = code_by_id(&data, id.trim())?;
    locker_pull(app, state, code, dest_path, password)
}

#[tauri::command]
pub fn locker_pull_bytes_by_id(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> Result<LockerPullBytesOut> {
    let vault = clone_unlocked_vault(&state)?;
    let data = store::load_locker(&vault)?;
    let code = code_by_id(&data, id.trim())?;
    locker_pull_bytes(app, state, code, password)
}

#[tauri::command]
pub fn locker_pull(
    app: AppHandle,
    state: State<'_, AppState>,
    code: String,
    dest_path: String,
    password: Option<String>,
) -> Result<LockerPullOut> {
    ensure_reveal_authorized(&state, password.as_deref())?;
    let vault = clone_unlocked_vault(&state)?;
    let s3 = open_s3(&state, &vault)?;
    let data = store::load_locker(&vault)?;
    let shared = index_by_code(&data, &code)
        .ok()
        .and_then(|i| data.entries.get(i))
        .and_then(|e| e.share.clone())
        .is_some();
    let endpoint = if shared {
        Some(require_shared_pull_worker(&vault)?)
    } else {
        None
    };
    let dest = PathBuf::from(dest_path.trim());
    if dest.as_os_str().is_empty() {
        return Err(AppError::Invalid("请选择保存位置".into()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let part = dest.with_extension("part");
    let file = std::fs::File::create(&part)?;
    let taken = match write_pull(&vault, &s3, endpoint.as_ref(), proxy_of(&state).as_ref(), &code, file) {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
    };
    if let Err(e) = std::fs::rename(&part, &dest) {
        std::fs::copy(&part, &dest).map_err(|copy_err| {
            AppError::Io(format!("保存取回文件失败：{e} / {copy_err}"))
        })?;
        let _ = std::fs::remove_file(&part);
    }
    util::audit(vault.root(), "取回寄存文件");
    publish(app);
    Ok(LockerPullOut {
        id: taken.id,
        name: taken.name,
        original_name: taken.original_name.clone(),
        dest_path: dest.display().to_string(),
        pulls_left: taken.pulls_left,
        burned: taken.burned,
    })
}

#[tauri::command]
pub fn locker_pull_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    code: String,
    password: Option<String>,
) -> Result<LockerPullBytesOut> {
    ensure_reveal_authorized(&state, password.as_deref())?;
    let vault = clone_unlocked_vault(&state)?;
    let s3 = open_s3(&state, &vault)?;
    let data = store::load_locker(&vault)?;
    let shared = index_by_code(&data, &code)
        .ok()
        .and_then(|i| data.entries.get(i))
        .and_then(|e| e.share.clone())
        .is_some();
    let endpoint = if shared {
        Some(require_shared_pull_worker(&vault)?)
    } else {
        None
    };
    let mut bytes = Vec::new();
    let taken = write_pull(
        &vault,
        &s3,
        endpoint.as_ref(),
        proxy_of(&state).as_ref(),
        &code,
        &mut bytes,
    )?;
    util::audit(vault.root(), "取回寄存文件到内存");
    publish(app);
    Ok(LockerPullBytesOut {
        id: taken.id,
        name: taken.name,
        original_name: taken.original_name,
        bytes,
        pulls_left: taken.pulls_left,
        burned: taken.burned,
    })
}

#[tauri::command]
pub fn locker_share(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> Result<LockerShareOut> {
    ensure_reveal_authorized(&state, password.as_deref())?;
    let vault = clone_unlocked_vault(&state)?;
    let s3 = open_s3(&state, &vault)?;
    let endpoint = require_share_worker(&vault)?;
    let proxy = proxy_of(&state);
    let mut data = store::load_locker(&vault)?;
    let stamp = now();
    let snapshot = data
        .entries
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::Invalid("找不到这份寄存".into()))?
        .clone();
    if is_expired(snapshot.expire_at.as_deref(), &stamp) || pulls_exhausted(snapshot.pulls_left) {
        return Err(AppError::Invalid("这份寄存已过期或次数已用完".into()));
    }
    let mut ck = locker::unwrap_content_key(&vault, &snapshot.wrap_self)?;
    let slug = if let Some(share) = &snapshot.share {
        share.slug.clone()
    } else {
        let object_key = s3.full_key(&object_subpath(&snapshot.object_name));
        let size = framed_ciphertext_len(snapshot.size, DEFAULT_CHUNK_SIZE);
        let mut chosen = String::new();
        for _ in 0..5 {
            let slug = random_slug();
            let body = RegisterBody {
                slug: slug.clone(),
                object_key: object_key.clone(),
                code_hash: snapshot.code_hash.clone(),
                size,
                expire_at: snapshot.expire_at.clone(),
                max_pulls: snapshot.max_pulls,
                pulls_left: snapshot.pulls_left,
            };
            match worker::register(&endpoint, &body, proxy.as_ref()) {
                Ok(()) => {
                    chosen = slug;
                    break;
                }
                Err(AppError::Invalid(msg)) if msg == "SHARE_SLUG_CONFLICT" => continue,
                Err(e) => {
                    ck.zeroize();
                    return Err(e);
                }
            }
        }
        if chosen.is_empty() {
            ck.zeroize();
            return Err(AppError::Invalid("分享短码冲突，请重试".into()));
        }
        if let Some(entry) = data.entries.iter_mut().find(|e| e.id == id) {
            entry.share = Some(ShareMeta {
                slug: chosen.clone(),
                registered_at: stamp,
            });
        }
        store::save_locker(&vault, &data)?;
        chosen
    };
    let filename = if snapshot.original_name.trim().is_empty() {
        snapshot.name.as_str()
    } else {
        snapshot.original_name.as_str()
    };
    let url = share_link(&endpoint.base, &slug, &ck, filename);
    ck.zeroize();
    util::audit(vault.root(), "生成寄存分享链接");
    publish(app);
    Ok(LockerShareOut { url, slug })
}

#[tauri::command]
pub fn locker_revoke_share(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let vault = clone_unlocked_vault(&state)?;
    let endpoint = require_share_worker(&vault)?;
    let mut data = store::load_locker(&vault)?;
    let entry = data
        .entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::Invalid("找不到这份寄存".into()))?;
    let Some(share) = entry.share.clone() else {
        return Ok(());
    };
    worker::revoke(&endpoint, &share.slug, proxy_of(&state).as_ref())?;
    entry.share = None;
    store::save_locker(&vault, &data)?;
    util::audit(vault.root(), "吊销寄存分享");
    publish(app);
    Ok(())
}

#[tauri::command]
pub fn locker_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let vault = clone_unlocked_vault(&state)?;
    let s3 = open_s3(&state, &vault)?;
    let mut data = store::load_locker(&vault)?;
    let Some(pos) = data.entries.iter().position(|e| e.id == id) else {
        return Ok(());
    };
    if data.entries[pos].share.is_some() {
        let endpoint = require_share_worker(&vault)?;
        let slug = data.entries[pos]
            .share
            .as_ref()
            .map(|s| s.slug.clone())
            .unwrap_or_default();
        worker::revoke(&endpoint, &slug, proxy_of(&state).as_ref())?;
    }
    let entry = data.entries.remove(pos);
    s3.delete_object(&object_subpath(&entry.object_name))?;
    data.deleted_entries.insert(entry.id, now());
    store::save_locker(&vault, &data)?;
    util::audit(vault.root(), "手动焚毁寄存");
    publish(app);
    Ok(())
}

#[tauri::command]
pub fn locker_get_worker_config(state: State<'_, AppState>) -> Result<LockerWorkerView> {
    let vault = clone_unlocked_vault(&state)?;
    let secrets = store::load_secrets(&vault)?;
    Ok(LockerWorkerView {
        base_url: secrets.locker_worker_base_url.unwrap_or_default(),
        has_secret: secrets
            .locker_worker_secret
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty()),
    })
}

#[tauri::command]
pub fn locker_save_worker_config(
    app: AppHandle,
    state: State<'_, AppState>,
    base_url: String,
    secret: Option<String>,
    clear_secret: Option<bool>,
) -> Result<LockerWorkerView> {
    ensure_writes_allowed(&state)?;
    let vault = clone_unlocked_vault(&state)?;
    let mut secrets = store::load_secrets(&vault)?;
    let base = base_url.trim().trim_end_matches('/').to_string();
    secrets.locker_worker_base_url = if base.is_empty() { None } else { Some(base) };
    if clear_secret.unwrap_or(false) {
        secrets.locker_worker_secret = None;
    } else if let Some(secret) = secret.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        secrets.locker_worker_secret = Some(secret);
    }
    store::save_secrets(&vault, &secrets)?;
    publish(app);
    Ok(LockerWorkerView {
        base_url: secrets.locker_worker_base_url.unwrap_or_default(),
        has_secret: secrets
            .locker_worker_secret
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty()),
    })
}
