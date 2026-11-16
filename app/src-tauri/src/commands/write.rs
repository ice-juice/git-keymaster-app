//! M3 命令层：密钥生成、config 预览/落盘、新建身份、机密二次验证查看。

use crate::commands::{recover_lock, AppState};
use crate::error::{AppError, Result};
use crate::model::{Identity, KeyRecord};
use crate::platform::{self, PlatformOps};
use crate::ssh::managed::{self, ManagedEntry};
use crate::ssh::{key, keygen};
use crate::store;
use crate::sys;
use crate::util;
use crate::vault::Vault;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

/// 密钥注释：优先邮箱，否则备注名，再否则提交姓名。
pub fn suggest_key_comment(email: Option<&str>, name: &str, git_user_name: Option<&str>) -> String {
    if let Some(e) = email.map(str::trim).filter(|s| !s.is_empty()) {
        return e.to_string();
    }
    let n = name.trim();
    if !n.is_empty() {
        return format!("{n}@gam");
    }
    if let Some(g) = git_user_name.map(str::trim).filter(|s| !s.is_empty()) {
        let compact = g.split_whitespace().collect::<Vec<_>>().join(".");
        return format!("{compact}@gam");
    }
    String::new()
}

fn persist_workspace_ssh_config(v: &Vault, text: &str) -> Result<()> {
    sys::persist_ssh_config(Some(v.root()), text)
}

fn load_workspace_ssh_config(v: &Vault) -> String {
    sys::read_workspace_ssh_config(v.root())
        .map(|(_, text)| text)
        .unwrap_or_default()
}

/// Metadata/secrets form one durable transaction. SSH config is an external
/// projection: keep its exact prior bytes and restore them on pre-commit failure.
fn with_ssh_transaction<T>(v: &Vault, operation: impl FnOnce() -> Result<T>) -> Result<T> {
    store::with_exclusive_workspace(v.root(), || {
        let path = sys::workspace_ssh_config(v.root());
        let previous = match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        if previous.is_some() {
            util::backup_file(&path)?;
        }
        let result = store::transaction(v, operation);
        if let Err(error) = result {
            // A committed redo must finish; rolling its projection back would create
            // the opposite mismatch. The original config backup remains available.
            if v.root().join(".store-transaction/COMMITTED").is_file() {
                return Err(error);
            }
            let restored = match previous {
                Some(bytes) => crate::vault::atomic_write(&path, &bytes),
                None => match std::fs::remove_file(&path) {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(e.into()),
                },
            };
            if let Err(restore_error) = restored {
                return Err(AppError::Other(format!("身份保存失败：{error}；SSH 配置恢复也失败：{restore_error}。原始配置备份已保留，请勿重复创建身份。")));
            }
            return Err(error);
        }
        result
    })
}

/// Only an explicitly referenced, strict-only key can lose its deployed private
/// file. Unbound generated keys and keys with any non-strict consumer are retained.
fn cleanup_strict_private_keys(v: &Vault) -> Result<()> {
    store::with_exclusive_workspace(v.root(), || {
        let data = store::load_data(v)?;
        for record in &data.keys {
            let references: Vec<_> = data
                .identities
                .iter()
                .filter(|id| id.key_id.as_deref() == Some(record.id.as_str()))
                .collect();
            if references.is_empty() || references.iter().any(|id| !id.strict_mode) {
                continue;
            }
            let dir = sys::workspace_ssh_keys_dir(v.root());
            let private = dir.join(deployed_key_stem(record));
            if private
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink())
            {
                return Err(AppError::Invalid(
                    "严格模式清理遇到符号链接，已拒绝删除".into(),
                ));
            }
            if private.is_file() {
                let expected = zeroize::Zeroizing::new(store::load_key(v, &record.id)?);
                let actual = zeroize::Zeroizing::new(std::fs::read(&private)?);
                if actual.as_slice() != expected.as_slice() {
                    return Err(AppError::Invalid(
                        "严格模式目标文件并非该密钥，已保留文件".into(),
                    ));
                }
                std::fs::remove_file(&private).map_err(|e| {
                    AppError::Other(format!(
                        "身份已保存，但严格模式私钥清理失败：{e}。私钥文件尚在，请检查文件权限。"
                    ))
                })?;
            }
        }
        Ok(())
    })
}

/// 按库内身份补齐工作空间 SSH Host。正本若被写成 Include stub 会先清空再重建。
pub fn reconcile_ssh_hosts(v: &Vault) -> Result<u32> {
    let count = with_ssh_transaction(v, || reconcile_ssh_hosts_inner(v))?;
    cleanup_strict_private_keys(v)?;
    Ok(count)
}

fn reconcile_ssh_hosts_inner(v: &Vault) -> Result<u32> {
    let mut data = store::load_data(v)?;
    let dest = sys::workspace_ssh_config(v.root());
    let mut text = std::fs::read_to_string(&dest).unwrap_or_default();
    if sys::text_is_include_only(&text) {
        text.clear();
    }
    let before_norm = text.clone();
    text = managed::normalize_unique_hosts(&text);
    let mut added = 0u32;
    let mut updated = 0u32;
    let mut data_changed = false;
    for key in &mut data.keys {
        if let Some(p) = &key.deployed_path {
            let portable = sys::portable_deployed_path(p);
            if portable != *p {
                key.deployed_path = Some(portable);
                data_changed = true;
            }
        }
    }
    for id in &data.identities {
        if id.host_alias.trim().is_empty() {
            continue;
        }
        let Some(kid) = &id.key_id else {
            continue;
        };
        let Some(record) = data.keys.iter().find(|k| &k.id == kid) else {
            continue;
        };
        // Identity mode decides the path; shared KeyRecord.deployed_path is only
        // a catalog hint and cannot stand in for each identity's policy.
        let identity_file = deploy_openssh_files(v, record, "", id.strict_mode)?;
        let existing = managed::list(&text);
        if let Some(cur) = existing
            .iter()
            .find(|e| e.alias.eq_ignore_ascii_case(&id.host_alias))
        {
            let cur_path = sys::resolve_identity_file(&cur.identity_file, v.root());
            if cur_path == identity_file {
                continue;
            }
            updated += 1;
        } else {
            added += 1;
        }
        text = managed::upsert(
            &text,
            ManagedEntry {
                alias: id.host_alias.clone(),
                host_name: id.real_host.clone(),
                user: id.user.clone(),
                identity_file,
                identities_only: true,
            },
        );
    }
    for record in &mut data.keys {
        let references: Vec<_> = data
            .identities
            .iter()
            .filter(|id| id.key_id.as_deref() == Some(record.id.as_str()))
            .collect();
        if references.is_empty() {
            continue;
        }
        let strict_only = references.iter().all(|id| id.strict_mode);
        let dir = sys::workspace_ssh_keys_dir(v.root());
        let stem = deployed_key_stem(record);
        let path = dir.join(if strict_only {
            format!("{stem}.pub")
        } else {
            stem
        });
        let portable = sys::portable_deployed_path(&sys::identity_file_for_ssh(&path));
        if record.deployed_path.as_deref() != Some(portable.as_str()) {
            record.deployed_path = Some(portable);
            data_changed = true;
        }
    }
    if data_changed {
        store::save_data(v, &data)?;
    }
    if added > 0 || updated > 0 || text != before_norm {
        persist_workspace_ssh_config(v, &text)?;
        util::audit(
            v.root(),
            &format!(
                "按身份补齐/校正 SSH Host 新增 {added} 条、路径更新 {updated} 条{}",
                if added == 0 && updated == 0 {
                    "（已去除重复 Host）"
                } else {
                    ""
                }
            ),
        );
    } else {
        let localized = sys::localize_ssh_config(&text, v.root());
        if localized != text {
            persist_workspace_ssh_config(v, &localized)?;
        }
    }
    Ok(added + updated)
}

