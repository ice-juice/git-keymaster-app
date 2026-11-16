//! 用户自建分享 Worker 的客户端。御钥师不运营中心服务。
//!
//! 登记与吊销带共享密钥 HMAC。已分享项的自取走 `POST /api/<slug>`，
//! 与下载页同一条原子递减并取回密文的路径，不在本地偷偷扣次数。

use crate::error::{AppError, Result};
use crate::app_config::NetworkProxy;
use crate::net;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone)]
pub struct WorkerEndpoint {
    pub base: String,
    pub secret: String,
}

#[derive(Debug, Clone)]
pub struct RegisterBody {
    pub slug: String,
    pub object_key: String,
    pub code_hash: String,
    pub size: u64,
    pub expire_at: Option<String>,
    pub max_pulls: Option<u32>,
    pub pulls_left: Option<u32>,
}

#[derive(Debug)]
pub struct SharedObject {
    pub pulls_left: Option<u32>,
    pub burned: bool,
    pub pulls_known: bool,
}

pub fn canonical(ts: &str, nonce: &str, method: &str, path: &str, body: &[u8]) -> String {
    format!(
        "{ts}\n{nonce}\n{method}\n{path}\n{}",
        hex_encode(&Sha256::digest(body))
    )
}

pub fn sign(secret: &str, material: &str) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(secret.as_bytes()).expect("HMAC 接受任意长度密钥");
    mac.update(material.as_bytes());
    hex_encode(&mac.finalize().into_bytes())
}

fn join_url(base: &str, rel: &str) -> Result<(String, String)> {
    let base = base.trim().trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err(AppError::Invalid("分享服务地址需要以 http:// 或 https:// 开头".into()));
    }
    let rel = if rel.starts_with('/') {
        rel.to_string()
    } else {
        format!("/{rel}")
    };
    let full = format!("{base}{rel}");
    let url = reqwest::Url::parse(&full).map_err(|_| AppError::Invalid("分享服务地址无效".into()))?;
    Ok((full, url.path().to_string()))
}

fn client(proxy: Option<&NetworkProxy>, timeout: Duration) -> Result<reqwest::blocking::Client> {
    let mut builder = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none());
    if let Some(p) = proxy {
        builder = net::apply_reqwest_blocking(builder, p)?;
    }
    builder
        .build()
        .map_err(|e| AppError::Invalid(format!("创建分享服务客户端失败: {e}")))
}

fn auth_headers(secret: &str, method: &str, path: &str, body: &[u8]) -> (String, String, String) {
    let ts = time::OffsetDateTime::now_utc().unix_timestamp().to_string();
    let mut nonce_raw = [0u8; 16];
    crate::vault::crypto::fill_random(&mut nonce_raw);
    let nonce = hex_encode(&nonce_raw);
    let material = canonical(&ts, &nonce, method, path, body);
    let sig = sign(secret, &material);
    (ts, nonce, sig)
}

fn apply_auth(
    req: reqwest::blocking::RequestBuilder,
    secret: &str,
    method: &str,
    path: &str,
    body: &[u8],
) -> reqwest::blocking::RequestBuilder {
    let (ts, nonce, sig) = auth_headers(secret, method, path, body);
    req.header("X-Locker-Timestamp", ts)
        .header("X-Locker-Nonce", nonce)
        .header("X-Locker-Signature", sig)
}

