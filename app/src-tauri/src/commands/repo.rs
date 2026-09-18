//! M5 命令层：地址解析/身份推断、仓库扫描/体检/切换、归属标识管理、PAT 上传公钥。

use crate::agent::AgentEnv;
use crate::commands::{ensure_reveal_authorized, recover_lock, AppState};
use crate::error::{AppError, Result};
use crate::git::infer::{
    apply_probe_hits, classify_ls_remote, identities_for_probe, infer, Inference, ProbeFailClass,
    ProbeHit,
};
use crate::git::url::parse_repo_url;
use crate::git::{gitee, github, gitlab, repo, GitProvider};
use crate::model::ManagedRepo;
use crate::store;
use crate::sys;
use crate::vault::Vault;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

const PROBE_TIMEOUT: Duration = Duration::from_secs(12);

/// `reqwest::blocking` 不能在 `#[tauri::command(async)]` 的 Tokio 线程里创建或收尾，
/// 否则界面会一直转圈、甚至把运行时卡死（与云同步同一类问题）。
async fn run_pat_http<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Other(format!("PAT 请求中断：{e}")))?
}

fn with_vault<T>(state: &State<AppState>, f: impl FnOnce(&Vault) -> Result<T>) -> Result<T> {
    let vault = recover_lock(&state.vault);
    let v = vault.as_ref().ok_or(AppError::Locked)?;
    if !v.is_unlocked() {
        return Err(AppError::Locked);
    }
    f(v)
}

/// 解析地址并做本地身份推断（纯本地查表，零网络）。
#[tauri::command]
pub fn resolve_url(state: State<AppState>, url: String) -> Result<Inference> {
    let parsed = parse_repo_url(&url)?;
    with_vault(&state, |v| {
        let data = store::load_data(v)?;
        Ok(infer(&parsed, &data.identities, &data.clone_history))
    })
}

fn current_agent_env(state: &State<AppState>) -> AgentEnv {
    let current = recover_lock(&state.agent_env).clone();
    if crate::agent::is_ready(&current) {
        current
    } else {
        match crate::agent::ensure() {
            Ok(started) => {
                *recover_lock(&state.agent_env) = started.clone();
                started
            }
            Err(_) => current,
        }
    }
}

fn configure_git_command(
    cmd: &mut Command,
    env: &AgentEnv,
    proxy: Option<&crate::app_config::NetworkProxy>,
) -> Result<()> {
    crate::agent::apply_to_command(cmd, env);
    let ssh = crate::agent::ssh_bin(env);
    let home_cfg = crate::sys::home_included_config();
    let ssh_cmd = if home_cfg.is_file() {
        let cfg = home_cfg.to_string_lossy().replace('\\', "/");
        format!("\"{ssh}\" -F \"{cfg}\" -o BatchMode=yes -o StrictHostKeyChecking=accept-new")
    } else {
        format!("\"{ssh}\" -o BatchMode=yes -o StrictHostKeyChecking=accept-new")
    };
    cmd.env("GIT_SSH_COMMAND", ssh_cmd);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GCM_INTERACTIVE", "never");
    if let Some(p) = proxy {
        crate::net::apply_git_command(cmd, p)?;
    }
    Ok(())
}

fn run_git_timeout(
    env: &AgentEnv,
    args: &[&str],
    proxy: Option<&crate::app_config::NetworkProxy>,
    timeout: Duration,
) -> Result<(String, String, i32)> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    configure_git_command(&mut cmd, env, proxy)?;
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Io(format!("执行 git 失败：{e}")))?;
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let out_h = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = stdout_pipe.take() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let err_h = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = stderr_pipe.take() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = String::from_utf8_lossy(&out_h.join().unwrap_or_default()).to_string();
                let stderr = String::from_utf8_lossy(&err_h.join().unwrap_or_default()).to_string();
                return Ok((stdout, stderr, status.code().unwrap_or(-1)));
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_h.join();
                let _ = err_h.join();
                return Ok((String::new(), String::new(), -1));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(AppError::Io(format!("等待 git 失败：{e}"))),
        }
    }
}

fn public_https_probe_url(
    parsed: &crate::git::url::ParsedRepo,
    targets: &[crate::model::Identity],
) -> Option<String> {
    if let Some(host) = parsed.host.as_deref() {
        if !parsed.is_alias {
            if let Some(u) = crate::git::url::https_probe_url(host, &parsed.repo_path) {
                return Some(u);
            }
        }
    }
    targets
        .iter()
        .find_map(|id| crate::git::url::https_probe_url(&id.real_host, &parsed.repo_path))
}

