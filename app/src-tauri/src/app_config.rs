//! 本机状态（工作空间路径、自动锁定时长等），存于 %APPDATA%。
//! 判断标准：换台电脑还需要的东西放工作空间；只对本机有意义的放这里。
//!
//! 云同步 Secret Key 和代理密码曾经明文写在这里。锁定/退出清不掉，
//! 拷走配置目录就能拿到桶钥匙。现在只进保险库信封；`save()` 写盘前会剥掉。

use crate::error::Result;
use crate::vault::atomic_write;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_AUTO_SYNC_MINUTES: u32 = 30;
pub const MIN_AUTO_SYNC_MINUTES: u32 = 5;
pub const MAX_AUTO_SYNC_MINUTES: u32 = 24 * 60;
/// 内置默认更新源仓库（出厂值，用户可覆盖）。
pub const DEFAULT_UPDATE_REPO: &str = "ice-juice/git-keymaster-app";

fn default_auto_sync_minutes() -> u32 {
    DEFAULT_AUTO_SYNC_MINUTES
}

fn default_true() -> bool {
    true
}

fn default_reveal_grace_minutes() -> u32 {
    5
}

fn default_clipboard_clear_seconds() -> u32 {
    20
}

fn default_account_history_limit() -> u32 {
    10
}

pub const DEFAULT_ATTACHMENT_PER_FILE_LIMIT_MB: u32 = 100;
pub const MAX_ATTACHMENT_PER_FILE_LIMIT_MB: u32 = 100;

fn default_attachment_per_file_limit_mb() -> u32 {
    DEFAULT_ATTACHMENT_PER_FILE_LIMIT_MB
}

fn default_biometric_method() -> String {
    "auto".into()
}

pub fn clamp_biometric_method(raw: &str) -> String {
    match raw.trim() {
        "fingerprint" | "password" | "auto" => raw.trim().into(),
        _ => "password".into(),
    }
}

pub fn clamp_reveal_grace_minutes(minutes: u32) -> u32 {
    minutes.min(30)
}

/// 空闲自动锁定时长。0 表示关闭；其余夹到 1–1440 分钟。
pub fn clamp_auto_lock_minutes(minutes: u32) -> u32 {
    if minutes == 0 {
        0
    } else {
        minutes.clamp(1, 24 * 60)
    }
}

pub fn clamp_clipboard_clear_seconds(seconds: u32) -> u32 {
    if seconds == 0 {
        0
    } else {
        seconds.clamp(5, 120)
    }
}

pub fn clamp_account_history_limit(n: u32) -> u32 {
    n.clamp(1, 50)
}

/// 单文件上限，默认且封顶 100 MB。
pub fn clamp_attachment_per_file_limit_mb(n: u32) -> u32 {
    n.clamp(1, MAX_ATTACHMENT_PER_FILE_LIMIT_MB)
}

pub fn attachment_per_file_limit_bytes(limit_mb: u32) -> u64 {
    u64::from(clamp_attachment_per_file_limit_mb(limit_mb)) * 1024 * 1024
}

/// 0 表示关闭；其余夹到 5–1440 分钟。
fn default_ui_locale() -> String {
    "system".into()
}

/// `system` | `zh` | `en`。其它值回退跟随系统。
pub fn clamp_ui_locale(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "zh" | "en" | "system" => raw.trim().to_ascii_lowercase(),
        _ => "system".into(),
    }
}

