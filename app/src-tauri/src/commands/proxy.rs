//! 网络代理 IPC。

use crate::app_config::NetworkProxy;
use crate::commands::{recover_lock, vault_is_unlocked, AppState};
use crate::error::{AppError, Result};
use crate::net;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestResult {
    pub proxy_ok: bool,
    pub proxy_ms: Option<u128>,
    pub proxy_error: Option<String>,
    pub egress_ok: bool,
    pub egress_ip: Option<String>,
    pub egress_location: Option<String>,
    pub egress_timezone: Option<String>,
    pub egress_ms: Option<u128>,
    pub egress_error: Option<String>,
    pub https_ok: bool,
    pub https_ms: Option<u128>,
    pub https_error: Option<String>,
    pub ssh_helper_found: bool,
    pub ssh_helper_name: Option<String>,
    pub ssh_note: Option<String>,
}

#[tauri::command]
pub fn get_network_proxy(state: State<AppState>) -> Result<Option<NetworkProxy>> {
    let unlocked = vault_is_unlocked(&state);
    let cfg = recover_lock(&state.config);
    if unlocked {
        Ok(cfg.network_proxy.clone())
    } else {
        Ok(cfg.redact_network_proxy())
    }
}

#[tauri::command]
pub fn save_network_proxy(state: State<AppState>, proxy: Option<NetworkProxy>) -> Result<()> {
    if !vault_is_unlocked(&state) {
        return Err(AppError::Locked);
    }
    if let Some(ref p) = proxy {
        if p.enabled {
            let _ = net::proxy_url(p)?;
        } else if !p.host.trim().is_empty() {
            let _ = net::proxy_url(p)?;
        }
    }
    let vault = {
        let guard = recover_lock(&state.vault);
        guard.as_ref().filter(|v| v.is_unlocked()).cloned().ok_or(AppError::Locked)?
    };
    match proxy.as_ref() {
        Some(p) => {
            crate::store::set_proxy_password(
                &vault,
                p.password.clone().filter(|s| !s.trim().is_empty()),
            )?;
        }
        None => crate::store::set_proxy_password(&vault, None)?,
    }
    let mut cfg = recover_lock(&state.config);
    let _ = cfg.take_pending_legacy_secrets();
    cfg.network_proxy = proxy;
    cfg.save()
}

#[tauri::command]
pub fn test_network_proxy(proxy: NetworkProxy) -> Result<ProxyTestResult> {
    let _ = net::proxy_url(&proxy)?;
    let helper = net::ssh_helper_status();
    let mut ssh_note = None;
    if net::ssh_auth_unsupported(&proxy) {
        ssh_note = Some(
            "SSH 通道暂不支持带用户名密码的代理，请改用本机无认证端口，或只开启 Git HTTPS / 应用内请求。"
                .into(),
        );
    } else if proxy.apply_to_ssh && !helper.found {
        ssh_note = Some(
            crate::ssh::toolchain::missing_ssh_proxy_helper()
                .into(),
        );
    } else if proxy.apply_to_ssh && helper.found {
        ssh_note = Some(format!(
            "将使用 {} 为 SSH 注入 ProxyCommand。",
            helper.name.as_deref().unwrap_or("助手")
        ));
    }

    let (proxy_ok, proxy_ms, proxy_error) = match net::probe_proxy_tcp(&proxy) {
        Ok(ms) => (true, Some(ms), None),
        Err(e) => (false, None, Some(e.to_string())),
    };
    let (
        egress_ok,
        egress_ip,
        egress_location,
        egress_timezone,
        egress_ms,
        egress_error,
        https_ok,
        https_ms,
        https_error,
    ) = if proxy_ok {
        let client = net::proxied_blocking_client(&proxy)?;
        let (egress_ok, egress_ip, egress_location, egress_timezone, egress_ms, egress_error) =
            match net::fetch_egress_ip(&client) {
                Ok(info) => (
                    true,
                    Some(info.ip),
                    info.location,
                    info.timezone,
                    Some(info.ms),
                    None,
                ),
                Err(e) => (false, None, None, None, None, Some(e.to_string())),
            };
        let (https_ok, https_ms, https_error) = match net::test_github_with_client(&client) {
            Ok(ms) => (true, Some(ms), None),
            Err(e) => (false, None, Some(e.to_string())),
        };
        (
            egress_ok,
            egress_ip,
            egress_location,
            egress_timezone,
            egress_ms,
            egress_error,
            https_ok,
            https_ms,
            https_error,
        )
    } else {
        (false, None, None, None, None, None, false, None, None)
    };

    Ok(ProxyTestResult {
        proxy_ok,
        proxy_ms,
        proxy_error,
        egress_ok,
        egress_ip,
        egress_location,
        egress_timezone,
        egress_ms,
        egress_error,
        https_ok,
        https_ms,
        https_error,
        ssh_helper_found: helper.found,
        ssh_helper_name: helper.name,
        ssh_note,
    })
}
