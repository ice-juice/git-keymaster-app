//! 隐私账号 CRUD、密码 reveal 与历史版本。

use crate::app_config;
use crate::commands::{ensure_reveal_authorized, ensure_writes_allowed, recover_lock, AppState};
use crate::error::{AppError, Result};
use crate::icons;
use crate::model::{AccountEntry, AccountSecret, GroupMeta, PasswordHistoryItem};
use crate::store;
use crate::util;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, State};

fn publish(app: AppHandle) {
    crate::sync::scheduler::kick_publish(app);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountList {
    pub entries: Vec<AccountEntry>,
    pub groups: Vec<GroupMeta>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUpsertArgs {
    pub id: Option<String>,
    pub platform: String,
    pub username: String,
    pub password: Option<String>,
    pub display_name: Option<String>,
    pub url: Option<String>,
    pub note: Option<String>,
    pub group: Option<String>,
    pub tags: Option<Vec<String>>,
    pub icon: Option<String>,
    pub pinned: Option<bool>,
    pub sort_order: Option<i32>,
    pub totp_ref: Option<String>,
    #[serde(default)]
    pub extra_fields: Option<HashMap<String, String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountReveal {
    pub password: String,
    #[serde(default)]
    pub extra_fields: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMeta {
    pub index: usize,
    pub replaced_at: String,
}

fn now() -> String {
    util::now_rfc3339()
}

#[tauri::command(async)]
pub fn account_list(state: State<'_, AppState>) -> Result<AccountList> {
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let data = store::load_accounts(v)?;
    let secrets = store::load_secrets(v)?;
    let entries = data
        .entries
        .into_iter()
        .map(|mut e| {
            let secret = secrets.account_secrets.get(&e.id);
            e.has_password = secret.map(|s| !s.password.is_empty()).unwrap_or(false);
            e.extra_field_keys = secret
                .map(|s| {
                    let mut keys: Vec<String> = s.extra_fields.keys().cloned().collect();
                    keys.sort();
                    keys
                })
                .unwrap_or_default();
            e
        })
        .collect();
    Ok(AccountList {
        entries,
        groups: data.groups,
    })
}

fn missing_password() -> AppError {
    AppError::Other("这条账号的密码已丢失，请编辑并重新填入密码。".into())
}

#[tauri::command]
pub fn account_add(app: AppHandle, state: State<AppState>, args: AccountUpsertArgs) -> Result<AccountEntry> {
    ensure_writes_allowed(&state)?;
    let password = args
        .password
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Invalid("请填写密码".into()))?
        .to_string();
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let mut data = store::load_accounts(v)?;
    let mut secrets = store::load_secrets(v)?;
    let username = args.username.trim().to_string();
    if args.platform.trim().is_empty() || username.is_empty() {
        return Err(AppError::Invalid("平台与用户名不能为空".into()));
    }
    let (platform, icon) = resolve_and_align(
        &mut data.entries,
        None,
        args.platform.trim(),
        nonempty_icon(args.icon.clone()),
    );
    let now = now();
    let entry = AccountEntry {
        id: uuid::Uuid::new_v4().to_string(),
        platform,
        username,
        display_name: empty_none(args.display_name),
        url: empty_none(args.url),
        note: empty_none(args.note),
        group: empty_none(args.group),
        tags: args.tags.unwrap_or_default(),
        icon,
        pinned: args.pinned.unwrap_or(false),
        sort_order: args.sort_order.unwrap_or(0),
        totp_ref: empty_none(args.totp_ref),
        last_used_at: None,
        created_at: now.clone(),
        updated_at: now,
        has_password: true,
        extra_field_keys: vec![],
    };
    let extra_fields = sanitize_extra_fields(args.extra_fields);
    let extra_field_keys = extra_field_keys_of(&extra_fields);
    secrets.account_secrets.insert(
        entry.id.clone(),
        AccountSecret {
            password,
            extra_fields,
            history: vec![],
        },
    );
    let mut entry = entry;
    entry.extra_field_keys = extra_field_keys;
    data.entries.push(entry.clone());
    store::save_secrets(v, &secrets)?;
    store::save_accounts(v, &data)?;
    util::audit(v.root(), &format!("新增隐私账号 id={}", entry.id));
    drop(vault);
    publish(app);
    Ok(entry)
}

#[tauri::command]
pub fn account_update(app: AppHandle, state: State<AppState>, args: AccountUpsertArgs) -> Result<AccountEntry> {
    ensure_writes_allowed(&state)?;
    let id = args.id.clone().ok_or_else(|| AppError::Invalid("缺少 id".into()))?;
    let limit = {
        let cfg = recover_lock(&state.config);
        app_config::clamp_account_history_limit(cfg.account_history_limit)
    };
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let mut data = store::load_accounts(v)?;
    let mut secrets = store::load_secrets(v)?;
    if !data.entries.iter().any(|e| e.id == id) {
        return Err(AppError::Invalid("账号不存在".into()));
    }
    let incoming_icon = nonempty_icon(args.icon.clone()).or_else(|| {
        data.entries
            .iter()
            .find(|e| e.id == id)
            .and_then(|e| e.icon.clone())
    });
    let (platform, icon) = resolve_and_align(
        &mut data.entries,
        Some(&id),
        args.platform.trim(),
        incoming_icon,
    );
    let entry = data
        .entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::Invalid("账号不存在".into()))?;
    entry.platform = platform;
    entry.username = args.username.trim().to_string();
    entry.display_name = empty_none(args.display_name);
    entry.url = empty_none(args.url);
    entry.note = empty_none(args.note);
    entry.group = empty_none(args.group);
    if let Some(tags) = args.tags {
        entry.tags = tags;
    }
    entry.icon = icon;
    if let Some(p) = args.pinned {
        entry.pinned = p;
    }
    if let Some(s) = args.sort_order {
        entry.sort_order = s;
    }
    entry.totp_ref = empty_none(args.totp_ref);
    entry.updated_at = now();

    if let Some(new_pw) = args.password.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let secret = secrets.account_secrets.entry(id.clone()).or_default();
        if secret.password != new_pw {
            if !secret.password.is_empty() {
                secret.history.insert(
                    0,
                    PasswordHistoryItem {
                        password: secret.password.clone(),
                        replaced_at: now(),
                    },
                );
                if secret.history.len() > limit as usize {
                    secret.history.truncate(limit as usize);
                }
            }
            secret.password = new_pw.to_string();
        }
    } else if secrets
        .account_secrets
        .get(&id)
        .map(|s| s.password.is_empty())
        .unwrap_or(true)
    {
        return Err(AppError::Invalid("这条记录没有密码，请重新填入".into()));
    }
    if let Some(fields) = args.extra_fields {
        let secret = secrets.account_secrets.entry(id.clone()).or_default();
        secret.extra_fields = sanitize_extra_fields(Some(fields));
    }
    let mut out = entry.clone();
    out.has_password = secrets
        .account_secrets
        .get(&id)
        .map(|s| !s.password.is_empty())
        .unwrap_or(false);
    out.extra_field_keys = secrets
        .account_secrets
        .get(&id)
        .map(|s| extra_field_keys_of(&s.extra_fields))
        .unwrap_or_default();
    store::save_secrets(v, &secrets)?;
    store::save_accounts(v, &data)?;
    util::audit(v.root(), &format!("更新隐私账号 id={id}"));
    drop(vault);
    publish(app);
    Ok(out)
}

#[tauri::command]
pub fn account_delete(app: AppHandle, state: State<AppState>, id: String) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let mut data = store::load_accounts(v)?;
    let mut secrets = store::load_secrets(v)?;
    let before = data.entries.len();
    data.entries.retain(|e| e.id != id);
    if data.entries.len() == before {
        return Err(AppError::Invalid("账号不存在".into()));
    }
    data.deleted_entries.insert(id.clone(), now());
    secrets.account_secrets.remove(&id);
    store::save_secrets(v, &secrets)?;
    store::save_accounts(v, &data)?;
    util::audit(v.root(), &format!("删除隐私账号 id={id}"));
    drop(vault);
    publish(app);
    Ok(())
}

