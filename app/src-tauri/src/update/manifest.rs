//! 解析统一的 `latest.json`。桌面官方插件与安卓侧载共用这份形状。

use crate::app_config::{NetworkProxy, UpdateSource, DEFAULT_UPDATE_REPO};
use crate::error::{AppError, Result};
use crate::net;
use crate::update::source::{self, github_tag_json_url};
use semver::Version;
use serde::Deserialize;
use std::collections::HashMap;
use url::Url;

/// 侧载安装包在清单 `platforms` 里的键；官方桌面 updater 不认识，会忽略。
pub const ANDROID_PLATFORM_KEY: &str = "android-aarch64";

#[derive(Debug, Clone, Deserialize)]
pub struct LatestManifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub pub_date: Option<String>,
    #[serde(default)]
    pub platforms: HashMap<String, PlatformAsset>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlatformAsset {
    pub url: String,
    #[serde(default)]
    pub signature: String,
}

pub fn is_newer(current: &str, latest: &str) -> bool {
    match (parse_version(current), parse_version(latest)) {
        (Some(c), Some(l)) => l > c,
        _ => false,
    }
}

pub fn parse_version(raw: &str) -> Option<Version> {
    Version::parse(raw.trim().trim_start_matches(['v', 'V'])).ok()
}

pub fn manual_download_url(src: &UpdateSource) -> Option<String> {
    match src.kind.as_str() {
        "github" => {
            let repo = src
                .repo
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_UPDATE_REPO);
            Some(format!("https://github.com/{repo}/releases"))
        }
        "manifest" => src.manifest_url.clone(),
        _ => None,
    }
}

pub fn platform_asset<'a>(manifest: &'a LatestManifest, key: &str) -> Option<&'a PlatformAsset> {
    manifest.platforms.get(key).filter(|p| !p.url.trim().is_empty())
}

pub async fn resolve_check_endpoints(
    src: &UpdateSource,
    proxy: Option<&NetworkProxy>,
) -> Result<Vec<Url>> {
    if src.kind == "github" && src.include_prerelease {
        let repo = src
            .repo
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_UPDATE_REPO);
        source::validate_github_repo(repo)?;
        if let Some(tag) = fetch_latest_github_tag(repo, true, proxy).await? {
            return Ok(vec![github_tag_json_url(repo, &tag)?]);
        }
    }
    source::resolve_endpoints(src)
}

pub async fn fetch_manifest(
    src: &UpdateSource,
    proxy: Option<&NetworkProxy>,
) -> Result<Option<LatestManifest>> {
    let endpoints = resolve_check_endpoints(src, proxy).await?;
    let Some(url) = endpoints.first() else {
        return Ok(None);
    };
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20));
    if let Some(p) = proxy {
        builder = net::apply_reqwest_async(builder, p)?;
    }
    let client = builder
        .build()
        .map_err(|e| AppError::Other(format!("HTTP 客户端构建失败：{e}")))?;
    let resp = client
        .get(url.as_str())
        .header("User-Agent", crate::identity::USER_AGENT)
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| {
            AppError::Other(format!(
                "检查更新失败：{e}。直连失败时可在设置 → 关于与更新 → 网络代理 中配置代理"
            ))
        })?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "检查更新失败：清单返回 {}",
            resp.status()
        )));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Other(format!("读取更新清单失败：{e}")))?;
    let parsed: LatestManifest = serde_json::from_str(&body)
        .map_err(|e| AppError::Other(format!("解析更新清单失败：{e}")))?;
    Ok(Some(parsed))
}

pub async fn fetch_latest_github_tag(
    repo: &str,
    include_prerelease: bool,
    proxy: Option<&NetworkProxy>,
) -> Result<Option<String>> {
    let url = format!("https://api.github.com/repos/{repo}/releases?per_page=15");
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15));
    if let Some(p) = proxy {
        builder = net::apply_reqwest_async(builder, p)?;
    }
    let client = builder
        .build()
        .map_err(|e| AppError::Other(format!("HTTP 客户端构建失败：{e}")))?;
    let resp = client
        .get(&url)
        .header("User-Agent", crate::identity::USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| AppError::Other(format!("读取 GitHub Releases 失败：{e}")))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let items: Vec<GitHubRelease> = resp
        .json()
        .await
        .map_err(|e| AppError::Other(format!("解析 GitHub Releases 失败：{e}")))?;
    Ok(items
        .into_iter()
        .find(|r| !r.draft && (include_prerelease || !r.prerelease))
        .map(|r| r.tag_name))
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
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
    fn parse_version_accepts_v_prefix() {
        assert_eq!(parse_version("v1.2.3").unwrap().to_string(), "1.2.3");
    }

    #[test]
    fn android_aarch64_is_optional_extra_platform() {
        let sample = serde_json::json!({
            "version": "1.5.1",
            "notes": "demo",
            "pub_date": "2026-09-14T12:00:00Z",
            "platforms": {
                "windows-x86_64": { "signature": "s", "url": "https://example.com/a.exe" },
                "darwin-universal": { "signature": "s", "url": "https://example.com/a.app.tar.gz" },
                "linux-x86_64": { "signature": "s", "url": "https://example.com/a.AppImage" },
                "android-aarch64": {
                    "signature": "",
                    "url": "https://example.com/Git.Keymaster_1.5.1_arm64-v8a.apk"
                }
            }
        });
        let parsed: LatestManifest = serde_json::from_value(sample).unwrap();
        assert_eq!(parsed.version, "1.5.1");
        let apk = platform_asset(&parsed, ANDROID_PLATFORM_KEY).unwrap();
        assert!(apk.url.ends_with("_arm64-v8a.apk"));
        assert!(platform_asset(&parsed, "windows-x86_64").is_some());
    }

    #[test]
    fn empty_android_url_is_treated_as_absent() {
        let parsed: LatestManifest = serde_json::from_value(serde_json::json!({
            "version": "1.5.1",
            "platforms": {
                "android-aarch64": { "signature": "", "url": "   " }
            }
        }))
        .unwrap();
        assert!(platform_asset(&parsed, ANDROID_PLATFORM_KEY).is_none());
    }
}