/// 对候选身份跑 `git ls-remote`：公开托管主机先 HTTPS 探仓库是否存在，再按身份走 SSH 别名。
#[tauri::command]
pub fn probe_url_identity(state: State<AppState>, url: String) -> Result<Inference> {
    let parsed = parse_repo_url(&url)?;
    let env = current_agent_env(&state);
    let proxy = {
        let cfg = recover_lock(&state.config);
        crate::net::effective(&cfg)
    };

    with_vault(&state, |v| {
        let data = store::load_data(v)?;
        let targets: Vec<crate::model::Identity> = identities_for_probe(&parsed, &data.identities)
            .into_iter()
            .cloned()
            .collect();
        if targets.is_empty() {
            return Ok(infer(&parsed, &data.identities, &data.clone_history));
        }
        let mut key_load_failed = HashSet::new();
        for id in &targets {
            if let Some(key_id) = &id.key_id {
                if crate::agent::load_key(v, &env, key_id).is_err() {
                    key_load_failed.insert(id.id.clone());
                }
            }
        }
        let public_https_ok = match public_https_probe_url(&parsed, &targets) {
            Some(https_url) => matches!(
                run_git_timeout(
                    &env,
                    &["ls-remote", &https_url],
                    proxy.as_ref(),
                    PROBE_TIMEOUT,
                ),
                Ok((_o, _e, 0))
            ),
            None => false,
        };
        let repo_path = parsed.repo_path.clone();
        let hits = std::thread::scope(|scope| {
            let handles: Vec<_> = targets
                .iter()
                .map(|id| {
                    let env = env.clone();
                    let proxy = proxy.clone();
                    let alias_url = crate::git::url::rewrite_to_alias(&id.host_alias, &repo_path);
                    let identity_id = id.id.clone();
                    let key_failed = key_load_failed.contains(&identity_id);
                    scope.spawn(move || {
                        let (ssh_ok, mut fail) = match run_git_timeout(
                            &env,
                            &["ls-remote", &alias_url],
                            proxy.as_ref(),
                            PROBE_TIMEOUT,
                        ) {
                            Ok((_o, _e, 0)) => (true, ProbeFailClass::NetworkSsh),
                            Ok((_o, e, code)) => (false, classify_ls_remote(code, &e)),
                            Err(_) => (false, ProbeFailClass::NetworkSsh),
                        };
                        if !ssh_ok && key_failed {
                            fail = ProbeFailClass::KeyMissing;
                        }
                        ProbeHit {
                            identity_id,
                            ssh_ok,
                            fail,
                        }
                    })
                })
                .collect();
            handles
                .into_iter()
                .filter_map(|h| h.join().ok())
                .collect::<Vec<_>>()
        });
        Ok(apply_probe_hits(
            &parsed,
            &data.identities,
            &data.clone_history,
            &hits,
            public_https_ok,
        ))
    })
}

