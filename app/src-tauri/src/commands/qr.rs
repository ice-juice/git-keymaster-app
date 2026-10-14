//! 二维码渲染、解码，以及扫描/生成历史。
//!
//! 历史跟备忘录一样进保险库信封，再由同步引擎加密上传。图片不入库，打开记录时用原文重画。

use crate::commands::{ensure_writes_allowed, recover_lock, AppState};
use crate::error::{AppError, Result};
use crate::model::{
    canonical_qr_history_id, clear_qr_history, delete_qr_history, import_legacy_qr_history, insert_qr_history,
    qr_updated_at_from_unix_ms, QrHistoryData, QrHistoryEntry, QrHistoryKind, QrHistoryWriteError,
};
use crate::qrscan;
use crate::store;
use crate::util;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

fn publish(app: AppHandle) {
    crate::sync::scheduler::kick_publish(app);
}

fn parse_kind(kind: &str) -> Result<QrHistoryKind> {
    match kind {
        "scan" => Ok(QrHistoryKind::Scan),
        "generate" => Ok(QrHistoryKind::Generate),
        _ => Err(AppError::Invalid("未知的二维码历史类型".into())),
    }
}

fn now_ms() -> i64 {
    let now = time::OffsetDateTime::now_utc();
    now.unix_timestamp().saturating_mul(1000) + i64::from(now.nanosecond() / 1_000_000)
}

fn view(data: QrHistoryData) -> QrHistoryList {
    QrHistoryList {
        scans: data.scans,
        generations: data.generations,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrHistoryList {
    pub scans: Vec<QrHistoryEntry>,
    pub generations: Vec<QrHistoryEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QrHistoryLegacyItem {
    pub id: String,
    pub at: i64,
    pub text: String,
}

#[tauri::command]
pub fn render_qr_png(text: String) -> Result<String> {
    qrscan::render_qr_png_b64(&text)
}

#[tauri::command]
pub fn decode_qr_from_image(bytes: Vec<u8>) -> Result<Vec<String>> {
    qrscan::decode_image_bytes(&bytes)
}

#[tauri::command(async)]
pub fn qr_history_list(state: State<'_, AppState>) -> Result<QrHistoryList> {
    let vault = crate::commands::clone_unlocked_vault(&state)?;
    Ok(view(store::load_qr_history(&vault)?))
}

#[tauri::command(async)]
pub fn qr_history_add(app: AppHandle, state: State<'_, AppState>, kind: String, text: String) -> Result<QrHistoryList> {
    ensure_writes_allowed(&state)?;
    let kind = parse_kind(&kind)?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().filter(|item| item.is_unlocked()).ok_or(AppError::Locked)?;
    let mut data = store::load_qr_history(v)?;
    let at = now_ms();
    let entry = QrHistoryEntry {
        id: uuid::Uuid::new_v4().to_string(),
        text,
        at,
        updated_at: util::now_rfc3339(),
    };
    if let Err(err) = insert_qr_history(&mut data, kind, entry) {
        return Err(match err {
            QrHistoryWriteError::Empty => AppError::Invalid("二维码内容为空".into()),
            QrHistoryWriteError::TooLong => AppError::Invalid("二维码内容过长".into()),
        });
    }
    store::save_qr_history(v, &data)?;
    util::audit(v.root(), "记录二维码历史");
    drop(vault);
    publish(app);
    Ok(view(data))
}

#[tauri::command(async)]
pub fn qr_history_delete(app: AppHandle, state: State<'_, AppState>, kind: String, id: String) -> Result<QrHistoryList> {
    ensure_writes_allowed(&state)?;
    let kind = parse_kind(&kind)?;
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err(AppError::Invalid("缺少记录编号".into()));
    }
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().filter(|item| item.is_unlocked()).ok_or(AppError::Locked)?;
    let mut data = store::load_qr_history(v)?;
    if !delete_qr_history(&mut data, kind, &id, &util::now_rfc3339()) {
        return Err(AppError::Invalid("记录不存在".into()));
    }
    store::save_qr_history(v, &data)?;
    util::audit(v.root(), "删除二维码历史");
    drop(vault);
    publish(app);
    Ok(view(data))
}

#[tauri::command(async)]
pub fn qr_history_clear(app: AppHandle, state: State<'_, AppState>, kind: String) -> Result<QrHistoryList> {
    ensure_writes_allowed(&state)?;
    let kind = parse_kind(&kind)?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().filter(|item| item.is_unlocked()).ok_or(AppError::Locked)?;
    let mut data = store::load_qr_history(v)?;
    clear_qr_history(&mut data, kind, &util::now_rfc3339());
    store::save_qr_history(v, &data)?;
    util::audit(v.root(), "清空二维码历史");
    drop(vault);
    publish(app);
    Ok(view(data))
}

fn legacy_entries(kind: &str, items: Vec<QrHistoryLegacyItem>) -> Vec<QrHistoryEntry> {
    items
        .into_iter()
        .filter_map(|item| {
            let text = item.text.trim();
            if text.is_empty() {
                return None;
            }
            let at = item.at.clamp(0, 253_402_300_799_000);
            Some(QrHistoryEntry {
                id: canonical_qr_history_id(kind, &item.id, at, text),
                text: text.to_string(),
                at,
                updated_at: qr_updated_at_from_unix_ms(at),
            })
        })
        .collect()
}

#[tauri::command(async)]
pub fn qr_history_import_legacy(
    app: AppHandle,
    state: State<'_, AppState>,
    scans: Vec<QrHistoryLegacyItem>,
    generations: Vec<QrHistoryLegacyItem>,
) -> Result<QrHistoryList> {
    ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().filter(|item| item.is_unlocked()).ok_or(AppError::Locked)?;
    let mut data = store::load_qr_history(v)?;
    let changed = import_legacy_qr_history(
        &mut data,
        legacy_entries("scan", scans),
        legacy_entries("generate", generations),
    );
    if changed {
        store::save_qr_history(v, &data)?;
        util::audit(v.root(), "迁入本地二维码历史");
        drop(vault);
        publish(app);
    }
    Ok(view(data))
}
