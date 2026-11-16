//! vault 相关 IPC 命令。

use crate::autostart;
use crate::commands::{recover_lock, AppState};
use crate::error::{AppError, Result};
use crate::session;
use crate::vault::crypto::MasterKey;
use crate::vault::header::KdfParams;
use crate::vault::kdf::{calibrate, DEFAULT_TARGET_MS};
use crate::vault::Vault;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
    pub workspace_path: Option<String>,
    pub workspace_id: Option<String>,
    pub auto_lock_minutes: u32,
    pub launch_at_login: bool,
    pub launch_at_login_supported: bool,
    pub grace_days: u32,
    pub grace_active: bool,
    pub grace_expires_at: Option<String>,
    /// `tray` / `quit` / None（每次询问）。
    pub close_action: Option<String>,
    /// 云同步不再挡住操作。字段保留，避免旧前端读不到。
    pub writes_locked: bool,
    /// 移动端主界面返回键：true 回系统桌面保活，false 退出。
    pub mobile_background_run: bool,
    pub startup_note: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    pub recovery_key: String,
    pub workspace_id: String,
}

pub use crate::workspace_path::PathCheck;

/// Applies only when choosing a new access password. Existing passwords remain unlockable.
pub fn validate_new_access_password(password: &str) -> Result<()> {
    if password.chars().count() < 8 || password.len() > 4096 {
        return Err(AppError::Invalid(
            "访问密码至少需要 8 个字符，且不超过 4096 字节".into(),
        ));
    }
    let comparison = password.trim().to_lowercase();
    let common = [
        "12345678",
        "123456789",
        "1234567890",
        "87654321",
        "password",
        "password123",
        "qwerty123",
        "abcdefgh",
    ];
    if comparison.is_empty()
        || common.contains(&comparison.as_str())
        || comparison
            .chars()
            .next()
            .is_some_and(|first| comparison.chars().all(|c| c == first))
    {
        return Err(AppError::Invalid(
            "访问密码过于常见，请使用较长且独特的口令".into(),
        ));
    }
    Ok(())
}

#[cfg(mobile)]
fn discover_existing_workspace() -> Option<PathBuf> {
    crate::identity::workspace_search_roots()
        .into_iter()
        .map(|root| root.join("workspace"))
        .find(|p| Vault::exists(p))
}

/// 移动端配置根和 JS `appDataDir()` 可能差一层 `files/`。
/// 若沙箱里已经有 vault，但本机 config 还没记下路径，冷启动会误进初始化向导。
#[cfg(mobile)]
fn adopt_sandboxed_workspace_if_needed(state: &AppState) {
    {
        let cfg = recover_lock(&state.config);
        if cfg
            .workspace_path
            .as_ref()
            .is_some_and(|p| Vault::exists(&PathBuf::from(p)))
        {
            return;
        }
    }
    let Some(found) = discover_existing_workspace() else {
        return;
    };
    let mut cfg = recover_lock(&state.config);
    if !cfg
        .workspace_path
        .as_ref()
        .is_some_and(|p| Vault::exists(&PathBuf::from(p)))
    {
        cfg.workspace_path = Some(found.to_string_lossy().into_owned());
        let _ = cfg.save();
    }
}

/// 查询当前状态（前端启动、锁定、解锁后都会调用）。
///
/// 必须离开窗口线程 / 安卓 WebView 桥。这条命令要拿保险库锁；解锁时若把 Argon2
/// 或整库解密放在同一把锁里，放置久了内存和页缓存变冷，状态查询会干等超过 5 秒，
/// Windows 把窗口标成「未响应」，手机上则点按和返回都停住。
#[tauri::command(async)]
pub fn vault_status(state: State<'_, AppState>) -> VaultStatus {
    #[cfg(mobile)]
    adopt_sandboxed_workspace_if_needed(&state);

    let cfg = recover_lock(&state.config);
    let vault = recover_lock(&state.vault);
    let initialized = cfg
        .workspace_path
        .as_ref()
        .map(|p| Vault::exists(&PathBuf::from(p)))
        .unwrap_or(false);
    let workspace_id = vault.as_ref().map(|v| v.workspace_id().to_string());
    let unlocked = vault.as_ref().map(|v| v.is_unlocked()).unwrap_or(false);
    let workspace_path = cfg.workspace_path.clone();
    let auto_lock_minutes = cfg.auto_lock_minutes;
    let launch_at_login = cfg.launch_at_login || autostart::is_enabled();
    let grace_days = cfg.grace_days;
    let close_action = cfg.close_action.clone();
    let mobile_background_run = cfg.mobile_background_run;
    drop(vault);
    drop(cfg);
    let grace = session::info(workspace_id.as_deref());
    VaultStatus {
        initialized,
        unlocked,
        workspace_path,
        workspace_id,
        auto_lock_minutes,
        launch_at_login,
        launch_at_login_supported: autostart::is_supported(),
        grace_days,
        grace_active: grace.active,
        grace_expires_at: grace.expires_at,
        close_action,
        mobile_background_run,
        writes_locked: state
            .writes_locked
            .load(std::sync::atomic::Ordering::SeqCst),
        startup_note: state.startup_note.lock().ok().and_then(|n| n.clone()),
    }
}

