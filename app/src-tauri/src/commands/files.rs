//! 文件保险库：元数据 CRUD、流式入库/导出、墓碑与本地 blob GC。

use crate::app_config;
use crate::commands::{ensure_reveal_authorized, ensure_writes_allowed, recover_lock, AppState};
use crate::error::{AppError, Result};
use crate::model::{collect_blob_hashes, file_usage_bytes, FileAttachment, FileEntry, GroupMeta};
use crate::store;
use crate::store::blob::{self, DEFAULT_CHUNK_SIZE};
use crate::util;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

fn publish(app: AppHandle) {
    crate::sync::scheduler::kick_publish(app);
}

fn now() -> String {
    util::now_rfc3339()
}

fn empty_none(s: Option<String>) -> Option<String> {
    s.map(|x| x.trim().to_string()).filter(|x| !x.is_empty())
}

fn unlocked_vault<'a>(
    vault: &'a Option<crate::vault::Vault>,
) -> Result<&'a crate::vault::Vault> {
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    Ok(v)
}

fn per_file_limit(state: &AppState) -> u64 {
    let cfg = recover_lock(&state.config);
    app_config::attachment_per_file_limit_bytes(cfg.attachment_per_file_limit_mb)
}

fn original_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("file")
        .to_string()
}

/// 按扩展名猜测 MIME；未知则空。不编造内置图标 id。
fn guess_mime(name: &str) -> Option<String> {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.trim().to_ascii_lowercase())?;
    if ext.is_empty() {
        return None;
    }
    Some(
        match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "svg" => "image/svg+xml",
            "ico" => "image/x-icon",
            "heic" | "heif" => "image/heic",
            "pdf" => "application/pdf",
            "zip" => "application/zip",
            "7z" => "application/x-7z-compressed",
            "rar" => "application/vnd.rar",
            "tar" => "application/x-tar",
            "gz" | "tgz" => "application/gzip",
            "txt" | "log" | "md" => "text/plain",
            "json" => "application/json",
            "xml" => "application/xml",
            "csv" => "text/csv",
            "html" | "htm" => "text/html",
            "css" => "text/css",
            "js" | "mjs" => "text/javascript",
            "ts" => "text/plain",
            "doc" => "application/msword",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xls" => "application/vnd.ms-excel",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "ppt" => "application/vnd.ms-powerpoint",
            "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "pem" | "crt" | "cer" => "application/x-pem-file",
            "key" | "ppk" => "application/x-pem-file",
            "p12" | "pfx" => "application/x-pkcs12",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "mp4" => "video/mp4",
            "mov" => "video/quicktime",
            "webm" => "video/webm",
            _ => return None,
        }
        .into(),
    )
}

fn display_name(preferred: Option<String>, original: &str) -> Result<String> {
    let name = empty_none(preferred).unwrap_or_else(|| original.to_string());
    if name.is_empty() {
        return Err(AppError::Invalid("请填写文件名称".into()));
    }
    Ok(name)
}

fn reject_oversize(size: u64, limit: u64) -> Result<()> {
    if size > limit {
        let mb = (limit / (1024 * 1024)).max(1);
        return Err(AppError::Invalid(format!("单个文件不能超过 {mb} MB")));
    }
    Ok(())
}

fn new_attachment(original_name: String, sha256: String, size: u64) -> FileAttachment {
    let mime = guess_mime(&original_name);
    FileAttachment {
        id: uuid::Uuid::new_v4().to_string(),
        original_name,
        mime,
        size,
        sha256,
    }
}

fn ingest_path(v: &crate::vault::Vault, path: &str, limit: u64) -> Result<FileAttachment> {
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::Invalid("请选择要入库的文件".into()));
    }
    let src = PathBuf::from(path);
    if !src.is_file() {
        return Err(AppError::Invalid("找不到所选文件".into()));
    }
    let size_on_disk = std::fs::metadata(&src)?.len();
    reject_oversize(size_on_disk, limit)?;
    let original_name = original_name_from_path(path);
    let file = std::fs::File::open(&src)?;
    let blob = blob::write_blob_limited(v, file, DEFAULT_CHUNK_SIZE, limit)?;
    Ok(new_attachment(original_name, blob.sha256, blob.size))
}

