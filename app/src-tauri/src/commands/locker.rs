//! 文件寄存柜：加密对象放在用户自己的 R2，元数据进 locker.enc。
//! 已分享项的次数只通过用户自建的 Worker 递减，未配置地址时不会改走本地计数。

use crate::commands::{clone_unlocked_vault, ensure_reveal_authorized, ensure_writes_allowed, recover_lock, AppState};
use crate::error::{AppError, Result};
use crate::locker::deploy::{self, DeployMethod, LockerDeployProgress, LockerProbeResult};
use crate::locker::worker::{self, WorkerEndpoint};
use crate::locker::{
    self, framed_ciphertext_len, is_expired, logical_path, normalize_pickup_code,
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

#[path = "locker_v2.rs"]
mod v2;
pub use v2::*;

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
    pub operation_id: Option<String>,
    #[serde(default)]
    pub share_requested: bool,
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
    pub access_status: String,
    pub cleanup_status: String,
    pub sync_status: String,
    pub legacy: bool,
    pub ended_at: Option<String>,
    pub last_error: Option<String>,
    pub quota_origin: Option<String>,
    pub in_flight_claims: u32,
    pub share_status: String,
    pub share_requested: bool,
    pub share_error: Option<String>,
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
    pub workers_dev_url: String,
    pub has_secret: bool,
    pub has_api_token: bool,
    pub token_last4: String,
    pub last_method: String,
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
        access_status: if is_expired(entry.expire_at.as_deref(), &now()) { "expired" } else if pulls_exhausted(entry.pulls_left) { "exhausted" } else { "active" }.into(),
        cleanup_status: "none".into(),
        sync_status: if entry.service.is_some() { "unknown" } else { "confirmed" }.into(),
        legacy: entry.service.is_none(),
        ended_at: None,
        last_error: None,
        quota_origin: entry.service.as_ref().map(|s| s.origin.clone().unwrap_or_else(|| "service".into())),
        in_flight_claims: 0,
        share_status: if entry.share.is_some() {"active"}else if entry.share_stopped {"stopped"}else if entry.share_error.is_some(){"failed"}else if entry.share_requested{"pending"}else{"none"}.into(),
        share_requested: entry.share_requested,
        share_error: entry.share_error.clone(),
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

fn index_by_code(data: &crate::model::LockerData, code: &str) -> Result<usize> {
    let norm = normalize_pickup_code(code)?;
    let hash = pickup_code_hash(&norm);
    data.entries
        .iter()
        .position(|e| ct_eq(&e.code_hash, &hash))
        .ok_or_else(|| AppError::Invalid("取件码不正确".into()))
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

#[tauri::command(async)]
pub fn locker_list(app: AppHandle, state: State<'_, AppState>) -> Result<LockerListOut> {
    let _ = app;
    let (_session, vault) = v2::capture(&state)?;
    v2::list(&state, &vault)
}

#[tauri::command(async)]
pub fn locker_put_from_path(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    opts: Option<LockerPutOpts>,
) -> Result<LockerPutOut> {
    ensure_writes_allowed(&state)?;
    let (_session, vault) = v2::capture(&state)?;
    let operation_id = opts.as_ref().and_then(|o| o.operation_id.clone());
    let result = (|| -> Result<LockerPutOut> {
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
    let out = v2::ingest(&state, &vault, &s3, &original, mime, file, opts)?;
    util::audit(vault.root(), "寄存文件");
    publish(app);
    Ok(out)
    })();
    v2::put_result(&state, &vault, operation_id.as_deref(), result)
}

#[tauri::command(async)]
pub fn locker_put_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    original_name: String,
    bytes: Vec<u8>,
    opts: Option<LockerPutOpts>,
) -> Result<LockerPutOut> {
    ensure_writes_allowed(&state)?;
    let (_session, vault) = v2::capture(&state)?;
    let operation_id = opts.as_ref().and_then(|o| o.operation_id.clone());
    let result = (|| -> Result<LockerPutOut> {
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
    let stored = v2::ingest(&state, &vault, &s3, original, mime, Cursor::new(bytes.as_slice()), opts);
    bytes.zeroize();
    let out = stored?;
    util::audit(vault.root(), "寄存文件字节");
    publish(app);
    Ok(out)
    })();
    v2::put_result(&state, &vault, operation_id.as_deref(), result)
}

#[tauri::command(async)]
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
    let (_session, vault) = v2::capture(&state)?;
    let operation_id = opts.as_ref().and_then(|o| o.operation_id.clone());
    let result = (|| -> Result<LockerPutOut> {
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
    let stored = v2::ingest(&state, &vault, &s3, &original, mime, Cursor::new(plain.as_slice()), opts);
    plain.zeroize();
    let out = stored?;
    util::audit(vault.root(), "从保险库寄出");
    publish(app);
    Ok(out)
    })();
    v2::put_result(&state, &vault, operation_id.as_deref(), result)
}