/// 移动端固定保险库目录；已有库时优先返回实际路径。桌面端也返回同一约定（前端只在手机上用）。
#[tauri::command]
pub fn default_workspace_path() -> String {
    #[cfg(mobile)]
    if let Some(found) = discover_existing_workspace() {
        return found.to_string_lossy().into_owned();
    }
    crate::identity::workspace_dir()
        .to_string_lossy()
        .into_owned()
}

/// 检测工作空间路径：非法字符拒绝；空格 / 非 ASCII / 同步盘只警告。
#[tauri::command]
pub fn check_workspace_path(path: String) -> PathCheck {
    crate::workspace_path::inspect(&path)
}

/// 初始化工作空间。会做 Argon2id 运行时标定（略慢，属正常）。
#[tauri::command(async)]
pub fn vault_init(
    state: State<'_, AppState>,
    path: String,
    password: String,
) -> Result<InitResult> {
    crate::commands::ensure_writes_allowed(&state)?;
    validate_new_access_password(&password)?;
    let password = zeroize::Zeroizing::new(password);
    crate::workspace_path::reject_if_invalid(&path)?;
    let root = PathBuf::from(&path);
    if Vault::exists(&root) {
        // 库已在，但本机 config 可能没记下路径（手机上 JS/Rust 数据目录曾分叉）。
        // 先写回路径，前端再 refresh 就能进解锁，而不是停在向导里报错。
        #[cfg(mobile)]
        {
            let mut cfg = recover_lock(&state.config);
            cfg.workspace_path = Some(path.clone());
            let _ = cfg.save();
        }
        return Err(AppError::AlreadyInitialized(path));
    }
    let kdf: KdfParams = calibrate(DEFAULT_TARGET_MS);
    let (vault, recovery_key) = Vault::init(&root, &password, kdf)?;
    let workspace_id = vault.workspace_id().to_string();

    // 记录工作空间路径（非机密）。
    {
        let mut cfg = recover_lock(&state.config);
        if state.reset_busy.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(AppError::Busy);
        }
        cfg.workspace_path = Some(path);
        cfg.save()?;
    }
    {
        let mut current = recover_lock(&state.vault);
        if state.reset_busy.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(AppError::Busy);
        }
        state
            .session_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Some(old) = current.as_mut() {
            old.lock();
        }
        *current = Some(vault);
    }
    recover_lock(&state.unlock_guard).reset();
    grant_grace_if_configured(&state);
    let _ = crate::sys::adopt_ssh_config(&root);

    Ok(InitResult {
        recovery_key,
        workspace_id,
    })
}

/// 将已解锁的 Vault 登记为本机工作空间（初始化或换机恢复后调用）。
pub(crate) fn adopt_unlocked_vault(
    state: &AppState,
    vault: crate::vault::Vault,
    workspace_path: String,
    cloud_sync: Option<crate::sync::s3::S3Config>,
) -> Result<()> {
    crate::commands::ensure_writes_allowed(state)?;
    {
        let mut cfg = recover_lock(&state.config);
        if state.reset_busy.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(AppError::Busy);
        }
        cfg.workspace_path = Some(workspace_path.clone());
        if let Some(sync) = cloud_sync {
            cfg.cloud_sync = Some(sync);
        }
        cfg.save()?;
    }
    let root = PathBuf::from(&workspace_path);
    {
        let mut current = recover_lock(&state.vault);
        if state.reset_busy.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(AppError::Busy);
        }
        state
            .session_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Some(old) = current.as_mut() {
            old.lock();
        }
        *current = Some(vault);
    }
    recover_lock(&state.unlock_guard).reset();
    crate::commands::hydrate_config_secrets(state);
    grant_grace_if_configured(state);
    let _ = crate::sys::adopt_ssh_config(&root);
    Ok(())
}

pub(crate) fn ensure_loaded(state: &AppState) -> Result<()> {
    if state.reset_busy.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(AppError::Busy);
    }
    let cfg_path = {
        let cfg = recover_lock(&state.config);
        cfg.workspace_path.clone()
    };
    let path = cfg_path.ok_or(AppError::NotInitialized)?;
    let mut vault = recover_lock(&state.vault);
    if vault.is_none() {
        state
            .session_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *vault = Some(Vault::load(&PathBuf::from(path))?);
    }
    Ok(())
}

pub(crate) fn resolve_workspace_id(state: &AppState) -> Option<String> {
    recover_lock(&state.vault)
        .as_ref()
        .map(|v| v.workspace_id().to_string())
}

