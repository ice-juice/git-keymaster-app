//! 代理校验、URL 拼装，以及挂到各网络通道。

use crate::app_config::{AppConfig, NetworkProxy};
use crate::error::{AppError, Result};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;
use url::Url;

const ALLOWED_SCHEMES: &[&str] = &["http", "https", "socks5"];

/// 总开关打开且字段合法时返回一份克隆；否则 None。
pub fn effective(cfg: &AppConfig) -> Option<NetworkProxy> {
    let p = cfg.network_proxy.as_ref()?;
    if !p.enabled {
        return None;
    }
    Some(p.clone())
}

/// 云同步通道：总开关开且 `apply_to_cloud_sync`。
pub fn for_cloud_sync(cfg: &AppConfig) -> Option<NetworkProxy> {
    let p = effective(cfg)?;
    if p.apply_to_cloud_sync {
        Some(p)
    } else {
        None
    }
}

/// 校验并拼出代理 URL（用户名密码已百分号编码）。
pub fn proxy_url(p: &NetworkProxy) -> Result<Url> {
    let scheme = p.scheme.trim().to_ascii_lowercase();
    if !ALLOWED_SCHEMES.contains(&scheme.as_str()) {
        return Err(AppError::Invalid(format!(
            "代理协议仅支持 http / https / socks5，当前为 {}",
            p.scheme
        )));
    }
    let host = p.host.trim();
    if host.is_empty() {
        return Err(AppError::Invalid("请填写代理主机".into()));
    }
    if host.contains(char::is_whitespace)
        || host.contains('/')
        || host.contains('@')
        || host.contains('#')
        || host.contains('?')
    {
        return Err(AppError::Invalid("代理主机含有非法字符".into()));
    }
    if p.port == 0 {
        return Err(AppError::Invalid("代理端口必须在 1–65535".into()));
    }
    let host_for_url = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    // SOCKS5 用 socks5h：把域名交给代理解析。本机解析 GitHub 容易被污染，更新会在连上代理前就失败。
    let wire_scheme = if scheme == "socks5" { "socks5h" } else { scheme.as_str() };
    let mut url = Url::parse(&format!("{wire_scheme}://{host_for_url}:{}/", p.port))
        .map_err(|e| AppError::Invalid(format!("代理地址无效：{e}")))?;
    if let Some(user) = p.username.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        url.set_username(user)
            .map_err(|_| AppError::Invalid("代理用户名无效".into()))?;
    }
    if let Some(pass) = p.password.as_deref().filter(|s| !s.is_empty()) {
        url.set_password(Some(pass))
            .map_err(|_| AppError::Invalid("代理密码无效".into()))?;
    }
    Ok(url)
}

pub fn apply_reqwest_blocking(
    builder: reqwest::blocking::ClientBuilder,
    p: &NetworkProxy,
) -> Result<reqwest::blocking::ClientBuilder> {
    let url = proxy_url(p)?;
    let proxy = reqwest::Proxy::all(url.as_str())
        .map_err(|e| AppError::Invalid(format!("代理无效：{e}")))?;
    Ok(builder.no_proxy().proxy(proxy))
}

pub fn apply_reqwest_async(
    builder: reqwest::ClientBuilder,
    p: &NetworkProxy,
) -> Result<reqwest::ClientBuilder> {
    let url = proxy_url(p)?;
    let proxy = reqwest::Proxy::all(url.as_str())
        .map_err(|e| AppError::Invalid(format!("代理无效：{e}")))?;
    Ok(builder.no_proxy().proxy(proxy))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn apply_updater(
    builder: tauri_plugin_updater::UpdaterBuilder,
    p: &NetworkProxy,
) -> Result<tauri_plugin_updater::UpdaterBuilder> {
    // 引用与插件相同的 reqwest 0.13，避免 socks 依赖被当成未使用删掉。
    let _ = updater_reqwest::Client::builder;
    Ok(builder.proxy(proxy_url(p)?))
}

/// 给本应用拉起的 `git` 写入代理环境变量；SSH 走 `GIT_SSH_COMMAND` 的 ProxyCommand。
pub fn apply_git_command(cmd: &mut Command, p: &NetworkProxy) -> Result<()> {
    if p.apply_to_git_https {
        let url = proxy_url(p)?.to_string();
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            cmd.env(key, &url);
        }
    }
    if p.apply_to_ssh {
        if let Some(line) = proxy_command_line(p)? {
            merge_git_ssh_proxy(cmd, &git_ssh_proxy_suffix(&line));
        }
    }
    Ok(())
}

