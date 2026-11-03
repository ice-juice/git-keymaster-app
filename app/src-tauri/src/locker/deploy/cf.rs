//! Cloudflare REST：API Token 路径的账号、D1、R2、Worker、密钥、cron、workers.dev。

use super::assets;
use super::sql;
use super::LockerCfAccount;
use crate::app_config::NetworkProxy;
use crate::error::{AppError, Result};
use crate::net;
use reqwest::blocking::multipart::{Form, Part};
use serde_json::{json, Value};
use std::time::Duration;

const API: &str = "https://api.cloudflare.com/client/v4";

pub struct CfClient {
    http: reqwest::blocking::Client,
    token: String,
}

impl CfClient {
    pub fn new(token: &str, proxy: Option<&NetworkProxy>) -> Result<Self> {
        let token = token.trim().to_string();
        if token.is_empty() {
            return Err(AppError::Invalid("请粘贴 Cloudflare API Token".into()));
        }
        let mut builder = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90))
            .redirect(reqwest::redirect::Policy::none());
        if let Some(p) = proxy {
            builder = net::apply_reqwest_blocking(builder, p)?;
        }
        let http = builder
            .build()
            .map_err(|e| AppError::Invalid(format!("创建 Cloudflare 客户端失败: {e}")))?;
        Ok(Self { http, token })
    }

    pub fn list_accounts(&self) -> Result<Vec<LockerCfAccount>> {
        let v = self.get("/accounts?per_page=50")?;
        let mut out = Vec::new();
        if let Some(arr) = v.get("result").and_then(|r| r.as_array()) {
            for item in arr {
                let id = item
                    .get("id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = item
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or(&id)
                    .to_string();
                if !id.is_empty() {
                    out.push(LockerCfAccount { id, name });
                }
            }
        }
        if out.is_empty() {
            return Err(AppError::Invalid("令牌没有可管理的 Cloudflare 账号".into()));
        }
        Ok(out)
    }

    pub fn find_or_create_d1(&self, account_id: &str, name: &str) -> Result<String> {
        if let Some(id) = self.find_d1(account_id, name)? {
            return Ok(id);
        }
        let v = self.post(
            &format!("/accounts/{account_id}/d1/database"),
            json!({ "name": name }),
        )?;
        d1_id(&v).ok_or_else(|| AppError::Invalid("创建 D1 库失败：没有返回 database_id".into()))
    }

    fn find_d1(&self, account_id: &str, name: &str) -> Result<Option<String>> {
        let v = self.get(&format!("/accounts/{account_id}/d1/database"))?;
        let Some(arr) = result_array(&v) else {
            return Ok(None);
        };
        for item in arr {
            let item_name = item
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or_default();
            if item_name == name {
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

    pub fn query_d1(&self, account_id: &str, db_id: &str, sql: &str) -> Result<Value> {
        self.post(
            &format!("/accounts/{account_id}/d1/database/{db_id}/query"),
            json!({ "sql": sql }),
        )
    }

    pub fn locker_table_names(&self, account_id: &str, db_id: &str) -> Result<Vec<String>> {
        let v = self.query_d1(account_id, db_id, sql::sqlite_master_probe_sql())?;
        Ok(sql::names_from_d1_json(&v))
    }

    pub fn apply_locker_sql(&self, account_id: &str, db_id: &str) -> Result<()> {
        for stmt in sql::split_sql_statements(assets::LOCKER_MIGRATION_SQL) {
            self.query_d1(account_id, db_id, &stmt)?;
        }
        Ok(())
    }

    pub fn r2_bucket_exists(&self, account_id: &str, bucket: &str) -> Result<bool> {
        let path = format!(
            "/accounts/{account_id}/r2/buckets/{}",
            urlencoding_bucket(bucket)
        );
        match self.get_status(&path) {
            Ok((200..=299, _)) => Ok(true),
            Ok((404, _)) => Ok(false),
            Ok((status, body)) => Err(map_cf_err(status, &body)),
            Err(e) => Err(e),
        }
    }

    pub fn script_exists(&self, account_id: &str, name: &str) -> Result<bool> {
        match self.get_status(&format!("/accounts/{account_id}/workers/scripts/{name}")) {
            Ok((200..=299, _)) => Ok(true),
            Ok((404, _)) => Ok(false),
            Ok((status, body)) => Err(map_cf_err(status, &body)),
            Err(e) => Err(e),
        }
    }

    pub fn upload_script(&self, account_id: &str, bucket: &str, db_id: &str) -> Result<()> {
        let metadata = json!({
            "main_module": "index.js",
            "compatibility_date": assets::compatibility_date(),
            "bindings": [
                { "type": "d1", "name": assets::D1_BINDING, "id": db_id },
                { "type": "r2_bucket", "name": assets::R2_BINDING, "bucket_name": bucket },
            ],
        });
        let part = Part::text(assets::WORKER_SCRIPT.to_string())
            .file_name("index.js")
            .mime_str("application/javascript+module")
            .map_err(|e| AppError::Invalid(format!("打包 Worker 脚本失败: {e}")))?;
        let form = Form::new()
            .text("metadata", metadata.to_string())
            .part("index.js", part);
        let url = format!("{API}/accounts/{account_id}/workers/scripts/{}", assets::SCRIPT_NAME);
        let resp = self
            .http
            .put(url)
            .header("Authorization", format!("Bearer {}", self.token))
            .multipart(form)
            .send()
            .map_err(|e| AppError::Invalid(format!("上传分享服务失败: {e}")))?;
        let status = resp.status().as_u16();
        let body = resp.text().unwrap_or_default();
        if !(200..=299).contains(&status) {
            return Err(map_cf_err(status, &body));
        }
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        if v.get("success") == Some(&Value::Bool(false)) {
            return Err(map_cf_err(status, &body));
        }
        Ok(())
    }

    pub fn put_secret(&self, account_id: &str, secret: &str) -> Result<()> {
        self.put(
            &format!(
                "/accounts/{account_id}/workers/scripts/{}/secrets",
                assets::SCRIPT_NAME
            ),
            json!({
                "name": assets::HMAC_SECRET_NAME,
                "text": secret,
                "type": "secret_text",
            }),
        )?;
        Ok(())
    }

    pub fn put_cron(&self, account_id: &str) -> Result<()> {
        self.put(
            &format!(
                "/accounts/{account_id}/workers/scripts/{}/schedules",
                assets::SCRIPT_NAME
            ),
            json!([{ "cron": assets::CRON }]),
        )?;
        Ok(())
    }

    pub fn ensure_workers_dev(&self, account_id: &str, account_name: &str) -> Result<String> {
        let subdomain = self.ensure_subdomain(account_id, account_name)?;
        self.post(
            &format!(
                "/accounts/{account_id}/workers/scripts/{}/subdomain",
                assets::SCRIPT_NAME
            ),
            json!({ "enabled": true }),
        )
        .ok();
        Ok(format!(
            "https://{}.{}.workers.dev",
            assets::SCRIPT_NAME,
            subdomain
        ))
    }

    fn ensure_subdomain(&self, account_id: &str, account_name: &str) -> Result<String> {
        if let Ok(v) = self.get(&format!("/accounts/{account_id}/workers/subdomain")) {
            if let Some(sub) = v
                .get("result")
                .and_then(|r| r.get("subdomain"))
                .and_then(|s| s.as_str())
                .filter(|s| !s.is_empty())
            {
                return Ok(sub.to_string());
            }
        }
        let candidates = subdomain_candidates(account_name, account_id);
        let mut last_err = AppError::Invalid("注册 workers.dev 子域失败".into());
        for name in candidates {
            match self.post(
                &format!("/accounts/{account_id}/workers/subdomain"),
                json!({ "subdomain": name }),
            ) {
                Ok(v) => {
                    if let Some(sub) = v
                        .get("result")
                        .and_then(|r| r.get("subdomain"))
                        .and_then(|s| s.as_str())
                        .filter(|s| !s.is_empty())
                    {
                        return Ok(sub.to_string());
                    }
                    return Ok(name);
                }
                Err(e) => last_err = e,
            }
        }
        Err(last_err)
    }

    fn get(&self, path: &str) -> Result<Value> {
        let (status, body) = self.get_status(path)?;
        parse_cf(status, &body)
    }

    fn get_status(&self, path: &str) -> Result<(u16, String)> {
        let resp = self
            .http
            .get(format!("{API}{path}"))
            .header("Authorization", format!("Bearer {}", self.token))
            .send()
            .map_err(|e| AppError::Invalid(format!("连接 Cloudflare 失败: {e}")))?;
        Ok((resp.status().as_u16(), resp.text().unwrap_or_default()))
    }

    fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.send(reqwest::Method::POST, path, Some(body))
    }

    fn put(&self, path: &str, body: Value) -> Result<Value> {
        self.send(reqwest::Method::PUT, path, Some(body))
    }

    fn send(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut req = self
            .http
            .request(method, format!("{API}{path}"))
            .header("Authorization", format!("Bearer {}", self.token));
        if let Some(body) = body {
            req = req.header("content-type", "application/json").body(body.to_string());
        }
        let resp = req
            .send()
            .map_err(|e| AppError::Invalid(format!("连接 Cloudflare 失败: {e}")))?;
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        parse_cf(status, &text)
    }
}

fn result_array(v: &Value) -> Option<&Vec<Value>> {
    v.get("result").and_then(|r| r.as_array()).or_else(|| v.as_array())
}

fn d1_id(v: &Value) -> Option<String> {
    let result = v.get("result")?;
    result
        .get("uuid")
        .or_else(|| result.get("id"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

fn parse_cf(status: u16, body: &str) -> Result<Value> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if (200..=299).contains(&status) && v.get("success") != Some(&Value::Bool(false)) {
        return Ok(v);
    }
    Err(map_cf_err(status, body))
}

fn map_cf_err(status: u16, body: &str) -> AppError {
    if status == 401 || status == 403 {
        return AppError::Invalid("令牌无效或权限不够".into());
    }
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let msg = v
        .get("errors")
        .and_then(|e| e.as_array())
        .and_then(|arr| arr.first())
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("");
    let brief = if msg.is_empty() {
        let t = body.trim().replace(['\n', '\r'], " ");
        t.chars().take(120).collect()
    } else {
        msg.to_string()
    };
    AppError::Invalid(format!("Cloudflare 返回 HTTP {status}: {brief}"))
}

fn urlencoding_bucket(bucket: &str) -> String {
    bucket
        .chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}

fn subdomain_candidates(account_name: &str, account_id: &str) -> Vec<String> {
    let mut from_name: String = account_name
        .chars()
        .flat_map(|c| c.to_lowercase())
        .filter(|c| c.is_ascii_alphanumeric())
        .take(24)
        .collect();
    if from_name.len() < 3 {
        from_name = format!("locker{}", account_id.chars().take(8).collect::<String>());
    }
    let suffix = account_id.chars().take(6).collect::<String>();
    vec![
        from_name.clone(),
        format!("{from_name}{suffix}"),
        format!("locker{}", suffix),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subdomain_falls_back_when_name_is_symbols() {
        let got = subdomain_candidates("***", "abcdef123456");
        assert!(got.iter().any(|s| s.starts_with("locker")));
        assert!(got.iter().all(|s| s.chars().all(|c| c.is_ascii_alphanumeric())));
    }
}