pub fn clamp_auto_sync_minutes(minutes: u32) -> u32 {
    if minutes == 0 {
        0
    } else {
        minutes.clamp(MIN_AUTO_SYNC_MINUTES, MAX_AUTO_SYNC_MINUTES)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// 当前工作空间路径（未初始化时为 None）。
    pub workspace_path: Option<String>,
    /// 无操作自动锁定时长（分钟），0 表示永不。
    pub auto_lock_minutes: u32,
    /// 系统休眠/锁屏时立即锁定。
    pub lock_on_sleep: bool,
    /// 登录 Windows 后自动启动本应用。
    #[serde(default)]
    pub launch_at_login: bool,
    /// 免验证天数：0 表示每次开机都要输入访问密码；1–30 为宽限期。
    #[serde(default)]
    pub grace_days: u32,
    /// 云端同步存储配置（v1.1）
    #[serde(default)]
    pub cloud_sync: Option<crate::sync::s3::S3Config>,
    /// 关闭主窗口时的记住选择：`tray` 最小化到托盘，`quit` 退出；`None` 每次询问。
    #[serde(default)]
    pub close_action: Option<String>,
    /// 自动同步间隔（分钟）。0 关闭；默认 30。打开程序时仍会先拉取一次。
    #[serde(default = "default_auto_sync_minutes")]
    pub auto_sync_minutes: u32,
    /// 最近一次自动/手动云同步时间（ISO）。
    #[serde(default)]
    pub last_auto_sync_at: Option<String>,
    /// 最近一次自动同步说明（成功或失败摘要）。
    #[serde(default)]
    pub last_auto_sync_message: Option<String>,
    /// 本机安装实例 ID。换机/重装会变，不进云端工作空间。
    #[serde(default)]
    pub machine_id: String,
    /// 更新源（None 表示使用内置默认 GitHub 仓库）。
    #[serde(default)]
    pub update_source: Option<UpdateSource>,
    /// 启动后自动检查更新（默认开启）。
    #[serde(default = "default_true")]
    pub auto_check_update: bool,
    /// 用户「跳过」的版本号，避免重复打扰。
    #[serde(default)]
    pub skipped_update_version: Option<String>,
    /// 最近一次检查时间（ISO）。
    #[serde(default)]
    pub last_update_check_at: Option<String>,
    /// 本机网络代理（访问 GitHub / GitLab / 更新源等）。None 表示未配置。
    #[serde(default)]
    pub network_proxy: Option<NetworkProxy>,
    /// 查看 OTP/密码的免密时效（分钟）。0 = 每次都验。
    #[serde(default = "default_reveal_grace_minutes")]
    pub reveal_grace_minutes: u32,
    /// 复制机密后清空剪贴板的秒数。0 = 不清空。
    #[serde(default = "default_clipboard_clear_seconds")]
    pub clipboard_clear_seconds: u32,
    /// 每个账号保留的密码历史条数。
    #[serde(default = "default_account_history_limit")]
    pub account_history_limit: u32,
    /// 是否开启本机指纹解锁。默认关。
    #[serde(default)]
    pub biometric_unlock_enabled: bool,
    /// 查看 OTP/账密是否允许指纹重认证。
    #[serde(default)]
    pub biometric_reveal_enabled: bool,
    /// 是否允许指纹替代密码取回 TOTP 原始密钥。默认关。
    #[serde(default)]
    pub biometric_reveal_secret: bool,
    /// 解锁方式：`password` | `fingerprint` | `auto`。
    #[serde(default = "default_biometric_method")]
    pub biometric_method: String,
    /// 运行时界面语言：`system` | `zh` | `en`。只影响 React 文案，不写卸载项。
    #[serde(default = "default_ui_locale")]
    pub ui_locale: String,
    /// 文件保险库 / 备忘录附件单文件上限（MiB）。默认 100，总量不设限。
    #[serde(default = "default_attachment_per_file_limit_mb")]
    pub attachment_per_file_limit_mb: u32,
    /// 仅在 Wi-Fi / 以太网下同步附件与备忘录图片。默认开。
    #[serde(default = "default_true")]
    pub sync_attachments_wifi_only: bool,
    /// 附件不参与自动同步，仅手动推送/拉取。默认关。
    #[serde(default)]
    pub sync_attachments_manual_only: bool,
    /// 移动端主界面再按返回：true 回到系统桌面且不杀进程；false 退出应用。
    #[serde(default)]
    pub mobile_background_run: bool,
    /// 是否允许系统截屏 / 录屏捕获本应用画面。默认关（防护开）。
    /// 旧配置缺字段时 serde 走 `bool` 默认值 false，与出厂行为一致。
    #[serde(default)]
    pub allow_screenshots: bool,
    /// 从旧版 config.json 读出的明文密钥，等首次解锁写进保险库后再丢掉。
    /// 不进序列化：未迁走之前 `save()` 会把它临时补回磁盘，避免改主题冲掉钥匙。
    #[serde(skip)]
    pub pending_legacy_secrets: Option<LegacyConfigSecrets>,
}

/// 旧版写在 config.json 里的两份密钥。进保险库之前只存在这份待迁区。
#[derive(Debug, Clone, Default)]
pub struct LegacyConfigSecrets {
    pub s3_secret_access_key: Option<String>,
    pub proxy_password: Option<String>,
}

impl LegacyConfigSecrets {
    pub fn is_empty(&self) -> bool {
        opt_blank(&self.s3_secret_access_key) && opt_blank(&self.proxy_password)
    }
}

fn opt_blank(value: &Option<String>) -> bool {
    value.as_deref().map(str::trim).unwrap_or("").is_empty()
}

/// 本机 HTTP/HTTPS/SOCKS5 代理。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkProxy {
    /// 总开关。false 时其余字段保留但不生效。
    pub enabled: bool,
    /// "http" | "https" | "socks5"
    pub scheme: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    /// 代理密码。只活在已解锁的内存里；写 config.json 前必须剥掉。
    #[serde(default)]
    pub password: Option<String>,
    /// 本应用拉起的 git HTTPS 是否带上代理环境变量。
    #[serde(default = "default_true")]
    pub apply_to_git_https: bool,
    /// 本应用拉起的 ssh / GIT_SSH_COMMAND 是否注入 ProxyCommand。
    #[serde(default = "default_true")]
    pub apply_to_ssh: bool,
    /// 云同步 reqwest 是否走代理。
    #[serde(default = "default_true")]
    pub apply_to_cloud_sync: bool,
}

