//! 备忘录：元数据 CRUD、正文/图片 blob、无损压缩与导出。

use crate::app_config;
use crate::commands::{ensure_writes_allowed, recover_lock, AppState};
use crate::error::{AppError, Result};
use crate::model::{collect_blob_hashes, GroupMeta, NoteEntry};
use crate::store;
use crate::store::blob::{self, DEFAULT_CHUNK_SIZE};
use crate::util;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use image::{ExtendedColorType, ImageFormat};
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

fn reject_oversize(size: u64, limit: u64) -> Result<()> {
    if size > limit {
        let mb = (limit / (1024 * 1024)).max(1);
        return Err(AppError::Invalid(format!("单个文件不能超过 {mb} MB")));
    }
    Ok(())
}

fn gc_after_notes_change(v: &crate::vault::Vault) -> Result<()> {
    let files = store::load_files(v)?;
    let notes = store::load_notes(v)?;
    let refs = collect_blob_hashes(&files, &notes);
    blob::gc_unreferenced_blobs(v, &refs)?;
    Ok(())
}

/// 列表摘要：去掉图片语法与常见 Markdown 标记，取前若干可读字。
pub fn excerpt_from_markdown(md: &str) -> Option<String> {
    let mut s = String::with_capacity(md.len());
    let chars: Vec<char> = md.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '!'
            && i + 1 < chars.len()
            && chars[i + 1] == '['
        {
            if let Some(end) = find_image_end(&chars, i) {
                i = end;
                s.push(' ');
                continue;
            }
        }
        s.push(chars[i]);
        i += 1;
    }
    let cleaned: String = s
        .chars()
        .map(|c| match c {
            '#' | '*' | '`' | '>' | '[' | ']' | '(' | ')' => ' ',
            _ => c,
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let take: String = collapsed.chars().take(160).collect();
    if take.is_empty() {
        None
    } else {
        Some(take)
    }
}

fn find_image_end(chars: &[char], start: usize) -> Option<usize> {
    let mut j = start + 2;
    while j < chars.len() && chars[j] != ']' {
        j += 1;
    }
    if j + 1 >= chars.len() || chars[j] != ']' || chars[j + 1] != '(' {
        return None;
    }
    j += 2;
    while j < chars.len() && chars[j] != ')' {
        j += 1;
    }
    if j < chars.len() && chars[j] == ')' {
        Some(j + 1)
    } else {
        None
    }
}

pub fn collect_asset_hashes(md: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = md.as_bytes();
    let needle = b"kmasset://";
    let mut i = 0;
    while i + needle.len() + 64 <= bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            let hex = &md[i + needle.len()..i + needle.len() + 64];
            let hash = hex.to_ascii_lowercase();
            if blob::is_sha256_hex(&hash) && !out.iter().any(|h| h == &hash) {
                out.push(hash);
            }
            i += needle.len() + 64;
        } else {
            i += 1;
        }
    }
    out
}

fn sniff_image_format(bytes: &[u8]) -> Option<ImageFormat> {
    image::guess_format(bytes).ok().or_else(|| {
        if bytes.starts_with(b"\x89PNG") {
            Some(ImageFormat::Png)
        } else if bytes.starts_with(b"BM") {
            Some(ImageFormat::Bmp)
        } else if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
            Some(ImageFormat::Jpeg)
        } else if bytes.starts_with(b"GIF8") {
            Some(ImageFormat::Gif)
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(ImageFormat::WebP)
        } else {
            None
        }
    })
}

fn sniff_image_mime(bytes: &[u8]) -> &'static str {
    match sniff_image_format(bytes) {
        Some(ImageFormat::Png) => "image/png",
        Some(ImageFormat::Jpeg) => "image/jpeg",
        Some(ImageFormat::Gif) => "image/gif",
        Some(ImageFormat::WebP) => "image/webp",
        Some(ImageFormat::Bmp) => "image/bmp",
        _ => "application/octet-stream",
    }
}

/// PNG / BMP → 无损 WebP；JPEG / GIF / 已是 WebP 保持原样。
pub fn optimize_note_image(bytes: &[u8]) -> Result<Vec<u8>> {
    match sniff_image_format(bytes) {
        Some(ImageFormat::Png) | Some(ImageFormat::Bmp) => {
            let img = image::load_from_memory(bytes)
                .map_err(|e| AppError::Invalid(format!("图片解码失败: {e}")))?;
            let rgba = img.to_rgba8();
            let mut out = Vec::new();
            let enc = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
            enc.encode(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                ExtendedColorType::Rgba8,
            )
            .map_err(|_| AppError::Invalid("WebP 编码失败".into()))?;
            Ok(out)
        }
        _ => Ok(bytes.to_vec()),
    }
}