/// 给本应用拉起的 `ssh` 追加 `-o ProxyCommand=...`。
pub fn apply_ssh_command(cmd: &mut Command, p: &NetworkProxy) -> Result<()> {
    if !p.apply_to_ssh {
        return Ok(());
    }
    if let Some(line) = proxy_command_line(p)? {
        cmd.args(["-o", &format!("ProxyCommand={line}")]);
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct SshProxyHelper {
    pub found: bool,
    pub name: Option<String>,
    pub path: Option<PathBuf>,
}

pub fn ssh_helper_status() -> SshProxyHelper {
    if let Some(path) = find_connect() {
        return SshProxyHelper {
            found: true,
            name: Some("connect".into()),
            path: Some(path),
        };
    }
    if let Some(path) = look_in_path("ncat") {
        return SshProxyHelper {
            found: true,
            name: Some("ncat".into()),
            path: Some(path),
        };
    }
    SshProxyHelper {
        found: false,
        name: None,
        path: None,
    }
}

const EGRESS_GEO_URLS: &[&str] = &[
    "https://ipwho.is/",
    "https://ipinfo.io/json",
    "https://api.ip.sb/geoip",
];
const EGRESS_IP_URLS: &[&str] = &[
    "https://api.ipify.org",
    "https://checkip.amazonaws.com",
    "https://icanhazip.com",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EgressPlace {
    pub ip: String,
    pub location: Option<String>,
    pub timezone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EgressInfo {
    pub ip: String,
    pub location: Option<String>,
    pub timezone: Option<String>,
    pub ms: u128,
}

/// 只确认代理主机端口能连上，不代表协议或外网可用。
pub fn probe_proxy_tcp(p: &NetworkProxy) -> Result<u128> {
    use std::net::ToSocketAddrs;
    let host = p.host.trim();
    let endpoint = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{}", p.port)
    } else {
        format!("{host}:{}", p.port)
    };
    let addrs = endpoint
        .to_socket_addrs()
        .map_err(|e| AppError::Other(format!("无法解析代理主机：{e}")))?;
    let start = Instant::now();
    let mut last = None;
    let mut tried = false;
    for addr in addrs {
        tried = true;
        match std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(3)) {
            Ok(stream) => {
                drop(stream);
                return Ok(start.elapsed().as_millis());
            }
            Err(e) => last = Some(e),
        }
    }
    if !tried {
        return Err(AppError::Other(format!("无法解析代理主机 {endpoint}")));
    }
    Err(AppError::Other(format!(
        "无法连接代理 {endpoint}：{}",
        last.map(|e| e.to_string()).unwrap_or_else(|| "连接失败".into())
    )))
}

pub fn proxied_blocking_client(p: &NetworkProxy) -> Result<reqwest::blocking::Client> {
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent(crate::identity::USER_AGENT)
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::limited(4));
    builder = apply_reqwest_blocking(builder, p)?;
    builder
        .build()
        .map_err(|e| AppError::Other(format!("HTTP 客户端构建失败：{e}")))
}

/// 经代理查询出口 IP、位置和时区。优先用带地理信息的接口。
pub fn fetch_egress_ip(client: &reqwest::blocking::Client) -> Result<EgressInfo> {
    let start = Instant::now();
    let mut last = "经代理访问外网失败".to_string();
    let mut ip_only: Option<EgressPlace> = None;
    for url in EGRESS_GEO_URLS.iter().chain(EGRESS_IP_URLS.iter()) {
        match client
            .get(*url)
            .header("Accept", "application/json, text/plain")
            .timeout(std::time::Duration::from_secs(8))
            .send()
        {
            Ok(resp) if resp.status().is_success() => {
                let text = resp.text().unwrap_or_default();
                if let Some(place) = parse_egress_place(&text) {
                    if place.location.is_some() || place.timezone.is_some() {
                        return Ok(EgressInfo {
                            ip: place.ip,
                            location: place.location,
                            timezone: place.timezone,
                            ms: start.elapsed().as_millis(),
                        });
                    }
                    ip_only.get_or_insert(place);
                } else {
                    last = format!("外网响应不是 IP 信息（{url}）");
                }
            }
            Ok(resp) => last = format!("查询出口 IP 返回 HTTP {}（{url}）", resp.status()),
            Err(e) => last = redact(&format!("经代理访问外网失败：{e}")),
        }
    }
    if let Some(place) = ip_only {
        return Ok(EgressInfo {
            ip: place.ip,
            location: place.location,
            timezone: place.timezone,
            ms: start.elapsed().as_millis(),
        });
    }
    Err(AppError::Other(last))
}

pub fn parse_egress_place(body: &str) -> Option<EgressPlace> {
    let trimmed = body.trim();
    if trimmed.starts_with('{') {
        let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
        if value.get("success").and_then(|v| v.as_bool()) == Some(false) {
            return None;
        }
        let ip = parse_egress_ip(json_str(&value, &["ip"])?.as_str())?;
        return Some(EgressPlace {
            ip,
            location: egress_location(&value),
            timezone: egress_timezone(&value),
        });
    }
    Some(EgressPlace {
        ip: parse_egress_ip(trimmed)?,
        location: None,
        timezone: None,
    })
}

fn egress_location(value: &serde_json::Value) -> Option<String> {
    let country = json_str(value, &["country_code", "countryCode"]).or_else(|| {
        json_str(value, &["country"]).filter(|s| s.chars().count() == 2)
    });
    let region = json_str(value, &["region", "region_name", "regionName"]);
    let city = json_str(value, &["city"]);
    let parts: Vec<String> = [country, region, city]
        .into_iter()
        .flatten()
        .map(|s| s.to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" / "))
    }
}

