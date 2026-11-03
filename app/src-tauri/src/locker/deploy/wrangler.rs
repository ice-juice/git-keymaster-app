//! wrangler login 路径：本机 Node / npx wrangler。不读取、不保存 wrangler 的令牌。

use super::assets;
use super::sql;
use super::LockerCfAccount;
use crate::error::{AppError, Result};
use crate::sys;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

const NODE_MIN: u32 = 22;
static LOGIN_PID: AtomicU32 = AtomicU32::new(0);

pub struct TempProject {
    pub dir: PathBuf,
}

impl Drop for TempProject {
    fn drop(&mut self) {
        if self
            .dir
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|n| n.starts_with("gam-locker-deploy-"))
        {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

pub fn parse_node_major(version: &str) -> Option<u32> {
    let t = version.trim().trim_start_matches('v');
    t.split(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())
        .and_then(|s| s.parse().ok())
}

pub fn check_node() -> Result<u32> {
    let node = resolve_bin("node").ok_or_else(|| node_missing())?;
    let (out, err, code) = sys::run_timeout(&node, &["-v"], Duration::from_secs(8))?;
    if code != 0 {
        return Err(node_missing());
    }
    let major = parse_node_major(&format!("{out}{err}")).ok_or_else(|| node_missing())?;
    if major < NODE_MIN {
        return Err(AppError::Invalid(format!(
            "本机 Node.js 是 {major}，需要 22 或更高。请改用 API Token 部署"
        )));
    }
    Ok(major)
}

fn node_missing() -> AppError {
    AppError::Invalid("本机没有 Node.js 22 或更高版本，请改用 API Token 部署".into())
}

pub fn resolve_bin(name: &str) -> Option<String> {
    if let Some(p) = crate::sys::resolve_bin(name) {
        return Some(p.display().to_string());
    }
    #[cfg(windows)]
    {
        for ext in [".cmd", ".bat", ".exe"] {
            if let Some(p) = crate::sys::resolve_bin(&format!("{name}{ext}")) {
                return Some(p.display().to_string());
            }
            if let Some(path) = std::env::var_os("PATH") {
                for dir in std::env::split_paths(&path) {
                    let p = dir.join(format!("{name}{ext}"));
                    if p.is_file() {
                        return Some(p.display().to_string());
                    }
                }
            }
        }
    }
    None
}

fn npx() -> Result<String> {
    resolve_bin("npx").ok_or_else(|| AppError::Invalid("找不到 npx，请确认已安装 Node.js 22+".into()))
}

fn wrangler_args(rest: &[&str]) -> Vec<String> {
    let mut args = vec!["--yes".into(), "wrangler".into()];
    args.extend(rest.iter().map(|s| s.to_string()));
    args
}

fn run_wrangler(cwd: Option<&Path>, rest: &[&str], timeout: Duration) -> Result<(String, String, i32)> {
    let exe = npx()?;
    let args = wrangler_args(rest);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    if let Some(dir) = cwd {
        run_in_dir(&exe, &refs, dir, timeout)
    } else {
        sys::run_timeout(&exe, &refs, timeout)
    }
}

fn run_in_dir(exe: &str, args: &[&str], cwd: &Path, timeout: Duration) -> Result<(String, String, i32)> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sys::hide_console(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| AppError::Io(format!("执行 wrangler 失败：{e}")))?;
    sys::wait_output_timeout(child, timeout, "wrangler")
}

fn brief(out: &str, err: &str) -> String {
    let text = format!("{err}\n{out}");
    let trimmed = text.trim().replace(['\n', '\r'], " ");
    let redacted = trimmed
        .replace("CLOUDFLARE_API_TOKEN", "[token]")
        .replace("LOCKER_HMAC_SECRET", "[secret]");
    if redacted.chars().count() > 240 {
        redacted.chars().take(240).collect()
    } else {
        redacted
    }
}

pub fn whoami(cwd: Option<&Path>) -> Result<Vec<LockerCfAccount>> {
    let (out, err, code) = run_wrangler(cwd, &["whoami"], Duration::from_secs(45))?;
    let text = format!("{out}\n{err}");
    if code != 0 {
        return Err(AppError::Invalid(if looks_logged_out(&text) {
            "还没有登录 Cloudflare".into()
        } else {
            format!("wrangler whoami 失败：{}", brief(&out, &err))
        }));
    }
    let accounts = parse_whoami_accounts(&text);
    if accounts.is_empty() {
        return Err(AppError::Invalid("wrangler 没有列出可管理的账号".into()));
    }
    Ok(accounts)
}

pub fn looks_logged_out(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("not logged in")
        || lower.contains("not authenticated")
        || lower.contains("please run") && lower.contains("login")
        || lower.contains("you are not")
}

pub fn parse_whoami_accounts(text: &str) -> Vec<LockerCfAccount> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut ids = Vec::new();
        let mut cur = String::new();
        for c in line.chars() {
            if c.is_ascii_hexdigit() {
                cur.push(c);
            } else {
                if cur.len() == 32 {
                    ids.push(cur.clone());
                }
                cur.clear();
            }
        }
        if cur.len() == 32 {
            ids.push(cur);
        }
        for id in ids {
            let name = line
                .split('|')
                .map(str::trim)
                .find(|s| !s.is_empty() && *s != id && !s.contains("Account"))
                .unwrap_or(&id)
                .trim_matches(|c: char| c == '│' || c.is_whitespace())
                .to_string();
            if !out.iter().any(|a: &LockerCfAccount| a.id == id) {
                out.push(LockerCfAccount {
                    name: if name.is_empty() { id.clone() } else { name },
                    id,
                });
            }
        }
    }
    out
}