/// 用访问密码解锁（带限速）。
#[tauri::command(async)]
pub fn vault_unlock(app: AppHandle, state: State<'_, AppState>, password: String) -> Result<()> {
    let password = zeroize::Zeroizing::new(password);
    {
        let guard = recover_lock(&state.unlock_guard);
        if guard.remaining_ms() > 0 {
            return Err(AppError::RateLimited);
        }
    }
    ensure_loaded(&state)?;
    // 先抄出信封和 KDF，再放开锁做 Argon2。派生要几十到几百 MiB，放置久了这些页会被系统收回，
    // 耗时远超刚锁定时的热缓存。这段时间不能占着保险库锁。
    let (envelope, kdf, epoch, workspace_id) = {
        let vault = recover_lock(&state.vault);
        let v = vault.as_ref().ok_or(AppError::NotInitialized)?;
        (
            v.header().envelopes.password.clone(),
            v.kdf_params().clone(),
            state
                .session_epoch
                .load(std::sync::atomic::Ordering::SeqCst),
            v.workspace_id().to_string(),
        )
    };
    crate::vault::kdf::ensure_affordable(&kdf)?;
    match crate::vault::envelope::unwrap_with_password(&envelope, &password, &kdf) {
        Ok(mk) => {
            {
                let mut vault = recover_lock(&state.vault);
                let v = vault.as_mut().ok_or(AppError::NotInitialized)?;
                if state.reset_busy.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err(AppError::Busy);
                }
                if v.workspace_id() != workspace_id
                    || state
                        .session_epoch
                        .load(std::sync::atomic::Ordering::SeqCst)
                        != epoch
                {
                    return Err(AppError::Locked);
                }
                state
                    .session_epoch
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                v.install_master_key(mk);
            }
            finish_unlock(&app, &state);
            Ok(())
        }
        Err(e) => {
            recover_lock(&state.unlock_guard).record_failure();
            Err(e)
        }
    }
}

/// 用恢复密钥解锁（忘记密码/换机）。
#[tauri::command(async)]
pub fn vault_unlock_recovery(
    app: AppHandle,
    state: State<'_, AppState>,
    recovery_key: String,
) -> Result<()> {
    let recovery_key = zeroize::Zeroizing::new(recovery_key);
    ensure_loaded(&state)?;
    let mut vault = recover_lock(&state.vault);
    let v = vault.as_mut().ok_or(AppError::NotInitialized)?;
    if state.reset_busy.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(AppError::Busy);
    }
    v.unlock_with_recovery(&recovery_key)?;
    state
        .session_epoch
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    drop(vault);
    finish_unlock(&app, &state);
    Ok(())
}

/// 用本机指纹 / Windows Hello / Touch ID 解锁。
#[tauri::command(async)]
pub fn vault_unlock_biometric(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    crate::biometric::bind_window(&app);
    {
        let guard = recover_lock(&state.unlock_guard);
        if guard.remaining_ms() > 0 {
            return Err(AppError::RateLimited);
        }
    }
    ensure_loaded(&state)?;
    let (workspace_id, epoch) = {
        let guard = recover_lock(&state.vault);
        let v = guard.as_ref().ok_or(AppError::NotInitialized)?;
        (
            v.workspace_id().to_string(),
            state
                .session_epoch
                .load(std::sync::atomic::Ordering::SeqCst),
        )
    };
    match crate::biometric::unlock_master_key(&workspace_id) {
        Ok(mk) => {
            {
                let mut vault = recover_lock(&state.vault);
                let v = vault.as_mut().ok_or(AppError::NotInitialized)?;
                if state.reset_busy.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err(AppError::Busy);
                }
                if v.workspace_id() != workspace_id
                    || state
                        .session_epoch
                        .load(std::sync::atomic::Ordering::SeqCst)
                        != epoch
                {
                    return Err(AppError::Locked);
                }
                state
                    .session_epoch
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                v.install_master_key(mk);
            }
            // 身份库校验会解密整份 identities.enc。放在保险库锁外面，避免和状态查询、
            // 指纹框抢同一条窗口线程。钥匙不对就立刻锁回去，不把明文留在缓存里。
            if let Err(e) = confirm_installed_key(&state) {
                recover_lock(&state.unlock_guard).record_failure();
                return Err(e);
            }
            finish_unlock(&app, &state);
            Ok(())
        }
        Err(AppError::BiometricCancelled) => Err(AppError::BiometricCancelled),
        Err(e) => {
            if !matches!(e, AppError::BiometricStale) {
                recover_lock(&state.unlock_guard).record_failure();
            }
            Err(e)
        }
    }
}

/// 锁定：清零内存中的 MK。
#[tauri::command]
pub fn vault_lock(state: State<AppState>) {
    lock_in_memory(&state);
}

pub fn lock_in_memory(state: &AppState) {
    {
        let mut current = recover_lock(&state.vault);
        state
            .session_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Some(v) = current.as_mut() {
            v.lock();
        }
    }
    crate::store::invalidate_plaintext_cache();
    {
        let mut cfg = recover_lock(&state.config);
        cfg.clear_runtime_secrets();
    }
    crate::commands::sync::invalidate_cloud_view_cache();
    crate::commands::sync::invalidate_client_cache();
    crate::biometric::clear_session_secrets();
    *recover_lock(&state.pending_recovery) = None;
    state
        .pending_edit_publish
        .store(false, std::sync::atomic::Ordering::SeqCst);
    state
        .pending_full_sync
        .store(false, std::sync::atomic::Ordering::SeqCst);
    // 锁上了却把刚复制的密码留在剪贴板，等于没锁。
    crate::clipboard::clear_on_teardown();
    crate::commands::clear_reveal_grace(state);
    state
        .writes_locked
        .store(false, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut n) = state.startup_note.lock() {
        *n = None;
    }
}