fn write_body_blob(v: &crate::vault::Vault, markdown: &str, limit: u64) -> Result<String> {
    reject_oversize(markdown.len() as u64, limit)?;
    let blob = blob::write_blob_limited(
        v,
        Cursor::new(markdown.as_bytes().to_vec()),
        DEFAULT_CHUNK_SIZE,
        limit,
    )?;
    Ok(blob.sha256)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteList {
    pub entries: Vec<NoteEntry>,
    pub groups: Vec<GroupMeta>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteBody {
    pub format: String,
    pub markdown: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpsertArgs {
    pub id: Option<String>,
    pub title: String,
    pub format: Option<String>,
    pub tags: Option<Vec<String>>,
    pub group: Option<String>,
    pub icon: Option<String>,
    pub pinned: Option<bool>,
    pub markdown: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteAssetAddResult {
    pub hash: String,
}

#[tauri::command(async)]
pub fn note_list(state: State<'_, AppState>) -> Result<NoteList> {
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let data = store::load_notes(v)?;
    Ok(NoteList {
        entries: data.entries,
        groups: data.groups,
    })
}

#[tauri::command(async)]
pub fn note_get_body(state: State<'_, AppState>, id: String) -> Result<NoteBody> {
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let data = store::load_notes(v)?;
    let entry = data
        .entries
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::Invalid("备忘录不存在".into()))?;
    let bytes = blob::read_blob_bytes(v, &entry.body_sha256)?;
    let markdown = String::from_utf8(bytes)
        .map_err(|_| AppError::Invalid("备忘录正文不是有效 UTF-8".into()))?;
    Ok(NoteBody {
        format: entry.format.clone(),
        markdown,
    })
}

#[tauri::command(async)]
pub fn note_upsert(
    app: AppHandle,
    state: State<'_, AppState>,
    args: NoteUpsertArgs,
) -> Result<NoteEntry> {
    ensure_writes_allowed(&state)?;
    let format = args
        .format
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("markdown")
        .to_string();
    if format != "markdown" {
        return Err(AppError::Invalid("目前仅支持 Markdown 备忘录".into()));
    }
    let tags = args
        .tags
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>();
    let excerpt = excerpt_from_markdown(&args.markdown);
    let asset_hashes = collect_asset_hashes(&args.markdown);
    let limit = per_file_limit(&state);
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let body_sha256 = write_body_blob(v, &args.markdown, limit)?;
    let mut data = store::load_notes(v)?;
    let ts = now();
    let out = if let Some(id) = args.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let entry = data
            .entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::Invalid("备忘录不存在".into()))?;
        entry.title = args.title.trim().to_string();
        entry.format = format;
        entry.tags = tags;
        entry.group = empty_none(args.group);
        if args.icon.is_some() {
            entry.icon = empty_none(args.icon);
        }
        entry.pinned = args.pinned.unwrap_or(entry.pinned);
        entry.excerpt = excerpt;
        entry.body_sha256 = body_sha256;
        entry.asset_hashes = asset_hashes;
        entry.updated_at = ts;
        entry.clone()
    } else {
        let entry = NoteEntry {
            id: uuid::Uuid::new_v4().to_string(),
            title: args.title.trim().to_string(),
            format,
            group: empty_none(args.group),
            tags,
            icon: empty_none(args.icon),
            pinned: args.pinned.unwrap_or(false),
            sort_order: 0,
            excerpt,
            body_sha256,
            asset_hashes,
            created_at: ts.clone(),
            updated_at: ts,
        };
        data.deleted_entries.remove(&entry.id);
        data.entries.push(entry.clone());
        entry
    };
    store::save_notes(v, &data)?;
    gc_after_notes_change(v)?;
    util::audit(v.root(), &format!("保存备忘录 id={}", out.id));
    drop(vault);
    publish(app);
    Ok(out)
}

#[tauri::command]
pub fn note_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let mut data = store::load_notes(v)?;
    let before = data.entries.len();
    data.entries.retain(|e| e.id != id);
    if data.entries.len() == before {
        return Err(AppError::Invalid("备忘录不存在".into()));
    }
    data.deleted_entries.insert(id.clone(), now());
    store::save_notes(v, &data)?;
    gc_after_notes_change(v)?;
    util::audit(v.root(), &format!("删除备忘录 id={id}"));
    drop(vault);
    publish(app);
    Ok(())
}

#[tauri::command(async)]
pub fn note_asset_add(
    app: AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
    bytes: Option<Vec<u8>>,
) -> Result<NoteAssetAddResult> {
    ensure_writes_allowed(&state)?;
    let raw = if let Some(p) = path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let src = PathBuf::from(p);
        if !src.is_file() {
            return Err(AppError::Invalid("找不到所选图片".into()));
        }
        std::fs::read(&src)?
    } else if let Some(b) = bytes {
        b
    } else {
        return Err(AppError::Invalid("请选择要插入的图片".into()));
    };
    let limit = per_file_limit(&state);
    reject_oversize(raw.len() as u64, limit)?;
    let optimized = optimize_note_image(&raw)?;
    reject_oversize(optimized.len() as u64, limit)?;
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let blob = blob::write_blob_limited(v, Cursor::new(optimized), DEFAULT_CHUNK_SIZE, limit)?;
    drop(vault);
    publish(app);
    Ok(NoteAssetAddResult { hash: blob.sha256 })
}