fn egress_timezone(value: &serde_json::Value) -> Option<String> {
    let zone = value.get("timezone").or_else(|| value.get("time_zone"))?;
    let text = zone
        .as_str()
        .map(str::to_string)
        .or_else(|| json_str(zone, &["id", "name"]));
    text.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn json_str(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(|v| v.as_str()) {
            let text = text.trim();
            if !text.is_empty() && text != "null" {
                return Some(text.to_string());
            }
        }
    }
    None
}

pub fn parse_egress_ip(body: &str) -> Option<String> {
    let token = body.split_whitespace().next()?.trim();
    let ip: std::net::IpAddr = token.parse().ok()?;
    if ip.is_unspecified() {
        return None;
    }
    Some(ip.to_string())
}

/// 经代理 GET https://github.com，成功返回毫秒。
pub fn test_github_https(p: &NetworkProxy) -> Result<u128> {
    test_github_with_client(&proxied_blocking_client(p)?)
}

pub fn test_github_with_client(client: &reqwest::blocking::Client) -> Result<u128> {
    let start = Instant::now();
    let resp = client
        .get("https://github.com")
        .send()
        .map_err(|e| AppError::Other(redact(&format!("无法经代理访问 GitHub：{e}"))))?;
    let code = resp.status();
    if !code.is_success() && !code.is_redirection() {
        return Err(AppError::Other(format!(
            "经代理访问 GitHub 返回 HTTP {}",
            code.as_u16()
        )));
    }
    Ok(start.elapsed().as_millis())
}

pub fn ssh_auth_unsupported(p: &NetworkProxy) -> bool {
    p.apply_to_ssh
        && (p
            .username
            .as_deref()
            .map(str::trim)
            .is_some_and(|s| !s.is_empty())
            || p.password.as_deref().is_some_and(|s| !s.is_empty()))
}

fn proxy_command_line(p: &NetworkProxy) -> Result<Option<String>> {
    if ssh_auth_unsupported(p) {
        return Ok(None);
    }
    let helper = ssh_helper_status();
    let Some(path) = helper.path.as_ref() else {
        return Ok(None);
    };
    let kind = helper.name.as_deref().unwrap_or("connect");
    Ok(Some(format_proxy_command(path, kind, p)))
}