/// 按免验证设置尝试静默解锁。`grace_days == 0` 或会话过期时返回 false。
pub fn try_grace_unlock_silent(state: &AppState) -> bool {
    {
        let vault = recover_lock(&state.vault);
        if vault.as_ref().is_some_and(|v| v.is_unlocked()) {
            return true;
        }
    }
    let days = recover_lock(&state.config).grace_days;
    if days == 0 {
        return false;
    }
    if ensure_loaded(state).is_err() {
        return false;
    }
    let (workspace_id, epoch) = {
        let vault = recover_lock(&state.vault);
        match vault.as_ref() {
            Some(v) => (
                v.workspace_id().to_string(),
                state
                    .session_epoch
                    .load(std::sync::atomic::Ordering::SeqCst),
            ),
            None => return false,
        }
    };
    let Ok(mk) = session::try_restore(&workspace_id) else {
        return false;
    };
    let mk = zeroize::Zeroizing::new(mk);
    {
        let mut vault = recover_lock(&state.vault);
        let Some(v) = vault.as_mut() else {
            return false;
        };
        if state.reset_busy.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        if v.workspace_id() != workspace_id
            || state
                .session_epoch
                .load(std::sync::atomic::Ordering::SeqCst)
                != epoch
        {
            return false;
        }
        state
            .session_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        v.install_master_key(MasterKey::from_bytes(*mk));
    }
    if confirm_installed_key(state).is_err() {
        return false;
    }
    crate::commands::hydrate_config_secrets(state);
    crate::autolock::touch(state);
    true
}

/// 主密钥已经装上之后，在不持有保险库锁的情况下确认它能解开身份库。
fn confirm_installed_key(state: &AppState) -> Result<()> {
    let snap = crate::commands::clone_unlocked_vault(state)?;
    if snap.master_key_opens_data().is_err() {
        if let Some(v) = recover_lock(&state.vault)
            .as_mut()
            .filter(|v| v.same_session(&snap))
        {
            state
                .session_epoch
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            v.lock();
        }
        crate::store::invalidate_plaintext_cache();
        return Err(AppError::BadPassword);
    }
    Ok(())
}

fn finish_unlock(app: &AppHandle, state: &AppState) {
    recover_lock(&state.unlock_guard).reset();
    crate::commands::hydrate_config_secrets(state);
    grant_grace_if_configured(state);
    // 空闲计时从这次解锁起算。否则进后台前积下的空闲会在解锁成功后马上再锁一次。
    crate::autolock::touch(state);
    schedule_after_unlock(app.clone());
}

/// 当场校验访问密码（不吃免密查看窗口）。
/// 用于查看云存储 Access Key、导出或分享配置前的二次确认。
#[tauri::command]
pub fn verify_access_password(state: State<AppState>, access_password: String) -> Result<()> {
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    if access_password.trim().is_empty() {
        return Err(AppError::Invalid("访问密码不能为空".into()));
    }
    v.verify_password(&access_password)
}

/// 修改访问密码（需正确旧密码）。
#[tauri::command]
pub fn change_password(
    state: State<AppState>,
    old_password: String,
    new_password: String,
) -> Result<()> {
    crate::commands::ensure_writes_allowed(&state)?;
    validate_new_access_password(&new_password)?;
    let old_password = zeroize::Zeroizing::new(old_password);
    let new_password = zeroize::Zeroizing::new(new_password);
    ensure_loaded(&state)?;
    let mut vault = recover_lock(&state.vault);
    let v = vault.as_mut().ok_or(AppError::NotInitialized)?;
    v.change_password(&old_password, &new_password)?;
    state
        .session_epoch
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    *recover_lock(&state.pending_recovery) = None;
    crate::commands::clear_reveal_grace(&state);
    drop(vault);
    session::clear();
    grant_grace_if_configured(&state);
    Ok(())
}

#[tauri::command(async)]
pub fn reset_access_password_with_recovery(
    app: AppHandle,
    state: State<'_, AppState>,
    recovery_key: String,
    new_password: String,
) -> Result<()> {
    validate_new_access_password(&new_password)?;
    let recovery_key = zeroize::Zeroizing::new(recovery_key);
    let new_password = zeroize::Zeroizing::new(new_password);
    ensure_loaded(&state)?;
    let target = calibrate(DEFAULT_TARGET_MS);
    {
        let mut guard = recover_lock(&state.vault);
        let vault = guard.as_mut().ok_or(AppError::NotInitialized)?;
        if state.reset_busy.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(AppError::Busy);
        }
        vault.reset_password_with_recovery(&recovery_key, &new_password, target)?;
        state
            .session_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *recover_lock(&state.pending_recovery) = None;
        crate::commands::clear_reveal_grace(&state);
        crate::util::audit(vault.root(), "使用恢复密钥重设访问密码");
    }
    session::clear();
    grant_grace_if_configured(&state);
    crate::sync::scheduler::kick_publish(app);
    Ok(())
}

