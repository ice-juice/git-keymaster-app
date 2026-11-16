//! Create and verify a separate vault with a fresh MK. Never rekey the live
//! workspace in place, overwrite a destination, deploy SSH, or contact a cloud.
use crate::commands::{recover_lock, AppState};
use crate::error::{AppError, Result};
use crate::store;
use crate::sync::backup::{self, BackupPayload, BackupSummary};
use crate::vault::{crypto, header::KdfParams, recovery, Vault};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{atomic::Ordering, Mutex};
use std::time::{Duration, Instant};
use tauri::State;
use zeroize::Zeroizing;

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
static PREPARING: Mutex<()> = Mutex::new(());

#[derive(Clone)]
struct Pending {
    token: String,
    path: PathBuf,
    workspace_id: String,
    source_path: PathBuf,
    source_id: String,
    source_epoch: u64,
    source_revision: [u8; 32],
    target_revision: [u8; 32],
    recovery_hash: [u8; 32],
    expires: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPrepared {
    token: String,
    recovery_key: String,
    workspace_id: String,
    path: String,
    source_path: String,
    summary: BackupSummary,
}

struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        // Only this newly-created UUID directory is ever removed. Published
        // destinations and source workspaces are deliberately never cleaned up.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn recovery_hash(value: &str) -> Result<[u8; 32]> {
    Ok(Sha256::digest(recovery::parse(value)?.as_bytes()).into())
}

fn source_revision(v: &Vault) -> Result<[u8; 32]> {
    let mut paths = vec![v.root().join("vault.json")];
    for name in ["data", "keys", "icons", "blobs"] {
        let dir = v.root().join(name);
        if !dir.exists() { continue; }
        for item in std::fs::read_dir(dir)? {
            let item = item?;
            let kind = item.file_type()?;
            if kind.is_symlink() { return Err(AppError::Invalid("迁移不接受符号链接数据文件".into())); }
            if kind.is_file() { paths.push(item.path()); }
        }
    }
    paths.sort();
    let mut hash = Sha256::new();
    for path in paths {
        let name = path.strip_prefix(v.root()).map_err(|_| AppError::Crypto)?.to_string_lossy();
        hash.update((name.len() as u64).to_le_bytes()); hash.update(name.as_bytes());
        let mut file = std::fs::File::open(path)?;
        let size = file.metadata()?.len();
        hash.update(size.to_le_bytes());
        let mut buffer = [0u8; 64 * 1024];
        let mut total = 0u64;
        loop {
            let count = std::io::Read::read(&mut file, &mut buffer)?;
            if count == 0 { break; }
            total += count as u64;
            hash.update(&buffer[..count]);
        }
        if total != size { return Err(AppError::Invalid("校验期间数据文件长度发生变化".into())); }
    }
    Ok(hash.finalize().into())
}

fn destination(requested: &Path, source: &Path) -> Result<PathBuf> {
    if !requested.is_absolute() || requested.file_name().is_none() {
        return Err(AppError::Invalid("请选择现有父目录下的全新绝对路径".into()));
    }
    if requested.symlink_metadata().is_ok() {
        return Err(AppError::Invalid("目标目录必须尚不存在，不能覆盖已有目录".into()));
    }
    let parent = requested.parent().ok_or_else(|| AppError::Invalid("目标父目录无效".into()))?.canonicalize()?;
    if !parent.is_dir() { return Err(AppError::Invalid("目标父目录不存在".into())); }
    let path = parent.join(requested.file_name().unwrap());
    if path.starts_with(source.canonicalize()?) {
        return Err(AppError::Invalid("新保险库必须位于原保险库之外".into()));
    }
    Ok(path)
}

fn publish_directory(from: &Path, to: &Path) -> Result<()> {
    if to.symlink_metadata().is_ok() { return Err(AppError::Invalid("目标目录已经存在，已停止发布".into())); }
    #[cfg(windows)]
    { std::fs::rename(from, to)?; }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::os::unix::ffi::OsStrExt;
        let old = std::ffi::CString::new(from.as_os_str().as_bytes()).map_err(|_| AppError::Invalid("路径含NUL".into()))?;
        let new = std::ffi::CString::new(to.as_os_str().as_bytes()).map_err(|_| AppError::Invalid("路径含NUL".into()))?;
        #[cfg(target_os = "linux")]
        let rc = unsafe {
            extern "C" { fn renameat2(olddir: i32, old: *const std::os::raw::c_char, newdir: i32, new: *const std::os::raw::c_char, flags: u32) -> i32; }
            renameat2(-100, old.as_ptr(), -100, new.as_ptr(), 1)
        };
        #[cfg(target_os = "macos")]
        let rc = unsafe {
            extern "C" { fn renamex_np(old: *const std::os::raw::c_char, new: *const std::os::raw::c_char, flags: u32) -> i32; }
            renamex_np(old.as_ptr(), new.as_ptr(), 4)
        };
        if rc != 0 { return Err(std::io::Error::last_os_error().into()); }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    { let _ = (from, to); return Err(AppError::Unsupported("独立主密钥迁移仅支持桌面端")); }
    Ok(())
}