fn ready_agent(state: &State<AppState>) -> Result<crate::agent::AgentEnv> {
    crate::commands::agent::adopt_agent(state)
}

fn now_iso8601() -> String {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

/// 把已有的带口令 OpenSSH 私钥写入 vault，并投放到工作空间 `ssh-keys/`。
/// 不创建身份、不写 Host、不装 agent。调用方负责把返回的记录推进 `VaultData.keys`。
fn store_prepared_key(
    v: &Vault,
    private_openssh: &str,
    passphrase: &str,
    record_name: String,
    file_stem: &str,
    purpose_intent: String,
) -> Result<KeyRecord> {
    let info = key::parse_private_openssh(private_openssh)?;
    let encrypted = info.encrypted.unwrap_or(false);
    if encrypted {
        key::verify_passphrase(private_openssh, passphrase)
            .map_err(|_| AppError::Invalid("私钥口令不正确".into()))?;
    }
    let data = store::load_data(v)?;
    if data.keys.iter().any(|k| k.fingerprint == info.fingerprint) {
        return Err(AppError::Invalid(format!(
            "已存在相同指纹的密钥：{}",
            info.fingerprint
        )));
    }

    let key_id = uuid::Uuid::new_v4().to_string();
    store::save_key(v, &key_id, private_openssh.as_bytes())?;
    if encrypted {
        let mut secrets = store::load_secrets(v)?;
        secrets
            .key_passphrases
            .insert(key_id.clone(), passphrase.to_string());
        store::save_secrets(v, &secrets)?;
    }

    let weak = info.algorithm == "rsa" && info.bits.map(|b| b < 2048).unwrap_or(false);
    let mut record = KeyRecord {
        id: key_id,
        name: record_name,
        algorithm: info.algorithm,
        fingerprint: info.fingerprint,
        public_openssh: info.public_openssh,
        bits: info.bits,
        has_passphrase: encrypted,
        weak,
        source_path: None,
        deployed_path: None,
        imported_at: now_iso8601(),
        purpose_intent,
    };
    let deployed = deploy_openssh_files(v, &record, file_stem, false)?;
    record.deployed_path = Some(sys::portable_deployed_path(&deployed));
    Ok(record)
}

/// 生成密钥并存入 vault（私钥密文 + 口令 + 元数据），返回元数据记录。
/// 身份创建与密钥页的旧入口仍只产 ed25519，文件名干走 `key_file_stem`。
fn generate_and_store_key(v: &Vault, comment: &str, name: Option<String>) -> Result<KeyRecord> {
    let g = keygen::generate_ed25519(comment)?;
    let stem_name = name.clone().unwrap_or_else(|| default_key_name(comment));
    let stem = sys::key_file_stem(&stem_name);
    store_prepared_key(
        v,
        &g.private_openssh_encrypted,
        &g.passphrase,
        stem_name,
        &stem,
        String::new(),
    )
}

fn default_key_name(comment: &str) -> String {
    let base = comment.split('@').next().unwrap_or(comment).trim();
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    if cleaned.is_empty() {
        "id_ed25519".into()
    } else {
        format!("id_ed25519_{cleaned}")
    }
}

/// 把 OpenSSH 公钥（以及非严格模式下的带口令私钥）写到工作空间 `ssh-keys/`。
/// 返回 IdentityFile 应指向的真实路径。
fn deployed_key_stem(record: &KeyRecord) -> String {
    // A display name is mutable and non-unique. The full ID digest is stable,
    // including for imported legacy IDs that are not UUIDs or contain slashes.
    let name: String = sys::key_file_stem_for_algo(&record.algorithm, &record.name)
        .chars()
        .take(40)
        .collect();
    format!("{name}_{:x}", Sha256::digest(record.id.as_bytes()))
}

pub(crate) fn deploy_openssh_files(
    v: &Vault,
    record: &KeyRecord,
    _stem: &str,
    strict: bool,
) -> Result<String> {
    let dir = sys::workspace_ssh_keys_dir(v.root());
    std::fs::create_dir_all(&dir)?;
    let stem = deployed_key_stem(record);
    let priv_path = dir.join(&stem);
    let pub_path = dir.join(format!("{stem}.pub"));
    // Never follow a planted link or silently replace a different public key.
    for path in [&pub_path, &priv_path] {
        if path
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err(AppError::Invalid("密钥目标是符号链接，已拒绝写入".into()));
        }
    }
    if pub_path.exists() {
        let existing = std::fs::read_to_string(&pub_path)?;
        if existing.trim() != record.public_openssh.trim() {
            return Err(AppError::Invalid(
                "目标文件已属于另一把密钥，已拒绝覆盖".into(),
            ));
        }
    } else {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pub_path)?;
        writeln!(file, "{}", record.public_openssh.trim())?;
        file.sync_all()?;
    }

    let target = if strict {
        // Never delete here: another identity/draft may still require this private
        // file. Destructive cleanup happens only after committed reference changes.
        pub_path
    } else {
        let priv_bytes = store::load_key(v, &record.id)?;
        if priv_path.exists() {
            if std::fs::read(&priv_path)? != priv_bytes {
                return Err(AppError::Invalid("目标私钥内容不匹配，已拒绝覆盖".into()));
            }
            platform::current().secure_key_file(&priv_path)?;
        } else {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&priv_path)?;
            // Establish owner-only access while still empty, fail closed.
            let result = platform::current()
                .secure_key_file(&priv_path)
                .and_then(|_| {
                    file.write_all(&priv_bytes)?;
                    file.sync_all()?;
                    Ok(())
                });
            drop(file);
            if let Err(e) = result {
                let _ = std::fs::remove_file(&priv_path);
                return Err(e);
            }
        }
        priv_path
    };
    Ok(sys::identity_file_for_ssh(&target))
}