/// 当前保险库的 KDF 参数与移动端兼容性。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfInfo {
    pub mem_mib: u32,
    pub iters: u32,
    pub parallelism: u32,
    /// 内存是否已收在移动端安全上限内（手机能否用访问密码解锁）。
    pub mobile_compatible: bool,
    pub mobile_ceiling_mib: u32,
}

fn kdf_info(p: &KdfParams) -> KdfInfo {
    KdfInfo {
        mem_mib: p.mem_kib / 1024,
        iters: p.iters,
        parallelism: p.parallelism,
        mobile_compatible: p.mem_kib <= crate::vault::kdf::MEM_CEIL_MOBILE_SAFE_KIB,
        mobile_ceiling_mib: crate::vault::kdf::MEM_CEIL_MOBILE_SAFE_KIB / 1024,
    }
}

/// 查询当前 KDF 参数（设置页展示「手机能否接入」）。
#[tauri::command]
pub fn get_kdf_info(state: State<AppState>) -> Result<KdfInfo> {
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::NotInitialized)?;
    Ok(kdf_info(v.kdf_params()))
}

/// 降低 KDF 参数以便手机接入（需正确访问密码）。
///
/// 只重新包裹密码信封，不重加密数据；完成后把头部推到云端，其它设备才拿得到新参数。
/// 标定较慢，走 async 命令避免堵住 WebView。
#[tauri::command(async)]
pub fn relax_kdf_for_mobile(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<KdfInfo> {
    ensure_loaded(&state)?;
    let target = crate::vault::kdf::calibrate_with(
        DEFAULT_TARGET_MS,
        crate::vault::kdf::KdfProfile::CrossDevice,
    );
    let mut vault = recover_lock(&state.vault);
    let v = vault.as_mut().ok_or(AppError::NotInitialized)?;
    let changed = v.relax_kdf(&password, target)?;
    let info = kdf_info(v.kdf_params());
    drop(vault);
    if changed.is_some() {
        session::clear();
        grant_grace_if_configured(&state);
        crate::sync::scheduler::kick_publish(app);
    }
    Ok(info)
}

pub struct PendingRecovery {
    token: String,
    workspace_id: String,
    epoch: u64,
    expires: std::time::Instant,
    envelope: crate::vault::header::Envelope,
    // Keep only a digest for confirmation, never the displayed recovery secret.
    confirmation: [u8; 32],
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryKeyPreparation {
    pub token: String,
    pub recovery_key: String,
    pub workspace_id: String,
}

fn recovery_confirmation(input: &str) -> Result<[u8; 32]> {
    use sha2::{Digest, Sha256};
    let secret = crate::vault::recovery::parse(input)?;
    Ok(Sha256::digest(secret.as_bytes()).into())
}

/// Fresh authentication is mandatory even when the ordinary reveal grace is active.
#[tauri::command(async)]
pub fn rotate_recovery_key(
    state: State<'_, AppState>,
    password: String,
) -> Result<RecoveryKeyPreparation> {
    let password = zeroize::Zeroizing::new(password);
    let vault = recover_lock(&state.vault);
    let v = vault
        .as_ref()
        .filter(|v| v.is_unlocked())
        .ok_or(AppError::Locked)?;
    v.verify_password(&password)?;
    let (envelope, recovery_key) = v.prepare_recovery_key()?;
    let token = uuid::Uuid::new_v4().to_string();
    let workspace_id = v.workspace_id().to_string();
    *recover_lock(&state.pending_recovery) = Some(PendingRecovery {
        token: token.clone(),
        workspace_id: workspace_id.clone(),
        epoch: state
            .session_epoch
            .load(std::sync::atomic::Ordering::SeqCst),
        expires: std::time::Instant::now() + std::time::Duration::from_secs(300),
        envelope,
        confirmation: recovery_confirmation(&recovery_key)?,
    });
    Ok(RecoveryKeyPreparation {
        token,
        recovery_key,
        workspace_id,
    })
}

#[tauri::command]
pub fn commit_recovery_key(
    app: AppHandle,
    state: State<AppState>,
    token: String,
    recovery_key: String,
) -> Result<()> {
    crate::commands::ensure_writes_allowed(&state)?;
    let recovery_key = zeroize::Zeroizing::new(recovery_key);
    let mut vault = recover_lock(&state.vault);
    let v = vault
        .as_mut()
        .filter(|v| v.is_unlocked())
        .ok_or(AppError::Locked)?;
    let mut slot = recover_lock(&state.pending_recovery);
    let pending = slot.as_ref().ok_or(AppError::NeedReauth)?;
    if pending.token != token
        || pending.workspace_id != v.workspace_id()
        || pending.epoch
            != state
                .session_epoch
                .load(std::sync::atomic::Ordering::SeqCst)
        || std::time::Instant::now() >= pending.expires
    {
        *slot = None;
        return Err(AppError::NeedReauth);
    }
    if pending.confirmation != recovery_confirmation(&recovery_key)? {
        return Err(AppError::Invalid(
            "恢复密钥确认不匹配，请重新核对已保存的恢复密钥".into(),
        ));
    }
    v.commit_recovery_envelope(pending.envelope.clone())?;
    *slot = None;
    crate::util::audit(v.root(), "确认轮换恢复密钥");
    drop(slot);
    drop(vault);
    crate::sync::scheduler::kick_publish(app);
    Ok(())
}

#[tauri::command]
pub fn cancel_recovery_key(state: State<AppState>, token: String) -> Result<()> {
    let mut slot = recover_lock(&state.pending_recovery);
    if slot.as_ref().is_some_and(|p| p.token == token) {
        *slot = None;
    }
    Ok(())
}

fn grant_grace_if_configured(state: &AppState) {
    let days = recover_lock(&state.config).grace_days;
    if days == 0 {
        session::clear();
        return;
    }
    let vault = recover_lock(&state.vault);
    let Some(v) = vault.as_ref() else {
        return;
    };
    if let Ok(mk) = v.master_key_bytes() {
        let mk = zeroize::Zeroizing::new(mk);
        let _ = session::grant(v.workspace_id(), &mk, days);
    }
}

fn load_agent_best_effort(state: &AppState) {
    let env = match crate::commands::agent::adopt_agent(state) {
        Ok(env) => env,
        Err(_) => return,
    };
    let vault = {
        let guard = recover_lock(&state.vault);
        match guard.as_ref().filter(|v| v.is_unlocked()).cloned() {
            Some(v) => v,
            None => return,
        }
    };
    let Ok(data) = crate::store::load_data(&vault) else {
        return;
    };
    let mut env = env;
    let mut restarted = false;
    for identity in &data.identities {
        let Some(key_id) = &identity.key_id else {
            continue;
        };
        if let Err(e) = crate::agent::load_key(&vault, &env, key_id) {
            if restarted || !crate::agent::is_agent_down(&e) {
                continue;
            }
            restarted = true;
            let Ok(next) = crate::agent::restart() else {
                return;
            };
            *recover_lock(&state.agent_env) = next.clone();
            env = next;
            let _ = crate::agent::load_key(&vault, &env, key_id);
        }
    }
}

/// 启动时尝试用未过期的本机会话解锁并加载 agent。
#[tauri::command(async)]
pub fn vault_try_grace_unlock(app: AppHandle, state: State<'_, AppState>) -> Result<bool> {
    let ok = try_grace_unlock_silent(&state);
    if ok {
        // 首个 IPC 只恢复本机会话并立刻返回，让 WebView 先画出首帧。
        // 云同步 / 补 SSH / 加载 agent 延后到后台，避免初始化期事件风暴拖死消息泵。
        std::thread::Builder::new()
            .name("gam-after-unlock".into())
            .spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                schedule_after_unlock(app);
            })
            .ok();
    }
    Ok(ok)
}

