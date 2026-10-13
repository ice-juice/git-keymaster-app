//! 进程级云同步。
//!
//! 真·首次（配置里 `initial_cloud_sync_done == false`）解锁后后台强制拉一次，不锁界面。
//! 之后按持久化的真实时钟到期，先拉后推。锁定、托盘、锁屏都不停这条循环。
//! 界面锁定会清掉 Vault 里的主密钥；这里另留一份进程级副本，后台仍能同步。

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::sync::engine::{self, SyncResult};
use crate::sync::s3::{S3Client, S3Config};
use crate::vault::crypto::MasterKey;
use crate::vault::Vault;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const MIN_ATTEMPT_GAP: Duration = Duration::from_secs(20);

/// `auto_sync_busy` 的复位器。正常返回、错误、panic 都会在 Drop 里清掉忙标志。
struct BusyGuard<'a> {
    flag: &'a AtomicBool,
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

pub fn start(app: AppHandle) {
    // 不在这里写 last_periodic_sync：启动去重会把「刚写入的时间戳」当成刚同步过。
    // 时间戳只在真正尝试之后更新。tick 自己 panic 也不能把这条线程带走。
    std::thread::Builder::new()
        .name("gam-autosync".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(20));
            let _ = catch_unwind(AssertUnwindSafe(|| tick(&app)));
        })
        .ok();
}

/// 解锁后记下主密钥。只有「云已可用且首启标记还没成功过、本进程也还没试过」才后台强制一次。
pub fn on_vault_unlocked(app: AppHandle) {
    {
        let state = app.state::<AppState>();
        capture_sync_key_from_state(state.inner());
    }
    refresh_background_sync(&app);
    let state = app.state::<AppState>();
    // 云还没配好时不要吃掉首启机会，用户稍后保存配置仍能强制一次。
    if !should_force_startup_sync(state.inner()) {
        return;
    }
    if state.startup_sync_done.swap(true, Ordering::SeqCst) {
        return;
    }
    let app_for_thread = app.clone();
    let spawned = std::thread::Builder::new()
        .name("gam-startup-sync".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            let _ = run(&app_for_thread, "startup");
        });
    if spawned.is_err() {
        state.startup_sync_done.store(false, Ordering::SeqCst);
    }
}

/// 按当前配置决定要不要让 Android 在后台用前台服务保活。非 Android 是空操作。
/// 不在每次 tick 里调用，避免来回启停服务。
pub fn refresh_background_sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let enabled = background_sync_enabled(state.inner());
    crate::mobile::bgsync::set_enabled(app, enabled);
}

fn background_sync_enabled(state: &AppState) -> bool {
    let (minutes, mobile, sync_config, workspace) = {
        let Ok(cfg) = state.config.lock() else {
            return false;
        };
        (
            cfg.auto_sync_minutes,
            cfg.mobile_background_run,
            cfg.cloud_sync.clone(),
            cfg.workspace_path.clone(),
        )
    };
    if minutes == 0 || !mobile {
        return false;
    }
    let has_key = state
        .sync_key
        .lock()
        .ok()
        .is_some_and(|slot| slot.is_some());
    if !has_key {
        return false;
    }
    let Some(sync_config) = sync_config else {
        return false;
    };
    cloud_secret_usable(state, &sync_config, &workspace)
}

fn should_force_startup_sync(state: &AppState) -> bool {
    let (sync_config, workspace) = {
        let Ok(cfg) = state.config.lock() else {
            return false;
        };
        if cfg.initial_cloud_sync_done {
            return false;
        }
        let Some(sync_config) = cfg.cloud_sync.clone() else {
            return false;
        };
        (sync_config, cfg.workspace_path.clone())
    };
    cloud_secret_usable(state, &sync_config, &workspace)
}

fn cloud_secret_usable(state: &AppState, sync_config: &S3Config, workspace: &Option<String>) -> bool {
    if sync_config.has_usable_secret() {
        return true;
    }
    let Ok(Some(vault)) = vault_for_sync(state, workspace) else {
        return false;
    };
    let Ok(Some(sk)) = crate::store::cloud_sync_secret(&vault) else {
        return false;
    };
    let mut filled = sync_config.clone();
    filled.secret_access_key = sk;
    filled.has_usable_secret()
}