fn code_by_id(data: &crate::model::LockerData, id: &str) -> Result<String> {
    data.entries
        .iter()
        .find(|e| e.id == id)
        .map(|e| e.pickup_code.clone())
        .ok_or_else(|| AppError::Invalid("找不到这份寄存".into()))
}

#[tauri::command(async)]
pub fn locker_reveal_code(
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> Result<LockerCodeOut> {
    ensure_reveal_authorized(&state, password.as_deref())?;
    let (_session, vault) = v2::capture(&state)?;
    let data = store::load_locker(&vault)?;
    let code = code_by_id(&data, id.trim())?;
    v2::ensure_current(&state, &vault)?;
    Ok(LockerCodeOut { code })
}

#[tauri::command(async)]
pub fn locker_pull_by_id(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    dest_path: String,
    password: Option<String>,
) -> Result<LockerPullOut> {
    let (_session, vault) = v2::capture(&state)?;
    let data = store::load_locker(&vault)?;
    let code = code_by_id(&data, id.trim())?;
    locker_pull(app, state, code, dest_path, password)
}

#[tauri::command(async)]
pub fn locker_pull_bytes_by_id(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> Result<LockerPullBytesOut> {
    let (_session, vault) = v2::capture(&state)?;
    let data = store::load_locker(&vault)?;
    let code = code_by_id(&data, id.trim())?;
    locker_pull_bytes(app, state, code, password)
}

#[tauri::command(async)]
pub fn locker_pull(
    app: AppHandle,
    state: State<'_, AppState>,
    code: String,
    dest_path: String,
    password: Option<String>,
) -> Result<LockerPullOut> {
    let _ = (app, code, dest_path, password);
    let _vault = clone_unlocked_vault(&state)?;
    Err(AppError::Invalid("请使用带操作 ID 的新版领取流程，旧版下载接口已停用".into()))
}

#[tauri::command(async)]
pub fn locker_pull_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    code: String,
    password: Option<String>,
) -> Result<LockerPullBytesOut> {
    let _ = (app, code, password);
    let _vault = clone_unlocked_vault(&state)?;
    Err(AppError::Invalid("请使用新版直接存入保险库流程，旧版明文字节接口已停用".into()))
}

#[tauri::command(async)]
pub fn locker_share(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> Result<LockerShareOut> {
    ensure_writes_allowed(&state)?;
    let (_session, vault) = v2::capture(&state)?;
    let result = match v2::share(&state, &vault, &id, password.as_deref()) {Ok(result)=>result,Err(error)=>{v2::share_failed(&state,&vault,&id,&error);return Err(error);}};
    publish(app);
    Ok(result)
}

#[tauri::command(async)]
pub fn locker_revoke_share(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let (_session, vault) = v2::capture(&state)?;
    v2::stop_share(&state, &vault, &id)?;
    publish(app);
    Ok(())
}

#[tauri::command(async)]
pub fn locker_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let (_session, vault) = v2::capture(&state)?;
    v2::delete(&state, &vault, &id)?;
    publish(app);
    Ok(())
}

fn worker_view_of(vault: &crate::vault::Vault) -> Result<LockerWorkerView> {
    let secrets = store::load_secrets(vault)?;
    let rec = deploy::load_record(vault);
    Ok(LockerWorkerView {
        base_url: secrets.locker_worker_base_url.unwrap_or_default(),
        workers_dev_url: secrets.locker_worker_workers_dev_url.unwrap_or_default(),
        has_secret: secrets
            .locker_worker_secret
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty()),
        has_api_token: deploy::has_token(&rec),
        token_last4: rec
            .api_token
            .as_deref()
            .map(deploy::token_last4)
            .unwrap_or_default(),
        last_method: rec.last_method.unwrap_or_default(),
    })
}