/// 解锁后的慢活：补 SSH / 加载 agent。云同步不在这里做，也不锁写入。
///
/// 首启强制同步由调度器按配置级标记决定；之后的解锁不再立刻拉取。
/// 锁屏、托盘都不会停掉定时器。
pub(crate) fn schedule_after_unlock(app: AppHandle) {
    let state = app.state::<AppState>();
    let start_bootstrap = !state
        .bootstrap_busy
        .swap(true, std::sync::atomic::Ordering::SeqCst);
    // 抓同步钥匙、补 SSH、加载 agent 都可能在冷磁盘上读很久。
    // 解锁命令先返回，界面才能从解锁页切走；这些慢活不要占着调用线程。
    let app_for_thread = app.clone();
    let spawned = std::thread::Builder::new()
        .name("gam-after-unlock".into())
        .spawn(move || {
            crate::sync::scheduler::on_vault_unlocked(app_for_thread.clone());
            if !start_bootstrap {
                return;
            }
            let app = app_for_thread;
            let state = app.state::<AppState>();
            if let Some(p) = state
                .config
                .lock()
                .ok()
                .and_then(|c| c.workspace_path.clone())
            {
                let _ = crate::sys::adopt_ssh_config(std::path::Path::new(&p));
            }
            let vault_clone = match state.vault.lock() {
                Ok(g) => g.as_ref().filter(|v| v.is_unlocked()).cloned(),
                Err(_) => {
                    state
                        .bootstrap_busy
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                    return;
                }
            };
            if let Some(v) = vault_clone {
                let _ = crate::commands::write::reconcile_ssh_hosts(&v);
            }
            load_agent_best_effort(&state);
            state
                .bootstrap_busy
                .store(false, std::sync::atomic::Ordering::SeqCst);
            let still_unlocked = state
                .vault
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|v| v.is_unlocked()))
                .unwrap_or(false);
            if still_unlocked {
                crate::update::scheduler::kick_after_unlock(app.clone());
            }
        });
    if spawned.is_err() {
        if start_bootstrap {
            state
                .bootstrap_busy
                .store(false, std::sync::atomic::Ordering::SeqCst);
        }
        crate::sync::scheduler::on_vault_unlocked(app);
    }
}

