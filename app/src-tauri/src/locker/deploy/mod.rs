//! 寄存柜分享 Worker 一键部署：进度事件、API Token / wrangler 两条路径。

pub mod addr;
pub mod assets;
mod cf;
pub mod probe;
mod sql;
mod store;
mod wrangler;

use crate::app_config::NetworkProxy;
use crate::error::{AppError, Result};
use crate::store as vault_store;
use crate::vault::Vault;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub use addr::{decide_base_url, normalize_worker_url, AddressDecision};
pub use probe::{probe_worker, LockerProbeResult};
pub use store::{has_token, token_last4, LockerDeployRecord};

pub const PROGRESS_EVENT: &str = "locker-deploy-progress";

const STEP_NAMES: [&str; 12] = [
    "检查云同步存储桶",
    "取得部署权限",
    "确认 Cloudflare 账号",
    "准备 D1",
    "建立寄存表",
    "绑定同一只 R2 桶",
    "写入共享密钥",
    "上传分享服务",
    "挂上每分钟清理",
    "开通 workers.dev 地址",
    "写入地址",
    "连通性测试",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeployMethod {
    ApiToken,
    Wrangler,
}

impl DeployMethod {
    pub fn parse(s: &str) -> Result<Self> {
        match s.trim() {
            "apiToken" | "api_token" => Ok(Self::ApiToken),
            "wrangler" => Ok(Self::Wrangler),
            _ => Err(AppError::Invalid("未知的部署方式".into())),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ApiToken => "apiToken",
            Self::Wrangler => "wrangler",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerCfAccount {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerDeployStep {
    pub index: u8,
    pub name: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerDeployProgress {
    pub running: bool,
    pub method: String,
    pub current_step: u8,
    pub total_steps: u8,
    pub headline: String,
    pub steps: Vec<LockerDeployStep>,
    pub accounts: Vec<LockerCfAccount>,
    pub waiting_for_account: bool,
    pub cancelable: bool,
    pub workers_dev_url: String,
    pub current_url: String,
    pub kept_custom_address: bool,
    pub has_secret: bool,
    pub error: Option<String>,
    pub finished: bool,
    pub note: Option<String>,
}

impl LockerDeployProgress {
    pub fn idle() -> Self {
        Self {
            running: false,
            method: String::new(),
            current_step: 1,
            total_steps: 12,
            headline: String::new(),
            steps: (1..=12).map(pending_step).collect(),
            accounts: Vec::new(),
            waiting_for_account: false,
            cancelable: false,
            workers_dev_url: String::new(),
            current_url: String::new(),
            kept_custom_address: false,
            has_secret: false,
            error: None,
            finished: false,
            note: None,
        }
    }

    fn fresh(method: &str) -> Self {
        Self {
            running: true,
            method: method.to_string(),
            current_step: 1,
            total_steps: 12,
            headline: headline(1),
            steps: (1..=12).map(pending_step).collect(),
            accounts: Vec::new(),
            waiting_for_account: false,
            cancelable: true,
            workers_dev_url: String::new(),
            current_url: String::new(),
            kept_custom_address: false,
            has_secret: false,
            error: None,
            finished: false,
            note: None,
        }
    }

    fn begin(&mut self, step: u8, detail: &str) {
        self.current_step = step;
        self.headline = headline(step);
        self.cancelable = step <= 3;
        self.waiting_for_account = false;
        if let Some(s) = self.steps.iter_mut().find(|s| s.index == step) {
            s.status = "running".into();
            s.detail = detail.to_string();
        }
    }

    fn done(&mut self, step: u8, detail: impl Into<String>) {
        if let Some(s) = self.steps.iter_mut().find(|s| s.index == step) {
            s.status = "done".into();
            s.detail = detail.into();
        }
    }

    fn fail(&mut self, step: u8, err: impl Into<String>) {
        let err = err.into();
        if let Some(s) = self.steps.iter_mut().find(|s| s.index == step) {
            s.status = "failed".into();
            s.detail = err.clone();
        }
        self.current_step = step;
        self.headline = headline(step);
        self.error = Some(err);
        self.running = false;
        self.cancelable = false;
        self.waiting_for_account = false;
        self.finished = false;
    }
}

fn pending_step(index: u8) -> LockerDeployStep {
    LockerDeployStep {
        index,
        name: STEP_NAMES[(index as usize).saturating_sub(1).min(11)].into(),
        status: "pending".into(),
        detail: String::new(),
    }
}

fn headline(step: u8) -> String {
    let name = STEP_NAMES[(step as usize).saturating_sub(1).min(11)];
    format!("正在进行 {step}/12 · {name}")
}

struct Hub {
    running: AtomicBool,
    cancel: AtomicBool,
    account_tx: Mutex<Option<mpsc::Sender<String>>>,
    progress: Mutex<LockerDeployProgress>,
}

fn hub() -> &'static Hub {
    static H: OnceLock<Hub> = OnceLock::new();
    H.get_or_init(|| Hub {
        running: AtomicBool::new(false),
        cancel: AtomicBool::new(false),
        account_tx: Mutex::new(None),
        progress: Mutex::new(LockerDeployProgress::idle()),
    })
}

pub fn current_progress() -> LockerDeployProgress {
    hub().progress.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn status_from_record(vault: &Vault) -> LockerDeployProgress {
    let mem = current_progress();
    if mem.running || mem.finished || mem.error.is_some() {
        return mem;
    }
    store::load(vault)
        .ok()
        .and_then(|r| r.progress)
        .unwrap_or_else(LockerDeployProgress::idle)
}

pub fn load_record(vault: &Vault) -> LockerDeployRecord {
    store::load(vault).unwrap_or_default()
}

pub fn save_api_token(vault: &Vault, token: &str) -> Result<LockerDeployRecord> {
    store::upsert(vault, |rec| {
        rec.api_token = Some(token.trim().to_string());
        rec.last_method = Some(DeployMethod::ApiToken.as_str().into());
    })
}

pub fn clear_api_token(vault: &Vault) -> Result<LockerDeployRecord> {
    store::upsert(vault, |rec| {
        rec.api_token = None;
    })
}

pub fn is_running() -> bool {
    hub().running.load(Ordering::SeqCst)
}

struct DeployCtx {
    app: AppHandle,
    vault: Vault,
    method: DeployMethod,
    token: Option<String>,
    proxy: Option<NetworkProxy>,
    bucket: String,
    existing_secret: Option<String>,
    current_url: String,
    last_workers_dev: String,
}

pub fn start_deploy(
    app: AppHandle,
    vault: Vault,
    method: DeployMethod,
    token: Option<String>,
    proxy: Option<NetworkProxy>,
    bucket: String,
    access_ok: bool,
    existing_secret: Option<String>,
    current_url: String,
    last_workers_dev: String,
) -> Result<LockerDeployProgress> {
    if is_running() {
        return Err(AppError::Invalid("分享服务部署正在进行".into()));
    }
    if method == DeployMethod::Wrangler && cfg!(any(target_os = "android", target_os = "ios")) {
        return Err(AppError::Unsupported("wrangler login 部署"));
    }

    let token = match method {
        DeployMethod::ApiToken => {
            let raw = token
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .or_else(|| store::load(&vault).ok().and_then(|r| r.api_token));
            let raw = raw.ok_or_else(|| AppError::Invalid("请粘贴 Cloudflare API Token".into()))?;
            let client = cf::CfClient::new(&raw, proxy.as_ref())?;
            client.list_accounts()?;
            save_api_token(&vault, &raw)?;
            Some(raw)
        }
        DeployMethod::Wrangler => None,
    };

    let _ = store::upsert(&vault, |rec| {
        rec.last_method = Some(method.as_str().into());
    });

    let progress = LockerDeployProgress::fresh(method.as_str());
    {
        let mut g = hub().progress.lock().unwrap_or_else(|e| e.into_inner());
        *g = progress.clone();
    }
    hub().cancel.store(false, Ordering::SeqCst);
    hub().running.store(true, Ordering::SeqCst);
    *hub().account_tx.lock().unwrap_or_else(|e| e.into_inner()) = None;

    let ctx = DeployCtx {
        app,
        vault,
        method,
        token,
        proxy,
        bucket: if access_ok { bucket } else { String::new() },
        existing_secret,
        current_url,
        last_workers_dev,
    };
    if let Err(e) = std::thread::Builder::new()
        .name("locker-deploy".into())
        .spawn(move || run_deploy(ctx))
    {
        hub().running.store(false, Ordering::SeqCst);
        return Err(AppError::Io(format!("无法启动部署：{e}")));
    }
    Ok(progress)
}

pub fn select_account(account_id: String) -> Result<LockerDeployProgress> {
    let id = account_id.trim().to_string();
    if id.is_empty() {
        return Err(AppError::Invalid("请选择 Cloudflare 账号".into()));
    }
    let guard = hub().account_tx.lock().unwrap_or_else(|e| e.into_inner());
    let Some(tx) = guard.as_ref() else {
        return Err(AppError::Invalid("当前没有在等待选择账号".into()));
    };
    tx.send(id)
        .map_err(|_| AppError::Invalid("当前没有在等待选择账号".into()))?;
    Ok(current_progress())
}

pub fn cancel_deploy() -> Result<LockerDeployProgress> {
    let p = current_progress();
    if !p.cancelable || !p.running {
        return Ok(p);
    }
    hub().cancel.store(true, Ordering::SeqCst);
    wrangler::kill_login();
    Ok(current_progress())
}

fn emit(ctx: &DeployCtx, p: &LockerDeployProgress) {
    let _ = ctx.app.emit(PROGRESS_EVENT, p);
    *hub().progress.lock().unwrap_or_else(|e| e.into_inner()) = p.clone();
    let _ = store::upsert(&ctx.vault, |rec| {
        rec.progress = Some(p.clone());
        if !p.method.is_empty() {
            rec.last_method = Some(p.method.clone());
        }
    });
}

fn cancelled() -> AppError {
    AppError::Invalid("已取消".into())
}

fn stop_if_cancelled() -> Result<()> {
    if hub().cancel.load(Ordering::SeqCst) {
        Err(cancelled())
    } else {
        Ok(())
    }
}

fn finish_cancel(ctx: &DeployCtx, mut p: LockerDeployProgress) {
    wrangler::kill_login();
    p.running = false;
    p.cancelable = false;
    p.waiting_for_account = false;
    p.error = Some("已取消".into());
    if let Some(s) = p.steps.iter_mut().find(|s| s.status == "running" || s.status == "waiting") {
        s.status = "pending".into();
        s.detail.clear();
    }
    hub().running.store(false, Ordering::SeqCst);
    *hub().account_tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
    emit(ctx, &p);
}

fn finish_fail(ctx: &DeployCtx, p: &LockerDeployProgress) {
    hub().running.store(false, Ordering::SeqCst);
    *hub().account_tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
    emit(ctx, p);
}

fn generate_secret() -> String {
    let mut buf = [0u8; 32];
    crate::vault::crypto::fill_random(&mut buf);
    B64.encode(buf)
}

fn run_deploy(ctx: DeployCtx) {
    struct ClearRunning;
    impl Drop for ClearRunning {
        fn drop(&mut self) {
            hub().running.store(false, Ordering::SeqCst);
            *hub().account_tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
            wrangler::kill_login();
        }
    }
    let _clear = ClearRunning;

    let mut p = LockerDeployProgress::fresh(ctx.method.as_str());
    emit(&ctx, &p);

    p.begin(1, "正在读取云同步里已经填写的桶名");
    emit(&ctx, &p);
    if ctx.bucket.trim().is_empty() {
        p.fail(1, "请先到云同步填写存储桶和访问密钥");
        finish_fail(&ctx, &p);
        return;
    }
    let bucket = ctx.bucket.trim().to_string();
    p.done(1, format!("已确认桶 {bucket}"));
    emit(&ctx, &p);

    if let Err(e) = stop_if_cancelled() {
        finish_cancel(&ctx, p);
        let _ = e;
        return;
    }

    p.begin(
        2,
        match ctx.method {
            DeployMethod::ApiToken => "正在校验部署权限",
            DeployMethod::Wrangler => "请在打开的浏览器里登录 Cloudflare 并点允许",
        },
    );
    emit(&ctx, &p);

    let accounts = match list_accounts(&ctx) {
        Ok(a) => a,
        Err(e) => {
            if hub().cancel.load(Ordering::SeqCst) {
                finish_cancel(&ctx, p);
                return;
            }
            p.fail(2, e.to_string());
            finish_fail(&ctx, &p);
            return;
        }
    };
    p.done(2, format!("已取得 {} 个账号的部署权限", accounts.len()));
    emit(&ctx, &p);

    if let Err(_) = stop_if_cancelled() {
        finish_cancel(&ctx, p);
        return;
    }

    let account = match pick_account(&ctx, &mut p, accounts) {
        Ok(a) => a,
        Err(e) => {
            if hub().cancel.load(Ordering::SeqCst) || e.to_string().contains("取消") {
                finish_cancel(&ctx, p);
                return;
            }
            p.fail(3, e.to_string());
            finish_fail(&ctx, &p);
            return;
        }
    };
    p.waiting_for_account = false;
    p.done(3, format!("使用账号 {}", account.name));
    emit(&ctx, &p);

    let outcome = match ctx.method {
        DeployMethod::ApiToken => deploy_via_api(&ctx, &mut p, &account, &bucket),
        DeployMethod::Wrangler => deploy_via_wrangler(&ctx, &mut p, &account, &bucket),
    };
    match outcome {
        Ok((workers_dev, secret)) => finish_write_and_probe(&ctx, &mut p, workers_dev, secret),
        Err(e) => {
            if hub().cancel.load(Ordering::SeqCst) {
                finish_cancel(&ctx, p);
                return;
            }
            if p.error.is_none() {
                p.fail(p.current_step, e.to_string());
            }
            finish_fail(&ctx, &p);
        }
    }
}

fn list_accounts(ctx: &DeployCtx) -> Result<Vec<LockerCfAccount>> {
    match ctx.method {
        DeployMethod::ApiToken => {
            let token = ctx.token.as_deref().unwrap_or("");
            cf::CfClient::new(token, ctx.proxy.as_ref())?.list_accounts()
        }
        DeployMethod::Wrangler => {
            wrangler::check_node()?;
            wrangler::login_until_ready(&hub().cancel)
        }
    }
}

fn pick_account(
    ctx: &DeployCtx,
    p: &mut LockerDeployProgress,
    accounts: Vec<LockerCfAccount>,
) -> Result<LockerCfAccount> {
    if accounts.len() == 1 {
        return Ok(accounts.into_iter().next().unwrap());
    }
    let (tx, rx) = mpsc::channel();
    *hub().account_tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    p.accounts = accounts.clone();
    p.waiting_for_account = true;
    p.cancelable = true;
    p.begin(3, "多个账号，请选择要部署到的那一个");
    if let Some(s) = p.steps.iter_mut().find(|s| s.index == 3) {
        s.status = "waiting".into();
    }
    emit(ctx, p);
    loop {
        if hub().cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(id) => {
                *hub().account_tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
                return accounts
                    .into_iter()
                    .find(|a| a.id == id)
                    .ok_or_else(|| AppError::Invalid("所选账号无效".into()));
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return Err(cancelled()),
        }
    }
}

fn deploy_via_api(
    ctx: &DeployCtx,
    p: &mut LockerDeployProgress,
    account: &LockerCfAccount,
    bucket: &str,
) -> Result<(String, String)> {
    let token = ctx.token.as_deref().unwrap_or("");
    let cf = cf::CfClient::new(token, ctx.proxy.as_ref())?;

    p.begin(4, "正在查找或创建 D1 库 file-locker");
    emit(ctx, p);
    let db_id = cf.find_or_create_d1(&account.id, assets::D1_NAME)?;
    p.done(4, "已准备 D1 库 file-locker");
    emit(ctx, p);

    p.begin(5, "正在查看远程库是否已有 locker 表");
    emit(ctx, p);
    let names = cf.locker_table_names(&account.id, &db_id)?;
    if sql::should_apply_locker_migration(&names) {
        p.begin(5, "正在执行 0001_locker.sql");
        emit(ctx, p);
        cf.apply_locker_sql(&account.id, &db_id)?;
        p.done(5, "已建立寄存表");
    } else {
        p.done(5, "寄存表已存在，已跳过");
    }
    emit(ctx, p);

    p.begin(6, &format!("正在确认桶 {bucket} 属于该账号"));
    emit(ctx, p);
    if !cf.r2_bucket_exists(&account.id, bucket)? {
        p.fail(
            6,
            format!("这个 Cloudflare 账号里没有桶 {bucket}。Worker 必须和云同步使用同一账号下的同一只桶"),
        );
        return Err(AppError::Invalid(p.error.clone().unwrap_or_default()));
    }
    p.done(6, format!("将把桶 {bucket} 绑到 LOCKER_BUCKET"));
    emit(ctx, p);

    let secret = ctx
        .existing_secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(generate_secret);

    p.begin(7, "正在写入 LOCKER_HMAC_SECRET");
    emit(ctx, p);
    if !cf.script_exists(&account.id, assets::SCRIPT_NAME)? {
        cf.upload_script(&account.id, bucket, &db_id)?;
    }
    cf.put_secret(&account.id, &secret)?;
    p.done(7, "已写入共享密钥");
    emit(ctx, p);

    p.begin(8, "正在上传内嵌的分享服务脚本");
    emit(ctx, p);
    cf.upload_script(&account.id, bucket, &db_id)?;
    let _ = cf.put_secret(&account.id, &secret);
    p.done(8, "已上传 file-locker 并绑定 D1 / R2");
    emit(ctx, p);

    p.begin(9, "正在挂上每分钟清理");
    emit(ctx, p);
    cf.put_cron(&account.id)?;
    p.done(9, "已挂上 * * * * *");
    emit(ctx, p);

    p.begin(10, "正在开通 workers.dev 地址");
    emit(ctx, p);
    let url = cf.ensure_workers_dev(&account.id, &account.name)?;
    p.workers_dev_url = url.clone();
    p.done(10, url.clone());
    emit(ctx, p);
    Ok((url, secret))
}

fn deploy_via_wrangler(
    ctx: &DeployCtx,
    p: &mut LockerDeployProgress,
    _account: &LockerCfAccount,
    bucket: &str,
) -> Result<(String, String)> {
    p.begin(4, "正在查找或创建 D1 库 file-locker");
    emit(ctx, p);
    let db_id = wrangler::find_or_create_d1(&hub().cancel)?;
    let project = wrangler::write_temp_project(bucket, &db_id)?;
    p.done(4, "已准备 D1 库 file-locker");
    emit(ctx, p);

    p.begin(5, "正在查看远程库是否已有 locker 表");
    emit(ctx, p);
    let names = wrangler::locker_table_names(&project)?;
    if sql::should_apply_locker_migration(&names) {
        p.begin(5, "正在执行 0001_locker.sql");
        emit(ctx, p);
        wrangler::apply_locker_sql(&project)?;
        p.done(5, "已建立寄存表");
    } else {
        p.done(5, "寄存表已存在，已跳过");
    }
    emit(ctx, p);

    p.begin(6, &format!("正在确认桶 {bucket} 属于该账号"));
    emit(ctx, p);
    if !wrangler::r2_bucket_exists(bucket)? {
        p.fail(
            6,
            format!("这个 Cloudflare 账号里没有桶 {bucket}。Worker 必须和云同步使用同一账号下的同一只桶"),
        );
        return Err(AppError::Invalid(p.error.clone().unwrap_or_default()));
    }
    p.done(6, format!("将把桶 {bucket} 绑到 LOCKER_BUCKET"));
    emit(ctx, p);

    let secret = ctx
        .existing_secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(generate_secret);

    p.begin(7, "正在写入 LOCKER_HMAC_SECRET");
    emit(ctx, p);
    let url = wrangler::deploy(&project)?;
    wrangler::put_secret(&project, &secret)?;
    p.done(7, "已写入共享密钥");
    emit(ctx, p);

    p.begin(8, "正在确认分享服务脚本");
    emit(ctx, p);
    p.done(8, "已上传 file-locker 并绑定 D1 / R2");
    emit(ctx, p);

    p.begin(9, "正在确认每分钟清理");
    emit(ctx, p);
    p.done(9, "已挂上 * * * * *");
    emit(ctx, p);

    p.begin(10, "正在开通 workers.dev 地址");
    emit(ctx, p);
    p.workers_dev_url = url.clone();
    p.done(10, url.clone());
    emit(ctx, p);
    Ok((url, secret))
}

fn finish_write_and_probe(ctx: &DeployCtx, p: &mut LockerDeployProgress, workers_dev: String, secret: String) {
    p.begin(11, "正在按规则写入分享服务地址");
    emit(ctx, p);
    let decision = decide_base_url(&ctx.current_url, &ctx.last_workers_dev, &workers_dev);
    let (written, kept) = match &decision {
        AddressDecision::WriteNew(url) => (url.clone(), false),
        AddressDecision::KeepCustom { current, .. } => (current.clone(), true),
    };
    if let Err(e) = write_secrets(&ctx.vault, &written, &workers_dev, &secret) {
        p.fail(11, e.to_string());
        finish_fail(ctx, p);
        return;
    }
    p.workers_dev_url = workers_dev.clone();
    p.current_url = written.clone();
    p.kept_custom_address = kept;
    p.has_secret = true;
    if kept {
        p.done(11, "部署已更新，当前仍使用你填写的地址");
        p.note = Some("部署已更新，当前仍使用你填写的地址".into());
    } else {
        p.done(11, written.clone());
    }
    emit(ctx, p);
    let _ = ctx.app.emit("vault-data-changed", ());

    p.begin(12, "正在测试刚开通的 workers.dev 地址");
    emit(ctx, p);
    let probe = probe_with_retry(&workers_dev, ctx.proxy.as_ref(), 5);
    if !probe.ok {
        p.fail(
            12,
            probe
                .hint
                .or_else(|| probe.checks.iter().find(|c| !c.ok).map(|c| c.detail.clone()))
                .unwrap_or_else(|| "连通性测试未通过".into()),
        );
        finish_fail(ctx, p);
        return;
    }
    if kept && !written.eq_ignore_ascii_case(workers_dev.trim_end_matches('/')) {
        let custom = probe::probe_worker(&written, ctx.proxy.as_ref());
        if custom.as_ref().is_ok_and(|r| r.ok) {
            p.done(12, "分享服务可连通");
        } else {
            p.done(12, "workers.dev 已通过；自定义域名还没有指到该 Worker");
            p.note = Some("workers.dev 已通过，但你填写的域名还没有指到该 Worker".into());
        }
    } else {
        p.done(12, "分享服务可连通");
    }
    p.running = false;
    p.finished = true;
    p.cancelable = false;
    p.headline = "部署完成".into();
    if p.note.is_none() {
        p.note = Some("请再做一次真实分享，确认 R2 绑的是云同步那只桶".into());
    }
    hub().running.store(false, Ordering::SeqCst);
    emit(ctx, p);
}

fn write_secrets(vault: &Vault, base_url: &str, workers_dev: &str, secret: &str) -> Result<()> {
    let mut secrets = vault_store::load_secrets(vault)?;
    secrets.locker_worker_base_url = Some(base_url.trim().trim_end_matches('/').to_string());
    secrets.locker_worker_workers_dev_url = Some(workers_dev.trim().trim_end_matches('/').to_string());
    secrets.locker_worker_secret = Some(secret.to_string());
    vault_store::save_secrets(vault, &secrets)
}

fn probe_with_retry(
    url: &str,
    proxy: Option<&NetworkProxy>,
    attempts: u32,
) -> LockerProbeResult {
    let mut last = LockerProbeResult {
        ok: false,
        url: url.to_string(),
        checks: Vec::new(),
        hint: Some("连通性测试未通过".into()),
    };
    for i in 0..attempts {
        match probe::probe_worker(url, proxy) {
            Ok(r) if r.ok => return r,
            Ok(r) => last = r,
            Err(e) => {
                last.hint = Some(e.to_string());
            }
        }
        if i + 1 < attempts {
            std::thread::sleep(Duration::from_secs(2));
        }
    }
    last
}
