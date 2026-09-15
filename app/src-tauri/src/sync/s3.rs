//! S3 / Cloudflare R2 兼容轻量存储客户端
//!
//! 实现纯原生 AWS SigV4 签名机制，零笨重额外 SDK 依赖，支持：
//! - Cloudflare R2
//! - AWS S3
//! - MinIO / 自建 S3 服务
//! - 阿里云 OSS / 腾讯云 COS（S3 兼容模式）

use crate::app_config::{AppConfig, NetworkProxy};
use crate::error::{AppError, Result};
use crate::net;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Config {
    /// 存储端点，如 "https://<account_id>.r2.cloudflarestorage.com" 或 "https://s3.us-east-1.amazonaws.com"
    pub endpoint: String,
    /// 存储桶名称
    pub bucket: String,
    /// 区域，如 "auto", "us-east-1"
    #[serde(default = "default_region")]
    pub region: String,
    /// Access Key ID
    pub access_key_id: String,
    /// Secret Access Key
    pub secret_access_key: String,
    /// 对象存储路径前缀，默认 "gam-sync/"
    #[serde(default = "default_prefix")]
    pub prefix: String,
}

fn default_region() -> String {
    "auto".into()
}

fn default_prefix() -> String {
    "gam-sync/".into()
}

#[derive(Clone)]
pub struct S3Client {
    config: S3Config,
    client: reqwest::blocking::Client,
}

impl S3Client {
    pub fn new(config: S3Config) -> Result<Self> {
        Self::new_with_proxy(config, None)
    }