#[tauri::command]
pub fn set_launch_at_login(state: State<AppState>, enabled: bool) -> Result<()> {
    autostart::set_enabled(enabled)?;
    let mut cfg = recover_lock(&state.config);
    cfg.launch_at_login = enabled;
    cfg.save()
}

#[tauri::command]
pub fn set_mobile_background_run(
    app: AppHandle,
    state: State<AppState>,
    enabled: bool,
) -> Result<()> {
    {
        let mut cfg = recover_lock(&state.config);
        cfg.mobile_background_run = enabled;
        cfg.save()?;
    }
    crate::sync::scheduler::refresh_background_sync(&app);
    Ok(())
}

#[tauri::command]
pub fn set_grace_days(state: State<AppState>, days: u32) -> Result<()> {
    let days = session::clamp_days(days);
    {
        let mut cfg = recover_lock(&state.config);
        cfg.grace_days = days;
        cfg.save()?;
    }
    if days == 0 {
        session::clear();
    } else {
        grant_grace_if_configured(&state);
    }
    Ok(())
}

/// 前端节流上报的用户活动心跳，喂给空闲自动锁定判定。
#[tauri::command]
pub fn report_activity(state: State<AppState>) {
    crate::autolock::touch(&state);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoLockSettings {
    pub auto_lock_minutes: u32,
    pub lock_on_sleep: bool,
    /// 本平台能否判定锁屏。false 时只有休眠能触发，界面需如实说明。
    pub screen_lock_detectable: bool,
}

#[tauri::command]
pub fn get_auto_lock_settings(state: State<AppState>) -> AutoLockSettings {
    let cfg = recover_lock(&state.config);
    AutoLockSettings {
        auto_lock_minutes: cfg.auto_lock_minutes,
        lock_on_sleep: cfg.lock_on_sleep,
        screen_lock_detectable: crate::autolock::workstation_locked().is_some(),
    }
}

#[tauri::command]
pub fn set_auto_lock_minutes(state: State<AppState>, minutes: u32) -> Result<u32> {
    let minutes = crate::app_config::clamp_auto_lock_minutes(minutes);
    let mut cfg = recover_lock(&state.config);
    cfg.auto_lock_minutes = minutes;
    cfg.save()?;
    Ok(minutes)
}

#[tauri::command]
pub fn set_lock_on_sleep(state: State<AppState>, enabled: bool) -> Result<()> {
    let mut cfg = recover_lock(&state.config);
    cfg.lock_on_sleep = enabled;
    cfg.save()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryResetReport {
    pub steps: Vec<String>,
}

fn wipe_workspace_files(root: &std::path::Path) -> Result<Vec<String>> {
    let mut steps = Vec::new();
    for name in [
        "data",
        "keys",
        "backups",
        "sync",
        "ssh-keys",
        "ssh",
        "blobs",
        "icons",
        ".store-transaction",
        "audit.log",
        "vault.json.prev",
        "vault.json",
    ] {
        let path = root.join(name);
        if path.is_dir() {
            std::fs::remove_dir_all(&path)?;
            steps.push(format!("已删除目录 {}", path.display()));
        } else if path.is_file() {
            std::fs::remove_file(&path)?;
            steps.push(format!("已删除 {}", path.display()));
        }
    }
    for item in std::fs::read_dir(root)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name
            .strip_prefix(".store-done-")
            .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok())
            && item.file_type()?.is_dir()
        {
            std::fs::remove_dir_all(item.path())?;
            steps.push(format!("已删除已完成事务目录 {name}"));
        }
    }
    Ok(steps)
}