#[tauri::command]
pub fn account_save_groups(app: AppHandle, state: State<AppState>, groups: Vec<GroupMeta>) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let mut data = store::load_accounts(v)?;
    data.groups = groups;
    store::save_accounts(v, &data)?;
    drop(vault);
    publish(app);
    Ok(())
}

#[tauri::command]
pub fn account_reveal_password(
    state: State<AppState>,
    id: String,
    password: Option<String>,
) -> Result<AccountReveal> {
    ensure_reveal_authorized(&state, password.as_deref())?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let secrets = store::load_secrets(v)?;
    let secret = secrets
        .account_secrets
        .get(&id)
        .ok_or_else(missing_password)?;
    if secret.password.is_empty() {
        return Err(missing_password());
    }
    util::audit(v.root(), &format!("查看账号机密 id={id}"));
    Ok(AccountReveal {
        password: secret.password.clone(),
        extra_fields: secret.extra_fields.clone(),
    })
}

#[tauri::command]
pub fn account_touch(state: State<AppState>, id: String) -> Result<()> {
    if state.writes_locked.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let mut data = store::load_accounts(v)?;
    if let Some(e) = data.entries.iter_mut().find(|e| e.id == id) {
        e.last_used_at = Some(now());
        store::save_accounts(v, &data)?;
    }
    Ok(())
}