    /// 必须在普通线程或 `spawn_blocking` 里调用。
    /// 在 Tokio worker 上 `build()` / drop 会直接 panic，IPC 也就没有返回。
    pub fn new_with_proxy(config: S3Config, proxy: Option<&NetworkProxy>) -> Result<Self> {
        let mut builder = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(8))
            .timeout(std::time::Duration::from_secs(20))
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .pool_max_idle_per_host(4);
        if let Some(p) = proxy {
            builder = net::apply_reqwest_blocking(builder, p)?;
        }
        let client = builder
            .build()
            .map_err(|e| AppError::Invalid(format!("创建 HTTP 客户端失败: {e}")))?;
        Ok(Self { config, client })
    }

    pub fn from_app(config: S3Config, app: &AppConfig) -> Result<Self> {
        let proxy = net::for_cloud_sync(app);
        Self::new_with_proxy(config, proxy.as_ref())
    }

    pub fn full_key(&self, subpath: &str) -> String {
        let p = self.config.prefix.trim_matches('/');
        let s = subpath.trim_matches('/');
        if p.is_empty() {
            s.to_string()
        } else {
            format!("{p}/{s}")
        }
    }

    /// 测试云端存储连通性（读写删探针），返回往返延迟毫秒
    pub fn test_connection(&self) -> Result<u128> {
        let probe_key = self.full_key("probe.tmp");
        let start = Instant::now();
        let test_payload = b"GAM-PROBE-OK";

        // 1. 尝试写入
        self.put_object_internal(&probe_key, test_payload)?;

        // 2. 尝试读取
        let read_back = self.get_object_internal(&probe_key)?;
        if read_back.as_deref() != Some(test_payload) {
            return Err(AppError::Invalid("读取探测对象内容不匹配".into()));
        }

        // 3. 尝试清理删除
        let _ = self.delete_object_internal(&probe_key);

        Ok(start.elapsed().as_millis())
    }

    /// 上传对象数据
    pub fn put_object(&self, key: &str, data: &[u8]) -> Result<()> {
        let full_key = self.full_key(key);
        self.put_object_internal(&full_key, data)
    }

    /// 流式上传本地文件：先流式哈希再 PUT 文件句柄，避免整块进内存。
    pub fn put_object_file(&self, key: &str, path: &Path) -> Result<()> {
        let full_key = self.full_key(key);
        let payload_hash = sha256_file(path)?;
        let size = std::fs::metadata(path)?.len();
        let (url, host, canonical_uri) = self.build_target(&full_key, "")?;
        let (headers, _) = self.sign_request_hashed("PUT", &host, &canonical_uri, "", &payload_hash)?;
        let file = std::fs::File::open(path)?;
        let mut req = self
            .client
            .put(&url)
            .body(file)
            .header("content-length", size)
            .timeout(Duration::from_secs(900));
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let resp = req
            .send()
            .map_err(|e| AppError::Invalid(format!("连接云存储失败: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(AppError::Invalid(format!(
                "上传失败 (HTTP {}): {}",
                status,
                extract_s3_error(&body)
            )));
        }
        Ok(())
    }

    /// 流式下载对象到本地文件。不存在返回 Ok(false)。
    pub fn get_object_to_file(&self, key: &str, dest: &Path) -> Result<bool> {
        let full_key = self.full_key(key);
        let (url, host, canonical_uri) = self.build_target(&full_key, "")?;
        let (headers, _) = self.sign_request("GET", &host, &canonical_uri, "", &[])?;
        let mut req = self.client.get(&url).timeout(Duration::from_secs(900));
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let mut resp = req
            .send()
            .map_err(|e| AppError::Invalid(format!("连接云存储失败: {e}")))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(false);
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(AppError::Invalid(format!(
                "下载失败 (HTTP {}): {}",
                status,
                extract_s3_error(&body)
            )));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = dest.with_extension("part");
        let mut out = std::fs::File::create(&tmp)?;
        std::io::copy(&mut resp, &mut out)
            .map_err(|e| AppError::Invalid(format!("写入下载文件失败: {e}")))?;
        out.flush()?;
        drop(out);
        if let Err(e) = std::fs::rename(&tmp, dest) {
            std::fs::copy(&tmp, dest).map_err(|copy_err| {
                AppError::Io(format!("保存下载文件失败：{e} / {copy_err}"))
            })?;
            let _ = std::fs::remove_file(&tmp);
        }
        Ok(true)
    }

    /// 读取对象数据（若不存在返回 None）
    pub fn get_object(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let full_key = self.full_key(key);
        self.get_object_internal(&full_key)
    }

    /// 判断对象是否存在。优先 HEAD，不支持时回退 GET。
    pub fn object_exists(&self, key: &str) -> bool {
        let full_key = self.full_key(key);
        match self.head_object_internal(&full_key) {
            Ok(Some(exists)) => exists,
            Ok(None) | Err(_) => self.get_object_internal(&full_key).ok().flatten().is_some(),
        }
    }

    /// 删除对象
    pub fn delete_object(&self, key: &str) -> Result<()> {
        let full_key = self.full_key(key);
        self.delete_object_internal(&full_key)
    }

    // ---- 内部实现 ----

    fn put_object_internal(&self, full_key: &str, data: &[u8]) -> Result<()> {
        let (url, host, canonical_uri) = self.build_target(full_key, "")?;
        let (headers, _) = self.sign_request("PUT", &host, &canonical_uri, "", data)?;

        let mut req = self.client.put(&url).body(data.to_vec());
        for (k, v) in headers {
            req = req.header(k, v);
        }

        let resp = req
            .send()
            .map_err(|e| AppError::Invalid(format!("连接云存储失败: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(AppError::Invalid(format!(
                "上传失败 (HTTP {}): {}",
                status,
                extract_s3_error(&body)
            )));
        }

        Ok(())
    }

    fn get_object_internal(&self, full_key: &str) -> Result<Option<Vec<u8>>> {
        let (url, host, canonical_uri) = self.build_target(full_key, "")?;
        let (headers, _) = self.sign_request("GET", &host, &canonical_uri, "", &[])?;

        let mut req = self.client.get(&url);
        for (k, v) in headers {
            req = req.header(k, v);
        }

        let resp = req
            .send()
            .map_err(|e| AppError::Invalid(format!("连接云存储失败: {e}")))?;

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(AppError::Invalid(format!(
                "下载失败 (HTTP {}): {}",
                status,
                extract_s3_error(&body)
            )));
        }

        let bytes = resp
            .bytes()
            .map_err(|e| AppError::Invalid(format!("读取响应失败: {e}")))?
            .to_vec();

        Ok(Some(bytes))
    }

    /// HEAD 探测对象。`Ok(Some(true/false))` 表示确定结果；`Ok(None)` 表示服务端不支持 HEAD。
    fn head_object_internal(&self, full_key: &str) -> Result<Option<bool>> {
        let (url, host, canonical_uri) = self.build_target(full_key, "")?;
        let (headers, _) = self.sign_request("HEAD", &host, &canonical_uri, "", &[])?;

        let mut req = self.client.head(&url);
        for (k, v) in headers {
            req = req.header(k, v);
        }

        let resp = req
            .send()
            .map_err(|e| AppError::Invalid(format!("连接云存储失败: {e}")))?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(Some(false));
        }
        if status.is_success() {
            return Ok(Some(true));
        }
        if status == reqwest::StatusCode::METHOD_NOT_ALLOWED
            || status == reqwest::StatusCode::NOT_IMPLEMENTED
        {
            return Ok(None);
        }
        Ok(None)
    }

    fn delete_object_internal(&self, full_key: &str) -> Result<()> {
        let (url, host, canonical_uri) = self.build_target(full_key, "")?;
        let (headers, _) = self.sign_request("DELETE", &host, &canonical_uri, "", &[])?;

        let mut req = self.client.delete(&url);
        for (k, v) in headers {
            req = req.header(k, v);
        }

        let resp = req
            .send()
            .map_err(|e| AppError::Invalid(format!("连接云存储失败: {e}")))?;

        if resp.status().is_success() || resp.status() == reqwest::StatusCode::NOT_FOUND {
            Ok(())
        } else {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            Err(AppError::Invalid(format!(
                "删除失败 (HTTP {}): {}",
                status,
                extract_s3_error(&body)
            )))
        }
    }

    fn build_target(
        &self,
        full_key: &str,
        query: &str,
    ) -> Result<(String, String, String)> {
        let endpoint = self.config.endpoint.trim().trim_end_matches('/');
        let bucket = self.config.bucket.trim();

        let parsed = reqwest::Url::parse(endpoint)
            .map_err(|_| AppError::Invalid("存储端点 Endpoint 格式无效".into()))?;

        let host = parsed
            .host_str()
            .ok_or_else(|| AppError::Invalid("存储端点缺少 Host".into()))?
            .to_string();

        let host_header = if let Some(port) = parsed.port() {
            format!("{}:{}", host, port)
        } else {
            host
        };

        // 标准 Path-style：/{bucket}/{key}
        let clean_key = full_key.trim_start_matches('/');
        let canonical_uri = format!("/{}/{}", bucket, clean_key);

        let mut url = format!("{}{}", endpoint, canonical_uri);
        if !query.is_empty() {
            url.push('?');
            url.push_str(query);
        }

        Ok((url, host_header, canonical_uri))
    }

    /// 生成 AWS SigV4 签名请求头
    fn sign_request(
        &self,
        method: &str,
        host: &str,
        canonical_uri: &str,
        canonical_query_string: &str,
        payload: &[u8],
    ) -> Result<(Vec<(String, String)>, String)> {
        self.sign_request_hashed(
            method,
            host,
            canonical_uri,
            canonical_query_string,
            &sha256_hex(payload),
        )
    }

    fn sign_request_hashed(
        &self,
        method: &str,
        host: &str,
        canonical_uri: &str,
        canonical_query_string: &str,
        payload_hash: &str,
    ) -> Result<(Vec<(String, String)>, String)> {
        let now = time::OffsetDateTime::now_utc();
        let amz_date = format!(
            "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
            now.year(),
            now.month() as u8,
            now.day(),
            now.hour(),
            now.minute(),
            now.second()
        );
        let date_stamp = format!(
            "{:04}{:02}{:02}",
            now.year(),
            now.month() as u8,
            now.day()
        );

        // Canonical Headers
        let canonical_headers = format!(
            "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
            host, payload_hash, amz_date
        );
        let signed_headers = "host;x-amz-content-sha256;x-amz-date";

        // Canonical Request
        let canonical_request = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            method,
            canonical_uri,
            canonical_query_string,
            canonical_headers,
            signed_headers,
            payload_hash
        );
        let hashed_canonical_request = sha256_hex(canonical_request.as_bytes());

        // String to Sign
        let region = if self.config.region.is_empty() {
            "auto"
        } else {
            &self.config.region
        };
        let credential_scope = format!("{}/{}/s3/aws4_request", date_stamp, region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{}\n{}\n{}",
            amz_date, credential_scope, hashed_canonical_request
        );

        // Signing Key
        let k_secret = format!("AWS4{}", self.config.secret_access_key);
        let k_date = hmac_sha256(k_secret.as_bytes(), date_stamp.as_bytes())?;
        let k_region = hmac_sha256(&k_date, region.as_bytes())?;
        let k_service = hmac_sha256(&k_region, b"s3")?;
        let k_signing = hmac_sha256(&k_service, b"aws4_request")?;

        let signature = hex_encode(&hmac_sha256(&k_signing, string_to_sign.as_bytes())?);

        let auth_header = format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            self.config.access_key_id, credential_scope, signed_headers, signature
        );

        let headers = vec![
            ("x-amz-date".to_string(), amz_date.clone()),
            ("x-amz-content-sha256".to_string(), payload_hash.to_string()),
            ("authorization".to_string(), auth_header),
            ("host".to_string(), host.to_string()),
        ];

        Ok((headers, amz_date))
    }
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex_encode(&hasher.finalize())
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_encode(&hasher.finalize()))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<[u8; 32]> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key)
        .map_err(|_| AppError::Crypto)?;
    mac.update(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&mac.finalize().into_bytes());
    Ok(out)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn extract_s3_error(xml: &str) -> String {
    if let Some(msg_start) = xml.find("<Message>") {
        if let Some(msg_end) = xml[msg_start..].find("</Message>") {
            let msg = &xml[msg_start + 9..msg_start + msg_end];
            return msg.to_string();
        }
    }
    if let Some(code_start) = xml.find("<Code>") {
        if let Some(code_end) = xml[code_start..].find("</Code>") {
            let code = &xml[code_start + 6..code_start + code_end];
            return format!("错误代码: {code}");
        }
    }
    if xml.is_empty() {
        "未知云服务错误".into()
    } else {
        xml.chars().take(120).collect()
    }
}