fn equal_json<T: Serialize>(a: &T, b: &T) -> Result<()> {
    if serde_json::to_value(a)? != serde_json::to_value(b)? {
        return Err(AppError::Invalid("新保险库内容校验不一致，原库未更改".into()));
    }
    Ok(())
}

fn verify_copy(v: &Vault, original: &BackupPayload) -> Result<()> {
    store::invalidate_plaintext_cache();
    equal_json(&store::load_data(v)?, &original.data)?;
    equal_json(&store::load_secrets(v)?, &original.secrets)?;
    equal_json(&store::load_accounts(v)?, &original.account_data)?;
    equal_json(&store::load_totp(v)?, &original.totp_data)?;
    equal_json(&store::load_files(v)?, &original.file_data)?;
    equal_json(&store::load_notes(v)?, &original.note_data)?;
    if let Some(qr) = &original.qr_history { equal_json(&store::load_qr_history(v)?, qr)?; }
    for (id, encoded) in &original.private_keys {
        if *Zeroizing::new(store::load_key(v, id)?) != *Zeroizing::new(B64.decode(encoded).map_err(|_| AppError::Crypto)?) { return Err(AppError::Crypto); }
    }
    for (hash, encoded) in &original.blobs {
        if *Zeroizing::new(store::blob::read_blob_bytes(v, hash)?) != *Zeroizing::new(B64.decode(encoded).map_err(|_| AppError::Crypto)?) { return Err(AppError::Crypto); }
    }
    for (hash, encoded) in &original.icons {
        if store::load_icon(v, hash)? != B64.decode(encoded).map_err(|_| AppError::Crypto)? { return Err(AppError::Crypto); }
    }
    if let Some(expected) = &original.locker_data {
        let actual = store::load_locker(v)?;
        if actual.entries.len() != expected.entries.len() { return Err(AppError::Crypto); }
        for entry in &actual.entries {
            let key = Zeroizing::new(crate::locker::unwrap_content_key(v, &entry.wrap_self)?);
            let expected = Zeroizing::new(B64.decode(original.locker_content_keys.get(&entry.id).ok_or(AppError::Crypto)?).map_err(|_| AppError::Crypto)?);
            if key.as_slice() != expected.as_slice() { return Err(AppError::Crypto); }
        }
    }
    Ok(())
}

