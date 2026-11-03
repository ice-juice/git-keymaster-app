//! 分享服务地址：格式校验与部署时的写入取舍。

use crate::error::{AppError, Result};

pub fn normalize_worker_url(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("请填写分享服务地址".into()));
    }
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err(AppError::Invalid(
            "分享服务地址需要以 http:// 或 https:// 开头".into(),
        ));
    }
    let url = reqwest::Url::parse(trimmed).map_err(|_| AppError::Invalid("分享服务地址无效".into()))?;
    if url.host_str().map(str::is_empty).unwrap_or(true) {
        return Err(AppError::Invalid("分享服务地址缺少主机名".into()));
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddressDecision {
    WriteNew(String),
    KeepCustom { current: String, workers_dev: String },
}

/// 当前为空或仍是上次记下的 workers.dev 时写入新地址；已是别的主机名则保留。
pub fn decide_base_url(current: &str, last_workers_dev: &str, new_workers_dev: &str) -> AddressDecision {
    let new = new_workers_dev.trim().trim_end_matches('/').to_string();
    let current_n = current.trim().trim_end_matches('/');
    let last_n = last_workers_dev.trim().trim_end_matches('/');
    if current_n.is_empty() || (!last_n.is_empty() && current_n.eq_ignore_ascii_case(last_n)) {
        AddressDecision::WriteNew(new)
    } else {
        AddressDecision::KeepCustom {
            current: current_n.to_string(),
            workers_dev: new,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_requires_http_and_host() {
        assert!(normalize_worker_url("").is_err());
        assert!(normalize_worker_url("locker.example.com").is_err());
        assert!(normalize_worker_url("ftp://locker.example.com").is_err());
        assert!(normalize_worker_url("https://").is_err());
        assert_eq!(
            normalize_worker_url("https://file-locker.ex.workers.dev/").unwrap(),
            "https://file-locker.ex.workers.dev"
        );
        assert_eq!(
            normalize_worker_url(" http://127.0.0.1:8787/app/ ").unwrap(),
            "http://127.0.0.1:8787/app"
        );
    }

    #[test]
    fn write_new_when_empty_or_same_as_last_workers_dev() {
        assert_eq!(
            decide_base_url("", "", "https://file-locker.a.workers.dev/"),
            AddressDecision::WriteNew("https://file-locker.a.workers.dev".into())
        );
        assert_eq!(
            decide_base_url(
                "https://file-locker.old.workers.dev/",
                "https://file-locker.old.workers.dev",
                "https://file-locker.new.workers.dev"
            ),
            AddressDecision::WriteNew("https://file-locker.new.workers.dev".into())
        );
    }

    #[test]
    fn keep_custom_hostname() {
        assert_eq!(
            decide_base_url(
                "https://share.example.com",
                "https://file-locker.old.workers.dev",
                "https://file-locker.new.workers.dev"
            ),
            AddressDecision::KeepCustom {
                current: "https://share.example.com".into(),
                workers_dev: "https://file-locker.new.workers.dev".into(),
            }
        );
        assert_eq!(
            decide_base_url(
                "https://share.example.com",
                "",
                "https://file-locker.new.workers.dev"
            ),
            AddressDecision::KeepCustom {
                current: "https://share.example.com".into(),
                workers_dev: "https://file-locker.new.workers.dev".into(),
            }
        );
    }
}