#[tauri::command(async)]
pub fn note_asset_get(state: State<'_, AppState>, hash: String) -> Result<String> {
    let hash = hash.trim().to_ascii_lowercase();
    if !blob::is_sha256_hex(&hash) {
        return Err(AppError::Invalid("无效的图片哈希".into()));
    }
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let bytes = blob::read_blob_bytes(v, &hash)?;
    let mime = sniff_image_mime(&bytes);
    Ok(format!("data:{mime};base64,{}", B64.encode(bytes)))
}

#[tauri::command]
pub fn note_save_groups(
    app: AppHandle,
    state: State<'_, AppState>,
    groups: Vec<GroupMeta>,
) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let mut data = store::load_notes(v)?;
    data.groups = groups;
    store::save_notes(v, &data)?;
    drop(vault);
    publish(app);
    Ok(())
}

fn resolve_export_dest(dest_path: &str) -> Result<PathBuf> {
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
    Ok(dest)
}

fn note_markdown_for_export(
    v: &crate::vault::Vault,
    id: &str,
    mode: Option<&str>,
) -> Result<String> {
    let data = store::load_notes(v)?;
    let entry = data
        .entries
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::Invalid("备忘录不存在".into()))?;
    let bytes = blob::read_blob_bytes(v, &entry.body_sha256)?;
    let markdown = String::from_utf8(bytes)
        .map_err(|_| AppError::Invalid("备忘录正文不是有效 UTF-8".into()))?;
    if mode.unwrap_or("md_raw") == "md_inline" {
        inline_note_assets(v, &markdown)
    } else {
        Ok(markdown)
    }
}

#[tauri::command(async)]
pub fn note_export(
    state: State<'_, AppState>,
    id: String,
    dest_path: String,
    mode: Option<String>,
) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let dest = resolve_export_dest(&dest_path)?;
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    let body = note_markdown_for_export(v, &id, mode.as_deref())?;
    std::fs::write(&dest, body.as_bytes())?;
    util::audit(v.root(), &format!("导出备忘录 id={id}"));
    Ok(())
}

#[tauri::command(async)]
pub fn note_export_content(
    state: State<'_, AppState>,
    id: String,
    mode: Option<String>,
) -> Result<String> {
    let vault = recover_lock(&state.vault);
    let v = unlocked_vault(&vault)?;
    note_markdown_for_export(v, &id, mode.as_deref())
}

#[tauri::command(async)]
pub fn note_write_export_file(
    state: State<'_, AppState>,
    dest_path: String,
    bytes: Vec<u8>,
) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let dest = resolve_export_dest(&dest_path)?;
    std::fs::write(&dest, bytes)?;
    Ok(())
}

fn inline_note_assets(v: &crate::vault::Vault, markdown: &str) -> Result<String> {
    let mut out = markdown.to_string();
    for hash in collect_asset_hashes(markdown) {
        let bytes = blob::read_blob_bytes(v, &hash)?;
        let mime = sniff_image_mime(&bytes);
        let data = format!("data:{mime};base64,{}", B64.encode(bytes));
        out = out.replace(&format!("kmasset://{hash}"), &data);
    }
    Ok(out)
}

#[allow(dead_code)]
fn original_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpt_strips_images_and_markup() {
        let md = "# 标题\n\n![x](kmasset://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)\n正文 **加粗** 内容";
        let ex = excerpt_from_markdown(md).unwrap();
        assert!(!ex.contains("kmasset"));
        assert!(ex.contains("标题"));
        assert!(ex.contains("正文"));
        assert!(ex.contains("加粗"));
    }

    #[test]
    fn collect_asset_hashes_dedups() {
        let h = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let md = format!("![](kmasset://{h}) and again ![](kmasset://{h})");
        let hashes = collect_asset_hashes(&md);
        assert_eq!(hashes, vec![h.to_string()]);
    }

    #[test]
    fn jpeg_and_webp_kept_as_is() {
        let jpeg = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3];
        assert_eq!(optimize_note_image(&jpeg).unwrap(), jpeg);
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        webp.extend_from_slice(&[9, 8, 7]);
        assert_eq!(optimize_note_image(&webp).unwrap(), webp);
    }

    #[test]
    fn png_converts_to_lossless_webp() {
        let img = image::RgbaImage::from_pixel(2, 2, image::Rgba([10, 20, 30, 255]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        let out = optimize_note_image(&png).unwrap();
        assert_ne!(out, png);
        assert_eq!(sniff_image_format(&out), Some(ImageFormat::WebP));
    }
}