fn cloud_sync_bucket(state: &AppState, vault: &crate::vault::Vault) -> (String, bool) {
    let app_cfg = recover_lock(&state.config).clone();
    let Some(mut sync) = app_cfg.cloud_sync.clone() else {
        return (String::new(), false);
    };
    if sync.secret_access_key.trim().is_empty() {
        sync.secret_access_key = store::cloud_sync_secret(vault).ok().flatten().unwrap_or_default();
    }
    (sync.bucket.trim().to_string(), sync.has_usable_secret())
}

#[tauri::command(async)]
pub fn locker_get_worker_config(state: State<'_, AppState>) -> Result<LockerWorkerView> {
    let (_session, vault) = v2::capture(&state)?;
    worker_view_of(&vault)
}

#[tauri::command(async)]
pub fn locker_save_worker_config(
    app: AppHandle,
    state: State<'_, AppState>,
    base_url: String,
    secret: Option<String>,
    clear_secret: Option<bool>,
) -> Result<LockerWorkerView> {
    ensure_writes_allowed(&state)?;
    let (_session, vault) = v2::capture(&state)?;
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
    worker_view_of(&vault)
}

#[tauri::command(async)]
pub async fn locker_probe_worker(
    state: State<'_, AppState>,
    url: String,
) -> Result<LockerProbeResult> {
    let proxy = proxy_of(&state);
    tauri::async_runtime::spawn_blocking(move || deploy::probe_worker(&url, proxy.as_ref()))
        .await
        .map_err(|e| AppError::Other(format!("连通性测试中断：{e}")))?
}

#[tauri::command(async)]
pub fn locker_deploy_status(state: State<'_, AppState>) -> Result<LockerDeployProgress> {
    let (_session, vault) = v2::capture(&state)?;
    Ok(deploy::status_from_record(&vault))
}

#[tauri::command(async)]
pub async fn locker_deploy_start(
    app: AppHandle,
    state: State<'_, AppState>,
    method: String,
    token: Option<String>,
) -> Result<LockerDeployProgress> {
    ensure_writes_allowed(&state)?;
    let vault = clone_unlocked_vault(&state)?;
    let method = DeployMethod::parse(&method)?;
    let proxy = proxy_of(&state);
    let (bucket, access_ok) = cloud_sync_bucket(&state, &vault);
    let secrets = store::load_secrets(&vault)?;
    let existing_secret = secrets.locker_worker_secret.clone();
    let current_url = secrets.locker_worker_base_url.clone().unwrap_or_default();
    let last_workers_dev = secrets
        .locker_worker_workers_dev_url
        .clone()
        .unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        deploy::start_deploy(
            app,
            vault,
            method,
            token,
            proxy,
            bucket,
            access_ok,
            existing_secret,
            current_url,
            last_workers_dev,
        )
    })
    .await
    .map_err(|e| AppError::Other(format!("启动部署中断：{e}")))?
}

#[tauri::command(async)]
pub fn locker_deploy_select_account(account_id: String) -> Result<LockerDeployProgress> {
    deploy::select_account(account_id)
}

#[tauri::command(async)]
pub fn locker_deploy_cancel() -> Result<LockerDeployProgress> {
    deploy::cancel_deploy()
}

#[tauri::command(async)]
pub fn locker_clear_api_token(state: State<'_, AppState>) -> Result<LockerWorkerView> {
    ensure_writes_allowed(&state)?;
    let (_session, vault) = v2::capture(&state)?;
    deploy::clear_api_token(&vault)?;
    worker_view_of(&vault)
}