/// 生成新密钥（供密钥管理界面单独使用）。
#[tauri::command]
pub fn generate_key(
    app: AppHandle,
    state: State<AppState>,
    comment: String,
    name: Option<String>,
) -> Result<KeyRecord> {
    crate::commands::ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let record = store::transaction(v, || {
        let record = generate_and_store_key(v, &comment, name)?;
        let mut data = store::load_data(v)?;
        data.keys.push(record.clone());
        store::save_data(v, &data)?;
        Ok(record)
    })?;
    util::audit(v.root(), &format!("生成密钥 {}", record.name));
    drop(vault);
    crate::sync::scheduler::kick_publish(app);
    Ok(record)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedSshMaterial {
    pub algorithm: String,
    pub bits: Option<u32>,
    pub fingerprint: String,
    pub public_openssh: String,
    pub private_openssh: String,
    pub passphrase: String,
}

/// 在本机内存生成 OpenSSH 密钥。不入库、不写磁盘、不装 agent、不创建身份。
#[tauri::command]
pub fn generate_ssh_material(
    algorithm: String,
    bits: Option<u32>,
    comment: String,
) -> Result<GeneratedSshMaterial> {
    let g = match algorithm.trim().to_ascii_lowercase().as_str() {
        "ed25519" => keygen::generate_ed25519(&comment)?,
        "rsa" => keygen::generate_rsa(bits.unwrap_or(2048), &comment)?,
        _ => return Err(AppError::Invalid("只支持 ed25519 与 RSA".into())),
    };
    Ok(GeneratedSshMaterial {
        algorithm: g.algorithm,
        bits: g.bits,
        fingerprint: g.fingerprint,
        public_openssh: g.public_openssh,
        private_openssh: g.private_openssh_encrypted,
        passphrase: g.passphrase,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveGeneratedSshKeyArgs {
    pub private_openssh: String,
    pub public_openssh: String,
    pub passphrase: String,
    pub name: Option<String>,
    pub purpose_intent: String,
}

fn normalize_purpose_intent(raw: &str) -> Result<String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "git" => Ok("git".into()),
        "server" => Ok("server".into()),
        "export" => Ok("export".into()),
        _ => Err(AppError::Invalid(
            "请设置密钥标签：Git 托管、服务器登录，或仅导出公钥".into(),
        )),
    }
}

fn normalize_purpose_intent_optional(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    normalize_purpose_intent(trimmed)
}

fn assign_purpose_intent(keys: &mut [KeyRecord], key_id: &str, raw: &str) -> Result<KeyRecord> {
    let intent = normalize_purpose_intent_optional(raw)?;
    let key = keys
        .iter_mut()
        .find(|k| k.id == key_id)
        .ok_or_else(|| AppError::Invalid("密钥不存在".into()))?;
    key.purpose_intent = intent;
    Ok(key.clone())
}

/// 修改已入库密钥的用途标签。空字符串表示清除。不改身份、不写 SSH 配置。
#[tauri::command]
pub fn set_key_purpose_intent(
    app: AppHandle,
    state: State<AppState>,
    key_id: String,
    purpose_intent: String,
) -> Result<KeyRecord> {
    crate::commands::ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let mut data = store::load_data(v)?;
    let record = assign_purpose_intent(&mut data.keys, &key_id, &purpose_intent)?;
    store::save_data(v, &data)?;
    util::audit(
        v.root(),
        &format!("更新密钥标签 {} -> {}", record.name, record.purpose_intent),
    );
    drop(vault);
    crate::sync::scheduler::kick_publish(app);
    Ok(record)
}

/// 把工具箱里已经生成的 OpenSSH 密钥存进保险库。不创建身份、不写 Host、不装 agent。
#[tauri::command]
pub fn save_generated_ssh_key(
    app: AppHandle,
    state: State<AppState>,
    args: SaveGeneratedSshKeyArgs,
) -> Result<KeyRecord> {
    crate::commands::ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let intent = normalize_purpose_intent(&args.purpose_intent)?;
    if args.public_openssh.trim().is_empty() || args.private_openssh.trim().is_empty() {
        return Err(AppError::Invalid("没有可保存的密钥，请先生成".into()));
    }
    if !crate::ssh::key::pair_matches(&args.private_openssh, &args.public_openssh)? {
        return Err(AppError::Invalid(
            "提供的公钥与私钥不配对，疑似张冠李戴".into(),
        ));
    }
    let info = key::parse_private_openssh(&args.private_openssh)?;
    if info.algorithm != "rsa" && info.algorithm != "ed25519" {
        return Err(AppError::Invalid("只支持保存 RSA 与 ed25519".into()));
    }
    let raw_name = args.name.as_deref().unwrap_or("").trim();
    let stem = sys::key_file_stem_for_algo(&info.algorithm, raw_name);
    let record = store::transaction(v, || {
        let record = store_prepared_key(
            v,
            &args.private_openssh,
            &args.passphrase,
            stem.clone(),
            &stem,
            intent,
        )?;
        let mut data = store::load_data(v)?;
        data.keys.push(record.clone());
        store::save_data(v, &data)?;
        Ok(record)
    })?;
    util::audit(v.root(), &format!("保存 SSH 密钥 {}", record.name));
    drop(vault);
    crate::sync::scheduler::kick_publish(app);
    Ok(record)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPreview {
    pub diff: String,
    pub new_text: String,
}

/// 预览把某托管条目写入 config 的 diff（不落盘）。
#[tauri::command]
pub fn preview_config(state: State<AppState>, entry: ManagedEntry) -> Result<ConfigPreview> {
    let ws = state
        .vault
        .lock()
        .unwrap()
        .as_ref()
        .map(|v| v.root().to_path_buf());
    let old = sys::read_canonical_ssh_config(ws.as_deref()).1;
    let new = managed::upsert(&old, entry);
    Ok(ConfigPreview {
        diff: util::unified_diff(&old, &new),
        new_text: new,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub backup_path: Option<String>,
    /// `ssh -G` 反向校验是否与预期一致。
    pub verified: bool,
}

/// 备份并写入 config（原子替换 + ssh -G 反向校验）。
#[tauri::command]
pub fn apply_config(
    app: AppHandle,
    state: State<AppState>,
    entry: ManagedEntry,
) -> Result<ApplyResult> {
    crate::commands::ensure_writes_allowed(&state)?;
    let ws = state
        .vault
        .lock()
        .unwrap()
        .as_ref()
        .map(|v| v.root().to_path_buf());
    let (path, old) = sys::read_canonical_ssh_config(ws.as_deref());
    let backup = util::backup_file(&path)?;
    let new = managed::upsert(&old, entry.clone());
    let ws = state
        .vault
        .lock()
        .unwrap()
        .as_ref()
        .map(|v| v.root().to_path_buf());
    sys::persist_ssh_config(ws.as_deref(), &new)?;

    let verified = verify_with_ssh_g(&entry, ws.as_deref());
    crate::sync::scheduler::kick_publish(app);
    Ok(ApplyResult {
        backup_path: backup.map(|p| p.display().to_string()),
        verified,
    })
}

/// 用 `ssh -F <工作空间正本> -G <alias>` 校验解析出的 hostname 与预期一致。
fn verify_with_ssh_g(entry: &ManagedEntry, workspace: Option<&std::path::Path>) -> bool {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (entry, workspace);
        return false;
    }
    let cfg = workspace.map(sys::workspace_ssh_config);
    let cfg_s = cfg.as_ref().map(|p| p.to_string_lossy().replace('\\', "/"));
    let alias = entry.alias.as_str();
    let args: Vec<&str> = match cfg_s.as_deref() {
        Some(c) => vec!["-F", c, "-G", alias],
        None => vec!["-G", alias],
    };
    match sys::run("ssh", &args) {
        Ok((out, _e, _c)) => {
            let want = format!("hostname {}", entry.host_name.to_lowercase());
            out.lines().any(|l| l.trim().to_lowercase() == want)
        }
        Err(_) => false,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIdentityArgs {
    pub name: String,
    pub platform: String,
    pub host_alias: String,
    pub real_host: String,
    pub user: Option<String>,
    pub email: Option<String>,
    pub git_user_name: Option<String>,
    pub strict_mode: bool,
    /// 提供则复用现有密钥；否则生成新密钥。
    pub key_id: Option<String>,
    pub key_comment: Option<String>,
    pub owners: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIdentityResult {
    pub identity: Identity,
    pub public_openssh: String,
    pub config_backup: Option<String>,
    pub config_verified: bool,
    pub identity_file: String,
}

/// 新建身份：生成/复用密钥 → 投放公钥（严格模式）或私钥（默认）→ 收紧 ACL →
/// 备份并写 config → 登记身份。
#[tauri::command]
pub fn create_identity(
    app: AppHandle,
    state: State<AppState>,
    args: CreateIdentityArgs,
) -> Result<CreateIdentityResult> {
    crate::commands::ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }

    let (identity, record, backup, verified, entry) = with_ssh_transaction(v, || {
        let mut data = store::load_data(v)?;

        // 解析密钥。
        let record = if let Some(id) = &args.key_id {
            data.keys
                .iter()
                .find(|k| &k.id == id)
                .cloned()
                .ok_or_else(|| AppError::Invalid("指定的密钥不存在".into()))?
        } else {
            let comment = {
                let raw = args.key_comment.as_deref().unwrap_or("").trim();
                if !raw.is_empty() {
                    raw.to_string()
                } else {
                    suggest_key_comment(
                        args.email.as_deref(),
                        &args.name,
                        args.git_user_name.as_deref(),
                    )
                }
            };
            let rec =
                generate_and_store_key(v, &comment, Some(format!("id_ed25519_{}", args.name)))?;
            data.keys.push(rec.clone());
            rec
        };

        // 投放 OpenSSH 文件到工作空间 ssh-keys/（不再写到 ~/.ssh）。
        let stem = sys::key_file_stem(&args.name);
        let identity_file = deploy_openssh_files(v, &record, &stem, args.strict_mode)?;
        if let Some(k) = data.keys.iter_mut().find(|k| k.id == record.id) {
            k.deployed_path = Some(sys::portable_deployed_path(&identity_file));
        }

        // 写 config（备份 + 原子 + 校验）。
        let entry = ManagedEntry {
            alias: args.host_alias.clone(),
            host_name: args.real_host.clone(),
            user: args.user.clone().unwrap_or_else(|| "git".into()),
            identity_file,
            identities_only: true,
        };
        // 带换行的 HostName 会往托管区块注入 ProxyCommand，必须在落盘前拦住。
        entry.validate()?;
        let cfg_path = sys::workspace_ssh_config(v.root());
        let old_cfg = load_workspace_ssh_config(v);
        let backup = util::backup_file(&cfg_path)?;
        let new_cfg = managed::upsert(&old_cfg, entry.clone());
        persist_workspace_ssh_config(v, &new_cfg)?;
        let verified = verify_with_ssh_g(&entry, Some(v.root()));

        // 登记身份。
        let identity = Identity {
            id: uuid::Uuid::new_v4().to_string(),
            name: args.name.clone(),
            platform: args.platform.clone(),
            host_alias: args.host_alias.clone(),
            real_host: args.real_host.clone(),
            user: args.user.clone().unwrap_or_else(|| "git".into()),
            email: args.email.clone(),
            git_user_name: args.git_user_name.clone(),
            key_id: Some(record.id.clone()),
            owners: args.owners.clone().unwrap_or_default(),
            strict_mode: args.strict_mode,
            updated_at: now_iso8601(),
        };
        data.identities.push(identity.clone());
        store::save_data(v, &data)?;
        Ok((identity, record, backup, verified, entry))
    })?;
    cleanup_strict_private_keys(v)?;
    if args.strict_mode {
        if let Ok(env) = ready_agent(&state) {
            let _ = crate::agent::load_key(v, &env, &record.id);
        }
    }
    util::audit(
        v.root(),
        &format!("新建身份 {} (alias={})", identity.name, identity.host_alias),
    );
    drop(vault);
    crate::sync::scheduler::kick_publish(app);

    Ok(CreateIdentityResult {
        identity,
        public_openssh: record.public_openssh,
        config_backup: backup.map(|p| p.display().to_string()),
        config_verified: verified,
        identity_file: entry.identity_file.clone(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageIdentityDraftArgs {
    pub name: String,
    pub host_alias: String,
    pub real_host: String,
    pub user: Option<String>,
    pub strict_mode: bool,
    pub key_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageIdentityDraftResult {
    pub identity_file: String,
    pub config_verified: bool,
    pub key_id: String,
}

/// 向导验证用：部署密钥文件、写入 Host、把私钥加载进 agent，不登记身份。
#[tauri::command]
pub fn stage_identity_draft(
    state: State<AppState>,
    args: StageIdentityDraftArgs,
) -> Result<StageIdentityDraftResult> {
    crate::commands::ensure_writes_allowed(&state)?;
    let alias = args.host_alias.trim();
    let host = args.real_host.trim();
    let key_id = args.key_id.trim();
    if alias.is_empty() || host.is_empty() || key_id.is_empty() {
        return Err(AppError::Invalid("别名、主机或密钥不完整，无法验证".into()));
    }

    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }

    let (record, identity_file, verified) = with_ssh_transaction(v, || {
        let mut data = store::load_data(v)?;
        if data
            .identities
            .iter()
            .any(|i| i.host_alias.eq_ignore_ascii_case(alias))
        {
            return Err(AppError::Invalid(format!("Host 别名「{alias}」已被占用")));
        }
        let record = data
            .keys
            .iter()
            .find(|k| k.id == key_id)
            .cloned()
            .ok_or_else(|| AppError::Invalid("指定的密钥不存在".into()))?;

        let stem = sys::key_file_stem(&args.name);
        let identity_file = deploy_openssh_files(v, &record, &stem, args.strict_mode)?;
        if let Some(k) = data.keys.iter_mut().find(|k| k.id == record.id) {
            k.deployed_path = Some(sys::portable_deployed_path(&identity_file));
        }
        store::save_data(v, &data)?;

        let entry = ManagedEntry {
            alias: alias.to_string(),
            host_name: host.to_string(),
            user: args.user.clone().unwrap_or_else(|| "git".into()),
            identity_file: identity_file.clone(),
            identities_only: true,
        };
        let cfg_path = sys::workspace_ssh_config(v.root());
        let old_cfg = load_workspace_ssh_config(v);
        let _ = util::backup_file(&cfg_path)?;
        persist_workspace_ssh_config(v, &managed::upsert(&old_cfg, entry.clone()))?;
        let verified = verify_with_ssh_g(&entry, Some(v.root()));

        Ok((record, identity_file, verified))
    })?;
    let env = ready_agent(&state)?;
    crate::agent::load_key(v, &env, &record.id)?;
    util::audit(
        v.root(),
        &format!("向导验证预加载密钥 {} (alias={alias})", record.name),
    );

    Ok(StageIdentityDraftResult {
        identity_file,
        config_verified: verified,
        key_id: record.id,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbortIdentityDraftArgs {
    pub host_alias: String,
    pub key_id: String,
}

/// 向导取消：撤回尚未登记的 Host，并从 agent 卸下未被其它身份使用的密钥。
#[tauri::command]
pub fn abort_identity_draft(state: State<AppState>, args: AbortIdentityDraftArgs) -> Result<()> {
    let alias = args.host_alias.trim();
    let key_id = args.key_id.trim();
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let data = store::load_data(v)?;
    let alias_in_use = !alias.is_empty()
        && data
            .identities
            .iter()
            .any(|i| i.host_alias.eq_ignore_ascii_case(alias));
    if !alias.is_empty() && !alias_in_use {
        let old_cfg = load_workspace_ssh_config(v);
        persist_workspace_ssh_config(v, &managed::remove(&old_cfg, alias))?;
    }
    let key_in_use = !key_id.is_empty()
        && data
            .identities
            .iter()
            .any(|i| i.key_id.as_deref() == Some(key_id));
    if !key_id.is_empty() && !key_in_use {
        if let Some(record) = data.keys.iter().find(|k| k.id == key_id) {
            if let Ok(env) = ready_agent(&state) {
                let _ = crate::agent::unload_public(&env, &record.public_openssh);
            }
        }
    }
    Ok(())
}

/// 二次验证后查看密钥口令（敏感，需重输访问密码；写审计）。
#[tauri::command]
pub fn reveal_key_passphrase(
    state: State<AppState>,
    password: String,
    key_id: String,
) -> Result<String> {
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    v.verify_password(&password)?; // 重认证
    let secrets = store::load_secrets(v)?;
    let pass = secrets
        .key_passphrases
        .get(&key_id)
        .cloned()
        .ok_or_else(|| AppError::Invalid("该密钥无已保存口令".into()))?;
    util::audit(v.root(), &format!("二次验证查看密钥口令 key_id={key_id}"));
    Ok(pass)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealedKeyMaterial {
    pub public_openssh: String,
    pub private_openssh: String,
    pub passphrase: Option<String>,
}

/// 二次验证后查看公钥/私钥（敏感，需重输访问密码；写审计）。
#[tauri::command]
pub fn reveal_key_material(
    state: State<AppState>,
    password: String,
    key_id: String,
) -> Result<RevealedKeyMaterial> {
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    v.verify_password(&password)?;
    let data = store::load_data(v)?;
    let record = data
        .keys
        .iter()
        .find(|k| k.id == key_id)
        .ok_or_else(|| AppError::Invalid("密钥不存在".into()))?;
    let raw = store::load_key(v, &key_id)?;
    let private_openssh = String::from_utf8(raw)
        .map_err(|_| AppError::Invalid("私钥不是可显示的 OpenSSH 文本".into()))?;
    let secrets = store::load_secrets(v)?;
    let passphrase = secrets.key_passphrases.get(&key_id).cloned();
    util::audit(v.root(), &format!("二次验证查看密钥材料 key_id={key_id}"));
    Ok(RevealedKeyMaterial {
        public_openssh: record.public_openssh.clone(),
        private_openssh,
        passphrase,
    })
}

/// 把内存中的 OpenSSH RSA 私钥转成无口令 PKCS#1 PEM。不入库。
#[tauri::command]
pub fn openssh_rsa_to_pem(private_openssh: String, passphrase: String) -> Result<String> {
    let pem = key::rsa_openssh_to_pkcs1_pem(&private_openssh, &passphrase)?;
    Ok(pem.to_string())
}

/// 二次验证后，把库内 RSA 私钥导出为无口令 PKCS#1 PEM。不改库存格式。
#[tauri::command]
pub fn export_vault_key_pem(
    state: State<AppState>,
    password: String,
    key_id: String,
) -> Result<String> {
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    v.verify_password(&password)?;
    let raw = store::load_key(v, &key_id)?;
    let private_openssh = String::from_utf8(raw)
        .map_err(|_| AppError::Invalid("私钥不是可显示的 OpenSSH 文本".into()))?;
    let secrets = store::load_secrets(v)?;
    let passphrase = secrets
        .key_passphrases
        .get(&key_id)
        .cloned()
        .unwrap_or_default();
    let pem = key::rsa_openssh_to_pkcs1_pem(&private_openssh, &passphrase)?;
    util::audit(v.root(), &format!("二次验证导出 PEM 私钥 key_id={key_id}"));
    Ok(pem.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateIdentityArgs {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub host_alias: String,
    pub real_host: String,
    pub user: Option<String>,
    pub email: Option<String>,
    pub git_user_name: Option<String>,
    pub strict_mode: bool,
    pub owners: Option<Vec<String>>,
}

/// 修改已有身份信息，并同步更新工作空间 SSH config。
#[tauri::command]
pub fn update_identity(
    app: AppHandle,
    state: State<AppState>,
    args: UpdateIdentityArgs,
) -> Result<Identity> {
    crate::commands::ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }

    let updated = with_ssh_transaction(v, || {
        let mut data = store::load_data(v)?;
        let idx = data
            .identities
            .iter()
            .position(|i| i.id == args.id)
            .ok_or_else(|| AppError::Invalid("身份不存在".into()))?;

        let old_alias = data.identities[idx].host_alias.clone();
        let key_id = data.identities[idx].key_id.clone();

        // 检查重名与别名冲突（排除自身）
        if data
            .identities
            .iter()
            .any(|i| i.id != args.id && i.name.eq_ignore_ascii_case(&args.name))
        {
            return Err(AppError::Invalid(format!("备注名「{}」已存在", args.name)));
        }
        if data
            .identities
            .iter()
            .any(|i| i.id != args.id && i.host_alias.eq_ignore_ascii_case(&args.host_alias))
        {
            return Err(AppError::Invalid(format!(
                "Host 别名「{}」已被占用",
                args.host_alias
            )));
        }

        // 重新部署密钥文件（如果严格模式改变或名字改变）
        let identity_file = if let Some(ref kid) = key_id {
            if let Some(record) = data.keys.iter().find(|k| &k.id == kid).cloned() {
                let stem = sys::key_file_stem(&args.name);
                let identity_file = deploy_openssh_files(v, &record, &stem, args.strict_mode)?;
                if let Some(k) = data.keys.iter_mut().find(|k| k.id == record.id) {
                    k.deployed_path = Some(sys::portable_deployed_path(&identity_file));
                }
                identity_file
            } else {
                "".to_string()
            }
        } else {
            "".to_string()
        };

        let config_path = sys::workspace_ssh_config(v.root());
        let old_config = load_workspace_ssh_config(v);
        let mut intermediate = if old_alias != args.host_alias {
            managed::remove(&old_config, &old_alias)
        } else {
            old_config
        };

        if !identity_file.is_empty() {
            let entry = ManagedEntry {
                alias: args.host_alias.clone(),
                host_name: args.real_host.clone(),
                user: args.user.clone().unwrap_or_else(|| "git".into()),
                identity_file,
                identities_only: true,
            };
            entry.validate()?;
            intermediate = managed::upsert(&intermediate, entry);
        }
        let _ = util::backup_file(&config_path);
        persist_workspace_ssh_config(v, &intermediate)?;

        let mut updated = data.identities[idx].clone();
        updated.name = args.name;
        updated.platform = args.platform;
        updated.host_alias = args.host_alias;
        updated.real_host = args.real_host;
        updated.user = args.user.unwrap_or_else(|| "git".into());
        updated.email = args.email;
        updated.git_user_name = args.git_user_name;
        updated.strict_mode = args.strict_mode;
        updated.updated_at = now_iso8601();
        if let Some(owners) = args.owners {
            updated.owners = owners;
        }

        data.identities[idx] = updated.clone();
        store::save_data(v, &data)?;
        Ok(updated)
    })?;
    cleanup_strict_private_keys(v)?;
    util::audit(
        v.root(),
        &format!("更新身份 {} (alias={})", updated.name, updated.host_alias),
    );
    drop(vault);
    crate::sync::scheduler::kick_publish(app);

    Ok(updated)
}

fn is_git_hosting_platform(platform: &str) -> bool {
    matches!(
        platform.trim().to_ascii_lowercase().as_str(),
        "github" | "gitlab" | "gitee" | "gitea"
    )
}

fn git_hosting_blocks_key_delete(identities: &[Identity], key_id: &str) -> bool {
    identities.iter().any(|identity| {
        identity.key_id.as_deref() == Some(key_id) && is_git_hosting_platform(&identity.platform)
    })
}

/// 写入锁或保险库未解锁时给出明确错误。命令与测试共用这一判断。
fn gate_key_delete(writes_locked: bool, unlocked: bool) -> Result<()> {
    if writes_locked {
        return Err(AppError::Busy);
    }
    if !unlocked {
        return Err(AppError::Locked);
    }
    Ok(())
}

fn safe_workspace_key_stem(stem: &str) -> bool {
    !stem.is_empty()
        && stem != "."
        && stem != ".."
        && !stem.contains('/')
        && !stem.contains('\\')
        && !stem.contains("..")
        && !stem.chars().any(|c| c.is_control())
}

/// 只删除工作空间 `ssh-keys/` 目录里的这一对文件。符号链接只摘掉链接本身。
fn remove_file_directly_inside(dir: &std::path::Path, path: &std::path::Path) -> Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let Ok(dir_canon) = dir.canonicalize() else {
        return Ok(());
    };
    let Ok(parent_canon) = parent.canonicalize() else {
        return Ok(());
    };
    if parent_canon != dir_canon {
        return Ok(());
    }
    match path.symlink_metadata() {
        Ok(meta) if meta.is_file() || meta.file_type().is_symlink() => std::fs::remove_file(path)?,
        _ => return Ok(()),
    }
    Ok(())
}

fn remove_workspace_key_pair(
    workspace: &std::path::Path,
    deployed_path: Option<&str>,
) -> Result<()> {
    let Some(raw) = deployed_path.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let Some(name) = sys::workspace_key_filename(raw) else {
        return Ok(());
    };
    let stem = name.strip_suffix(".pub").unwrap_or(name.as_str());
    if !safe_workspace_key_stem(stem) {
        return Ok(());
    }
    let dir = sys::workspace_ssh_keys_dir(workspace);
    remove_file_directly_inside(&dir, &dir.join(stem))?;
    remove_file_directly_inside(&dir, &dir.join(format!("{stem}.pub")))?;
    Ok(())
}

/// 从保险库去掉一把钥匙。不改 SSH config，不删除身份。
/// Git 托管身份仍引用时整单拒绝，此时磁盘不动。
fn delete_stored_key(v: &Vault, key_id: &str) -> Result<()> {
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    let key_id = key_id.trim();
    if key_id.is_empty() {
        return Err(AppError::Invalid("密钥不存在".into()));
    }
    let (removed, shares_deployment) = store::transaction(v, || {
        let mut data = store::load_data(v)?;
        let idx = data
            .keys
            .iter()
            .position(|k| k.id == key_id)
            .ok_or_else(|| AppError::Invalid("密钥不存在".into()))?;
        if git_hosting_blocks_key_delete(&data.identities, key_id) {
            return Err(AppError::Invalid("已被 Git 托管身份使用，不能删除".into()));
        }
        let removed = data.keys.remove(idx);
        let now = now_iso8601();
        data.deleted_keys.insert(key_id.to_string(), now.clone());
        for identity in &mut data.identities {
            if identity.key_id.as_deref() == Some(key_id) {
                identity.key_id = None;
                identity.updated_at = now.clone();
            }
        }
        let shares_deployment = removed.deployed_path.as_deref().is_some_and(|path| {
            let name =
                sys::workspace_key_filename(path).map(|s| s.trim_end_matches(".pub").to_owned());
            data.keys.iter().any(|key| {
                key.deployed_path.as_deref().is_some_and(|other| {
                    sys::workspace_key_filename(other)
                        .map(|s| s.trim_end_matches(".pub").to_owned())
                        == name
                })
            })
        });
        store::delete_key(v, key_id)?;
        let mut secrets = store::load_secrets(v)?;
        if secrets.key_passphrases.remove(key_id).is_some() {
            store::save_secrets(v, &secrets)?;
        }
        store::save_data(v, &data)?;
        Ok((removed, shares_deployment))
    })?;
    if !shares_deployment {
        remove_workspace_key_pair(v.root(), removed.deployed_path.as_deref()).map_err(|e| {
            AppError::Other(format!(
                "密钥记录已删除，但部署文件清理失败，请检查文件权限：{e}"
            ))
        })?;
    }
    util::audit(v.root(), &format!("删除密钥 {}", removed.name));
    Ok(())
}

/// 删除库内密钥。已被 Git 托管身份引用时拒绝。
#[tauri::command]
pub fn delete_key(app: AppHandle, state: State<AppState>, key_id: String) -> Result<()> {
    let unlocked = recover_lock(&state.vault)
        .as_ref()
        .is_some_and(|v| v.is_unlocked());
    gate_key_delete(
        state
            .writes_locked
            .load(std::sync::atomic::Ordering::SeqCst),
        unlocked,
    )?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    delete_stored_key(v, &key_id)?;
    drop(vault);
    crate::sync::scheduler::kick_publish(app);
    Ok(())
}

/// 删除已有身份，并从工作空间 SSH config 托管区块中移除。
#[tauri::command]
pub fn delete_identity(app: AppHandle, state: State<AppState>, identity_id: String) -> Result<()> {
    crate::commands::ensure_writes_allowed(&state)?;
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }

    let removed = with_ssh_transaction(v, || {
        let mut data = store::load_data(v)?;
        let idx = data
            .identities
            .iter()
            .position(|i| i.id == identity_id)
            .ok_or_else(|| AppError::Invalid("身份不存在".into()))?;

        let removed = data.identities.remove(idx);
        data.deleted_identities
            .insert(removed.id.clone(), now_iso8601());

        let config_path = sys::workspace_ssh_config(v.root());
        let old_config = load_workspace_ssh_config(v);
        let new_config = managed::remove(&old_config, &removed.host_alias);
        let _ = util::backup_file(&config_path);
        persist_workspace_ssh_config(v, &new_config)?;

        store::save_data(v, &data)?;
        Ok(removed)
    })?;
    cleanup_strict_private_keys(v)?;
    util::audit(
        v.root(),
        &format!("删除身份 {} (alias={})", removed.name, removed.host_alias),
    );
    drop(vault);
    crate::sync::scheduler::kick_publish(app);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unlocked_vault() -> (Vault, std::path::PathBuf) {
        use crate::vault::header::KdfParams;
        use crate::vault::kdf::{ITERS_FLOOR, MEM_FLOOR_KIB};
        let root = std::env::temp_dir().join(format!("gam-write-{}", uuid::Uuid::new_v4()));
        let kdf = KdfParams::new(MEM_FLOOR_KIB, ITERS_FLOOR, 1);
        let (v, _rec) = Vault::init(&root, "pw", kdf).unwrap();
        (v, root)
    }

    fn sample_key(id: &str) -> KeyRecord {
        KeyRecord {
            id: id.into(),
            name: "id_ed25519_techn".into(),
            algorithm: "ed25519".into(),
            fingerprint: "SHA256:abc".into(),
            public_openssh: "ssh-ed25519 AAAA techn".into(),
            bits: Some(256),
            has_passphrase: true,
            weak: false,
            source_path: None,
            deployed_path: None,
            imported_at: "now".into(),
            purpose_intent: String::new(),
        }
    }

    #[test]
    fn purpose_intent_can_be_changed_or_cleared() {
        let mut keys = vec![sample_key("k1")];
        let updated = assign_purpose_intent(&mut keys, "k1", "git").unwrap();
        assert_eq!(updated.purpose_intent, "git");
        let cleared = assign_purpose_intent(&mut keys, "k1", "  ").unwrap();
        assert!(cleared.purpose_intent.is_empty());
        assert!(assign_purpose_intent(&mut keys, "k1", "nope").is_err());
        assert!(assign_purpose_intent(&mut keys, "missing", "server").is_err());
    }

    #[test]
    fn duplicate_names_deploy_to_distinct_owned_files() {
        let (v, root) = unlocked_vault();
        let a = sample_key("first-id");
        let mut b = sample_key("second-id");
        b.public_openssh = "ssh-ed25519 BBBB second".into();
        let first = deploy_openssh_files(&v, &a, "same-name", true).unwrap();
        let second = deploy_openssh_files(&v, &b, "same-name", true).unwrap();
        assert_ne!(first, second);
        let first_path =
            sys::workspace_ssh_keys_dir(&root).join(format!("{}.pub", deployed_key_stem(&a)));
        let before = std::fs::read(&first_path).unwrap();
        let mut intruder = a.clone();
        intruder.public_openssh = b.public_openssh.clone();
        assert!(deploy_openssh_files(&v, &intruder, "same-name", true).is_err());
        assert_eq!(std::fs::read(&first_path).unwrap(), before);
        drop(v);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn shared_key_strict_identity_never_removes_non_strict_deployment() {
        let (v, root) = unlocked_vault();
        let mut key = sample_key("shared-id");
        store::save_key(&v, &key.id, b"synthetic-private").unwrap();
        let private_path = deploy_openssh_files(&v, &key, "ignored", false).unwrap();
        let public_path = deploy_openssh_files(&v, &key, "ignored", true).unwrap();
        assert!(public_path.ends_with(".pub"));
        assert!(!private_path.ends_with(".pub"));
        let private = sys::workspace_ssh_keys_dir(&root).join(deployed_key_stem(&key));
        assert_eq!(std::fs::read(&private).unwrap(), b"synthetic-private");
        // A catalog last written by the strict consumer must not change the other path.
        key.deployed_path = Some(sys::portable_deployed_path(&public_path));
        assert_eq!(
            deploy_openssh_files(&v, &key, "ignored", false).unwrap(),
            private_path
        );
        let mut data = store::load_data(&v).unwrap();
        data.keys.push(key.clone());
        let mut strict = identity("strict", "Strict", "other", Some(&key.id));
        strict.strict_mode = true;
        data.identities.push(strict);
        data.identities
            .push(identity("normal", "Normal", "other", Some(&key.id)));
        store::save_data(&v, &data).unwrap();
        cleanup_strict_private_keys(&v).unwrap();
        assert!(private.is_file());
        // Only after the last non-strict consumer's metadata has committed may removal occur.
        data.identities.retain(|id| id.id != "normal");
        store::transaction(&v, || store::save_data(&v, &data)).unwrap();
        cleanup_strict_private_keys(&v).unwrap();
        assert!(!private.exists());
        assert!(store::load_key(&v, &key.id).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn strict_cleanup_preserves_generated_unbound_keys() {
        let (v, root) = unlocked_vault();
        let key = sample_key("unbound-id");
        store::save_key(&v, &key.id, b"synthetic-private").unwrap();
        deploy_openssh_files(&v, &key, "ignored", false).unwrap();
        let mut data = store::load_data(&v).unwrap();
        data.keys.push(key.clone());
        store::save_data(&v, &data).unwrap();
        cleanup_strict_private_keys(&v).unwrap();
        assert!(sys::workspace_ssh_keys_dir(&root)
            .join(deployed_key_stem(&key))
            .is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ssh_projection_is_restored_when_metadata_transaction_aborts() {
        let (v, root) = unlocked_vault();
        let config = sys::workspace_ssh_config(&root);
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(&config, b"# original user config\n").unwrap();
        let outcome: Result<()> = with_ssh_transaction(&v, || {
            // Direct fixture write: never call the production home-SSH bridge in tests.
            std::fs::write(&config, b"# partial new projection\n")?;
            Err(AppError::Invalid("injected metadata failure".into()))
        });
        assert!(outcome.is_err());
        assert_eq!(std::fs::read(&config).unwrap(), b"# original user config\n");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn key_comment_prefers_email_then_name_then_git_user() {
        assert_eq!(
            suggest_key_comment(Some("a@b.com"), "nova", Some("Nova Reyes")),
            "a@b.com"
        );
        assert_eq!(
            suggest_key_comment(None, "nova-labs", Some("Nova")),
            "nova-labs@gam"
        );
        assert_eq!(
            suggest_key_comment(Some("  "), "", Some("Nova Reyes")),
            "Nova.Reyes@gam"
        );
        assert_eq!(suggest_key_comment(None, "", None), "");
    }

    #[test]
    fn legacy_generate_keeps_ed25519_stem_and_empty_intent() {
        let (v, root) = unlocked_vault();
        let rec = generate_and_store_key(&v, "a@b", Some("plain".into())).unwrap();
        assert_eq!(rec.name, "plain");
        assert_eq!(rec.algorithm, "ed25519");
        assert!(rec.purpose_intent.is_empty());
        let deployed = rec.deployed_path.unwrap();
        assert!(deployed.contains("id_ed25519_plain"), "{deployed}");
        drop(v);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn stored_rsa_uses_algo_stem_and_rejects_same_fingerprint() {
        let (v, root) = unlocked_vault();
        let g = keygen::generate_rsa(2048, "lab@host").unwrap();
        let stem = sys::key_file_stem_for_algo("rsa", "lab");
        let rec = store_prepared_key(
            &v,
            &g.private_openssh_encrypted,
            &g.passphrase,
            stem.clone(),
            &stem,
            "server".into(),
        )
        .unwrap();
        assert_eq!(rec.name, "id_rsa_lab");
        assert_eq!(rec.algorithm, "rsa");
        assert_eq!(rec.purpose_intent, "server");
        assert!(rec.public_openssh.starts_with("ssh-rsa "));
        let deployed_stem = deployed_key_stem(&rec);
        let pub_path = sys::workspace_ssh_keys_dir(v.root()).join(format!("{deployed_stem}.pub"));
        let text = std::fs::read_to_string(&pub_path).unwrap();
        assert!(text.starts_with("ssh-rsa "));
        assert!(text.ends_with('\n'));
        assert!(sys::workspace_ssh_keys_dir(v.root())
            .join(&deployed_stem)
            .is_file());
        let secrets = store::load_secrets(&v).unwrap();
        assert_eq!(secrets.key_passphrases.get(&rec.id).unwrap(), &g.passphrase);

        let mut data = store::load_data(&v).unwrap();
        data.keys.push(rec);
        store::save_data(&v, &data).unwrap();
        let again = store_prepared_key(
            &v,
            &g.private_openssh_encrypted,
            &g.passphrase,
            stem.clone(),
            &stem,
            "server".into(),
        );
        assert!(again.is_err(), "相同指纹应拒绝");
        drop(v);
        std::fs::remove_dir_all(&root).ok();
    }

    fn identity(id: &str, name: &str, platform: &str, key_id: Option<&str>) -> Identity {
        Identity {
            id: id.into(),
            name: name.into(),
            platform: platform.into(),
            host_alias: format!("h-{id}"),
            real_host: "example.com".into(),
            user: "git".into(),
            email: None,
            git_user_name: None,
            key_id: key_id.map(str::to_string),
            owners: vec![],
            strict_mode: false,
            updated_at: "2020-01-01T00:00:00Z".into(),
        }
    }

    fn put_key(v: &Vault, id: &str, name: &str, deployed: Option<String>) {
        store::save_key(v, id, b"OPENSSH PRIVATE KEY").unwrap();
        let mut secrets = store::load_secrets(v).unwrap();
        secrets
            .key_passphrases
            .insert(id.into(), format!("pass-{id}"));
        store::save_secrets(v, &secrets).unwrap();
        let mut data = store::load_data(v).unwrap();
        data.keys.push(KeyRecord {
            id: id.into(),
            name: name.into(),
            algorithm: "ed25519".into(),
            fingerprint: format!("SHA256:{id}"),
            public_openssh: format!("ssh-ed25519 AAAA {name}"),
            bits: Some(256),
            has_passphrase: true,
            weak: false,
            source_path: None,
            deployed_path: deployed,
            imported_at: "2020-01-01T00:00:00Z".into(),
            purpose_intent: String::new(),
        });
        store::save_data(v, &data).unwrap();
    }

    fn write_pair(dir: &std::path::Path, stem: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(stem), b"private").unwrap();
        std::fs::write(dir.join(format!("{stem}.pub")), b"public\n").unwrap();
    }

    #[test]
    fn key_delete_blocks_git_hosting() {
        for platform in ["GitHub", "gitlab", "Gitee", "gitea"] {
            let ident = identity("i", "host", platform, Some("k"));
            assert!(git_hosting_blocks_key_delete(&[ident], "k"), "{platform}");
        }
        let server = identity("i", "bastion", "other", Some("k"));
        assert!(!git_hosting_blocks_key_delete(&[server], "k"));
        let other_key = identity("i", "host", "github", Some("other"));
        assert!(!git_hosting_blocks_key_delete(&[other_key], "k"));
    }

    #[test]
    fn key_delete_refuses_locked_or_busy() {
        let busy = gate_key_delete(true, true).unwrap_err();
        assert!(matches!(busy, AppError::Busy));
        assert!(busy.to_string().contains("请稍后再修改"));
        let locked = gate_key_delete(false, false).unwrap_err();
        assert!(matches!(locked, AppError::Locked));
        assert_eq!(locked.to_string(), "工作空间未解锁");
        assert!(gate_key_delete(false, true).is_ok());

        let (mut v, root) = unlocked_vault();
        v.lock();
        let err = delete_stored_key(&v, "k1").unwrap_err();
        assert!(matches!(err, AppError::Locked));
        assert_eq!(err.to_string(), "工作空间未解锁");
        drop(v);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn key_delete_drops_record_files_and_passphrase() {
        let (v, root) = unlocked_vault();
        let keys_dir = sys::workspace_ssh_keys_dir(v.root());
        write_pair(&keys_dir, "id_ed25519_gh");
        write_pair(&keys_dir, "id_ed25519_lab");
        write_pair(&keys_dir, "id_ed25519_strict");
        write_pair(&keys_dir, "id_ed25519_export");
        std::fs::write(keys_dir.join("keep_me"), b"neighbor").unwrap();

        let outside = root.join("home-ssh");
        write_pair(&outside, "id_ed25519");
        let outside_priv = outside.join("id_ed25519");
        let secret = root.join("secrets.txt");
        std::fs::write(&secret, b"do-not-touch").unwrap();

        put_key(
            &v,
            "gh",
            "gh-key",
            Some(format!("%GAM_WORKSPACE%/ssh-keys/id_ed25519_gh")),
        );
        put_key(
            &v,
            "lab",
            "server-key",
            Some("%GAM_WORKSPACE%/ssh-keys/id_ed25519_lab".into()),
        );
        put_key(
            &v,
            "strict",
            "strict-key",
            Some("%GAM_WORKSPACE%/ssh-keys/id_ed25519_strict.pub".into()),
        );
        put_key(
            &v,
            "export",
            "export-key",
            Some(outside_priv.display().to_string()),
        );
        put_key(
            &v,
            "trav",
            "trav-key",
            Some("%GAM_WORKSPACE%/ssh-keys/../secrets.txt".into()),
        );

        let mut data = store::load_data(&v).unwrap();
        data.identities
            .push(identity("gh-id", "GitHub 工作", "GitHub", Some("gh")));
        data.identities
            .push(identity("lab-id", "机房登录", "other", Some("lab")));
        data.identities
            .push(identity("bak-id", "备份机", "custom", Some("lab")));
        data.keys
            .iter_mut()
            .find(|k| k.id == "export")
            .unwrap()
            .purpose_intent = "export".into();
        store::save_data(&v, &data).unwrap();

        let config = sys::workspace_ssh_config(v.root());
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        let config_body = "Host lab\n    IdentityFile %GAM_WORKSPACE%/ssh-keys/id_ed25519_lab\n";
        std::fs::write(&config, config_body).unwrap();

        let blocked = delete_stored_key(&v, "gh").unwrap_err();
        assert!(blocked.to_string().contains("已被 Git 托管身份使用"));
        assert!(store::key_exists(&v, "gh"));
        assert!(keys_dir.join("id_ed25519_gh").is_file());
        assert!(keys_dir.join("id_ed25519_gh.pub").is_file());
        assert_eq!(
            store::load_data(&v)
                .unwrap()
                .identities
                .iter()
                .find(|i| i.id == "gh-id")
                .unwrap()
                .key_id
                .as_deref(),
            Some("gh")
        );

        delete_stored_key(&v, "lab").unwrap();
        delete_stored_key(&v, "strict").unwrap();
        delete_stored_key(&v, "export").unwrap();
        delete_stored_key(&v, "trav").unwrap();
        let missing = delete_stored_key(&v, "missing").unwrap_err();
        assert!(missing.to_string().contains("密钥不存在"));

        let data = store::load_data(&v).unwrap();
        assert_eq!(data.keys.len(), 1);
        assert_eq!(data.keys[0].id, "gh");
        for id in ["lab", "strict", "export", "trav"] {
            assert!(data.deleted_keys.contains_key(id), "{id}");
        }
        assert!(!data.deleted_keys.contains_key("gh"));
        assert!(store::key_exists(&v, "gh"));
        let lab = data.identities.iter().find(|i| i.id == "lab-id").unwrap();
        let bak = data.identities.iter().find(|i| i.id == "bak-id").unwrap();
        assert_eq!(lab.name, "机房登录");
        assert!(lab.key_id.is_none());
        assert_ne!(lab.updated_at, "2020-01-01T00:00:00Z");
        assert_eq!(bak.name, "备份机");
        assert!(bak.key_id.is_none());
        assert!(data.identities.iter().any(|i| i.id == "gh-id"));

        let secrets = store::load_secrets(&v).unwrap();
        assert!(secrets.key_passphrases.get("lab").is_none());
        assert!(secrets.key_passphrases.get("strict").is_none());
        assert!(secrets.key_passphrases.get("export").is_none());
        assert_eq!(secrets.key_passphrases.get("gh").unwrap(), "pass-gh");
        assert!(!store::key_exists(&v, "lab"));
        assert!(!store::key_exists(&v, "strict"));
        assert!(!store::key_exists(&v, "export"));
        assert!(!store::key_exists(&v, "trav"));

        assert!(!keys_dir.join("id_ed25519_lab").exists());
        assert!(!keys_dir.join("id_ed25519_lab.pub").exists());
        assert!(!keys_dir.join("id_ed25519_strict").exists());
        assert!(!keys_dir.join("id_ed25519_strict.pub").exists());
        assert!(keys_dir.join("keep_me").is_file());
        assert!(outside.join("id_ed25519").is_file());
        assert!(outside.join("id_ed25519.pub").is_file());
        assert!(secret.is_file());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), config_body);

        let audit = std::fs::read_to_string(v.root().join("audit.log")).unwrap();
        assert!(audit.contains("删除密钥 server-key"));
        assert!(audit.contains("删除密钥 strict-key"));
        assert!(audit.contains("删除密钥 export-key"));
        assert!(!audit.contains("删除密钥 gh-key"));

        drop(v);
        std::fs::remove_dir_all(&root).ok();
    }
}