fn ingest_bytes(v: &crate::vault::Vault, original_name: &str, bytes: Vec<u8>, limit: u64) -> Result<FileAttachment> {
    let original_name = original_name.trim();
    if original_name.is_empty() {
        return Err(AppError::Invalid("缺少原始文件名".into()));
    }
    reject_oversize(bytes.len() as u64, limit)?;
    let blob = blob::write_blob_limited(v, Cursor::new(bytes), DEFAULT_CHUNK_SIZE, limit)?;
    Ok(new_attachment(original_name.to_string(), blob.sha256, blob.size))
}

fn register_entry(v: &crate::vault::Vault, meta: FileAddArgs, mut attachments: Vec<FileAttachment>) -> Result<FileEntry> {
    if attachments.is_empty() {
        return Err(AppError::Invalid("至少需要一个附件，不能保存空条目".into()));
    }
    let fallback = attachments
        .first()
        .map(|a| a.original_name.as_str())
        .unwrap_or("file")
        .to_string();
    let name = display_name(meta.name, &fallback)?;
    let mut data = store::load_files(v)?;
    let ts = now();
    let mut entry = FileEntry {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        original_name: String::new(),
        mime: None,
        size: 0,
        sha256: String::new(),
        attachments: std::mem::take(&mut attachments),
        group: empty_none(meta.group),
        note: empty_none(meta.note),
        icon: None,
        sort_order: 0,
        created_at: ts.clone(),
        updated_at: ts,
    };
    entry.sync_summary();
    data.deleted_entries.remove(&entry.id);
    data.entries.push(entry.clone());
    store::save_files(v, &data)?;
    Ok(entry)
}

fn materialize_attachments(entry: &mut FileEntry) {
    if entry.attachments.is_empty() {
        entry.attachments = entry
            .resolved_attachments()
            .into_iter()
            .map(|mut a| {
                if a.id == a.sha256 {
                    a.id = uuid::Uuid::new_v4().to_string();
                }
                a
            })
            .collect();
    }
}

fn attachment_matches(att: &FileAttachment, id: &str) -> bool {
    att.id == id || att.sha256 == id
}

fn ingest_added(
    v: &crate::vault::Vault,
    limit: u64,
    add_paths: Option<Vec<String>>,
    add_bytes: Option<Vec<FileBytesItem>>,
) -> Result<Vec<FileAttachment>> {
    let mut out = Vec::new();
    for path in add_paths.unwrap_or_default() {
        if path.trim().is_empty() {
            continue;
        }
        out.push(ingest_path(v, &path, limit)?);
    }
    for item in add_bytes.unwrap_or_default() {
        out.push(ingest_bytes(v, &item.original_name, item.bytes, limit)?);
    }
    Ok(out)
}