impl Default for NetworkProxy {
    fn default() -> Self {
        NetworkProxy {
            enabled: false,
            scheme: "http".into(),
            host: "127.0.0.1".into(),
            port: 7890,
            username: None,
            password: None,
            apply_to_git_https: true,
            apply_to_ssh: true,
            apply_to_cloud_sync: true,
        }
    }
}

/// 本机更新源偏好。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSource {
    /// "github" | "manifest"
    pub kind: String,
    /// github 模式：owner/repo；manifest 模式留空。
    pub repo: Option<String>,
    /// manifest 模式：清单 URL；github 模式留空。
    pub manifest_url: Option<String>,
    /// 是否接受 pre-release（github 模式）。
    #[serde(default)]
    pub include_prerelease: bool,
}

impl Default for UpdateSource {
    fn default() -> Self {
        UpdateSource {
            kind: "github".into(),
            repo: Some(DEFAULT_UPDATE_REPO.into()),
            manifest_url: None,
            include_prerelease: false,
        }
    }
}

impl UpdateSource {
    /// None 配置或空 github 仓库回填为出厂默认源。
    pub fn effective(src: Option<&UpdateSource>) -> Self {
        match src {
            Some(src) => {
                let mut out = src.clone();
                if out.kind.trim().is_empty() {
                    out.kind = "github".into();
                }
                if out.kind == "github"
                    && out
                        .repo
                        .as_deref()
                        .map(str::trim)
                        .unwrap_or("")
                        .is_empty()
                {
                    out.repo = Some(DEFAULT_UPDATE_REPO.into());
                }
                out
            }
            None => UpdateSource::default(),
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            workspace_path: None,
            auto_lock_minutes: 15,
            lock_on_sleep: true,
            launch_at_login: false,
            grace_days: 0,
            cloud_sync: None,
            close_action: None,
            auto_sync_minutes: DEFAULT_AUTO_SYNC_MINUTES,
            last_auto_sync_at: None,
            last_auto_sync_message: None,
            machine_id: String::new(),
            update_source: None,
            auto_check_update: true,
            skipped_update_version: None,
            last_update_check_at: None,
            network_proxy: None,
            reveal_grace_minutes: default_reveal_grace_minutes(),
            clipboard_clear_seconds: default_clipboard_clear_seconds(),
            account_history_limit: default_account_history_limit(),
            biometric_unlock_enabled: false,
            biometric_reveal_enabled: false,
            biometric_reveal_secret: false,
            biometric_method: default_biometric_method(),
            ui_locale: default_ui_locale(),
            attachment_per_file_limit_mb: default_attachment_per_file_limit_mb(),
            sync_attachments_wifi_only: true,
            sync_attachments_manual_only: false,
            mobile_background_run: false,
            allow_screenshots: false,
            pending_legacy_secrets: None,
        }
    }
}

