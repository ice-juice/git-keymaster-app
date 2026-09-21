//! Gitee API 薄封装（PAT 可选功能）：上传公钥、拉取账号与所属组织。
//! Token 只从 vault 取用，绝不落明文、日志脱敏。令牌走 query，禁止把带 token 的 URL 写入日志。

use crate::app_config::NetworkProxy;
use crate::error::{AppError, Result};
use crate::net;
use serde::Serialize;

const API: &str = "https://gitee.com/api/v5";
const UA: &str = crate::identity::USER_AGENT;

pub fn user_url() -> String {
    format!("{API}/user")
}

pub fn orgs_url() -> String {
    format!("{API}/user/orgs")
}

pub fn keys_url() -> String {
    format!("{API}/user/keys")
}

fn client(proxy: Option<&NetworkProxy>) -> Result<reqwest::blocking::Client> {
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent(UA)
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(20));
    if let Some(p) = proxy {
        builder = net::apply_reqwest_blocking(builder, p)?;
    }
    builder
        .build()
        .map_err(|e| AppError::Other(format!("HTTP 客户端构建失败：{e}")))
}

/// 校验 PAT 并返回账号名（`GET /user`）。
pub fn whoami(token: &str, proxy: Option<&NetworkProxy>) -> Result<String> {
    let resp = client(proxy)?
        .get(user_url())
        .query(&[("access_token", token)])
        .send()
        .map_err(|e| AppError::Other(format!("请求失败：{e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Invalid(format!("PAT 校验失败：HTTP {}", resp.status())));
    }
    let v: serde_json::Value = resp.json().map_err(|e| AppError::Serde(e.to_string()))?;
    v.get("login")
        .and_then(|l| l.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Other("响应缺少 login 字段".into()))
}

/// 拉取账号所属组织（`GET /user/orgs`）。
pub fn list_orgs(token: &str, proxy: Option<&NetworkProxy>) -> Result<Vec<String>> {
    let resp = client(proxy)?
        .get(orgs_url())
        .query(&[("access_token", token), ("per_page", "100")])
        .send()
        .map_err(|e| AppError::Other(format!("请求失败：{e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Invalid(format!("拉取组织失败：HTTP {}", resp.status())));
    }
    let arr: serde_json::Value = resp.json().map_err(|e| AppError::Serde(e.to_string()))?;
    Ok(arr
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|o| o.get("login").and_then(|l| l.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default())
}

#[derive(Serialize)]
struct AddKeyBody<'a> {
    title: &'a str,
    key: &'a str,
}

/// 上传公钥（`POST /user/keys`）。
pub fn upload_public_key(
    token: &str,
    title: &str,
    public_openssh: &str,
    proxy: Option<&NetworkProxy>,
) -> Result<()> {
    let body = AddKeyBody {
        title,
        key: public_openssh.trim(),
    };
    let resp = client(proxy)?
        .post(keys_url())
        .query(&[("access_token", token)])
        .json(&body)
        .send()
        .map_err(|e| AppError::Other(format!("请求失败：{e}")))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let code = resp.status();
        let text = resp.text().unwrap_or_default();
        if text.contains("已经存在") || text.contains("already") {
            return Err(AppError::Invalid("该公钥已在此账号中".into()));
        }
        Err(AppError::Invalid(format!("上传公钥失败：HTTP {code}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitee_api_urls() {
        assert_eq!(user_url(), "https://gitee.com/api/v5/user");
        assert_eq!(orgs_url(), "https://gitee.com/api/v5/user/orgs");
        assert_eq!(keys_url(), "https://gitee.com/api/v5/user/keys");
        assert!(!user_url().contains("access_token"), "URL 拼装不得带令牌");
    }
}