fn gc_after_files_change(v: &crate::vault::Vault) -> Result<()> {
    let files = store::load_files(v)?;
    let notes = store::load_notes(v)?;
    let refs = collect_blob_hashes(&files, &notes);
    blob::gc_unreferenced_blobs(v, &refs)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    pub entries: Vec<FileEntry>,
    pub groups: Vec<GroupMeta>,
    pub usage_bytes: u64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileAddArgs {
    pub name: Option<String>,
    pub note: Option<String>,
    pub group: Option<String>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileBytesItem {
    pub original_name: String,
    pub bytes: Vec<u8>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileUpdateArgs {
    pub name: Option<String>,
    pub note: Option<String>,
    pub group: Option<String>,
    pub icon: Option<String>,
    pub sort_order: Option<i32>,
    /// Some 表示重写附件列表：只保留这些 id（或旧数据的 sha256），再追加新入库文件。
    pub keep_attachment_ids: Option<Vec<String>>,
    pub add_paths: Option<Vec<String>>,
    pub add_bytes: Option<Vec<FileBytesItem>>,
}

#[tauri::command(async)]
pub fn file_list(state: State<'_, AppState>) -> Result<FileList> {
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let mut data = store::load_files(v)?;
    for e in &mut data.entries {
        if e.attachments.is_empty() {
            e.attachments = e.resolved_attachments();
        }
    }
    Ok(FileList {
        usage_bytes: file_usage_bytes(&data),
        entries: data.entries,
        groups: data.groups,
    })
}

#[tauri::command(async)]
pub fn file_add_from_path(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    args: Option<FileAddArgs>,
) -> Result<FileEntry> {
    file_add_from_paths(app, state, vec![path], args)
}

#[tauri::command(async)]
pub fn file_add_from_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    args: Option<FileAddArgs>,
) -> Result<FileEntry> {
    ensure_writes_allowed(&state)?;
    let limit = per_file_limit(&state);
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let attachments = ingest_added(v, limit, Some(paths), None)?;
    let entry = register_entry(v, args.unwrap_or_default(), attachments)?;
    util::audit(v.root(), &format!("新增保险库文件 id={} atts={}", entry.id, entry.attachments.len()));
    drop(vault);
    publish(app);
    Ok(entry)
}

#[tauri::command(async)]
pub fn file_add_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    original_name: String,
    bytes: Vec<u8>,
    args: Option<FileAddArgs>,
) -> Result<FileEntry> {
    file_add_bytes_many(
        app,
        state,
        vec![FileBytesItem {
            original_name,
            bytes,
        }],
        args,
    )
}

#[tauri::command(async)]
pub fn file_add_bytes_many(
    app: AppHandle,
    state: State<'_, AppState>,
    items: Vec<FileBytesItem>,
    args: Option<FileAddArgs>,
) -> Result<FileEntry> {
    ensure_writes_allowed(&state)?;
    let limit = per_file_limit(&state);
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let attachments = ingest_added(v, limit, None, Some(items))?;
    let entry = register_entry(v, args.unwrap_or_default(), attachments)?;
    util::audit(v.root(), &format!("新增保险库文件 id={} atts={}", entry.id, entry.attachments.len()));
    drop(vault);
    publish(app);
    Ok(entry)
}

#[tauri::command(async)]
pub fn file_update(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    args: FileUpdateArgs,
) -> Result<FileEntry> {
    ensure_writes_allowed(&state)?;
    let limit = per_file_limit(&state);
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let rewrite = args.keep_attachment_ids.is_some()
        || args.add_paths.as_ref().is_some_and(|p| !p.is_empty())
        || args.add_bytes.as_ref().is_some_and(|b| !b.is_empty());
    let added = if rewrite {
        ingest_added(v, limit, args.add_paths.clone(), args.add_bytes.clone())?
    } else {
        Vec::new()
    };

    let mut data = store::load_files(v)?;
    let entry = data
        .entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::Invalid("文件不存在".into()))?;
    if let Some(name) = args.name {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Invalid("请填写文件名称".into()));
        }
        entry.name = name.to_string();
    }
    if args.note.is_some() {
        entry.note = empty_none(args.note);
    }
    if args.group.is_some() {
        entry.group = empty_none(args.group);
    }
    if args.icon.is_some() {
        entry.icon = empty_none(args.icon);
    }
    if let Some(order) = args.sort_order {
        entry.sort_order = order;
    }
    if rewrite {
        materialize_attachments(entry);
        let mut next = if let Some(keep) = &args.keep_attachment_ids {
            entry
                .attachments
                .iter()
                .filter(|a| keep.iter().any(|id| attachment_matches(a, id)))
                .cloned()
                .collect::<Vec<_>>()
        } else {
            entry.attachments.clone()
        };
        next.extend(added);
        if next.is_empty() {
            return Err(AppError::Invalid("至少需要一个附件，不能保存空条目".into()));
        }
        entry.attachments = next;
        entry.sync_summary();
    }
    entry.updated_at = now();
    let out = entry.clone();
    store::save_files(v, &data)?;
    if rewrite {
        gc_after_files_change(v)?;
    }
    util::audit(v.root(), &format!("更新保险库文件 id={id} atts={}", out.attachments.len()));
    drop(vault);
    publish(app);
    Ok(out)
}