fn iso_now() -> String {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRepoView {
    pub id: String,
    pub path: String,
    pub name: String,
    pub remote_url: Option<String>,
    pub identity_id: Option<String>,
    pub identity_name: Option<String>,
    pub added_at: String,
    pub source: String,
    pub exists: bool,
    pub current_alias: Option<String>,
    pub needs_alias_fix: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScanResult {
    pub imported: u32,
    pub updated: u32,
    pub skipped_no_remote: u32,
    pub repos: Vec<ManagedRepoView>,
}

fn identity_name_of(data: &crate::model::VaultData, id: Option<&str>) -> Option<String> {
    id.and_then(|iid| {
        data.identities
            .iter()
            .find(|i| i.id == iid)
            .map(|i| i.name.clone())
    })
}

fn to_view(data: &crate::model::VaultData, rec: &ManagedRepo) -> ManagedRepoView {
    let exists = PathBuf::from(&rec.path).is_dir();
    let mut current_alias = None;
    let mut needs_alias_fix = false;
    let mut remote_url = rec.remote_url.clone();
    if exists {
        let live = repo::inspect(std::path::Path::new(&rec.path), &data.identities, &data.clone_history);
        if live.remote_url.is_some() {
            remote_url = live.remote_url;
        }
        current_alias = live.current_alias;
        needs_alias_fix = live.needs_alias_fix;
    }
    ManagedRepoView {
        id: rec.id.clone(),
        path: rec.path.clone(),
        name: rec.name.clone(),
        remote_url,
        identity_id: rec.identity_id.clone(),
        identity_name: identity_name_of(data, rec.identity_id.as_deref()),
        added_at: rec.added_at.clone(),
        source: rec.source.clone(),
        exists,
        current_alias,
        needs_alias_fix,
    }
}

fn current_machine_id() -> String {
    crate::app_config::AppConfig::current_machine_id()
}

fn upsert_from_info(
    data: &mut crate::model::VaultData,
    info: &repo::RepoInfo,
    source: &str,
) -> (bool, String) {
    let inferred_id = info.inferred_identity.as_ref().and_then(|name| {
        data.identities
            .iter()
            .find(|i| i.name == *name)
            .map(|i| i.id.clone())
    });
    repo::upsert_managed_repo(
        &mut data.repos,
        ManagedRepo {
            id: uuid::Uuid::new_v4().to_string(),
            path: info.path.clone(),
            name: repo::display_repo_name(&info.path),
            remote_url: info.remote_url.clone(),
            identity_id: inferred_id,
            added_at: iso_now(),
            source: source.into(),
            machine_id: current_machine_id(),
        },
    )
}

fn set_origin_url(repo_path: &str, url: &str) -> Result<()> {
    let (_o, _e, code) = sys::run("git", &["-C", repo_path, "remote", "get-url", "origin"])?;
    let (args, fail): (Vec<&str>, &str) = if code == 0 {
        (vec!["-C", repo_path, "remote", "set-url", "origin", url], "更新 origin 失败")
    } else {
        (vec!["-C", repo_path, "remote", "add", "origin", url], "添加 origin 失败")
    };
    let (_o, e, code) = sys::run("git", args.as_slice())?;
    if code != 0 {
        return Err(AppError::Other(format!("{fail}：{}", e.trim())));
    }
    Ok(())
}

/// 扫描根目录下的仓库并逐个体检（不入库，供预览）。
#[tauri::command]
pub fn scan_repos(state: State<AppState>, root: String, max_depth: Option<usize>) -> Result<Vec<repo::RepoInfo>> {
    let depth = max_depth.unwrap_or(5);
    with_vault(&state, |v| {
        let data = store::load_data(v)?;
        let repos = repo::scan(&PathBuf::from(&root), depth);
        Ok(repos
            .iter()
            .map(|p| repo::inspect(p, &data.identities, &data.clone_history))
            .collect())
    })
}

/// 扫描并把带 remote 的仓库登记进程序数据库。
#[tauri::command]
pub fn scan_and_import_repos(
    app: AppHandle,
    state: State<AppState>,
    root: String,
    max_depth: Option<usize>,
) -> Result<ImportScanResult> {
    crate::commands::ensure_writes_allowed(&state)?;
    let depth = max_depth.unwrap_or(5);
    let r = with_vault(&state, |v| {
        let mut data = store::load_data(v)?;
        let found = repo::scan(&PathBuf::from(&root), depth);
        let mut imported = 0u32;
        let mut updated = 0u32;
        let mut skipped_no_remote = 0u32;
        for p in found {
            let info = repo::inspect(&p, &data.identities, &data.clone_history);
            if info.remote_url.is_none() {
                skipped_no_remote += 1;
                continue;
            }
            let (is_new, _) = upsert_from_info(&mut data, &info, "scan");
            if is_new {
                imported += 1;
            } else {
                updated += 1;
            }
        }
        let machine_id = current_machine_id();
        crate::model::claim_unowned_repos(&mut data, &machine_id);
        crate::model::keep_repos_for_machine(&mut data, &machine_id);
        store::save_data(v, &data)?;
        crate::util::audit(
            v.root(),
            &format!("扫描导入仓库 imported={imported} updated={updated} skipped={skipped_no_remote}"),
        );
        let snapshot = data.repos.clone();
        let repos = snapshot.iter().map(|r| to_view(&data, r)).collect();
        Ok(ImportScanResult {
            imported,
            updated,
            skipped_no_remote,
            repos,
        })
    })?;
    crate::sync::scheduler::kick_publish(app);
    Ok(r)
}

/// 列出已登记仓库，并回读磁盘上的 origin。
#[tauri::command(async)]
pub fn list_managed_repos(state: State<'_, AppState>) -> Result<Vec<ManagedRepoView>> {
    let (mut data, vault) = {
        let guard = recover_lock(&state.vault);
        let v = guard.as_ref().ok_or(AppError::Locked)?;
        if !v.is_unlocked() {
            return Err(AppError::Locked);
        }
        (store::load_data(v)?, v.clone())
    };
    let machine_id = current_machine_id();
    let mut dirty = crate::model::claim_unowned_repos(&mut data, &machine_id);
    if crate::model::keep_repos_for_machine(&mut data, &machine_id) {
        dirty = true;
    }
    let identities = data.identities.clone();
    let history = data.clone_history.clone();
    let mut views = Vec::with_capacity(data.repos.len());
    for rec in data.repos.iter_mut() {
        let exists = PathBuf::from(&rec.path).is_dir();
        let mut current_alias = None;
        let mut needs_alias_fix = false;
        let mut remote_url = rec.remote_url.clone();
        // 目录不存在时绝不调用 git，避免无效路径把 UI 卡住。
        if exists {
            let live = repo::inspect(std::path::Path::new(&rec.path), &identities, &history);
            if live.remote_url.is_some() && live.remote_url != rec.remote_url {
                rec.remote_url = live.remote_url.clone();
                dirty = true;
            }
            if live.remote_url.is_some() {
                remote_url = live.remote_url;
            }
            current_alias = live.current_alias;
            needs_alias_fix = live.needs_alias_fix;
        }
        views.push(ManagedRepoView {
            id: rec.id.clone(),
            path: rec.path.clone(),
            name: rec.name.clone(),
            remote_url,
            identity_id: rec.identity_id.clone(),
            identity_name: identities
                .iter()
                .find(|i| rec.identity_id.as_deref() == Some(i.id.as_str()))
                .map(|i| i.name.clone()),
            added_at: rec.added_at.clone(),
            source: rec.source.clone(),
            exists,
            current_alias,
            needs_alias_fix,
        });
    }
    if dirty {
        store::save_data(&vault, &data)?;
    }
    Ok(views)
}

/// 从管理列表移除（不删除磁盘目录）。
#[tauri::command]
pub async fn remove_managed_repo(app: AppHandle, state: State<'_, AppState>, repo_id: String) -> Result<()> {
    crate::commands::ensure_writes_allowed(&state)?;
    with_vault(&state, |v| {
        let mut data = store::load_data(v)?;
        let machine_id = current_machine_id();
        crate::model::claim_unowned_repos(&mut data, &machine_id);
        crate::model::keep_repos_for_machine(&mut data, &machine_id);
        if !data.repos.iter().any(|r| r.id == repo_id) {
            return Err(AppError::Invalid("仓库不在管理列表中".into()));
        }
        data.repos.retain(|r| r.id != repo_id);
        data.deleted_repos.insert(repo_id.clone(), iso_now());
        store::save_data(v, &data)?;
        crate::util::audit(v.root(), &format!("移除已登记仓库 {repo_id}"));
        Ok(())
    })?;
    crate::sync::scheduler::kick_publish(app);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRepoRemoteArgs {
    pub repo_id: String,
    pub remote_url: String,
    pub identity_id: Option<String>,
}

/// 更换已登记仓库的 origin URL；可选同时绑定身份并改写为别名地址。
#[tauri::command]
pub fn set_repo_remote(app: AppHandle, state: State<AppState>, args: SetRepoRemoteArgs) -> Result<ManagedRepoView> {
    crate::commands::ensure_writes_allowed(&state)?;
    let r = with_vault(&state, |v| {
        let mut data = store::load_data(v)?;
        let idx = data
            .repos
            .iter()
            .position(|r| r.id == args.repo_id)
            .ok_or_else(|| AppError::Invalid("仓库不在管理列表中".into()))?;
        let repo_path = data.repos[idx].path.clone();
        if !PathBuf::from(&repo_path).is_dir() {
            return Err(AppError::Invalid("仓库目录不存在，无法改 remote".into()));
        }

        let raw = args.remote_url.trim();
        if raw.is_empty() {
            return Err(AppError::Invalid("remote URL 不能为空".into()));
        }
        let parsed = parse_repo_url(raw)?;
        let used_url = if let Some(iid) = &args.identity_id {
            let identity = data
                .identities
                .iter()
                .find(|i| i.id == *iid)
                .cloned()
                .ok_or_else(|| AppError::Invalid("身份不存在".into()))?;
            let url = crate::git::url::rewrite_to_alias(&identity.host_alias, &parsed.repo_path);
            repo::switch_identity(
                &repo_path,
                &url,
                identity.git_user_name.as_deref(),
                identity.email.as_deref(),
            )?;
            data.clone_history
                .insert(parsed.owner.to_lowercase(), identity.id.clone());
            data.repos[idx].identity_id = Some(identity.id);
            url
        } else {
            set_origin_url(&repo_path, raw)?;
            let inf = infer(&parsed, &data.identities, &data.clone_history);
            if let Some(rec) = inf.recommended {
                data.repos[idx].identity_id = Some(rec.identity_id);
            }
            raw.to_string()
        };

        data.repos[idx].remote_url = Some(used_url);
        let rec = data.repos[idx].clone();
        let view = to_view(&data, &rec);
        store::save_data(v, &data)?;
        crate::util::audit(v.root(), &format!("更新仓库 remote {}", repo_path));
        Ok(view)
    })?;
    crate::sync::scheduler::kick_publish(app);
    Ok(r)
}

/// 用资源管理器打开仓库目录。
#[tauri::command]
pub fn open_repo_dir(path: String) -> Result<()> {
    let p = PathBuf::from(path.trim());
    if !p.is_dir() {
        return Err(AppError::Invalid("目录不存在，无法打开".into()));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&p)
            .spawn()
            .map_err(|e| AppError::Io(format!("打开目录失败：{e}")))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&p)
            .spawn()
            .map_err(|e| AppError::Io(format!("打开目录失败：{e}")))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(|e| AppError::Io(format!("打开目录失败：{e}")))?;
    }
    Ok(())
}

/// 给身份追加一条归属标识（去重、小写化）。
#[tauri::command]
pub fn add_owner(app: AppHandle, state: State<AppState>, identity_id: String, owner: String) -> Result<()> {
    crate::commands::ensure_writes_allowed(&state)?;
    with_vault(&state, |v| {
        let mut data = store::load_data(v)?;
        let owner_lc = owner.trim().to_lowercase();
        let id = data
            .identities
            .iter_mut()
            .find(|i| i.id == identity_id)
            .ok_or_else(|| AppError::Invalid("身份不存在".into()))?;
        if !id.owners.iter().any(|o| o.eq_ignore_ascii_case(&owner_lc)) {
            id.owners.push(owner_lc);
            id.updated_at = {
                use time::format_description::well_known::Rfc3339;
                time::OffsetDateTime::now_utc()
                    .format(&Rfc3339)
                    .unwrap_or_default()
            };
        }
        store::save_data(v, &data)?;
        Ok(())
    })?;
    crate::sync::scheduler::kick_publish(app);
    Ok(())
}

/// 切换某仓库的身份：改 remote 为别名地址 + 设提交身份 + 学习归属。
#[tauri::command]
pub fn switch_repo_identity(app: AppHandle, state: State<AppState>, repo_path: String, identity_id: String) -> Result<String> {
    crate::commands::ensure_writes_allowed(&state)?;
    let r = with_vault(&state, |v| {
        let mut data = store::load_data(v)?;
        let identity = data
            .identities
            .iter()
            .find(|i| i.id == identity_id)
            .cloned()
            .ok_or_else(|| AppError::Invalid("身份不存在".into()))?;

        // 读当前 remote，解析出 repo_path。
        let (out, _e, code) = sys::run("git", &["-C", &repo_path, "remote", "get-url", "origin"])?;
        if code != 0 {
            return Err(AppError::Invalid("无法读取该仓库的 origin".into()));
        }
        let parsed = parse_repo_url(out.trim())?;
        let new_url = crate::git::url::rewrite_to_alias(&identity.host_alias, &parsed.repo_path);

        repo::switch_identity(
            &repo_path,
            &new_url,
            identity.git_user_name.as_deref(),
            identity.email.as_deref(),
        )?;

        // 学习 owner → identity。
        data.clone_history
            .insert(parsed.owner.to_lowercase(), identity.id.clone());
        let ident_id = identity.id.clone();
        repo::upsert_managed_repo(
            &mut data.repos,
            ManagedRepo {
                id: uuid::Uuid::new_v4().to_string(),
                path: repo_path.clone(),
                name: repo::display_repo_name(&repo_path),
                remote_url: Some(new_url.clone()),
                identity_id: Some(ident_id),
                added_at: iso_now(),
                source: "manual".into(),
                machine_id: current_machine_id(),
            },
        );
        store::save_data(v, &data)?;
        crate::util::audit(v.root(), &format!("切换仓库身份 {repo_path} → {}", identity.name));
        Ok(new_url)
    })?;
    crate::sync::scheduler::kick_publish(app);
    Ok(r)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    pub dest: String,
    pub used_url: String,
    pub identity_name: String,
    pub mode: String,
}

/// 探测选定文件夹适合 clone 还是 init，不落盘、不执行 git。
#[tauri::command]
pub fn inspect_clone_target(dest_dir: String, repo_name: String) -> Result<repo::ClonePlan> {
    if dest_dir.trim().is_empty() {
        return Err(AppError::Invalid("请先选择目标文件夹".into()));
    }
    Ok(repo::plan_clone_or_init(&PathBuf::from(dest_dir.trim()), repo_name.trim()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneOrInitArgs {
    pub url: String,
    pub dest_dir: String,
    pub identity_id: String,
    /// clone | init | addRemote
    pub mode: String,
}

fn run_git(
    env: &AgentEnv,
    args: &[&str],
    proxy: Option<&crate::app_config::NetworkProxy>,
) -> Result<(String, String, i32)> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    configure_git_command(&mut cmd, env, proxy)?;
    let output = cmd
        .output()
        .map_err(|e| AppError::Io(format!("执行 git 失败：{e}")))?;
    Ok((
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    ))
}

fn apply_local_identity(repo_path: &str, name: Option<&str>, email: Option<&str>) -> Result<()> {
    if let Some(n) = name {
        sys::run("git", &["-C", repo_path, "config", "user.name", n])?;
    }
    if let Some(e) = email {
        sys::run("git", &["-C", repo_path, "config", "user.email", e])?;
    }
    Ok(())
}

/// 按探测结果把仓库落到本地：空目录 clone，已有项目 init，已有裸仓库补 remote。
#[tauri::command]
pub fn clone_repo(app: AppHandle, state: State<AppState>, args: CloneOrInitArgs) -> Result<CloneResult> {
    crate::commands::ensure_writes_allowed(&state)?;
    let parsed = parse_repo_url(&args.url)?;
    let dest = PathBuf::from(args.dest_dir.trim());
    let plan = repo::plan_clone_or_init(&dest, &parsed.repo);
    if !plan.can_proceed {
        return Err(AppError::Invalid(plan.message));
    }
    let mode = args.mode.trim();
    if mode != plan.suggested_mode {
        return Err(AppError::Invalid(format!(
            "选定文件夹当前应执行 {}，与请求的 {} 不一致。请重新选择目录。",
            plan.suggested_mode, mode
        )));
    }

    let env = {
        let current = recover_lock(&state.agent_env).clone();
        if crate::agent::is_ready(&current) {
            current
        } else {
            match crate::agent::ensure() {
                Ok(started) => {
                    *recover_lock(&state.agent_env) = started.clone();
                    started
                }
                Err(_) => current,
            }
        }
    };

    let proxy = {
        let cfg = recover_lock(&state.config);
        crate::net::effective(&cfg)
    };

    let r = with_vault(&state, |v| {
        let mut data = store::load_data(v)?;
        let identity = data
            .identities
            .iter()
            .find(|i| i.id == args.identity_id)
            .cloned()
            .ok_or_else(|| AppError::Invalid("身份不存在".into()))?;
        let used_url = crate::git::url::rewrite_to_alias(&identity.host_alias, &parsed.repo_path);
        let target_str = plan.target_path.clone();

        if let Some(key_id) = &identity.key_id {
            let _ = crate::agent::load_key(v, &env, key_id);
        }

        match mode {
            "clone" => {
                if let Some(parent) = PathBuf::from(&target_str).parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let (_o, e, code) = run_git(&env, &["clone", &used_url, &target_str], proxy.as_ref())?;
                if code != 0 {
                    return Err(AppError::Other(format!("git clone 失败：{}", e.trim())));
                }
                apply_local_identity(
                    &target_str,
                    identity.git_user_name.as_deref(),
                    identity.email.as_deref(),
                )?;
            }
            "init" => {
                std::fs::create_dir_all(&target_str)?;
                let (_o, e, code) = sys::run("git", &["-C", &target_str, "init"])?;
                if code != 0 {
                    return Err(AppError::Other(format!("git init 失败：{}", e.trim())));
                }
                let (_o, e, code) = sys::run("git", &["-C", &target_str, "remote", "add", "origin", &used_url])?;
                if code != 0 {
                    return Err(AppError::Other(format!("绑定远程失败：{}", e.trim())));
                }
                apply_local_identity(
                    &target_str,
                    identity.git_user_name.as_deref(),
                    identity.email.as_deref(),
                )?;
            }
            "addRemote" => {
                let (_o, e, code) = sys::run("git", &["-C", &target_str, "remote", "add", "origin", &used_url])?;
                if code != 0 {
                    return Err(AppError::Other(format!("绑定远程失败：{}", e.trim())));
                }
                apply_local_identity(
                    &target_str,
                    identity.git_user_name.as_deref(),
                    identity.email.as_deref(),
                )?;
            }
            other => return Err(AppError::Invalid(format!("未知操作：{other}"))),
        }

        data.clone_history
            .insert(parsed.owner.to_lowercase(), identity.id.clone());
        repo::upsert_managed_repo(
            &mut data.repos,
            ManagedRepo {
                id: uuid::Uuid::new_v4().to_string(),
                path: target_str.clone(),
                name: parsed.repo.clone(),
                remote_url: Some(used_url.clone()),
                identity_id: Some(identity.id.clone()),
                added_at: iso_now(),
                source: mode.to_string(),
                machine_id: current_machine_id(),
            },
        );
        store::save_data(v, &data)?;
        crate::util::audit(
            v.root(),
            &format!("{mode} {} 使用身份 {}", parsed.repo_path, identity.name),
        );

        Ok(CloneResult {
            dest: target_str,
            used_url,
            identity_name: identity.name,
            mode: mode.to_string(),
        })
    })?;
    crate::sync::scheduler::kick_publish(app);
    Ok(r)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPatStatus {
    pub configured: bool,
}

fn pat_of(secrets: &crate::model::Secrets, provider: GitProvider) -> Option<&str> {
    match provider {
        GitProvider::Github => secrets.github_pat.as_deref(),
        GitProvider::Gitlab => secrets.gitlab_pat.as_deref(),
        GitProvider::Gitee => secrets.gitee_pat.as_deref(),
    }
    .map(str::trim)
    .filter(|s| !s.is_empty())
}

fn set_pat(secrets: &mut crate::model::Secrets, provider: GitProvider, token: Option<String>) {
    match provider {
        GitProvider::Github => secrets.github_pat = token,
        GitProvider::Gitlab => secrets.gitlab_pat = token,
        GitProvider::Gitee => secrets.gitee_pat = token,
    }
}

fn provider_whoami(
    provider: GitProvider,
    token: &str,
    proxy: Option<&crate::app_config::NetworkProxy>,
) -> Result<String> {
    match provider {
        GitProvider::Github => github::whoami(token, proxy),
        GitProvider::Gitlab => gitlab::whoami(token, proxy),
        GitProvider::Gitee => gitee::whoami(token, proxy),
    }
}

fn provider_list_orgs(
    provider: GitProvider,
    token: &str,
    proxy: Option<&crate::app_config::NetworkProxy>,
) -> Result<Vec<String>> {
    match provider {
        GitProvider::Github => github::list_orgs(token, proxy),
        GitProvider::Gitlab => gitlab::list_orgs(token, proxy),
        GitProvider::Gitee => gitee::list_orgs(token, proxy),
    }
}

fn provider_upload_key(
    provider: GitProvider,
    token: &str,
    title: &str,
    public_openssh: &str,
    proxy: Option<&crate::app_config::NetworkProxy>,
) -> Result<()> {
    match provider {
        GitProvider::Github => github::upload_public_key(token, title, public_openssh, proxy),
        GitProvider::Gitlab => gitlab::upload_public_key(token, title, public_openssh, proxy),
        GitProvider::Gitee => gitee::upload_public_key(token, title, public_openssh, proxy),
    }
}

/// 二次验证后回传已保存的 PAT 明文（吃免密查看时效）。
#[tauri::command]
pub fn reveal_git_pat(
    state: State<AppState>,
    provider: GitProvider,
    password: Option<String>,
) -> Result<String> {
    ensure_reveal_authorized(&state, password.as_deref())?;
    with_vault(&state, |v| {
        let secrets = store::load_secrets(v)?;
        let token = pat_of(&secrets, provider)
            .ok_or_else(|| AppError::Invalid("尚未配置 PAT".into()))?
            .to_string();
        crate::util::audit(v.root(), &format!("查看 {} PAT", provider.as_str()));
        Ok(token)
    })
}

/// 查询是否已保存某平台 PAT（不回传令牌本身）。
#[tauri::command(async)]
pub fn git_pat_status(state: State<'_, AppState>, provider: GitProvider) -> Result<GithubPatStatus> {
    with_vault(&state, |v| {
        let secrets = store::load_secrets(v)?;
        Ok(GithubPatStatus {
            configured: pat_of(&secrets, provider).is_some(),
        })
    })
}

/// 保存某平台 PAT（存入 vault，绝不落明文、不进日志）。
#[tauri::command]
pub fn set_git_pat(
    app: AppHandle,
    state: State<AppState>,
    provider: GitProvider,
    token: String,
) -> Result<()> {
    crate::commands::ensure_writes_allowed(&state)?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::Invalid("PAT 不能为空".into()));
    }
    with_vault(&state, |v| {
        let mut secrets = store::load_secrets(v)?;
        set_pat(&mut secrets, provider, Some(token));
        store::save_secrets(v, &secrets)?;
        crate::util::audit(v.root(), &format!("保存 {} PAT", provider.as_str()));
        Ok(())
    })?;
    crate::sync::scheduler::kick_publish(app);
    Ok(())
}

/// 清除已保存的某平台 PAT。
#[tauri::command]
pub fn clear_git_pat(app: AppHandle, state: State<AppState>, provider: GitProvider) -> Result<()> {
    crate::commands::ensure_writes_allowed(&state)?;
    with_vault(&state, |v| {
        let mut secrets = store::load_secrets(v)?;
        set_pat(&mut secrets, provider, None);
        store::save_secrets(v, &secrets)?;
        crate::util::audit(v.root(), &format!("清除 {} PAT", provider.as_str()));
        Ok(())
    })?;
    crate::sync::scheduler::kick_publish(app);
    Ok(())
}

/// 校验 PAT 并返回账号名。
#[tauri::command(async)]
pub async fn test_git_pat(state: State<'_, AppState>, provider: GitProvider) -> Result<String> {
    let proxy = crate::net::effective(&recover_lock(&state.config));
    let token = with_vault(&state, |v| {
        let secrets = store::load_secrets(v)?;
        pat_of(&secrets, provider)
            .ok_or_else(|| AppError::Invalid("尚未配置 PAT".into()))
            .map(|s| s.to_string())
    })?;
    run_pat_http(move || provider_whoami(provider, &token, proxy.as_ref())).await
}

/// 拉取 PAT 账号所属组织（供批量导入归属标识）。
#[tauri::command(async)]
pub async fn list_git_orgs(state: State<'_, AppState>, provider: GitProvider) -> Result<Vec<String>> {
    let proxy = crate::net::effective(&recover_lock(&state.config));
    let token = with_vault(&state, |v| {
        let secrets = store::load_secrets(v)?;
        pat_of(&secrets, provider)
            .ok_or_else(|| AppError::Invalid("尚未配置 PAT".into()))
            .map(|s| s.to_string())
    })?;
    run_pat_http(move || provider_list_orgs(provider, &token, proxy.as_ref())).await
}

/// 用 PAT 上传某把密钥的公钥到对应平台。
#[tauri::command]
pub fn upload_git_public_key(
    state: State<AppState>,
    provider: GitProvider,
    key_id: String,
    title: String,
) -> Result<()> {
    crate::commands::ensure_writes_allowed(&state)?;
    let proxy = crate::net::effective(&recover_lock(&state.config));
    let (token, public_openssh, key_name, root) = with_vault(&state, |v| {
        let secrets = store::load_secrets(v)?;
        let token = pat_of(&secrets, provider)
            .ok_or_else(|| AppError::Invalid("尚未配置 PAT，可改用复制公钥手动添加".into()))?
            .to_string();
        let data = store::load_data(v)?;
        let record = data
            .keys
            .iter()
            .find(|k| k.id == key_id)
            .ok_or_else(|| AppError::Invalid("密钥不存在".into()))?;
        Ok((
            token,
            record.public_openssh.clone(),
            record.name.clone(),
            v.root().to_path_buf(),
        ))
    })?;
    provider_upload_key(provider, &token, &title, &public_openssh, proxy.as_ref())?;
    crate::util::audit(&root, &format!("PAT 上传公钥 {key_name}"));
    Ok(())
}

/// 查询是否已保存 GitHub PAT（不回传令牌本身）。
#[tauri::command(async)]
pub fn github_pat_status(state: State<'_, AppState>) -> Result<GithubPatStatus> {
    git_pat_status(state, GitProvider::Github)
}

/// 保存 GitHub PAT（存入 vault，绝不落明文）。
#[tauri::command]
pub fn set_github_pat(app: AppHandle, state: State<AppState>, token: String) -> Result<()> {
    set_git_pat(app, state, GitProvider::Github, token)
}

/// 清除已保存的 GitHub PAT。
#[tauri::command]
pub fn clear_github_pat(app: AppHandle, state: State<AppState>) -> Result<()> {
    clear_git_pat(app, state, GitProvider::Github)
}

/// 校验 PAT 并返回账号名。
#[tauri::command(async)]
pub async fn test_github_pat(state: State<'_, AppState>) -> Result<String> {
    test_git_pat(state, GitProvider::Github).await
}

/// 拉取 PAT 账号所属组织（供批量导入归属标识）。
#[tauri::command(async)]
pub async fn list_github_orgs(state: State<'_, AppState>) -> Result<Vec<String>> {
    list_git_orgs(state, GitProvider::Github).await
}

/// 用 PAT 上传某把密钥的公钥到 GitHub。
#[tauri::command]
pub fn upload_public_key(state: State<AppState>, key_id: String, title: String) -> Result<()> {
    upload_git_public_key(state, GitProvider::Github, key_id, title)
}
