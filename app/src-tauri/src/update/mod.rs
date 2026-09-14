//! 应用自更新：源解析、检查、启动静默检查。

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod checker;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod scheduler;
pub mod source;

pub use crate::app_config::{UpdateSource, DEFAULT_UPDATE_REPO};
pub use source::{effective_source, resolve_endpoints};

use serde::Serialize;

/// 检查结果给前端看；结构放在这里是为了移动端命令签名还能编过。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub available: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub source: UpdateSource,
    pub download_url: Option<String>,
    pub platform: String,
    pub self_update_supported: bool,
}
