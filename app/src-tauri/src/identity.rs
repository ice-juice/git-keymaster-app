//! 产品本机标识。只在这里改名字，其它模块引用这些常量。
//!
//! 旧名 `git-account-manager` 只读兼容：首次启动把旧目录/文件拷到新位置，
//! 旧副本保留作备份，不覆盖已经存在的新路径。

use std::path::{Path, PathBuf};

/// 本机状态目录名（`%APPDATA%` / 临时目录下）。
pub const APP_DIR: &str = "git-keymaster";
pub const LEGACY_APP_DIR: &str = "git-account-manager";

/// `~/.ssh` 下的配置镜像文件名。
pub const SSH_INCLUDE: &str = "git-keymaster.config";
pub const LEGACY_SSH_INCLUDE: &str = "git-account-manager.config";

/// Git ssh-agent 固定套接字与 pid 文件名。
pub const AGENT_SOCK: &str = "git-keymaster";
pub const AGENT_PID: &str = "git-keymaster.pid";
pub const LEGACY_AGENT_SOCK: &str = "git-account-manager";
pub const LEGACY_AGENT_PID: &str = "git-account-manager.pid";

/// `~/.ssh/config` 托管区块标记。写入只用新标记；读取同时认旧标记。
pub const SSH_BEGIN: &str = "# ===== BEGIN managed by git-keymaster =====";
pub const SSH_END: &str = "# ===== END managed by git-keymaster =====";
pub const LEGACY_SSH_BEGIN: &str = "# ===== BEGIN managed by git-account-manager =====";
pub const LEGACY_SSH_END: &str = "# ===== END managed by git-account-manager =====";

/// PowerShell / Bash 启动脚本里的 agent 环境块。
pub const AGENT_BEGIN: &str = "# >>> git-keymaster agent >>>";
pub const AGENT_END: &str = "# <<< git-keymaster agent <<<";
pub const LEGACY_AGENT_BEGIN: &str = "# >>> git-account-manager agent >>>";
pub const LEGACY_AGENT_END: &str = "# <<< git-account-manager agent <<<";

pub const ENV_PS1: &str = "git-keymaster-agent.env.ps1";
pub const ENV_SH: &str = "git-keymaster-agent.env.sh";
pub const LEGACY_ENV_PS1: &str = "git-account-manager-agent.env.ps1";
pub const LEGACY_ENV_SH: &str = "git-account-manager-agent.env.sh";

/// 导出的 S3/R2 配置文件 `kind`。
pub const S3_KIND: &str = "git-keymaster-s3";
pub const LEGACY_S3_KIND: &str = "git-account-manager-s3";

/// 单实例锁文件名。
pub const INSTANCE_LOCK: &str = "com.jeck.gitkeymaster.instance.lock";
pub const LEGACY_INSTANCE_LOCK: &str = "com.jeck.gitaccountmanager.instance.lock";

/// HTTP User-Agent。
pub const USER_AGENT: &str = "git-keymaster";

/// 由宿主在启动早期注入的本机配置根目录。
///
/// 移动端沙箱目录只能通过 Tauri 的 path API 拿到（Android 要问 Context），
/// 所以 `run()` 会在建 `AppState` 之前调用 [`init_base_dir`] 把它填进来。
/// 桌面端也走同一条路，`%APPDATA%` 只作为未注入时的兜底。
static BASE_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// 注入本机配置根目录。只有第一次调用生效，重复调用被忽略。
///
/// **必须在任何 `AppConfig::load()` / `config_base_dir()` 之前调用**，
/// 否则移动端会退化到临时目录，保险库可能被系统清空。
pub fn init_base_dir(dir: PathBuf) {
    let _ = BASE_DIR.set(dir);
}

/// 未注入 Tauri 目录时，按宿主选择可跨重启保留的配置根。
///
/// Windows 继续用 `%APPDATA%`（与现有 `git-keymaster` 目录一致）。
/// macOS / Linux 没有 `APPDATA`，以前会落到临时目录，虚拟机或系统重启后配置消失，
/// 启动就被当成未初始化。这里改到用户配置目录。只有连家目录都没有时才用临时目录。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostKind {
    Windows,
    Macos,
    Linux,
    Other,
}