pub fn config_dir() -> PathBuf {
    crate::identity::app_config_dir()
}

fn config_file() -> PathBuf {
    config_dir().join("config.json")
}

impl AppConfig {
    pub fn load() -> Self {
        crate::identity::migrate_app_data();
        let path = config_file();
        let mut cfg = match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => AppConfig::default(),
        };
        // 旧版把桶钥匙和代理密码明文写在这份文件里。先挪到待迁区并清掉
        // 结构体上的密钥字段，这样未解锁的 IPC 读不到；先不 save，免得
        // 保险库还没打开就把磁盘明文抹掉。
        cfg.capture_legacy_secrets();
        cfg.ensure_machine_id();
        cfg
    }

    pub fn ensure_machine_id(&mut self) -> &str {
        if self.machine_id.trim().is_empty() {
            self.machine_id = uuid::Uuid::new_v4().to_string();
            let _ = self.save();
        }
        &self.machine_id
    }

    pub fn current_machine_id() -> String {
        Self::load().machine_id
    }

    pub fn save(&self) -> Result<()> {
        atomic_write(&config_file(), self.to_disk_json()?.as_bytes())
    }

    /// 写盘用的 JSON：已迁走则剥掉密钥；尚未迁走则把待迁明文补回去。
    pub fn to_disk_json(&self) -> Result<String> {
        let mut disk = self.clone();
        if let Some(pending) = disk.pending_legacy_secrets.take() {
            if !pending.is_empty() {
                disk.apply_legacy_secrets(&pending);
            } else {
                disk.clear_runtime_secrets();
            }
        } else {
            disk.clear_runtime_secrets();
        }
        Ok(serde_json::to_string_pretty(&disk)?)
    }

    /// 把结构体上的明文密钥挪进待迁区，并清掉会走 IPC 的字段。
    pub fn capture_legacy_secrets(&mut self) {
        let mut pending = self.pending_legacy_secrets.take().unwrap_or_default();
        if let Some(sk) = self.take_cloud_sync_secret() {
            pending.s3_secret_access_key = Some(sk);
        }
        if let Some(pw) = self.take_proxy_password() {
            pending.proxy_password = Some(pw);
        }
        if !pending.is_empty() {
            self.pending_legacy_secrets = Some(pending);
        }
    }

    pub fn take_pending_legacy_secrets(&mut self) -> Option<LegacyConfigSecrets> {
        self.pending_legacy_secrets.take()
    }

    pub fn take_cloud_sync_secret(&mut self) -> Option<String> {
        let s3 = self.cloud_sync.as_mut()?;
        let sk = std::mem::take(&mut s3.secret_access_key);
        if sk.trim().is_empty() {
            None
        } else {
            Some(sk)
        }
    }

    pub fn take_proxy_password(&mut self) -> Option<String> {
        let proxy = self.network_proxy.as_mut()?;
        let pw = proxy.password.take()?;
        if pw.trim().is_empty() {
            None
        } else {
            Some(pw)
        }
    }

    fn apply_legacy_secrets(&mut self, pending: &LegacyConfigSecrets) {
        if let Some(ref sk) = pending.s3_secret_access_key {
            if let Some(ref mut s3) = self.cloud_sync {
                s3.secret_access_key = sk.clone();
            }
        }
        if let Some(ref pw) = pending.proxy_password {
            if let Some(ref mut proxy) = self.network_proxy {
                proxy.password = Some(pw.clone());
            }
        }
    }

    /// 锁定时清内存里的两份密钥。待迁区不动：还没写进保险库时清掉就丢了。
    pub fn clear_runtime_secrets(&mut self) {
        if let Some(ref mut s3) = self.cloud_sync {
            s3.secret_access_key.clear();
        }
        if let Some(ref mut proxy) = self.network_proxy {
            proxy.password = None;
        }
    }

    pub fn apply_runtime_secrets(&mut self, s3_secret: Option<&str>, proxy_password: Option<&str>) {
        if let Some(sk) = s3_secret {
            if let Some(ref mut s3) = self.cloud_sync {
                if !sk.trim().is_empty() {
                    s3.secret_access_key = sk.to_string();
                }
            }
        }
        if let Some(pw) = proxy_password {
            if let Some(ref mut proxy) = self.network_proxy {
                if !pw.trim().is_empty() {
                    proxy.password = Some(pw.to_string());
                }
            }
        }
    }

    pub fn redact_cloud_sync(&self) -> Option<crate::sync::s3::S3Config> {
        let mut cfg = self.cloud_sync.clone()?;
        cfg.secret_access_key.clear();
        Some(cfg)
    }

    pub fn redact_network_proxy(&self) -> Option<NetworkProxy> {
        let mut proxy = self.network_proxy.clone()?;
        proxy.password = None;
        Some(proxy)
    }

    pub fn has_pending_legacy_secrets(&self) -> bool {
        self.pending_legacy_secrets
            .as_ref()
            .is_some_and(|p| !p.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_config_without_close_action_defaults_to_ask() {
        let raw = r#"{"workspacePath":null,"autoLockMinutes":15,"lockOnSleep":true}"#;
        let cfg: AppConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.close_action, None);
        assert_eq!(cfg.auto_lock_minutes, 15);
        assert_eq!(cfg.auto_sync_minutes, DEFAULT_AUTO_SYNC_MINUTES);
        assert!(cfg.machine_id.is_empty());
        assert_eq!(cfg.update_source, None);
        assert!(cfg.auto_check_update, "旧配置缺少字段时应默认开启自动检查");
        assert_eq!(cfg.skipped_update_version, None);
        assert_eq!(cfg.last_update_check_at, None);
        assert_eq!(cfg.network_proxy, None);
        assert_eq!(cfg.biometric_method, "auto");
        assert_eq!(cfg.ui_locale, "system");
        assert_eq!(
            cfg.attachment_per_file_limit_mb,
            DEFAULT_ATTACHMENT_PER_FILE_LIMIT_MB
        );
        assert!(cfg.sync_attachments_wifi_only);
        assert!(!cfg.sync_attachments_manual_only);
        assert!(
            !cfg.allow_screenshots,
            "旧配置缺字段时应默认禁止截屏"
        );
        assert_eq!(clamp_ui_locale("ZH"), "zh");
        assert_eq!(clamp_ui_locale("en"), "en");
        assert_eq!(clamp_ui_locale("nope"), "system");
        assert_eq!(clamp_biometric_method("fingerprint"), "fingerprint");
        assert_eq!(clamp_biometric_method("face"), "password");
        assert_eq!(clamp_biometric_method("nope"), "password");
        let filled = UpdateSource::effective(cfg.update_source.as_ref());
        assert_eq!(filled.kind, "github");
        assert_eq!(filled.repo.as_deref(), Some(DEFAULT_UPDATE_REPO));
        assert!(!filled.include_prerelease);
    }

    #[test]
    fn empty_github_repo_falls_back_to_default() {
        let src = UpdateSource {
            kind: "github".into(),
            repo: Some("  ".into()),
            manifest_url: None,
            include_prerelease: true,
        };
        let filled = UpdateSource::effective(Some(&src));
        assert_eq!(filled.repo.as_deref(), Some(DEFAULT_UPDATE_REPO));
        assert!(filled.include_prerelease);
    }

    #[test]
    fn custom_github_repo_is_preserved() {
        let src = UpdateSource {
            kind: "github".into(),
            repo: Some("acme/mirror".into()),
            manifest_url: None,
            include_prerelease: false,
        };
        let filled = UpdateSource::effective(Some(&src));
        assert_eq!(filled.repo.as_deref(), Some("acme/mirror"));
    }

    #[test]
    fn clamp_auto_sync_minutes_off_and_range() {
        assert_eq!(clamp_auto_sync_minutes(0), 0);
        assert_eq!(clamp_auto_sync_minutes(1), MIN_AUTO_SYNC_MINUTES);
        assert_eq!(clamp_auto_sync_minutes(30), 30);
        assert_eq!(clamp_auto_sync_minutes(9999), MAX_AUTO_SYNC_MINUTES);
    }

    #[test]
    fn clamp_attachment_per_file_limit_caps_at_100() {
        assert_eq!(clamp_attachment_per_file_limit_mb(0), 1);
        assert_eq!(clamp_attachment_per_file_limit_mb(50), 50);
        assert_eq!(clamp_attachment_per_file_limit_mb(100), 100);
        assert_eq!(clamp_attachment_per_file_limit_mb(999), 100);
        assert_eq!(
            attachment_per_file_limit_bytes(100),
            100 * 1024 * 1024
        );
    }

    fn sample_s3(secret: &str) -> crate::sync::s3::S3Config {
        crate::sync::s3::S3Config {
            endpoint: "https://example.r2.cloudflarestorage.com".into(),
            bucket: "vault".into(),
            region: "auto".into(),
            access_key_id: "AKIAEXAMPLE".into(),
            secret_access_key: secret.into(),
            prefix: "gam-sync/".into(),
        }
    }

    #[test]
    fn migrated_config_json_omits_secrets() {
        let mut cfg = AppConfig::default();
        cfg.cloud_sync = Some(sample_s3("sk-should-not-hit-disk"));
        cfg.network_proxy = Some(NetworkProxy {
            enabled: true,
            scheme: "http".into(),
            host: "127.0.0.1".into(),
            port: 7890,
            username: Some("user".into()),
            password: Some("proxy-secret".into()),
            apply_to_git_https: true,
            apply_to_ssh: true,
            apply_to_cloud_sync: true,
        });

        let json = cfg.to_disk_json().unwrap();
        assert!(!json.contains("sk-should-not-hit-disk"));
        assert!(!json.contains("proxy-secret"));
        assert!(json.contains("AKIAEXAMPLE"));
        assert!(json.contains("127.0.0.1"));
        assert_eq!(
            cfg.cloud_sync.as_ref().unwrap().secret_access_key,
            "sk-should-not-hit-disk",
            "内存里的回填值不应被 to_disk_json 清掉"
        );
    }

    #[test]
    fn pending_legacy_secrets_survive_save_until_migrated() {
        let mut cfg = AppConfig::default();
        cfg.cloud_sync = Some(sample_s3("sk-legacy"));
        cfg.network_proxy = Some(NetworkProxy {
            password: Some("proxy-legacy".into()),
            ..NetworkProxy::default()
        });
        cfg.capture_legacy_secrets();
        assert!(cfg.cloud_sync.as_ref().unwrap().secret_access_key.is_empty());
        assert!(cfg.network_proxy.as_ref().unwrap().password.is_none());
        assert!(cfg.has_pending_legacy_secrets());

        let json = cfg.to_disk_json().unwrap();
        assert!(json.contains("sk-legacy"), "未迁走前改主题不能把磁盘明文冲掉");
        assert!(json.contains("proxy-legacy"));
    }

    #[test]
    fn locked_readers_redact_secrets() {
        let mut cfg = AppConfig::default();
        cfg.cloud_sync = Some(sample_s3("sk-mem"));
        cfg.network_proxy = Some(NetworkProxy {
            password: Some("pw-mem".into()),
            ..NetworkProxy::default()
        });
        let s3 = cfg.redact_cloud_sync().unwrap();
        let proxy = cfg.redact_network_proxy().unwrap();
        assert!(s3.secret_access_key.is_empty());
        assert!(proxy.password.is_none());
        assert_eq!(s3.access_key_id, "AKIAEXAMPLE");
    }
}
