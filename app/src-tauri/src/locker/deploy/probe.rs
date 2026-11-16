//! 分享 Worker 连通性：校验 V2 能力、下载页和未经授权的登记请求。

use super::addr::normalize_worker_url;
use crate::app_config::NetworkProxy;
use crate::error::{AppError, Result};
use crate::net;
use serde::Serialize;
use std::io::Read;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerProbeCheck {
    pub id: String,
    pub ok: bool,
    pub status: Option<u16>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockerProbeResult {
    pub ok: bool,
    pub url: String,
    pub checks: Vec<LockerProbeCheck>,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateJudge {
    Pass,
    Misconfigured,
    Fail,
}

pub fn health_ok(status: u16, body: &str) -> bool {
    if status != 200 {
        return false;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body.trim()) else {
        return false;
    };
    let capabilities = v.get("capabilities").and_then(|x| x.as_array());
    v.get("service").and_then(|x| x.as_str()) == Some("file-locker")
        && v.get("ok").and_then(|x| x.as_bool()) == Some(true)
        && v.get("protocolVersion").and_then(|x| x.as_u64()) == Some(2)
        && v.get("schemaVersion").and_then(|x| x.as_u64()) == Some(2)
        && ["private-items", "lookup", "claims", "resume", "stop-share", "cleanup-status"]
            .iter().all(|required| capabilities.is_some_and(|values| values.iter().any(|v| v.as_str() == Some(required))))
}

pub fn download_page_ok(status: u16, body: &str) -> bool {
    // V2 deliberately serves the same shell for unknown and valid aliases.
    // File existence is revealed only after a code-validated lookup.
    status == 200 && body.contains("data-locker-protocol=\"2\"")
}

pub fn judge_gate(status: u16, body: &str) -> GateJudge {
    let lower = body.to_ascii_lowercase();
    if status == 401 && lower.contains("unauthorized") {
        GateJudge::Pass
    } else if status == 500 && lower.contains("misconfigured") {
        GateJudge::Misconfigured
    } else {
        GateJudge::Fail
    }
}

fn client(proxy: Option<&NetworkProxy>) -> Result<reqwest::blocking::Client> {
    let mut builder = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(p) = proxy {
        builder = net::apply_reqwest_blocking(builder, p)?;
    }
    builder
        .build()
        .map_err(|e| AppError::Invalid(format!("创建分享服务客户端失败: {e}")))
}

fn join(base: &str, rel: &str) -> String {
    format!("{}{rel}", base.trim_end_matches('/'))
}

fn request(
    http: &reqwest::blocking::Client,
    method: reqwest::Method,
    url: &str,
    body: Option<&'static str>,
) -> (Option<u16>, String, Option<String>) {
    let mut req = http.request(method, url);
    if let Some(body) = body {
        req = req.header("content-type", "application/json").body(body);
    }
    match req.send() {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let mut bytes = Vec::new();
            match resp.take(65_537).read_to_end(&mut bytes) {
                Ok(_) if bytes.len() <= 65_536 => match String::from_utf8(bytes) {
                    Ok(text) => (Some(status), text, None),
                    Err(_) => (Some(status), String::new(), Some("服务响应不是有效文本".into())),
                },
                Ok(_) => (Some(status), String::new(), Some("服务检测响应超过大小上限".into())),
                Err(e) => (Some(status), String::new(), Some(format!("读取服务检测响应失败: {e}"))),
            }
        }
        Err(e) => (None, String::new(), Some(format!("连接失败: {e}"))),
    }
}

pub fn probe_worker(url: &str, proxy: Option<&NetworkProxy>) -> Result<LockerProbeResult> {
    let url = normalize_worker_url(url)?;
    let http = client(proxy)?;
    let mut checks = Vec::new();
    let mut hint = None;

    let (st, body, err) = request(&http, reqwest::Method::GET, &join(&url, "/"), None);
    let ok = err.is_none() && st.is_some_and(|s| health_ok(s, &body));
    checks.push(LockerProbeCheck {
        id: "health".into(),
        ok,
        status: st,
        detail: err.unwrap_or_else(|| {
            if ok {
                "服务在线，领取协议 V2 与数据结构已就绪".into()
            } else {
                format!("需要兼容的领取协议 V2 与完整数据表，请升级取件服务。实际 {}", describe(st, &body))
            }
        }),
    });

    let (st, body, err) = request(&http, reqwest::Method::GET, &join(&url, "/d/aaaaaaaaaa"), None);
    let ok = err.is_none() && st.is_some_and(|s| download_page_ok(s, &body));
    checks.push(LockerProbeCheck {
        id: "download".into(),
        ok,
        status: st,
        detail: err.unwrap_or_else(|| {
            if ok {
                "下载页可用".into()
            } else {
                format!("期望协议 V2 取件页，实际 {}", describe(st, &body))
            }
        }),
    });

    let (st, body, err) = request(
        &http,
        reqwest::Method::PUT,
        &join(&url, "/v2/items/00000000-0000-4000-8000-000000000000"),
        Some("{}"),
    );
    let gate = st.map(|s| judge_gate(s, &body));
    let ok = err.is_none() && matches!(gate, Some(GateJudge::Pass));
    if matches!(gate, Some(GateJudge::Misconfigured)) {
        hint = Some("共享密钥还没写到 Worker".into());
    }
    checks.push(LockerProbeCheck {
        id: "gate".into(),
        ok,
        status: st,
        detail: err.unwrap_or_else(|| match gate {
            Some(GateJudge::Pass) => "门禁有效".into(),
            Some(GateJudge::Misconfigured) => "共享密钥还没写到 Worker".into(),
            _ => format!("期望 HTTP 401 unauthorized，实际 {}", describe(st, &body)),
        }),
    });

    Ok(LockerProbeResult {
        ok: checks.iter().all(|c| c.ok),
        url,
        checks,
        hint,
    })
}

fn describe(status: Option<u16>, body: &str) -> String {
    let brief = body.trim().replace(['\n', '\r'], " ");
    let brief: String = brief.chars().take(80).collect();
    match (status, brief.is_empty()) {
        (Some(s), true) => format!("HTTP {s}"),
        (Some(s), false) => format!("HTTP {s}: {brief}"),
        (None, _) => "无响应".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_requires_v2_schema_and_all_safety_capabilities() {
        let current = serde_json::json!({"service":"file-locker","ok":true,"protocolVersion":2,"schemaVersion":2,
            "capabilities":["private-items","lookup","claims","resume","stop-share","cleanup-status"]});
        assert!(health_ok(200, &current.to_string()));
        assert!(!health_ok(200, r#"{"service":"file-locker","ok":true}"#));
        for field in ["protocolVersion", "schemaVersion", "capabilities"] {
            let mut incomplete = current.clone();
            incomplete.as_object_mut().unwrap().remove(field);
            assert!(!health_ok(200, &incomplete.to_string()));
        }
        let mut unsafe_service = current.clone();
        unsafe_service["capabilities"] = serde_json::json!(["lookup", "claims"]);
        assert!(!health_ok(200, &unsafe_service.to_string()));
        assert!(!health_ok(200, r#"{"ok":true}"#));
        assert!(!health_ok(204, r#"{"service":"file-locker","ok":true}"#));
        assert!(!health_ok(200, "not-json"));
    }

    #[test]
    fn download_requires_v2_shell_without_probing_real_file_existence() {
        let shell = "<body data-locker-protocol=\"2\">";
        assert!(download_page_ok(200, shell));
        assert!(!download_page_ok(404, shell));
        assert!(!download_page_ok(500, shell));
        assert!(!download_page_ok(200, "unrelated proxy landing page"));
    }

    #[test]
    fn gate_detects_unauthorized_and_missing_secret() {
        assert_eq!(judge_gate(401, r#"{"error":"unauthorized"}"#), GateJudge::Pass);
        assert_eq!(
            judge_gate(500, r#"{"error":"misconfigured"}"#),
            GateJudge::Misconfigured
        );
        assert_eq!(judge_gate(200, r#"{"ok":true}"#), GateJudge::Fail);
        assert_eq!(judge_gate(401, r#"{"error":"bad_code"}"#), GateJudge::Fail);
    }
}