fn non_empty(raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim).filter(|s| !s.is_empty())
}

pub fn resolve_config_base(
    appdata: Option<&str>,
    home: Option<&str>,
    xdg_config_home: Option<&str>,
    host: HostKind,
) -> PathBuf {
    if let Some(dir) = non_empty(appdata) {
        return PathBuf::from(dir);
    }
    match host {
        HostKind::Windows => {
            if let Some(home) = non_empty(home) {
                return PathBuf::from(home).join("AppData").join("Roaming");
            }
        }
        HostKind::Macos => {
            if let Some(home) = non_empty(home) {
                return PathBuf::from(home)
                    .join("Library")
                    .join("Application Support");
            }
        }
        HostKind::Linux => {
            if let Some(xdg) = non_empty(xdg_config_home) {
                return PathBuf::from(xdg);
            }
            if let Some(home) = non_empty(home) {
                return PathBuf::from(home).join(".config");
            }
        }
        HostKind::Other => {}
    }
    std::env::temp_dir()
}

fn current_host() -> HostKind {
    #[cfg(windows)]
    {
        HostKind::Windows
    }
    #[cfg(target_os = "macos")]
    {
        HostKind::Macos
    }
    #[cfg(target_os = "linux")]
    {
        HostKind::Linux
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        HostKind::Other
    }
}

/// 本机配置根目录。
///
/// 优先用 [`init_base_dir`] 注入的值（移动端沙箱目录）。
/// 桌面未注入时走 [`resolve_config_base`]，避免 macOS / Linux 把配置写进临时目录。
pub fn config_base_dir() -> PathBuf {
    if let Some(dir) = BASE_DIR.get() {
        return dir.clone();
    }
    resolve_config_base(
        std::env::var("APPDATA").ok().as_deref(),
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok()
            .as_deref(),
        std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        current_host(),
    )
}

pub fn app_config_dir() -> PathBuf {
    config_base_dir().join(APP_DIR)
}

/// 移动端保险库固定目录：`<配置根>/workspace`。
pub fn workspace_dir() -> PathBuf {
    config_base_dir().join("workspace")
}

/// 冷启动时要扫的配置根。Android 上 JS `appDataDir()` 有时是包根，
/// Rust `app_data_dir()` 则是 `files/`，两边都可能已经落下 vault。
pub fn workspace_search_roots_from(base: PathBuf) -> Vec<PathBuf> {
    let mut roots = vec![base.clone()];
    if let Some(parent) = base.parent() {
        if parent != base.as_path() {
            roots.push(parent.to_path_buf());
        }
    }
    roots
}

pub fn workspace_search_roots() -> Vec<PathBuf> {
    workspace_search_roots_from(config_base_dir())
}

pub fn legacy_app_config_dir() -> PathBuf {
    config_base_dir().join(LEGACY_APP_DIR)
}

/// 若新目录还没有 `config.json`、旧目录存在，则整目录拷贝到新位置。旧目录不删。
pub fn migrate_app_data() {
    let new_dir = app_config_dir();
    let old_dir = legacy_app_config_dir();
    if new_dir.join("config.json").is_file() {
        return;
    }
    if !old_dir.is_dir() {
        return;
    }
    match copy_dir_recursive(&old_dir, &new_dir) {
        Ok(()) => log::info!(
            "已从旧本机目录拷贝配置：{} → {}（旧目录保留作备份）",
            old_dir.display(),
            new_dir.display()
        ),
        Err(e) => log::warn!(
            "拷贝旧本机目录失败：{} → {}：{e}",
            old_dir.display(),
            new_dir.display()
        ),
    }
}

