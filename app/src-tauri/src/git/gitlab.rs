//! GitLab API 薄封装（PAT 可选功能）：上传公钥、拉取账号与所属群组。
//! Token 只从 vault 取用，绝不落明文、日志脱敏。

use crate::app_config::NetworkProxy;
use crate::error::{AppError, Result};
use crate::net;
use serde::Serialize;

const API: &str = "https://gitlab.com/api/v4";
const UA: &str = crate::identity::USER_AGENT;

pub fn user_url() -> String {
    format!("{API}/user")
}

pub fn groups_url() -> String {
    format!("{API}/groups?min_access_level=10&per_page=100")
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
        .header("PRIVATE-TOKEN", token)
        .send()
        .map_err(|e| AppError::Other(format!("请求失败：{e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Invalid(format!("PAT 校验失败：HTTP {}", resp.status())));
    }
    let v: serde_json::Value = resp.json().map_err(|e| AppError::Serde(e.to_string()))?;
    v.get("username")
        .and_then(|l| l.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Other("响应缺少 username 字段".into()))
}

/// 拉取账号所属群组（`GET /groups`）。
pub fn list_orgs(token: &str, proxy: Option<&NetworkProxy>) -> Result<Vec<String>> {
    let resp = client(proxy)?
        .get(groups_url())
        .header("PRIVATE-TOKEN", token)
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
                .filter_map(|o| {
                    o.get("full_path")
                        .or_else(|| o.get("path"))
                        .and_then(|l| l.as_str())
                        .map(|s| s.to_string())
                })
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
        .header("PRIVATE-TOKEN", token)
        .json(&body)
        .send()
        .map_err(|e| AppError::Other(format!("请求失败：{e}")))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let code = resp.status();
        let text = resp.text().unwrap_or_default();
        if text.contains("has already been taken") || text.contains("already exists") {
            return Err(AppError::Invalid("该公钥已在此账号中".into()));
        }
        Err(AppError::Invalid(format!("上传公钥失败：HTTP {code}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitlab_api_urls() {
        assert_eq!(user_url(), "https://gitlab.com/api/v4/user");
        assert_eq!(
            groups_url(),
            "https://gitlab.com/api/v4/groups?min_access_level=10&per_page=100"
        );
        assert_eq!(keys_url(), "https://gitlab.com/api/v4/user/keys");
    }
}