pub fn register(endpoint: &WorkerEndpoint, body: &RegisterBody, proxy: Option<&NetworkProxy>) -> Result<()> {
    let payload = serde_json::json!({
        "slug": body.slug,
        "object_key": body.object_key,
        "code_hash": body.code_hash,
        "size": body.size,
        "expire_at": body.expire_at,
        "max_pulls": body.max_pulls,
        "pulls_left": body.pulls_left,
    });
    let bytes = serde_json::to_vec(&payload)?;
    let (url, path) = join_url(&endpoint.base, "/register")?;
    let http = client(proxy, Duration::from_secs(30))?;
    let req = apply_auth(
        http.post(url).header("content-type", "application/json").body(bytes.clone()),
        &endpoint.secret,
        "POST",
        &path,
        &bytes,
    );
    let resp = req
        .send()
        .map_err(|e| AppError::Invalid(format!("连接分享服务失败: {e}")))?;
    let status = resp.status();
    if status == reqwest::StatusCode::CONFLICT {
        return Err(AppError::Invalid("SHARE_SLUG_CONFLICT".into()));
    }
    if !status.is_success() {
        let text = resp.text().unwrap_or_default();
        if text.contains("missing_object") {
            return Err(AppError::Invalid(
                "分享服务的存储桶里没有这个文件。请把 Worker 的 R2 绑定改成御钥师云同步使用的同一个桶，然后重新 npx wrangler deploy。".into(),
            ));
        }
        return Err(AppError::Invalid(format!(
            "登记分享失败 (HTTP {}): {}",
            status,
            brief(&text)
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SharePresence {
    Alive,
    Gone,
}

/// 下载页的 HTTP 状态。只有 404 / 410 能认定分享已销毁；其它状态保持本地记录。
pub fn presence_from_status(status: u16) -> Result<SharePresence> {
    match status {
        200 => Ok(SharePresence::Alive),
        404 | 410 => Ok(SharePresence::Gone),
        other => Err(AppError::Invalid(format!("无法确认分享状态 (HTTP {other})"))),
    }
}

/// 只读核对 `GET /d/<slug>`。不提交取件码，也不扣次数。
pub fn probe_share(endpoint: &WorkerEndpoint, slug: &str, proxy: Option<&NetworkProxy>) -> Result<SharePresence> {
    if slug.len() != 10 || !slug.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(AppError::Invalid("分享短码无效".into()));
    }
    let rel = format!("/d/{slug}");
    let (url, _) = join_url(&endpoint.base, &rel)?;
    let http = client(proxy, Duration::from_secs(12))?;
    let resp = http
        .get(url)
        .header("accept", "text/html")
        .send()
        .map_err(|e| AppError::Invalid(format!("连接分享服务失败: {e}")))?;
    presence_from_status(resp.status().as_u16())
}

pub fn revoke(endpoint: &WorkerEndpoint, slug: &str, proxy: Option<&NetworkProxy>) -> Result<()> {
    let rel = format!("/register/{slug}");
    let (url, path) = join_url(&endpoint.base, &rel)?;
    let http = client(proxy, Duration::from_secs(30))?;
    let req = apply_auth(http.delete(url), &endpoint.secret, "DELETE", &path, b"");
    let resp = req
        .send()
        .map_err(|e| AppError::Invalid(format!("连接分享服务失败: {e}")))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    if !status.is_success() {
        let text = resp.text().unwrap_or_default();
        return Err(AppError::Invalid(format!(
            "吊销分享失败 (HTTP {}): {}",
            status,
            brief(&text)
        )));
    }
    Ok(())
}

/// 已分享项自取：`POST /api/<slug>` 提交取件码。Worker 原子递减后流式返回密文。
pub fn pull_shared(
    endpoint: &WorkerEndpoint,
    slug: &str,
    code: &str,
    dest: &Path,
    proxy: Option<&NetworkProxy>,
    max_bytes: u64,
) -> Result<SharedObject> {
    let rel = format!("/api/{slug}");
    let (url, _path) = join_url(&endpoint.base, &rel)?;
    let payload = serde_json::to_vec(&serde_json::json!({ "code": code }))?;
    let http = client(proxy, Duration::from_secs(900))?;
    let mut resp = http
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/octet-stream")
        .body(payload)
        .send()
        .map_err(|e| AppError::Invalid(format!("连接分享服务失败: {e}")))?;
    let status = resp.status();
    let pulls_header = header_string(resp.headers(), "x-locker-pulls-left");
    let burned_header = header_string(resp.headers(), "x-locker-burned");
    if !status.is_success() {
        let text = resp.text().unwrap_or_default();
        return Err(map_pull_status(status, &text));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = std::fs::File::create(dest)?;
    let cap = max_bytes.saturating_add(1024 * 1024);
    let copied = std::io::copy(&mut (&mut resp).take(cap + 1), &mut out)
        .map_err(|e| AppError::Invalid(format!("读取分享密文失败: {e}")))?;
    out.flush()?;
    if copied > cap {
        let _ = std::fs::remove_file(dest);
        return Err(AppError::Invalid("分享服务返回的密文超过大小上限".into()));
    }
    if copied < 9 {
        let _ = std::fs::remove_file(dest);
        return Err(AppError::Invalid("分享服务没有返回密文".into()));
    }
    let pulls_left = pulls_header.as_deref().and_then(|s| s.trim().parse::<u32>().ok());
    let burned = match burned_header.as_deref().map(str::trim) {
        Some("1") | Some("true") | Some("TRUE") => true,
        _ => pulls_left == Some(0),
    };
    Ok(SharedObject {
        pulls_left,
        burned,
        pulls_known: pulls_header.is_some(),
    })
}

fn map_pull_status(status: reqwest::StatusCode, body: &str) -> AppError {
    let brief = brief(body);
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE {
        return AppError::Invalid("这份寄存已焚毁或分享已失效".into());
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return AppError::Invalid("取件码不正确".into());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.as_u16() == 423 {
        return AppError::Invalid("取件码尝试过多，请稍后再试".into());
    }
    AppError::Invalid(format!("取件失败 (HTTP {status}): {brief}"))
}

fn header_string(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

fn brief(text: &str) -> String {
    let trimmed = text.trim().replace(['\n', '\r'], " ");
    if trimmed.chars().count() > 180 {
        trimmed.chars().take(180).collect()
    } else if trimmed.is_empty() {
        "无更多说明".into()
    } else {
        trimmed
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

// V2 requests never fall back to the destructive legacy API.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2Metadata {
    pub item_id: String,
    pub version: String,
    pub cipher_size: u64,
    pub expire_at: Option<String>,
    pub max_pulls: Option<u32>,
    pub pulls_left: Option<u32>,
    pub status: String,
    pub cleanup_status: String,
    pub share_slug: Option<String>,
    #[serde(default)]
    pub in_flight_claims: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2Claim {
    pub operation_id: String,
    pub token: String,
    pub item_id: String,
    pub version: String,
    pub state: String,
    pub recovery_until: String,
    pub attempts: u32,
    pub pulls_left: Option<u32>,
    pub cipher_size: u64,
    #[serde(default)]
    pub cleanup_status: Option<String>,
}

fn public_address(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v) => !(v.is_private() || v.is_loopback() || v.is_link_local() || v.is_unspecified()
            || v.is_broadcast() || v.is_multicast() || v.octets()[0] == 0 || v.octets()[0] >= 240
            || (v.octets()[0] == 100 && (64..=127).contains(&v.octets()[1]))),
        std::net::IpAddr::V6(v) => v.to_ipv4_mapped().map(|v| public_address(v.into())).unwrap_or_else(||
            !(v.is_loopback() || v.is_unspecified() || v.is_multicast() || (v.segments()[0] & 0xfe00) == 0xfc00 || (v.segments()[0] & 0xffc0) == 0xfe80)),
    }
}

fn v2_client(endpoint: &WorkerEndpoint, proxy: Option<&NetworkProxy>, timeout: Duration) -> Result<reqwest::blocking::Client> {
    let url = reqwest::Url::parse(&endpoint.base).map_err(|_| AppError::Invalid("取件服务地址无效".into()))?;
    let external = endpoint.secret.is_empty();
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() || url.query().is_some() {
        return Err(AppError::Invalid("取件服务地址不能包含凭据、查询参数或解密信息".into()));
    }
    if external {
        #[cfg(not(test))]
        if url.scheme() != "https" { return Err(AppError::Invalid("收到的分享必须使用 HTTPS".into())); }
        let host = url.host_str().ok_or_else(|| AppError::Invalid("分享链接缺少主机名".into()))?;
        use std::net::ToSocketAddrs;
        let addresses: Vec<_> = (host, url.port_or_known_default().unwrap_or(443)).to_socket_addrs()
            .map_err(|_| AppError::Invalid("无法解析分享服务地址".into()))?.collect();
        if addresses.is_empty() { return Err(AppError::Invalid("分享服务地址无法连接".into())); }
        #[cfg(not(test))]
        if addresses.iter().any(|a| !public_address(a.ip())) {
            return Err(AppError::Invalid("收到的分享不能访问本机或内网地址".into()));
        }
        // Bind the validated addresses, preventing DNS rebinding. An external
        // link does not inherit an HTTP proxy that could resolve a different IP.
        return reqwest::blocking::Client::builder().no_proxy().resolve_to_addrs(host, &addresses)
            .redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(8)).timeout(timeout)
            .build().map_err(|_| AppError::Invalid("无法创建取件连接".into()));
    }
    client(proxy, timeout)
}

fn v2_error(status: reqwest::StatusCode, bytes: &[u8]) -> AppError {
    let value: serde_json::Value = serde_json::from_slice(bytes).unwrap_or_default();
    let code = value.get("error").and_then(|v| v.as_str()).unwrap_or("service_error");
    let message = match status.as_u16() {
        426 => "取件服务版本过旧，请先升级服务；未执行旧版扣次或删除操作".to_string(),
        401 | 403 => "取件码或服务验证不正确".to_string(),
        404 => "找不到该寄存或分享已停止".to_string(),
        410 => "文件已过期或原领取会话的恢复期限已结束".to_string(),
        409 => format!("取件状态已改变，请重新查询；原操作不得换 ID 重试 ({})", code.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(60).collect::<String>()),
        423 | 429 => format!("尝试过多，请 {} 秒后再试", value.get("retryAfter").and_then(|v| v.as_u64()).unwrap_or(60)),
        _ => format!("取件服务响应异常 (HTTP {})，请查询原操作状态", status.as_u16()),
    };
    AppError::Invalid(message)
}

pub fn v2_json<T: serde::de::DeserializeOwned>(endpoint: &WorkerEndpoint, method: &str, rel: &str, body: Option<&serde_json::Value>, owner: bool, proxy: Option<&NetworkProxy>) -> Result<T> {
    let (url, path) = join_url(&endpoint.base, rel)?;
    let bytes = body.map(serde_json::to_vec).transpose()?.unwrap_or_default();
    let http = v2_client(endpoint, proxy, Duration::from_secs(30))?;
    let method_value = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| AppError::Invalid("请求方法无效".into()))?;
    let mut req = http.request(method_value, url).header("accept", "application/json");
    if body.is_some() { req = req.header("content-type", "application/json").body(bytes.clone()); }
    if owner {
        if endpoint.secret.is_empty() { return Err(AppError::Invalid("请先配置取件服务密钥".into())); }
        req = apply_auth(req, &endpoint.secret, method, &path, &bytes);
    }
    let mut response = req.send().map_err(|_| AppError::Invalid("取件服务连接中断，结果待确认，请查询原操作".into()))?;
    let status = response.status();
    let mut raw = Vec::new();
    (&mut response).take(1024 * 1024 + 1).read_to_end(&mut raw)?;
    if raw.len() > 1024 * 1024 { return Err(AppError::Invalid("取件服务响应过大".into())); }
    if !status.is_success() { return Err(v2_error(status, &raw)); }
    serde_json::from_slice(&raw).map_err(|_| AppError::Invalid("取件服务响应格式无效，操作结果待确认".into()))
}

pub fn v2_health(endpoint: &WorkerEndpoint, proxy: Option<&NetworkProxy>) -> Result<()> {
    let health: serde_json::Value = v2_json(endpoint, "GET", "/v2/health", None, false, proxy)?;
    if !crate::locker::deploy::probe::health_ok(200, &health.to_string()) {
        return Err(AppError::Invalid("取件服务或数据库需要升级到协议 2，已阻止旧版操作".into()));
    }
    Ok(())
}

pub fn v2_content(endpoint: &WorkerEndpoint, operation_id: &str, token: &str, dest: &Path, expected_size: u64, proxy: Option<&NetworkProxy>) -> Result<()> {
    let (url, _) = join_url(&endpoint.base, &format!("/v2/claims/{operation_id}/content"))?;
    let cap = crate::locker::LOCKER_MAX_BYTES + 1024 * 1024;
    if expected_size < 9 || expected_size > cap { return Err(AppError::Invalid("分享文件大小不合法".into())); }
    let http = v2_client(endpoint, proxy, Duration::from_secs(900))?;
    let mut resp = http.post(url).json(&serde_json::json!({"token":token})).send()
        .map_err(|_| AppError::Invalid("内容交付中断，请恢复原领取，不要新建领取".into()))?;
    if !resp.status().is_success() {
        let status = resp.status(); let mut bytes = Vec::new(); (&mut resp).take(4096).read_to_end(&mut bytes)?;
        return Err(v2_error(status, &bytes));
    }
    if resp.content_length().is_some_and(|n| n > cap || n != expected_size) { return Err(AppError::Invalid("返回文件大小与查询结果不一致".into())); }
    let mut out = std::fs::File::create(dest)?;
    let copied = std::io::copy(&mut (&mut resp).take(expected_size + 1), &mut out)?;
    out.flush()?; out.sync_all()?;
    if copied != expected_size { let _ = std::fs::remove_file(dest); return Err(AppError::Invalid("密文未完整接收，请恢复原领取".into())); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_sources_do_not_resolve_to_private_or_metadata_addresses() {
        for address in ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"] {
            assert!(!public_address(address.parse().unwrap()), "{address}");
        }
        assert!(public_address("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn signature_binds_method_path_and_body() {
        let body = br#"{"slug":"abc"}"#;
        let a = canonical("100", "n", "POST", "/register", body);
        let b = canonical("100", "n", "POST", "/register", body);
        let c = canonical("100", "n", "DELETE", "/register/abc", b"");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(sign("secret", &a), sign("secret", &b));
        assert_ne!(sign("secret", &a), sign("other", &a));
        assert_eq!(sign("secret", &a).len(), 64);
    }

    #[test]
    fn join_keeps_base_path() {
        let (full, path) = join_url("https://locker.example.com/", "/register").unwrap();
        assert_eq!(full, "https://locker.example.com/register");
        assert_eq!(path, "/register");
        let (full, path) = join_url("https://example.com/app", "/api/abc").unwrap();
        assert_eq!(full, "https://example.com/app/api/abc");
        assert_eq!(path, "/app/api/abc");
        assert!(join_url("locker.example.com", "/register").is_err());
    }

    #[test]
    fn presence_treats_only_missing_pages_as_gone() {
        assert_eq!(presence_from_status(200).unwrap(), SharePresence::Alive);
        assert_eq!(presence_from_status(404).unwrap(), SharePresence::Gone);
        assert_eq!(presence_from_status(410).unwrap(), SharePresence::Gone);
        assert!(presence_from_status(500).is_err());
        assert!(presence_from_status(423).is_err());
    }
}