fn prepare_copy(source: &Vault, target: &Path, password: &str, kdf: KdfParams) -> Result<(Vault, String, BackupSummary, [u8; 32])> {
    let target = destination(target, source.root())?;
    let staging_path = target.parent().unwrap().join(format!(".km-migration-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&staging_path)?;
    let staging = Staging(staging_path);
    let transfer = staging.0.join("transfer.gambackup");
    let random_password = Zeroizing::new(crypto::random_vec(32));
    let transfer_password = Zeroizing::new(B64.encode(&*random_password));
    let (summary, revision) = store::transaction(source, || {
        let summary = backup::export_backup(source, &transfer, &transfer_password)?;
        Ok((summary, source_revision(source)?))
    })?;
    let original = backup::inspect_backup(&transfer, &transfer_password)?;
    let staged_root = staging.0.join("vault");
    let (mut staged, recovery_key) = Vault::init(&staged_root, password, kdf)?;
    backup::import_backup(&staged, &transfer, &transfer_password, false)?;
    // Merge-oriented imports normalize tombstones and machine bindings. A key
    // migration must preserve the exact backup metadata, including history.
    store::transaction(&staged, || {
        store::save_data(&staged, &original.data)?;
        store::save_secrets(&staged, &original.secrets)?;
        store::save_accounts(&staged, &original.account_data)?;
        store::save_totp(&staged, &original.totp_data)?;
        store::save_files(&staged, &original.file_data)?;
        store::save_notes(&staged, &original.note_data)?;
        if let Some(qr) = &original.qr_history { store::save_qr_history(&staged, qr)?; }
        Ok(())
    })?;
    verify_copy(&staged, &original)?;
    staged.lock();
    publish_directory(&staged_root, &target)?;
    Ok((Vault::load(&target)?, recovery_key, summary, revision))
}

#[tauri::command(async)]
pub fn security_migration_prepare(state: State<'_, AppState>, target_path: String, access_password: String, new_password: String) -> Result<MigrationPrepared> {
    #[cfg(mobile)]
    return Err(AppError::Unsupported("独立主密钥迁移仅支持桌面端"));
    let _prepare = PREPARING.try_lock().map_err(|_| AppError::Busy)?;
    crate::commands::ensure_writes_allowed(&state)?;
    super::vault::validate_new_access_password(&new_password)?;
    let access_password = Zeroizing::new(access_password);
    let new_password = Zeroizing::new(new_password);
    if *new_password == *access_password { return Err(AppError::Invalid("安全迁移请使用不同的新访问密码".into())); }
    let (source, epoch) = {
        let current = recover_lock(&state.vault);
        let v = current.as_ref().filter(|v| v.is_unlocked()).ok_or(AppError::Locked)?;
        v.verify_password(&access_password)?;
        (v.clone(), state.session_epoch.load(Ordering::SeqCst))
    };
    let target = destination(Path::new(&target_path), source.root())?;
    let kdf = crate::vault::kdf::calibrate(crate::vault::kdf::DEFAULT_TARGET_MS);
    let (locked, recovery_key, summary, revision) = prepare_copy(&source, &target, &new_password, kdf)?;
    let recovery_key = Zeroizing::new(recovery_key);
    let token = uuid::Uuid::new_v4().to_string();
    let pending = Pending {
        token: token.clone(), path: target.clone(), workspace_id: locked.workspace_id().into(),
        source_path: source.root().into(), source_id: source.workspace_id().into(), source_epoch: epoch,
        source_revision: revision, target_revision: source_revision(&locked)?, recovery_hash: recovery_hash(&recovery_key)?, expires: Instant::now() + Duration::from_secs(30 * 60),
    };
    let current = recover_lock(&state.vault);
    if state.reset_busy.load(Ordering::SeqCst) || state.session_epoch.load(Ordering::SeqCst) != epoch || !current.as_ref().is_some_and(|v| v.is_unlocked() && v.same_session(&source)) {
        return Err(AppError::Invalid(format!("准备期间会话已改变，未返回恢复码。已验证副本保留在 {}，可用本次设置的新密码打开；原库未切换。", target.display())));
    }
    let out = MigrationPrepared { token, recovery_key: recovery_key.to_string(), workspace_id: pending.workspace_id.clone(), path: target.display().to_string(), source_path: source.root().display().to_string(), summary };
    *recover_lock(&PENDING) = Some(pending);
    Ok(out)
}

fn validated_target(pending: &Pending, state: &AppState, source: &Vault, token: &str, confirmation: &str) -> Result<Vault> {
    if pending.token != token || Instant::now() >= pending.expires { return Err(AppError::NeedReauth); }
    if !source.is_unlocked() || source.workspace_id() != pending.source_id || source.root() != pending.source_path || state.session_epoch.load(Ordering::SeqCst) != pending.source_epoch {
        return Err(AppError::Invalid("原工作空间会话已改变；已生成副本保留，请重新准备迁移".into()));
    }
    if recovery_hash(confirmation)? != pending.recovery_hash { return Err(AppError::Invalid("请输入已保存的新恢复密钥确认".into())); }
    if source_revision(source)? != pending.source_revision { return Err(AppError::Invalid("准备后原库内容已变化；副本保留，请重新准备以包含最新修改".into())); }
    let mut target = Vault::load(&pending.path)?;
    if target.workspace_id() != pending.workspace_id { return Err(AppError::Invalid("目标保险库已被替换".into())); }
    if source_revision(&target)? != pending.target_revision { return Err(AppError::Invalid("目标副本在校验后发生变化，已拒绝切换；请重新准备迁移".into())); }
    target.unlock_with_recovery(confirmation)?;
    Ok(target)
}

fn activate_copy(state: &AppState, pending: &Pending, token: &str, confirmation: &str, save_config: impl FnOnce(&crate::app_config::AppConfig) -> Result<()>) -> Result<()> {
    // Hold no AppState mutex while waiting for the disk gate. Once inside,
    // try_lock avoids deadlocking with a command holding vault/config while
    // waiting for that gate. Busy is safe to retry and changes no configuration.
    store::with_exclusive_workspace(&pending.source_path, || {
        let mut cfg = state.config.try_lock().map_err(|_| AppError::Busy)?;
        let mut current = state.vault.try_lock().map_err(|_| AppError::Busy)?;
        let source = current.as_ref().ok_or(AppError::Locked)?;
        let target = validated_target(pending, state, source, token, confirmation)?;
        let mut next = cfg.clone();
        next.clear_runtime_secrets(); next.cloud_sync = None; next.auto_sync_minutes = 0;
        next.grace_days = 0; next.biometric_unlock_enabled = false;
        next.biometric_reveal_enabled = false; next.biometric_reveal_secret = false;
        next.initial_cloud_sync_done = false; next.last_auto_sync_at = None; next.last_auto_sync_message = None;
        next.workspace_path = Some(pending.path.display().to_string());
        save_config(&next)?;
        if let Some(old) = current.as_mut() { old.lock(); }
        state.session_epoch.fetch_add(1, Ordering::SeqCst);
        *current = Some(target); *cfg = next;
        Ok(())
    })
}

fn commit_pending(slot: &mut Option<Pending>, token: &str, persist: impl FnOnce() -> Result<()>) -> Result<()> {
    if !slot.as_ref().is_some_and(|p| p.token == token) { return Err(AppError::NeedReauth); }
    persist()?;
    *slot = None;
    Ok(())
}

#[tauri::command(async)]
pub fn security_migration_activate(state: State<'_, AppState>, token: String, recovery_key: String) -> Result<()> {
    let confirmation = Zeroizing::new(recovery_key);
    if state.reset_busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return Err(AppError::Busy); }
    struct Busy<'a>(&'a AppState);
    impl Drop for Busy<'_> { fn drop(&mut self) { self.0.reset_busy.store(false, Ordering::SeqCst); } }
    let _busy = Busy(&state);
    let pending = recover_lock(&PENDING).as_ref().cloned().ok_or(AppError::NeedReauth)?;
    activate_copy(&state, &pending, &token, &confirmation, |next| {
        let mut slot = PENDING.try_lock().map_err(|_| AppError::Busy)?;
        commit_pending(&mut slot, &token, || next.save())
    })?;
    crate::session::clear();
    let _ = crate::biometric::disable();
    crate::biometric::clear_session_secrets();
    *recover_lock(&state.pending_recovery) = None;
    crate::commands::clear_reveal_grace(&state);
    store::invalidate_plaintext_cache();
    crate::commands::sync::invalidate_client_cache();
    crate::commands::sync::invalidate_cloud_view_cache();
    state.pending_edit_publish.store(false, Ordering::SeqCst);
    state.pending_full_sync.store(false, Ordering::SeqCst);
    crate::clipboard::clear_on_teardown();
    Ok(())
}

