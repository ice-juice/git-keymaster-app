//! 应用自更新：源解析、检查、启动静默检查。

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod checker;
pub mod manifest;
pub mod minisign;
pub mod scheduler;
pub mod source;
pub mod watermark;

pub use crate::app_config::{UpdateSource, DEFAULT_UPDATE_REPO};
pub use source::{effective_source, resolve_endpoints};

use crate::app_config::NetworkProxy;
use crate::error::Result;
use serde::Serialize;
use tauri::AppHandle;

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
    pub sideload_update_supported: bool,
    pub store_update_supported: bool,
}

impl UpdateCheckResult {
    pub fn none(
        current_version: String,
        source: UpdateSource,
        download_url: Option<String>,
        platform: String,
        self_update_supported: bool,
        sideload_update_supported: bool,
        store_update_supported: bool,
    ) -> Self {
        Self {
            available: false,
            current_version,
            latest_version: None,
            notes: None,
            pub_date: None,
            source,
            download_url,
            platform,
            self_update_supported,
            sideload_update_supported,
            store_update_supported,
        }
    }
}

pub async fn run_check(
    app: &AppHandle,
    src: &UpdateSource,
    proxy: Option<&NetworkProxy>,
) -> Result<UpdateCheckResult> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        checker::check(app, src, proxy).await
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        crate::mobile::update::check(app, src, proxy).await
    }
}
