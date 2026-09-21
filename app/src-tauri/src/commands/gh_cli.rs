//! 本机 GitHub CLI（`gh`）状态与浏览器登录。不读、不回传 token。

use crate::error::{AppError, Result};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::sys;
use serde::Serialize;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::process::Command;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::time::{Duration, Instant};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
static LOGIN_PID: AtomicU32 = AtomicU32::new(0);
#[cfg(not(any(target_os = "android", target_os = "ios")))]
static LOGIN_CANCELLED: AtomicBool = AtomicBool::new(false);

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const INSTALL_HINT: &str = "未检测到 GitHub CLI（gh）。请先安装：https://cli.github.com/";
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const DEVICE_LOGIN_URL: &str = "https://github.com/login/device";
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const CODE_WAIT: Duration = Duration::from_secs(12);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhCliStatus {
    pub installed: bool,
    pub logged_in: bool,
    pub login: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhCliLoginResult {
    pub started: bool,
    pub device_code: Option<String>,
    pub installed: bool,
    pub logged_in: bool,
    pub login: Option<String>,
}

fn missing_status() -> GhCliStatus {
    GhCliStatus {
        installed: false,
        logged_in: false,
        login: None,
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn gh_path() -> Option<String> {
    sys::resolve_bin("gh").map(|p| p.display().to_string())
}

/// 从 `gh auth status` 文本里取出账号名，不解析 token。
pub fn parse_logged_in_user(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        for marker in [" account ", " as "] {
            let Some((_, rest)) = line.split_once(marker) else {
                continue;
            };
            let name = rest
                .split_whitespace()
                .next()?
                .trim_matches(|c: char| c == '(' || c == ')' || c == ',');
            if !name.is_empty() && name != "github.com" {
                return Some(name.to_string());
            }
        }
    }
    None
}

/// GitHub 设备码：`XXXX-XXXX`。不是 PAT，本来就要给人看。
pub fn parse_device_code(text: &str) -> Option<String> {
    let text = text.trim();
    for token in text.split(|c: char| c.is_whitespace() || c == ':' || c == '：') {
        let token = token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-');
        if is_device_code(token) {
            return Some(token.to_ascii_uppercase());
        }
    }
    None
}

fn is_device_code(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 9
        && b[4] == b'-'
        && s.chars().enumerate().all(|(i, c)| {
            if i == 4 {
                c == '-'
            } else {
                c.is_ascii_alphanumeric()
            }
        })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn status_from_gh() -> GhCliStatus {
    let Some(exe) = gh_path() else {
        return missing_status();
    };
    match sys::run_timeout(
        &exe,
        &["auth", "status", "--hostname", "github.com"],
        Duration::from_secs(15),
    ) {
        Ok((out, err, code)) => {
            let login = parse_logged_in_user(&format!("{out}\n{err}"));
            GhCliStatus {
                installed: true,
                logged_in: code == 0 || login.is_some(),
                login,
            }
        }
        Err(_) => GhCliStatus {
            installed: true,
            logged_in: false,
            login: None,
        },
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn spawn_login(exe: &str) -> Result<()> {
    let _ = crate::commands::assets::open_url(DEVICE_LOGIN_URL.into());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        // GUI 父进程没有控制台：stdout inherit 会让新窗口空白。
        // 用脚本把提示和 gh 打到新控制台，不要重定向。
        let bat = std::env::temp_dir().join("git-keymaster-gh-login.cmd");
        let script = format!(
            "@echo off\r\n\
             chcp 65001 >nul\r\n\
             echo.\r\n\
             echo ================================================\r\n\
             echo  把下面 one-time code 填进浏览器的 8 个格子\r\n\
             echo ================================================\r\n\
             echo.\r\n\
             \"{exe}\" auth login --hostname github.com --git-protocol https --web --clipboard --skip-ssh-key\r\n\
             echo.\r\n\
             echo 完成后可关闭本窗口\r\n\
             pause >nul\r\n"
        );
        std::fs::write(&bat, script).map_err(|e| AppError::Io(e.to_string()))?;
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/K"]).arg(&bat);
        cmd.env_remove("BROWSER");
        cmd.env_remove("GH_BROWSER");
        cmd.creation_flags(CREATE_NEW_CONSOLE);
        remember_login_child(
            cmd.spawn()
                .map_err(|e| AppError::Io(format!("启动 gh 失败：{e}")))?,
        );
        Ok(())
    }
    #[cfg(not(windows))]
    {
        use std::process::Stdio;
        let mut cmd = Command::new(exe);
        cmd.args([
            "auth",
            "login",
            "--hostname",
            "github.com",
            "--git-protocol",
            "https",
            "--web",
            "--clipboard",
            "--skip-ssh-key",
        ]);
        cmd.env_remove("BROWSER");
        cmd.env_remove("GH_BROWSER");
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        sys::hide_console(&mut cmd);
        remember_login_child(
            cmd.spawn()
                .map_err(|e| AppError::Io(format!("启动 gh 失败：{e}")))?,
        );
        Ok(())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn remember_login_child(child: std::process::Child) {
    kill_pending_login();
    LOGIN_PID.store(child.id(), Ordering::SeqCst);
    // 交给系统继续跑；取消时按 PID 杀进程树。
    std::mem::forget(child);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn kill_pending_login() {
    let pid = LOGIN_PID.swap(0, Ordering::SeqCst);
    if pid != 0 {
        sys::kill_pid(pid);
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn wait_device_code(timeout: Duration) -> Option<String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Ok(text) = crate::clipboard::read() {
            if let Some(code) = parse_device_code(&text) {
                return Some(code);
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    None
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn logout_github(user: Option<&str>) -> Result<()> {
    let exe = gh_path().ok_or_else(|| AppError::Other(INSTALL_HINT.into()))?;
    let mut args = vec![
        "auth".into(),
        "logout".into(),
        "--hostname".into(),
        "github.com".into(),
    ];
    if let Some(name) = user.filter(|s| !s.is_empty()) {
        args.push("--user".into());
        args.push(name.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (out, err, code) = sys::run_timeout(&exe, &arg_refs, Duration::from_secs(20))?;
    if code != 0 {
        let detail = format!("{err}{out}").trim().to_string();
        return Err(AppError::Other(if detail.is_empty() {
            "取消 GitHub CLI 登录失败".into()
        } else {
            detail
        }));
    }
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn run_cancel() -> Result<GhCliStatus> {
    LOGIN_CANCELLED.store(true, Ordering::SeqCst);
    kill_pending_login();
    let status = status_from_gh();
    if status.logged_in {
        logout_github(status.login.as_deref())?;
    }
    Ok(status_from_gh())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn run_login() -> Result<GhCliLoginResult> {
    LOGIN_CANCELLED.store(false, Ordering::SeqCst);
    let exe = gh_path().ok_or_else(|| AppError::Other(INSTALL_HINT.into()))?;
    spawn_login(&exe)?;
    let device_code = wait_device_code(CODE_WAIT);
    let status = status_from_gh();
    if LOGIN_CANCELLED.load(Ordering::SeqCst) {
        return Ok(GhCliLoginResult {
            started: false,
            device_code: None,
            installed: status.installed,
            logged_in: status.logged_in,
            login: status.login,
        });
    }
    Ok(GhCliLoginResult {
        started: true,
        device_code,
        installed: status.installed,
        logged_in: status.logged_in,
        login: status.login,
    })
}

#[tauri::command(async)]
pub async fn gh_cli_status() -> Result<GhCliStatus> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return Ok(missing_status());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        tauri::async_runtime::spawn_blocking(status_from_gh)
            .await
            .map_err(|e| AppError::Other(format!("查询 gh 状态中断：{e}")))
    }
}

#[tauri::command(async)]
pub async fn gh_cli_cancel() -> Result<GhCliStatus> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return Err(AppError::Unsupported("GitHub CLI 登录"));
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        tauri::async_runtime::spawn_blocking(run_cancel)
            .await
            .map_err(|e| AppError::Other(format!("取消 gh 登录中断：{e}")))?
    }
}

#[tauri::command(async)]
pub async fn gh_cli_login() -> Result<GhCliLoginResult> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return Err(AppError::Unsupported("GitHub CLI 登录"));
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        tauri::async_runtime::spawn_blocking(run_login)
            .await
            .map_err(|e| AppError::Other(format!("gh 登录中断：{e}")))?
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_device_code, parse_logged_in_user};

    #[test]
    fn parse_current_gh_status_account() {
        let text = "github.com\n  ✓ Logged in to github.com account ice-juice (keyring)\n  - Active account: true";
        assert_eq!(parse_logged_in_user(text).as_deref(), Some("ice-juice"));
    }

    #[test]
    fn parse_legacy_gh_status_as() {
        let text = "✓ Logged in to github.com as octocat (GITHUB_TOKEN)";
        assert_eq!(parse_logged_in_user(text).as_deref(), Some("octocat"));
    }

    #[test]
    fn parse_ignores_token_lines() {
        let text = "  - Token: gho_************************************";
        assert_eq!(parse_logged_in_user(text), None);
    }

    #[test]
    fn parse_device_code_plain() {
        assert_eq!(parse_device_code("AB12-CD34").as_deref(), Some("AB12-CD34"));
    }

    #[test]
    fn parse_device_code_from_gh_line() {
        assert_eq!(
            parse_device_code("! First copy your one-time code: Wxyz-9k2m").as_deref(),
            Some("WXYZ-9K2M")
        );
    }

    #[test]
    fn parse_device_code_rejects_pat() {
        assert_eq!(parse_device_code("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), None);
    }
}