#[tauri::command]
pub fn security_migration_cancel(token: String) -> Result<()> {
    let mut pending = recover_lock(&PENDING);
    if pending.as_ref().is_some_and(|p| p.token == token) { *pending = None; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cheap_kdf() -> KdfParams {
        KdfParams::new(crate::vault::kdf::MEM_FLOOR_KIB, crate::vault::kdf::ITERS_FLOOR, 1)
    }

    #[test]
    fn fresh_key_copy_preserves_content_and_guards_activation() {
        let parent = std::env::temp_dir().join(format!("km-migration-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&parent).unwrap();
        let old_path = parent.join("old");
        let target_path = parent.join("new");
        let (source, _) = Vault::init(&old_path, "old access password", cheap_kdf()).unwrap();
        let mut secrets = crate::model::Secrets::default();
        secrets.github_pat = Some("synthetic-test-token".into());
        secrets.account_secrets.insert("account".into(), crate::model::AccountSecret { password: " password with spaces ".into(), ..Default::default() });
        store::save_secrets(&source, &secrets).unwrap();
        let accounts: crate::model::AccountData = serde_json::from_value(serde_json::json!({
            "entries":[{"id":"account","platform":"test","username":"test","tags":[],"pinned":false,"sortOrder":0,"createdAt":"2026-11-15T00:00:00Z","updatedAt":"2026-11-15T00:00:00Z"}],"groups":[]
        })).unwrap();
        store::save_accounts(&source, &accounts).unwrap();
        let before = source_revision(&source).unwrap();
        let old_subkey = Zeroizing::new(source.subkey(crypto::LABEL_METADATA).unwrap());
        let (mut target, recovery_key, summary, revision) = prepare_copy(&source, &target_path, "new unique access password", cheap_kdf()).unwrap();
        assert!(!target.is_unlocked());
        assert_ne!(target.workspace_id(), source.workspace_id());
        assert_eq!(summary.account_count, 1);
        assert_eq!(before, source_revision(&source).unwrap());
        assert!(target.unlock_with_password("old access password").is_err());
        target.unlock_with_password("new unique access password").unwrap();
        assert_ne!(*old_subkey, target.subkey(crypto::LABEL_METADATA).unwrap());
        assert_eq!(store::load_secrets(&target).unwrap().account_secrets["account"].password, " password with spaces ");
        target.lock();
        let state = AppState::new_for_test(crate::app_config::AppConfig::default());
        *recover_lock(&state.vault) = Some(source.clone());
        let mut pending = Pending {
            token: "single-use-test-token".into(), path: target_path.clone(), workspace_id: target.workspace_id().into(),
            source_path: old_path.clone(), source_id: source.workspace_id().into(), source_epoch: state.session_epoch.load(Ordering::SeqCst),
            source_revision: revision, target_revision: source_revision(&target).unwrap(), recovery_hash: recovery_hash(&recovery_key).unwrap(), expires: Instant::now() + Duration::from_secs(60),
        };
        let wrong = recovery::generate().1;
        assert!(activate_copy(&state, &pending, &pending.token, &wrong, |_| panic!("must not save config")).is_err());
        assert_eq!(recover_lock(&state.vault).as_ref().unwrap().workspace_id(), source.workspace_id());
        // Ciphertext attachments are covered too, not merely metadata IDs.
        let unexpected_blob = target_path.join("blobs").join("changed.blob");
        std::fs::write(&unexpected_blob, b"synthetic damaged ciphertext").unwrap();
        assert!(activate_copy(&state, &pending, &pending.token, &recovery_key, |_| panic!("changed target must not commit")).is_err());
        std::fs::remove_file(&unexpected_blob).unwrap();
        let source_blob = old_path.join("blobs").join("changed.blob");
        std::fs::write(&source_blob, b"synthetic source change").unwrap();
        assert!(activate_copy(&state, &pending, &pending.token, &recovery_key, |_| panic!("changed source attachment must not commit")).is_err());
        std::fs::remove_file(&source_blob).unwrap();
        state.session_epoch.fetch_add(1, Ordering::SeqCst);
        assert!(activate_copy(&state, &pending, &pending.token, &recovery_key, |_| panic!("stale session must not commit")).is_err());
        pending.source_epoch = state.session_epoch.load(Ordering::SeqCst);
        let mut updated = secrets.clone(); updated.github_pat = Some("newer-unsynced-token".into());
        store::save_secrets(&source, &updated).unwrap();
        assert!(activate_copy(&state, &pending, &pending.token, &recovery_key, |_| panic!("new edits must not be lost")).is_err());
        store::save_secrets(&source, &secrets).unwrap(); pending.source_revision = source_revision(&source).unwrap();
        let mut cancelled: Option<Pending> = None;
        assert!(activate_copy(&state, &pending, &pending.token, &recovery_key, |_| commit_pending(&mut cancelled, &pending.token, || panic!("cancelled"))).is_err());
        let mut replaced = Some(Pending { token: "newer preparation".into(), ..pending.clone() });
        assert!(activate_copy(&state, &pending, &pending.token, &recovery_key, |_| commit_pending(&mut replaced, &pending.token, || panic!("replaced"))).is_err());
        let mut live = Some(pending.clone());
        activate_copy(&state, &pending, &pending.token, &recovery_key, |cfg| {
            assert!(cfg.cloud_sync.is_none()); assert_eq!(cfg.auto_sync_minutes, 0);
            commit_pending(&mut live, &pending.token, || Ok(()))
        }).unwrap();
        assert!(live.is_none());
        assert!(!source.is_unlocked());
        assert_eq!(recover_lock(&state.vault).as_ref().unwrap().workspace_id(), target.workspace_id());
        assert!(old_path.join("vault.json").is_file());
        let mut old = Vault::load(&old_path).unwrap(); old.unlock_with_password("old access password").unwrap();
        assert_eq!(store::load_secrets(&old).unwrap().github_pat, secrets.github_pat);
        drop(state); drop(old); drop(target); drop(source);
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn publish_never_replaces_an_existing_empty_directory() {
        let parent = std::env::temp_dir().join(format!("km-publish-test-{}", uuid::Uuid::new_v4()));
        let source = parent.join("staging"); let target = parent.join("target");
        std::fs::create_dir_all(&source).unwrap(); std::fs::create_dir(&target).unwrap();
        std::fs::write(source.join("marker"), b"preserve").unwrap();
        assert!(publish_directory(&source, &target).is_err());
        assert!(source.join("marker").is_file()); assert!(!target.join("marker").exists());
        std::fs::remove_dir_all(parent).unwrap();
    }
}