pub const S3_CONFIG_FILE_KIND: &str = crate::identity::S3_KIND;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ConfigFile {
    pub kind: String,
    pub version: u32,
    pub config: S3Config,
}

pub fn write_s3_config_file(path: &std::path::Path, config: &S3Config) -> Result<()> {
    let payload = S3ConfigFile {
        kind: S3_CONFIG_FILE_KIND.into(),
        version: 1,
        config: config.clone(),
    };
    let json = serde_json::to_vec_pretty(&payload)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::vault::atomic_write(path, &json)
}

pub fn read_s3_config_file(path: &std::path::Path) -> Result<S3Config> {
    let raw = std::fs::read_to_string(path).map_err(|e| AppError::Io(format!("读取配置文件失败：{e}")))?;
    parse_s3_config_file(&raw)
}

pub fn parse_s3_config_file(raw: &str) -> Result<S3Config> {
    if let Ok(file) = serde_json::from_str::<S3ConfigFile>(raw) {
        if !crate::identity::accepted_s3_kind(&file.kind) {
            return Err(AppError::Invalid("这不是本程序导出的 S3/R2 配置文件".into()));
        }
        return Ok(file.config);
    }
    serde_json::from_str::<S3Config>(raw)
        .map_err(|_| AppError::Invalid("无法解析 S3/R2 配置文件".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_wrapped_and_raw_s3_config() {
        let cfg = S3Config {
            endpoint: "https://example.r2.cloudflarestorage.com".into(),
            bucket: "b".into(),
            region: "auto".into(),
            access_key_id: "ak".into(),
            secret_access_key: "sk".into(),
            prefix: "gam-sync/".into(),
        };
        let wrapped = serde_json::to_string(&S3ConfigFile {
            kind: S3_CONFIG_FILE_KIND.into(),
            version: 1,
            config: cfg.clone(),
        })
        .unwrap();
        let got = parse_s3_config_file(&wrapped).unwrap();
        assert_eq!(got.bucket, "b");
        let raw = serde_json::to_string(&cfg).unwrap();
        assert_eq!(parse_s3_config_file(&raw).unwrap().access_key_id, "ak");
        let legacy = serde_json::to_string(&S3ConfigFile {
            kind: crate::identity::LEGACY_S3_KIND.into(),
            version: 1,
            config: cfg.clone(),
        })
        .unwrap();
        assert_eq!(parse_s3_config_file(&legacy).unwrap().bucket, "b");
    }

    #[test]
    fn blocking_client_builds_inside_spawn_blocking() {
        tauri::async_runtime::block_on(async {
            tauri::async_runtime::spawn_blocking(|| {
                reqwest::blocking::Client::builder()
                    .timeout(std::time::Duration::from_secs(1))
                    .build()
                    .expect("spawn_blocking 内应能创建 blocking Client");
            })
            .await
            .expect("spawn_blocking 不应被取消");
        });
    }
}