#[tauri::command]
pub fn account_history_list(state: State<AppState>, id: String) -> Result<Vec<HistoryMeta>> {
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let secrets = store::load_secrets(v)?;
    let items = secrets
        .account_secrets
        .get(&id)
        .map(|s| {
            s.history
                .iter()
                .enumerate()
                .map(|(index, h)| HistoryMeta {
                    index,
                    replaced_at: h.replaced_at.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(items)
}

#[tauri::command]
pub fn account_reveal_history(
    state: State<AppState>,
    id: String,
    index: usize,
    password: Option<String>,
) -> Result<String> {
    ensure_reveal_authorized(&state, password.as_deref())?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let secrets = store::load_secrets(v)?;
    let item = secrets
        .account_secrets
        .get(&id)
        .and_then(|s| s.history.get(index))
        .ok_or_else(|| AppError::Invalid("历史版本不存在".into()))?;
    util::audit(v.root(), &format!("查看账号历史密码 id={id} index={index}"));
    Ok(item.password.clone())
}

#[tauri::command]
pub fn account_rollback_history(app: AppHandle, state: State<AppState>, id: String, index: usize) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let limit = {
        let cfg = recover_lock(&state.config);
        app_config::clamp_account_history_limit(cfg.account_history_limit)
    };
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let mut secrets = store::load_secrets(v)?;
    let mut data = store::load_accounts(v)?;
    let secret = secrets
        .account_secrets
        .get_mut(&id)
        .ok_or_else(|| AppError::Invalid("账号机密不存在".into()))?;
    if index >= secret.history.len() {
        return Err(AppError::Invalid("历史版本不存在".into()));
    }
    let old = secret.history[index].password.clone();
    if !secret.password.is_empty() {
        secret.history.insert(
            0,
            PasswordHistoryItem {
                password: secret.password.clone(),
                replaced_at: now(),
            },
        );
    }
    secret.password = old;
    if secret.history.len() > limit as usize {
        secret.history.truncate(limit as usize);
    }
    if let Some(e) = data.entries.iter_mut().find(|e| e.id == id) {
        e.updated_at = now();
    }
    store::save_secrets(v, &secrets)?;
    store::save_accounts(v, &data)?;
    util::audit(v.root(), &format!("回滚账号密码 id={id}"));
    drop(vault);
    publish(app);
    Ok(())
}

#[tauri::command]
pub fn account_clear_history(app: AppHandle, state: State<AppState>, id: String) -> Result<()> {
    ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let mut secrets = store::load_secrets(v)?;
    if let Some(s) = secrets.account_secrets.get_mut(&id) {
        s.history.clear();
        store::save_secrets(v, &secrets)?;
        util::audit(v.root(), &format!("清空账号密码历史 id={id}"));
        drop(vault);
        publish(app);
    }
    Ok(())
}

fn empty_none(s: Option<String>) -> Option<String> {
    s.map(|x| x.trim().to_string()).filter(|x| !x.is_empty())
}

fn sanitize_extra_fields(fields: Option<HashMap<String, String>>) -> HashMap<String, String> {
    fields
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(k, v)| {
            let key = k.trim().to_string();
            if key.is_empty() {
                return None;
            }
            Some((key, v))
        })
        .collect()
}

fn extra_field_keys_of(fields: &HashMap<String, String>) -> Vec<String> {
    let mut keys: Vec<String> = fields.keys().cloned().collect();
    keys.sort();
    keys
}

fn nonempty_icon(s: Option<String>) -> Option<String> {
    empty_none(s)
}

fn platform_family(platform: &str) -> String {
    icons::suggest_builtin(platform).unwrap_or_else(|| platform.trim().to_ascii_lowercase())
}

fn builtin_display_name(family: &str, raw_platform: &str) -> Option<String> {
    let id = family.strip_prefix("builtin:")?;
    let b = icons::list_builtin().into_iter().find(|i| i.id == id)?;
    let q = raw_platform.trim().to_ascii_lowercase();
    if q == b.id.to_ascii_lowercase() || q == b.name.to_ascii_lowercase() {
        Some(b.name)
    } else {
        None
    }
}

/// 同一平台（大小写 / 内置站别名）共用一份平台名和图标。
fn resolve_and_align(
    entries: &mut [AccountEntry],
    except_id: Option<&str>,
    platform: &str,
    icon: Option<String>,
) -> (String, Option<String>) {
    let platform = platform.trim();
    let family = platform_family(platform);
    let sibling_ids: Vec<String> = entries
        .iter()
        .filter(|e| except_id != Some(e.id.as_str()) && platform_family(&e.platform) == family)
        .map(|e| e.id.clone())
        .collect();

    let canonical_name = sibling_ids
        .first()
        .and_then(|id| {
            entries
                .iter()
                .find(|e| e.id == *id)
                .map(|e| e.platform.clone())
        })
        .or_else(|| builtin_display_name(&family, platform))
        .unwrap_or_else(|| platform.to_string());

    let sibling_icon = sibling_ids.iter().find_map(|id| {
        entries
            .iter()
            .find(|e| e.id == *id)
            .and_then(|e| e.icon.clone())
    });
    let canonical_icon = icon
        .filter(|s| !s.trim().is_empty())
        .or(sibling_icon)
        .or_else(|| icons::suggest_builtin(&canonical_name));

    for e in entries.iter_mut() {
        if sibling_ids.iter().any(|id| *id == e.id) {
            e.platform = canonical_name.clone();
            e.icon = canonical_icon.clone();
        }
    }
    (canonical_name, canonical_icon)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, platform: &str, icon: Option<&str>) -> AccountEntry {
        AccountEntry {
            id: id.into(),
            platform: platform.into(),
            username: id.into(),
            display_name: None,
            url: None,
            note: None,
            group: None,
            tags: vec![],
            icon: icon.map(|s| s.into()),
            pinned: false,
            sort_order: 0,
            totp_ref: None,
            last_used_at: None,
            created_at: "t".into(),
            updated_at: "t".into(),
            has_password: true,
            extra_field_keys: vec![],
        }
    }

    #[test]
    fn add_joins_existing_github_spelling() {
        let mut entries = vec![entry("a", "GitHub", Some("builtin:github"))];
        let (name, icon) = resolve_and_align(&mut entries, None, "github.com", None);
        assert_eq!(name, "GitHub");
        assert_eq!(icon.as_deref(), Some("builtin:github"));
        assert_eq!(entries[0].platform, "GitHub");
    }

    #[test]
    fn custom_icon_spreads_to_siblings() {
        let mut entries = vec![
            entry("a", "GitHub", Some("builtin:github")),
            entry("b", "github", Some("builtin:github")),
        ];
        let (name, icon) = resolve_and_align(
            &mut entries,
            None,
            "GitHub",
            Some("custom:abc".into()),
        );
        assert_eq!(name, "GitHub");
        assert_eq!(icon.as_deref(), Some("custom:abc"));
        assert!(entries.iter().all(|e| e.platform == "GitHub"));
        assert!(entries.iter().all(|e| e.icon.as_deref() == Some("custom:abc")));
    }

    #[test]
    fn case_only_name_keeps_one_group() {
        let mut entries = vec![entry("a", "MyBank", None)];
        let (name, _) = resolve_and_align(&mut entries, None, "mybank", None);
        assert_eq!(name, "MyBank");
        assert_eq!(entries[0].platform, "MyBank");
    }

    #[test]
    fn moving_to_other_platform_leaves_old_siblings() {
        let mut entries = vec![
            entry("a", "GitHub", Some("builtin:github")),
            entry("b", "GitHub", Some("builtin:github")),
        ];
        let (name, icon) = resolve_and_align(&mut entries, Some("b"), "GitLab", None);
        assert_eq!(name, "GitLab");
        assert_eq!(icon.as_deref(), Some("builtin:gitlab"));
        assert_eq!(entries[0].platform, "GitHub");
        assert_eq!(entries[0].icon.as_deref(), Some("builtin:github"));
    }

    #[test]
    fn extra_fields_drop_blank_keys() {
        let mut raw = HashMap::new();
        raw.insert("  ".into(), "x".into());
        raw.insert(" recovery ".into(), "ans".into());
        let cleaned = sanitize_extra_fields(Some(raw));
        assert_eq!(cleaned.get("recovery").map(String::as_str), Some("ans"));
        assert_eq!(cleaned.len(), 1);
        assert!(sanitize_extra_fields(None).is_empty());
        assert_eq!(extra_field_keys_of(&cleaned), vec!["recovery".to_string()]);
    }
}