fn format_proxy_command(helper_path: &Path, kind: &str, p: &NetworkProxy) -> String {
    let exe = helper_path.to_string_lossy().replace('\\', "/");
    let quoted = if exe.contains(' ') {
        format!("\"{exe}\"")
    } else {
        exe
    };
    let target = format!("{}:{}", p.host.trim(), p.port);
    match (kind, p.scheme.trim().to_ascii_lowercase().as_str()) {
        ("ncat", "socks5") => format!("{quoted} --proxy-type socks5 --proxy {target} %h %p"),
        ("ncat", _) => format!("{quoted} --proxy-type http --proxy {target} %h %p"),
        (_, "socks5") => format!("{quoted} -S {target} %h %p"),
        _ => format!("{quoted} -H {target} %h %p"),
    }
}

/// `GIT_SSH_COMMAND` 由 shell 再解析一次。`line` 在路径含空格时已经带了双引号，
/// 外面若再套双引号，`Program Files` 会被拆成独立参数，ssh 把它当成主机名，
/// 于是报 `hostname contains invalid characters`，克隆看起来像没有结果。
fn git_ssh_proxy_suffix(line: &str) -> String {
    let escaped = line.replace('\'', r#"'\''"#);
    format!(" -o ProxyCommand='{escaped}'")
}

/// `run_git` 先写好 `GIT_SSH_COMMAND` 再调用本函数时，把 ProxyCommand 接到现有值后面。
pub fn merge_proxy_into_git_ssh(existing: &str, p: &NetworkProxy) -> Result<String> {
    if !p.apply_to_ssh {
        return Ok(existing.to_string());
    }
    let Some(line) = proxy_command_line(p)? else {
        return Ok(existing.to_string());
    };
    if existing.contains("ProxyCommand=") {
        return Ok(existing.to_string());
    }
    Ok(format!("{existing}{}", git_ssh_proxy_suffix(&line)))
}

fn merge_git_ssh_proxy(cmd: &mut Command, extra: &str) {
    let current = cmd
        .get_envs()
        .find(|(k, _)| k.to_string_lossy() == "GIT_SSH_COMMAND")
        .and_then(|(_, v)| v.map(|s| s.to_string_lossy().into_owned()));
    if let Some(cur) = current {
        if !cur.contains("ProxyCommand=") {
            cmd.env("GIT_SSH_COMMAND", format!("{cur}{extra}"));
        }
    } else {
        cmd.env("GIT_SSH_COMMAND", format!("ssh{extra}"));
    }
}

fn find_connect() -> Option<PathBuf> {
    if let Some(git) = look_in_path("git") {
        if let Some(parent) = git.parent() {
            for rel in [
                "../mingw64/bin/connect.exe",
                "../usr/bin/connect.exe",
                "connect.exe",
                "../mingw64/bin/connect",
                "../usr/bin/connect",
            ] {
                let candidate = parent.join(rel);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    look_in_path("connect")
}

fn look_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names = if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_string()]
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(&path) {
        for n in &names {
            let p = dir.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn redact(raw: &str) -> String {
    let mut out = raw.to_string();
    if let Ok(url) = Url::parse(
        raw.split_whitespace()
            .find(|s| s.contains("://"))
            .unwrap_or(""),
    ) {
        if !url.username().is_empty() || url.password().is_some() {
            let mut safe = url.clone();
            let _ = safe.set_username("");
            let _ = safe.set_password(None);
            out = out.replace(url.as_str(), safe.as_str());
        }
    }
    if let Some(idx) = out.find("://") {
        if let Some(at) = out[idx..].find('@') {
            let start = idx + 3;
            let end = idx + at;
            if end > start {
                out.replace_range(start..end, "***");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(scheme: &str) -> NetworkProxy {
        NetworkProxy {
            enabled: true,
            scheme: scheme.into(),
            host: "127.0.0.1".into(),
            port: 7890,
            username: None,
            password: None,
            apply_to_git_https: true,
            apply_to_ssh: true,
            apply_to_cloud_sync: true,
        }
    }

    #[test]
    fn proxy_url_plain_http() {
        let u = proxy_url(&sample("http")).unwrap();
        assert_eq!(u.as_str(), "http://127.0.0.1:7890/");
    }

    #[test]
    fn proxy_url_encodes_userinfo() {
        let mut p = sample("socks5");
        p.username = Some("u r".into());
        p.password = Some("p@ss".into());
        let u = proxy_url(&p).unwrap();
        assert_eq!(u.scheme(), "socks5h");
        assert_eq!(u.username(), "u%20r");
        assert_eq!(u.password(), Some("p%40ss"));
        assert!(!u.as_str().contains("p@ss"));
    }

    #[test]
    fn proxy_url_rejects_bad_scheme_and_host() {
        let mut p = sample("ftp");
        assert!(proxy_url(&p).is_err());
        p.scheme = "http".into();
        p.host = "bad host".into();
        assert!(proxy_url(&p).is_err());
        p.host = "127.0.0.1".into();
        p.port = 0;
        assert!(proxy_url(&p).is_err());
    }

    #[test]
    fn effective_requires_enabled() {
        let mut cfg = AppConfig::default();
        assert!(effective(&cfg).is_none());
        let mut p = sample("http");
        p.enabled = false;
        cfg.network_proxy = Some(p.clone());
        assert!(effective(&cfg).is_none());
        p.enabled = true;
        cfg.network_proxy = Some(p);
        assert!(effective(&cfg).is_some());
    }

    #[test]
    fn cloud_sync_can_be_opted_out() {
        let mut cfg = AppConfig::default();
        let mut p = sample("http");
        p.apply_to_cloud_sync = false;
        cfg.network_proxy = Some(p);
        assert!(effective(&cfg).is_some());
        assert!(for_cloud_sync(&cfg).is_none());
    }

    #[test]
    fn old_config_without_proxy_deserializes() {
        let raw = r#"{"workspacePath":null,"autoLockMinutes":15,"lockOnSleep":true}"#;
        let cfg: AppConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.network_proxy, None);
        let stored = r#"{"enabled":true,"scheme":"socks5","host":"127.0.0.1","port":1080}"#;
        let p: NetworkProxy = serde_json::from_str(stored).unwrap();
        assert!(p.apply_to_git_https);
        assert!(p.apply_to_ssh);
        assert!(p.apply_to_cloud_sync);
    }

    #[test]
    fn format_connect_and_ncat() {
        let p = sample("socks5");
        let line = format_proxy_command(Path::new("C:/Git/mingw64/bin/connect.exe"), "connect", &p);
        assert_eq!(line, "C:/Git/mingw64/bin/connect.exe -S 127.0.0.1:7890 %h %p");
        let spaced = format_proxy_command(Path::new("C:/Program Files/connect.exe"), "connect", &p);
        assert!(spaced.starts_with('\"'));
        let http = sample("http");
        let ncat = format_proxy_command(Path::new("/usr/bin/ncat"), "ncat", &http);
        assert!(ncat.contains("--proxy-type http"));
    }

    #[test]
    fn merge_git_ssh_appends_once() {
        let p = sample("http");
        let helper = ssh_helper_status();
        if !helper.found {
            let base = "\"ssh\" -o BatchMode=yes";
            // 无助手时不改写
            let out = merge_proxy_into_git_ssh(base, &p).unwrap();
            assert_eq!(out, base);
            return;
        }
        let out = merge_proxy_into_git_ssh("\"ssh\" -o BatchMode=yes", &p).unwrap();
        assert!(out.contains("ProxyCommand='"));
        assert!(!out.contains("ProxyCommand=\""));
        let again = merge_proxy_into_git_ssh(&out, &p).unwrap();
        assert_eq!(again.matches("ProxyCommand=").count(), 1);
    }

    #[test]
    fn proxy_suffix_keeps_spaced_path_in_one_shell_word() {
        let line = format_proxy_command(
            Path::new("C:/Program Files/Git/mingw64/bin/connect.exe"),
            "connect",
            &sample("socks5"),
        );
        let suffix = git_ssh_proxy_suffix(&line);
        assert_eq!(
            suffix,
            " -o ProxyCommand='\"C:/Program Files/Git/mingw64/bin/connect.exe\" -S 127.0.0.1:7890 %h %p'"
        );
    }

    #[test]
    fn redact_strips_userinfo() {
        let s = redact("failed http://alice:secret@127.0.0.1:7890/path");
        assert!(!s.contains("secret"));
        assert!(!s.contains("alice"));
    }

    #[test]
    fn parse_egress_place_reads_geo_json() {
        let ipwho = r#"{"success":true,"ip":"38.80.191.155","country_code":"US","region":"California","city":"Los Angeles","timezone":{"id":"America/Los_Angeles"}}"#;
        let place = parse_egress_place(ipwho).unwrap();
        assert_eq!(place.ip, "38.80.191.155");
        assert_eq!(place.location.as_deref(), Some("us / california / los angeles"));
        assert_eq!(place.timezone.as_deref(), Some("America/Los_Angeles"));

        let ipinfo = r#"{"ip":"38.80.191.155","city":"Los Angeles","region":"California","country":"US","timezone":"America/Los_Angeles"}"#;
        let place = parse_egress_place(ipinfo).unwrap();
        assert_eq!(place.location.as_deref(), Some("us / california / los angeles"));
        assert_eq!(place.timezone.as_deref(), Some("America/Los_Angeles"));
        assert!(parse_egress_place(r#"{"success":false}"#).is_none());
    }

    #[test]
    fn parse_egress_ip_accepts_plain_v4_and_v6() {
        assert_eq!(parse_egress_ip("203.0.113.8\n").as_deref(), Some("203.0.113.8"));
        assert_eq!(parse_egress_ip("  2001:db8::1  ").as_deref(), Some("2001:db8::1"));
        assert!(parse_egress_ip("<html>not an ip</html>").is_none());
        assert!(parse_egress_ip("0.0.0.0").is_none());
        assert!(parse_egress_ip("").is_none());
    }

    #[test]
    fn probe_proxy_tcp_reaches_local_listener() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut p = sample("http");
        p.port = port;
        let ms = probe_proxy_tcp(&p).unwrap();
        assert!(ms < 3_000);
        drop(listener);
    }

    #[test]
    fn ssh_auth_blocks_proxycommand() {
        let mut p = sample("http");
        p.username = Some("u".into());
        p.password = Some("p".into());
        assert!(ssh_auth_unsupported(&p));
        assert!(proxy_command_line(&p).unwrap().is_none());
    }

    /// 在本机端口上收下代理客户端的第一包字节。用来区分 SOCKS 握手和 HTTP。
    fn proxy_preface(proxy_template: &str) -> Vec<u8> {
        use std::io::Read;
        use std::net::TcpListener;
        use std::time::{Duration, Instant};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        // 插件的 reqwest 用 rustls-no-provider，建客户端前要装上和更新器一样的 ring。
        let _ = rustls::crypto::ring::default_provider().install_default();
        let proxy = proxy_template.replace("{port}", &port.to_string());
        let proxy = updater_reqwest::Proxy::all(&proxy).unwrap();
        let client = updater_reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .proxy(proxy)
            .build()
            .unwrap();
        let worker = std::thread::spawn(move || {
            let _ = client.get("http://example.com/").send();
        });
        let start = Instant::now();
        let mut sock = loop {
            match listener.accept() {
                Ok((sock, _)) => break sock,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if start.elapsed() > Duration::from_secs(3) {
                        panic!("更新客户端没有连上代理");
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => panic!("accept: {e}"),
            }
        };
        sock.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut buf = [0u8; 24];
        let n = sock.read(&mut buf).unwrap_or(0);
        let _ = worker.join();
        buf[..n].to_vec()
    }

    #[test]
    fn updater_socks_proxy_sends_socks_greeting() {
        let bytes = proxy_preface("socks5h://127.0.0.1:{port}");
        assert_eq!(
            bytes.first().copied(),
            Some(0x05),
            "SOCKS5 应先发版本字节，实际 {}",
            String::from_utf8_lossy(&bytes)
        );
    }

    #[test]
    fn updater_http_proxy_sends_http() {
        let bytes = proxy_preface("http://127.0.0.1:{port}");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.starts_with("GET ") || text.starts_with("CONNECT "),
            "HTTP 代理应收到 HTTP 请求，实际 {text}"
        );
    }
}