/// Android 上 JS `appDataDir()` 有时是包根，Rust `app_data_dir()` 是 `files/`。
/// 若上层已经有 `git-keymaster/config.json` 而当前配置根还没有，拷过来。
pub fn adopt_parent_app_config() {
    let new_dir = app_config_dir();
    if new_dir.join("config.json").is_file() {
        return;
    }
    let base = config_base_dir();
    let Some(parent) = base.parent() else {
        return;
    };
    let old_dir = parent.join(APP_DIR);
    if old_dir == new_dir || !old_dir.join("config.json").is_file() {
        return;
    }
    match copy_dir_recursive(&old_dir, &new_dir) {
        Ok(()) => log::info!(
            "已从沙箱上层目录拷贝配置：{} → {}",
            old_dir.display(),
            new_dir.display()
        ),
        Err(e) => log::warn!(
            "拷贝沙箱上层配置失败：{} → {}：{e}",
            old_dir.display(),
            new_dir.display()
        ),
    }
}

pub fn copy_file_if_missing(src: &Path, dest: &Path) -> bool {
    if dest.exists() || !src.is_file() {
        return false;
    }
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::copy(src, dest) {
        Ok(_) => {
            log::info!("已拷贝 {} → {}（旧文件保留作备份）", src.display(), dest.display());
            true
        }
        Err(e) => {
            log::warn!("拷贝 {} → {} 失败：{e}", src.display(), dest.display());
            false
        }
    }
}

pub fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if !to.exists() {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

pub fn accepted_s3_kind(kind: &str) -> bool {
    kind.is_empty() || kind == S3_KIND || kind == LEGACY_S3_KIND
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_dir_keeps_old_and_skips_existing() {
        let root = std::env::temp_dir().join(format!(
            "gam-ident-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let old = root.join("old");
        let new = root.join("new");
        std::fs::create_dir_all(old.join("sub")).unwrap();
        std::fs::write(old.join("config.json"), b"old-cfg").unwrap();
        std::fs::write(old.join("sub").join("a.txt"), b"a").unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("keep.json"), b"keep").unwrap();
        copy_dir_recursive(&old, &new).unwrap();
        assert_eq!(std::fs::read_to_string(new.join("config.json")).unwrap(), "old-cfg");
        assert_eq!(std::fs::read_to_string(new.join("sub").join("a.txt")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(new.join("keep.json")).unwrap(), "keep");
        assert!(old.join("config.json").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_search_includes_base_and_parent() {
        let base = PathBuf::from("/data/user/0/com.jeck.gitkeymaster/files");
        let roots = workspace_search_roots_from(base);
        assert_eq!(
            roots,
            vec![
                PathBuf::from("/data/user/0/com.jeck.gitkeymaster/files"),
                PathBuf::from("/data/user/0/com.jeck.gitkeymaster"),
            ]
        );
    }

    #[test]
    fn linux_and_macos_config_base_is_not_temp() {
        let linux = resolve_config_base(None, Some("/home/dev"), None, HostKind::Linux);
        assert_eq!(linux, PathBuf::from("/home/dev/.config"));
        let xdg = resolve_config_base(None, Some("/home/dev"), Some("/data/cfg"), HostKind::Linux);
        assert_eq!(xdg, PathBuf::from("/data/cfg"));
        let mac = resolve_config_base(None, Some("/Users/dev"), None, HostKind::Macos);
        assert_eq!(
            mac,
            PathBuf::from("/Users/dev/Library/Application Support")
        );
        let win = resolve_config_base(Some(r"C:\Users\dev\AppData\Roaming"), None, None, HostKind::Windows);
        assert_eq!(win, PathBuf::from(r"C:\Users\dev\AppData\Roaming"));
        let win_fallback = resolve_config_base(None, Some(r"C:\Users\dev"), None, HostKind::Windows);
        assert_eq!(
            win_fallback,
            PathBuf::from(r"C:\Users\dev").join("AppData").join("Roaming")
        );
    }

    #[test]
    fn s3_kind_accepts_legacy_and_new() {
        assert!(accepted_s3_kind(""));
        assert!(accepted_s3_kind(S3_KIND));
        assert!(accepted_s3_kind(LEGACY_S3_KIND));
        assert!(!accepted_s3_kind("other-app"));
    }
}