/// 保存云存储配置后立刻先拉后推，避免只写了配置、数据却从未上传。
pub fn kick_full_sync(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        let state = app.state::<AppState>();
        if state.auto_sync_busy.load(Ordering::SeqCst) {
            state.pending_full_sync.store(true, Ordering::SeqCst);
            return;
        }
        match run(&app, "config") {
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => {
                let configured = state
                    .config
                    .lock()
                    .ok()
                    .and_then(|c| c.cloud_sync.clone())
                    .is_some();
                if configured {
                    state.pending_full_sync.store(true, Ordering::SeqCst);
                }
            }
        }
    });
}

pub fn capture_sync_key_from_state(state: &AppState) {
    let bytes = {
        let Ok(guard) = state.vault.lock() else {
            return;
        };
        let Some(v) = guard.as_ref().filter(|v| v.is_unlocked()) else {
            return;
        };
        v.master_key_bytes().ok()
    };
    if let Some(bytes) = bytes {
        if let Ok(mut slot) = state.sync_key.lock() {
            *slot = Some(MasterKey::from_bytes(bytes));
        }
    }
}

pub fn clear_sync_key(state: &AppState) {
    if let Ok(mut slot) = state.sync_key.lock() {
        *slot = None;
    }
}

/// 间隔是否到点。`minutes == 0` 表示用户关了定时同步。
#[cfg(test)]
pub(crate) fn interval_elapsed(elapsed: Duration, minutes: u32) -> bool {
    if minutes == 0 {
        return false;
    }
    elapsed >= Duration::from_secs(u64::from(minutes) * 60)
}

/// 周期是否到期。空时间戳或解析失败且 minutes > 0 视为到期；minutes == 0 永远不到期。
/// 用调用方传入的 `now`，测试不必等真实时钟。
pub(crate) fn periodic_due(
    last_auto_sync_at: Option<&str>,
    minutes: u32,
    now: time::OffsetDateTime,
) -> bool {
    if minutes == 0 {
        return false;
    }
    let Some(raw) = last_auto_sync_at.map(str::trim).filter(|s| !s.is_empty()) else {
        return true;
    };
    let Ok(parsed) =
        time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)
    else {
        return true;
    };
    now - parsed >= time::Duration::seconds(i64::from(minutes) * 60)
}

/// 本地编辑保存后立刻合并并推送，降低多端改同一条记录的冲突窗口。
pub fn kick_publish(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        let state = app.state::<AppState>();
        if state.auto_sync_busy.load(Ordering::SeqCst) {
            state.pending_edit_publish.store(true, Ordering::SeqCst);
            return;
        }
        match run(&app, "edit") {
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => {
                let configured = state
                    .config
                    .lock()
                    .ok()
                    .and_then(|c| c.cloud_sync.clone())
                    .is_some();
                if configured {
                    state.pending_edit_publish.store(true, Ordering::SeqCst);
                }
            }
        }
    });
}

fn tick(app: &AppHandle) {
    let state = app.state::<AppState>();
    // 锁定/托盘只是界面状态，这条循环绑在进程上，到点照样跑。
    if state.pending_full_sync.swap(false, Ordering::SeqCst) {
        if state.auto_sync_busy.load(Ordering::SeqCst) {
            state.pending_full_sync.store(true, Ordering::SeqCst);
            return;
        }
        let _ = run(app, "config");
        return;
    }
    if state.pending_edit_publish.swap(false, Ordering::SeqCst) {
        let _ = run(app, "edit");
        return;
    }
    let (minutes, last_at) = match state.config.lock() {
        Ok(cfg) => (cfg.auto_sync_minutes, cfg.last_auto_sync_at.clone()),
        Err(_) => return,
    };
    let now = time::OffsetDateTime::now_utc();
    if !periodic_due(last_at.as_deref(), minutes, now) {
        return;
    }
    // 进程内 Instant 只挡 20 秒内的空打，休眠时它不前进，到期与否看上面的真实时钟。
    if attempt_too_soon(&state) {
        return;
    }
    let _ = run(app, "periodic");
}

