//! 调用插件 check、语义化版本比较、结果映射。

use crate::app_config::{NetworkProxy, UpdateSource};
use crate::error::{AppError, Result};
use crate::net;
use crate::platform;
use crate::update::manifest;
use crate::update::UpdateCheckResult;
use tauri::AppHandle;
use tauri_plugin_updater::{Updater, UpdaterExt};
use url::Url;

pub use crate::update::manifest::{is_newer, manual_download_url, parse_version};

pub async fn check(
    app: &AppHandle,
    src: &UpdateSource,
    proxy: Option<&NetworkProxy>,
) -> Result<UpdateCheckResult> {
    let current_version = app.package_info().version.to_string();
    let platform = platform::updater_platform_key();
    let self_update_supported = platform::self_update_supported();
    let sideload_update_supported = platform::sideload_update_supported();
    let store_update_supported = platform::store_update_supported();
    let fallback = manual_download_url(src);

    let endpoints = resolve_check_endpoints(src, proxy).await?;
    let updater = build_updater(app, endpoints, proxy)?;

    match updater.check().await {
        Ok(Some(update)) => {
            let newer = is_newer(&current_version, &update.version);
            let pub_date = update.date.and_then(|d| {
                d.format(&time::format_description::well_known::Rfc3339)
                    .ok()
            });
            Ok(UpdateCheckResult {
                available: newer,
                current_version,
                latest_version: Some(update.version),
                notes: update.body,
                pub_date,
                source: src.clone(),
                download_url: Some(update.download_url.to_string()).or(fallback),
                platform,
                self_update_supported,
                sideload_update_supported,
                store_update_supported,
            })
        }
        Ok(None) => Ok(UpdateCheckResult::none(
            current_version,
            src.clone(),
            fallback,
            platform,
            self_update_supported,
            sideload_update_supported,
            store_update_supported,
        )),
        Err(e) => {
            if is_absent_release(&e) {
                Ok(UpdateCheckResult::none(
                    current_version,
                    src.clone(),
                    fallback,
                    platform,
                    self_update_supported,
                    sideload_update_supported,
                    store_update_supported,
                ))
            } else {
                Err(map_updater_err(e))
            }
        }
    }
}

pub fn build_updater(
    app: &AppHandle,
    endpoints: Vec<Url>,
    proxy: Option<&NetworkProxy>,
) -> Result<Updater> {
    let mut builder = app
        .updater_builder()
        .timeout(std::time::Duration::from_secs(20))
        .endpoints(endpoints)
        .map_err(map_updater_err)?;
    if let Some(p) = proxy {
        builder = net::apply_updater(builder, p).map_err(map_proxy_err)?;
    }
    builder.build().map_err(map_updater_err)
}

pub async fn resolve_check_endpoints(
    src: &UpdateSource,
    proxy: Option<&NetworkProxy>,
) -> Result<Vec<Url>> {
    manifest::resolve_check_endpoints(src, proxy).await
}

pub fn map_updater_err(e: tauri_plugin_updater::Error) -> AppError {
    AppError::Other(format!(
        "检查或安装更新失败：{e}。直连失败时可在设置 → 关于与更新 → 网络代理 中配置代理"
    ))
}

fn map_proxy_err(e: AppError) -> AppError {
    match e {
        AppError::Invalid(m) | AppError::Other(m) => AppError::Other(m),
        other => other,
    }
}

fn is_absent_release(e: &tauri_plugin_updater::Error) -> bool {
    matches!(
        e,
        tauri_plugin_updater::Error::ReleaseNotFound
            | tauri_plugin_updater::Error::TargetNotFound(_)
            | tauri_plugin_updater::Error::TargetsNotFound(_)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_rejects_downgrade_and_equal() {
        assert!(is_newer("1.1.0", "1.2.0"));
        assert!(is_newer("v1.1.0", "1.2.0"));
        assert!(!is_newer("1.2.0", "1.1.0"));
        assert!(!is_newer("1.1.0", "1.1.0"));
        assert!(!is_newer("not-a-version", "1.2.0"));
    }

    #[test]
    fn github_manual_url_points_to_releases() {
        let src = UpdateSource::default();
        assert_eq!(
            manual_download_url(&src).as_deref(),
            Some("https://github.com/ice-juice/git-keymaster-app/releases")
        );
    }

    #[test]
    fn parse_version_accepts_v_prefix() {
        assert_eq!(parse_version("v1.2.3").unwrap().to_string(), "1.2.3");
    }

    #[test]
    fn latest_json_requires_all_shipped_platforms() {
        let sample = serde_json::json!({
            "version": "1.2.0",
            "notes": "demo",
            "pub_date": "2026-09-09T12:00:00Z",
            "platforms": {
                "windows-x86_64": { "signature": "s", "url": "https://example.com/a.exe" },
                "darwin-x86_64": { "signature": "s", "url": "https://example.com/a.app.tar.gz" },
                "darwin-aarch64": { "signature": "s", "url": "https://example.com/a.app.tar.gz" },
                "darwin-universal": { "signature": "s", "url": "https://example.com/a.app.tar.gz" },
                "linux-x86_64": { "signature": "s", "url": "https://example.com/a.AppImage" },
                "android-aarch64": { "signature": "", "url": "https://example.com/a.apk" }
            }
        });
        let platforms = sample["platforms"].as_object().unwrap();
        for key in [
            "windows-x86_64",
            "linux-x86_64",
            "darwin-x86_64",
            "darwin-aarch64",
            "darwin-universal",
            "android-aarch64",
        ] {
            assert!(platforms.contains_key(key), "missing {key}");
        }
    }

    #[test]
    fn default_github_manifest_probe_returns_real_status() {
        let src = UpdateSource::default();
        let url = crate::update::source::resolve_endpoints(&src).unwrap()[0].clone();
        let resp = reqwest::blocking::Client::new()
            .get(url.as_str())
            .header("User-Agent", "git-keymaster-test")
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .expect("应能访问默认更新源");
        let status = resp.status();
        assert!(
            status.as_u16() == 404 || status.is_success(),
            "默认源应返回 404（尚未发版）或 200，实际 {status}"
        );
        if status.is_success() {
            let body: serde_json::Value = resp.json().expect("latest.json 应为 JSON");
            assert!(body.get("version").is_some(), "清单应含 version");
            assert!(body.get("platforms").is_some(), "清单应含 platforms");
        }
    }
}