pub fn login_until_ready(cancel: &AtomicBool) -> Result<Vec<LockerCfAccount>> {
    if let Ok(accounts) = whoami(None) {
        return Ok(accounts);
    }
    spawn_login()?;
    loop {
        if cancel.load(Ordering::SeqCst) {
            kill_login();
            return Err(AppError::Invalid("已取消登录".into()));
        }
        std::thread::sleep(Duration::from_secs(2));
        if let Ok(accounts) = whoami(None) {
            kill_login();
            return Ok(accounts);
        }
    }
}

fn spawn_login() -> Result<()> {
    let exe = npx()?;
    let args = wrangler_args(&["login"]);
    let mut cmd = Command::new(&exe);
    cmd.args(&args);
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    #[cfg(not(windows))]
    {
        sys::hide_console(&mut cmd);
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
    }
    let child = cmd
        .spawn()
        .map_err(|e| AppError::Io(format!("启动 wrangler login 失败：{e}")))?;
    kill_login();
    LOGIN_PID.store(child.id(), Ordering::SeqCst);
    std::mem::forget(child);
    Ok(())
}

pub fn kill_login() {
    let pid = LOGIN_PID.swap(0, Ordering::SeqCst);
    if pid != 0 {
        sys::kill_pid(pid);
    }
}