#[tauri::command]
pub fn file_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let mut data = store::load_files(v)?;
    let before = data.entries.len();
    data.entries.retain(|e| e.id != id);
    if data.entries.len() == before {
        return Err(AppError::Invalid("文件不存在".into()));
    }
    data.deleted_entries.insert(id.clone(), now());
    store::save_files(v, &data)?;
    gc_after_files_change(v)?;
    util::audit(v.root(), &format!("删除保险库文件 id={id}"));
    drop(vault);
    publish(app);
    Ok(())
}

#[tauri::command(async)]
pub fn file_export(
    state: State<'_, AppState>,
    id: String,
    dest_path: String,
    password: Option<String>,
    attachment_id: Option<String>,
) -> Result<()> {
    ensure_reveal_authorized(&state, password.as_deref())?;
    let dest = dest_path.trim();
    if dest.is_empty() {
        return Err(AppError::Invalid("请选择导出路径".into()));
    }
    let dest = PathBuf::from(dest);
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let data = store::load_files(v)?;
    let entry = data
        .entries
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::Invalid("文件不存在".into()))?;
    let atts = entry.resolved_attachments();
    if atts.is_empty() {
        return Err(AppError::Invalid("该条目没有可导出的附件".into()));
    }
    let picked = if let Some(aid) = attachment_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        atts.iter()
            .find(|a| attachment_matches(a, aid))
            .ok_or_else(|| AppError::Invalid("找不到要导出的附件".into()))?
    } else if atts.len() == 1 {
        &atts[0]
    } else {
        return Err(AppError::Invalid("请选择要导出的附件".into()));
    };
    let sha = picked.sha256.clone();
    let mut out = std::fs::File::create(&dest)?;
    match blob::read_blob(v, &sha, &mut out) {
        Ok(_) => {
            util::audit(v.root(), &format!("导出保险库文件 id={id}"));
            Ok(())
        }
        Err(e) => {
            drop(out);
            let _ = std::fs::remove_file(&dest);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn file_save_groups(
    app: AppHandle,
    state: State<'_, AppState>,
    groups: Vec<GroupMeta>,
) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let mut data = store::load_files(v)?;
    data.groups = groups;
    store::save_files(v, &data)?;
    drop(vault);
    publish(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_name_takes_file_stem_from_windows_and_unix() {
        assert_eq!(original_name_from_path(r"C:\docs\passport.pdf"), "passport.pdf");
        assert_eq!(original_name_from_path("/tmp/id_card.png"), "id_card.png");
        assert_eq!(original_name_from_path(""), "file");
    }

    #[test]
    fn guess_mime_by_extension() {
        assert_eq!(guess_mime("a.PDF").as_deref(), Some("application/pdf"));
        assert_eq!(guess_mime("shot.PNG").as_deref(), Some("image/png"));
        assert_eq!(guess_mime("keys.zip").as_deref(), Some("application/zip"));
        assert_eq!(guess_mime("readme"), None);
        assert_eq!(guess_mime("weird.unknownext"), None);
    }

    #[test]
    fn display_name_falls_back_to_original() {
        assert_eq!(display_name(None, "a.bin").unwrap(), "a.bin");
        assert_eq!(display_name(Some("  护照  ".into()), "a.bin").unwrap(), "护照");
        assert!(display_name(Some("   ".into()), "").is_err());
    }

    #[test]
    fn reject_oversize_uses_limit() {
        assert!(reject_oversize(10, 100).is_ok());
        let err = reject_oversize(101, 100).unwrap_err();
        assert!(err.to_string().contains("不能超过"));
    }

    #[test]
    fn attachment_matches_id_or_legacy_sha() {
        let a = FileAttachment {
            id: "u1".into(),
            original_name: "a.bin".into(),
            mime: None,
            size: 1,
            sha256: "abc".into(),
        };
        assert!(attachment_matches(&a, "u1"));
        assert!(attachment_matches(&a, "abc"));
        assert!(!attachment_matches(&a, "no"));
    }
}