/// 一键清空本机程序状态，回到未初始化。需二次确认：`confirmed=true` 且短语为「清空」。
#[tauri::command(async)]
pub fn factory_reset(
    state: State<'_, AppState>,
    confirmed: bool,
    confirm_phrase: String,
    access_password: Option<String>,
    recovery_key: Option<String>,
) -> Result<FactoryResetReport> {
    if !confirmed {
        return Err(AppError::Invalid("请先确认要清空还原本程序".into()));
    }
    if confirm_phrase.trim() != "清空" {
        return Err(AppError::Invalid(
            "请输入「清空」以确认不可恢复的还原".into(),
        ));
    }
    if state
        .reset_busy
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return Err(AppError::Busy);
    }
    struct ResetGuard<'a>(&'a std::sync::atomic::AtomicBool);
    impl Drop for ResetGuard<'_> {
        fn drop(&mut self) {
            self.0.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _reset_guard = ResetGuard(&state.reset_busy);
    {
        let _current = recover_lock(&state.vault);
        state
            .session_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    let access_password = access_password.map(zeroize::Zeroizing::new);
    let recovery_key = recovery_key.map(zeroize::Zeroizing::new);
    let workspace = recover_lock(&state.config).workspace_path.clone();
    let (authorized_workspace, managed_public_keys) = if let Some(path) = workspace
        .as_ref()
        .filter(|p| Vault::exists(&PathBuf::from(p)))
    {
        let mut checked = Vault::load(&PathBuf::from(path))?;
        if let Some(password) = access_password.as_ref().filter(|p| !p.is_empty()) {
            checked.unlock_with_password(password)?;
        } else if let Some(recovery) = recovery_key.as_ref().filter(|p| !p.is_empty()) {
            checked.unlock_with_recovery(recovery)?;
        } else {
            return Err(AppError::NeedReauth);
        }
        let public_keys = crate::store::load_data_uncached(&checked)
            .map(|data| {
                data.keys
                    .into_iter()
                    .map(|key| key.public_openssh)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        checked.lock();
        (Some(path.clone()), public_keys)
    } else {
        (None, Vec::new())
    };
    // Stop new secret operations before removing their workspace, not only at
    // the end; in-flight work observes the session change and fails closed.
    lock_in_memory(&state);
    let mut steps = Vec::new();

    let agent_snapshot = state.agent_env.lock().ok().map(|g| g.clone());
    if let Some(env) = agent_snapshot {
        if crate::agent::is_ready(&env) {
            for public_key in &managed_public_keys {
                let _ = crate::agent::unload_public(&env, public_key);
            }
            steps.push("已尝试卸载本工作空间管理的 SSH 密钥，保留其他程序的密钥".into());
        }
    }
    *recover_lock(&state.agent_env) = crate::agent::AgentEnv::default();

    match crate::agent::unify::revert() {
        Ok(more) => steps.extend(more),
        Err(e) => steps.push(format!("还原用户环境时部分失败：{e}")),
    }
    match crate::sys::revert_home_ssh_bridge() {
        Ok(more) => steps.extend(more),
        Err(e) => steps.push(format!("还原 ~/.ssh 时部分失败：{e}")),
    }
    for name in [
        crate::identity::AGENT_PID,
        crate::identity::LEGACY_AGENT_PID,
    ] {
        let pid = crate::sys::ssh_dir().join("agent").join(name);
        if pid.is_file() {
            let _ = std::fs::remove_file(&pid);
            steps.push("已删除本机 Git agent pid 记录".into());
        }
    }

    if let Some(path) = authorized_workspace {
        let root = PathBuf::from(path);
        steps.extend(crate::store::with_exclusive_workspace(&root, || {
            wipe_workspace_files(&root)
        })?);
    }

    session::clear();
    crate::biometric::factory_reset_cleanup();
    let _ = autostart::set_enabled(false);
    steps.push("已关闭开机自启动并清除免验证会话与指纹凭据".into());

    {
        let mut current = recover_lock(&state.vault);
        state
            .session_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *current = None;
    }
    crate::sync::scheduler::clear_sync_key(&state);
    {
        let mut cfg = crate::app_config::AppConfig::default();
        cfg.ensure_machine_id();
        cfg.save()?;
        *recover_lock(&state.config) = cfg;
    }
    recover_lock(&state.unlock_guard).reset();
    state
        .writes_locked
        .store(false, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut note) = state.startup_note.lock() {
        *note = None;
    }
    steps.push("已重置本机应用配置，程序回到未初始化状态".into());

    Ok(FactoryResetReport { steps })
}

#[cfg(test)]
mod tests {
    #[test]
    fn new_password_policy_does_not_normalize_or_accept_common_passwords() {
        assert!(super::validate_new_access_password("12345678").is_err());
        assert!(super::validate_new_access_password("password").is_err());
        assert!(super::validate_new_access_password("        ").is_err());
        assert!(super::validate_new_access_password(" maple river 47 ").is_ok());
    }

    #[test]
    fn workspace_wipe_has_an_exact_owner_boundary() {
        let root = std::env::temp_dir().join(format!("gam-wipe-{}", uuid::Uuid::new_v4()));
        for dir in [
            "blobs",
            "icons",
            ".store-transaction",
            "my-documents",
            ".store-done-not-a-uuid",
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join("sample"), b"synthetic").unwrap();
        }
        let done = format!(".store-done-{}", uuid::Uuid::new_v4());
        std::fs::create_dir(root.join(&done)).unwrap();
        std::fs::write(root.join("vault.json"), b"synthetic").unwrap();
        std::fs::write(root.join("vault.json.prev"), b"synthetic").unwrap();
        super::wipe_workspace_files(&root).unwrap();
        assert!(!root.join("blobs").exists());
        assert!(!root.join("icons").exists());
        assert!(!root.join("vault.json.prev").exists());
        assert!(!root.join(done).exists());
        assert!(root.join("my-documents/sample").is_file());
        assert!(root.join(".store-done-not-a-uuid/sample").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn vault_status_leaves_the_window_thread() {
        let src = include_str!("vault.rs");
        let idx = src
            .find("pub fn vault_status")
            .expect("vault_status 应仍是同步函数，由 command(async) 挪出窗口线程");
        let attr_at = src[..idx]
            .rfind("#[tauri::command")
            .expect("vault_status 缺少 command 属性");
        let attr = src[attr_at..idx].lines().next().unwrap();
        assert!(
            attr.contains("async"),
            "vault_status 必须是 async 命令，否则锁定后的状态刷新会堵在窗口线程上：{attr}"
        );
    }
}