pub fn write_temp_project(bucket: &str, database_id: &str) -> Result<TempProject> {
    let dir = std::env::temp_dir().join(format!("gam-locker-deploy-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("migrations"))?;
    std::fs::write(dir.join("index.js"), assets::WORKER_SCRIPT)?;
    std::fs::write(dir.join("migrations/0001_locker.sql"), assets::LOCKER_MIGRATION_SQL)?;
    let toml = format!(
        "name = \"{}\"\nmain = \"index.js\"\ncompatibility_date = \"{}\"\n\n[[d1_databases]]\nbinding = \"{}\"\ndatabase_name = \"{}\"\ndatabase_id = \"{database_id}\"\nmigrations_dir = \"migrations\"\n\n[[r2_buckets]]\nbinding = \"{}\"\nbucket_name = \"{}\"\n\n[triggers]\ncrons = [\"{}\"]\n",
        assets::SCRIPT_NAME,
        assets::compatibility_date(),
        assets::D1_BINDING,
        assets::D1_NAME,
        assets::R2_BINDING,
        bucket.replace('\\', "\\\\").replace('"', "\\\""),
        assets::CRON,
    );
    std::fs::write(dir.join("wrangler.toml"), toml)?;
    Ok(TempProject { dir })
}

pub fn find_or_create_d1(cancel_guard: &AtomicBool) -> Result<String> {
    if cancel_guard.load(Ordering::SeqCst) {
        return Err(AppError::Invalid("已取消".into()));
    }
    if let Some(id) = find_d1()? {
        return Ok(id);
    }
    let (out, err, code) = run_wrangler(None, &["d1", "create", assets::D1_NAME], Duration::from_secs(60))?;
    if let Some(id) = parse_database_id(&format!("{out}\n{err}")) {
        return Ok(id);
    }
    if let Some(id) = find_d1()? {
        return Ok(id);
    }
    if code != 0 {
        return Err(AppError::Invalid(format!("创建 D1 失败：{}", brief(&out, &err))));
    }
    Err(AppError::Invalid("创建 D1 后没有读到 database_id".into()))
}

fn find_d1() -> Result<Option<String>> {
    let (out, err, code) = run_wrangler(None, &["d1", "list", "--json"], Duration::from_secs(45))?;
    if code != 0 {
        return Err(AppError::Invalid(format!("列出 D1 失败：{}", brief(&out, &err))));
    }
    let v: serde_json::Value = serde_json::from_str(out.trim())
        .or_else(|_| serde_json::from_str(err.trim()))
        .unwrap_or(serde_json::Value::Null);
    let arr = v
        .as_array()
        .cloned()
        .or_else(|| v.get("databases").and_then(|d| d.as_array()).cloned())
        .or_else(|| v.get("result").and_then(|d| d.as_array()).cloned())
        .unwrap_or_default();
    for item in arr {
        if item.get("name").and_then(|n| n.as_str()) == Some(assets::D1_NAME) {
            if let Some(id) = item
                .get("uuid")
                .or_else(|| item.get("id"))
                .and_then(|x| x.as_str())
            {
                return Ok(Some(id.to_string()));
            }
        }
    }
    Ok(None)
}

pub fn parse_database_id(text: &str) -> Option<String> {
    for line in text.lines() {
        if let Some((_, rest)) = line.split_once("database_id") {
            let id: String = rest
                .chars()
                .filter(|c| c.is_ascii_hexdigit() || *c == '-')
                .collect();
            if id.len() >= 32 {
                return Some(id.trim_matches(|c: char| c == '"' || c == '=' || c.is_whitespace()).to_string());
            }
        }
    }
    None
}

pub fn locker_table_names(project: &TempProject) -> Result<Vec<String>> {
    let (out, err, code) = run_wrangler(
        Some(&project.dir),
        &[
            "d1",
            "execute",
            assets::D1_NAME,
            "--remote",
            "--json",
            "--command",
            sql::sqlite_master_probe_sql(),
        ],
        Duration::from_secs(60),
    )?;
    if code != 0 {
        return Err(AppError::Invalid(format!("查询 D1 表失败：{}", brief(&out, &err))));
    }
    let v: serde_json::Value = serde_json::from_str(out.trim())
        .or_else(|_| serde_json::from_str(err.trim()))
        .unwrap_or(serde_json::Value::Null);
    Ok(sql::names_from_d1_json(&v))
}

pub fn apply_locker_sql(project: &TempProject) -> Result<()> {
    let (out, err, code) = run_wrangler(
        Some(&project.dir),
        &[
            "d1",
            "execute",
            assets::D1_NAME,
            "--remote",
            "--file=migrations/0001_locker.sql",
        ],
        Duration::from_secs(90),
    )?;
    if code != 0 {
        return Err(AppError::Invalid(format!("建立寄存表失败：{}", brief(&out, &err))));
    }
    Ok(())
}

pub fn r2_bucket_exists(bucket: &str) -> Result<bool> {
    let (out, err, code) = run_wrangler(None, &["r2", "bucket", "list", "--json"], Duration::from_secs(45))?;
    if code != 0 {
        return Err(AppError::Invalid(format!("列出 R2 桶失败：{}", brief(&out, &err))));
    }
    let text = format!("{out}\n{err}");
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(out.trim()) {
        let arr = v
            .as_array()
            .cloned()
            .or_else(|| v.get("buckets").and_then(|b| b.as_array()).cloned())
            .unwrap_or_default();
        for item in arr {
            let name = item
                .get("name")
                .or_else(|| item.get("Name"))
                .and_then(|n| n.as_str())
                .unwrap_or_default();
            if name == bucket {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    Ok(text.contains(bucket))
}

pub fn put_secret(project: &TempProject, secret: &str) -> Result<()> {
    let exe = npx()?;
    let args = wrangler_args(&["secret", "put", assets::HMAC_SECRET_NAME]);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let payload = format!("{secret}\n");
    let (out, err, code) = run_with_stdin_in_dir(&exe, &refs, &project.dir, payload.as_bytes())?;
    if code != 0 {
        return Err(AppError::Invalid(format!("写入共享密钥失败：{}", brief(&out, &err))));
    }
    Ok(())
}

fn run_with_stdin_in_dir(exe: &str, args: &[&str], cwd: &Path, stdin_data: &[u8]) -> Result<(String, String, i32)> {
    use std::io::Write;
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sys::hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Io(format!("执行 wrangler 失败：{e}")))?;
    if let Some(mut si) = child.stdin.take() {
        si.write_all(stdin_data)
            .map_err(|e| AppError::Io(e.to_string()))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
        out.status.code().unwrap_or(-1),
    ))
}

pub fn deploy(project: &TempProject) -> Result<String> {
    let (out, err, code) = run_wrangler(Some(&project.dir), &["deploy"], Duration::from_secs(180))?;
    let text = format!("{out}\n{err}");
    if code != 0 {
        return Err(AppError::Invalid(format!("上传分享服务失败：{}", brief(&out, &err))));
    }
    parse_workers_dev_url(&text).ok_or_else(|| {
        AppError::Invalid("wrangler deploy 成功但没有读到 workers.dev 地址".into())
    })
}

pub fn parse_workers_dev_url(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let t = token.trim_matches(|c: char| "()[].,;".contains(c));
        if t.starts_with("https://") && t.contains(".workers.dev") {
            return Some(t.trim_end_matches('/').to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_major_parses_v_prefix() {
        assert_eq!(parse_node_major("v22.11.0"), Some(22));
        assert_eq!(parse_node_major("v16.20.2"), Some(16));
        assert_eq!(parse_node_major("23.0.0\n"), Some(23));
        assert_eq!(parse_node_major("nope"), None);
    }

    #[test]
    fn whoami_table_extracts_account_ids() {
        let text = "\
👋 You are logged in with an OAuth Token, associated with the email a@b.com.
┌─────────────────────────┬──────────────────────────────────┐
│ Account Name            │ Account ID                       │
├─────────────────────────┼──────────────────────────────────┤
│ Personal                │ 0123456789abcdef0123456789abcdef │
│ Work                    │ fedcba9876543210fedcba9876543210 │
└─────────────────────────┴──────────────────────────────────┘
";
        let got = parse_whoami_accounts(text);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].id, "0123456789abcdef0123456789abcdef");
        assert!(got[0].name.contains("Personal"));
        assert_eq!(got[1].id, "fedcba9876543210fedcba9876543210");
    }

    #[test]
    fn parse_deploy_url_and_database_id() {
        let out = "Published file-locker (1.2 sec)\n  https://file-locker.demo.workers.dev\nCurrent Version ID: abc";
        assert_eq!(
            parse_workers_dev_url(out).as_deref(),
            Some("https://file-locker.demo.workers.dev")
        );
        let create = r#"[[d1_databases]]
database_name = "file-locker"
database_id = "e05b62d5-7062-4d81-b3ff-0cdef3d87468"
"#;
        assert_eq!(
            parse_database_id(create).as_deref(),
            Some("e05b62d5-7062-4d81-b3ff-0cdef3d87468")
        );
    }
}