fn attempt_too_soon(state: &AppState) -> bool {
    match state.last_periodic_sync.lock() {
        Ok(last) => last.is_some_and(|t| t.elapsed() < MIN_ATTEMPT_GAP),
        Err(_) => true,
    }
}

pub fn run(app: &AppHandle, trigger: &str) -> Result<Option<SyncResult>> {
    let state = app.state::<AppState>();
    if state.auto_sync_busy.swap(true, Ordering::SeqCst) {
        return Ok(None);
    }
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let _guard = BusyGuard {
            flag: &state.auto_sync_busy,
        };
        run_locked(app, &state, trigger)
    }));
    let outcome = match outcome {
        Ok(result) => result,
        Err(_) => {
            log::error!("云同步意外中断（{trigger}），忙标志已复位");
            Err(AppError::Other("云同步意外中断，已恢复，可稍后重试".into()))
        }
    };

    let track_attempt = matches!(trigger, "periodic" | "startup" | "config");
    match &outcome {
        Ok(Some(res)) => {
            // 记下这次真正跑完的时间。只拉取、云端清单没改写时，结果里的旧快照时间不能当成最近同步。
            let finished_at = engine_now();
            persist_sync_note(&state, &finished_at, &res.message);
            if trigger == "startup" {
                mark_initial_cloud_sync_done(&state);
                refresh_background_sync(app);
            }
            let _ = app.emit(
                "cloud-auto-sync",
                serde_json::json!({
                    "ok": true,
                    "trigger": trigger,
                    "message": res.message,
                    "syncedAt": finished_at,
                }),
            );
            let _ = app.emit("vault-data-changed", ());
        }
        Ok(None) => {
            // 云未配置或没钥匙：只刷新内存去重，不要写成同步成功，也不要置首启标记。
            if track_attempt {
                touch_attempt(&state);
            }
        }
        Err(e) => {
            touch_attempt(&state);
            persist_sync_note(&state, &engine_now(), &e.to_string());
            let _ = app.emit(
                "cloud-auto-sync",
                serde_json::json!({
                    "ok": false,
                    "trigger": trigger,
                    "message": e.to_string(),
                }),
            );
        }
    }
    outcome
}

fn touch_attempt(state: &AppState) {
    if let Ok(mut last) = state.last_periodic_sync.lock() {
        *last = Some(Instant::now());
    }
}

fn mark_initial_cloud_sync_done(state: &AppState) {
    if let Ok(mut cfg) = state.config.lock() {
        if cfg.initial_cloud_sync_done {
            return;
        }
        cfg.initial_cloud_sync_done = true;
        let _ = cfg.save();
    }
}

fn run_locked(app: &AppHandle, state: &AppState, trigger: &str) -> Result<Option<SyncResult>> {
    let (sync_config, app_cfg) = {
        let cfg = state.config.lock().map_err(|_| AppError::Other("配置锁损坏".into()))?;
        (cfg.cloud_sync.clone(), cfg.clone())
    };
    let Some(mut sync_config) = sync_config else {
        return Ok(None);
    };

    let Some(vault) = vault_for_sync(state, &app_cfg.workspace_path)? else {
        return Ok(None);
    };
    // 界面锁定会把配置里的 Secret Key 清掉，钥匙仍在保险库信封里。
    if !sync_config.has_usable_secret() {
        if let Some(sk) = crate::store::cloud_sync_secret(&vault)? {
            sync_config.secret_access_key = sk;
        }
    }
    if !sync_config.has_usable_secret() {
        return Ok(None);
    }

    let client = S3Client::from_app(sync_config, &app_cfg)?;
    let unmetered = state.network_unmetered.load(Ordering::Relaxed);
    let blob_scope = if trigger == "startup" {
        engine::BlobSyncScope::NoteBodiesOnly
    } else {
        engine::resolve_blob_scope(
            trigger,
            app_cfg.sync_attachments_wifi_only,
            app_cfg.sync_attachments_manual_only,
            unmetered,
        )
    };
    let progress = |p: engine::BlobSyncProgress| {
        let _ = app.emit("blob-sync-progress", &p);
    };
    let result = if trigger == "edit" {
        engine::publish_after_edit_with(&vault, &client, blob_scope, Some(&progress))?
    } else {
        // startup / periodic / config / manual：都是先拉再推，不因「云端已有对象」跳过本地变更。
        engine::pull_then_maybe_push_with(&vault, &client, blob_scope, Some(&progress))?
    };
    crate::commands::sync::remember_view_after_sync(&vault, &client);
    if let Ok(mut last) = state.last_periodic_sync.lock() {
        *last = Some(Instant::now());
    }
    Ok(Some(result))
}

/// 界面已解锁就用内存里的 Vault；锁定后用进程级主密钥打开一份副本，不把界面解锁。
fn vault_for_sync(state: &AppState, workspace_path: &Option<String>) -> Result<Option<Vault>> {
    if let Ok(guard) = state.vault.lock() {
        if let Some(v) = guard.as_ref().filter(|v| v.is_unlocked()) {
            return Ok(Some(v.clone()));
        }
    }
    let Some(path) = workspace_path.as_ref().filter(|p| !p.trim().is_empty()) else {
        return Ok(None);
    };
    let Some(mk) = state.sync_key.lock().ok().and_then(|g| g.clone()) else {
        return Ok(None);
    };
    let mut vault = Vault::load(Path::new(path))?;
    vault.unlock_with_master_key(mk)?;
    Ok(Some(vault))
}

fn persist_sync_note(state: &AppState, at: &str, message: &str) {
    if let Ok(mut cfg) = state.config.lock() {
        cfg.last_auto_sync_at = Some(at.to_string());
        cfg.last_auto_sync_message = Some(message.to_string());
        let _ = cfg.save();
    }
}

fn engine_now() -> String {
    let now = time::OffsetDateTime::now_utc();
    now.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown".into())
}

#[cfg(test)]
mod tests {
    use super::periodic_due;
    use super::BusyGuard;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    #[test]
    fn interval_respects_off_switch_and_elapsed() {
        assert!(!super::interval_elapsed(Duration::from_secs(3600), 0));
        assert!(!super::interval_elapsed(Duration::from_secs(60), 30));
        assert!(super::interval_elapsed(Duration::from_secs(30 * 60), 30));
        assert!(super::interval_elapsed(Duration::from_secs(31 * 60), 30));
    }

    #[test]
    fn periodic_due_off_when_minutes_zero() {
        let now = time::OffsetDateTime::now_utc();
        assert!(!periodic_due(None, 0, now));
        assert!(!periodic_due(Some(""), 0, now));
        assert!(!periodic_due(Some("not-a-date"), 0, now));
    }

    #[test]
    fn periodic_due_when_missing_or_unparseable() {
        let now = time::OffsetDateTime::now_utc();
        assert!(periodic_due(None, 30, now));
        assert!(periodic_due(Some(""), 30, now));
        assert!(periodic_due(Some("   "), 30, now));
        assert!(periodic_due(Some("yesterday"), 30, now));
    }

    #[test]
    fn periodic_due_respects_elapsed_minutes() {
        let now = time::OffsetDateTime::now_utc();
        let fmt = &time::format_description::well_known::Rfc3339;
        let recent = (now - time::Duration::minutes(10)).format(fmt).unwrap();
        let exact = (now - time::Duration::minutes(30)).format(fmt).unwrap();
        let old = (now - time::Duration::minutes(31)).format(fmt).unwrap();
        assert!(!periodic_due(Some(recent.as_str()), 30, now));
        assert!(periodic_due(Some(exact.as_str()), 30, now));
        assert!(periodic_due(Some(old.as_str()), 30, now));
    }

    #[test]
    fn busy_guard_clears_flag_on_drop_and_unwind() {
        let flag = AtomicBool::new(true);
        {
            let _guard = BusyGuard { flag: &flag };
            assert!(flag.load(Ordering::SeqCst));
        }
        assert!(!flag.load(Ordering::SeqCst));

        flag.store(true, Ordering::SeqCst);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = BusyGuard { flag: &flag };
            panic!("sync panicked");
        }));
        assert!(caught.is_err());
        assert!(
            !flag.load(Ordering::SeqCst),
            "panic 被接住后忙标志也必须落下"
        );
    }
}
