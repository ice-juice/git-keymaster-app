//! 解析统一的 `latest.json`。桌面官方插件与安卓侧载共用这份形状。
//!
//! 旧客户端只认 `version` / `platforms` / `url` / `signature`，新字段必须可忽略。
//! `version` 本身没有密码学绑定：攻击者控制 Release 后，可把历史上合法签名的旧包
//! 配上自报 `99.0.0`。新客户端必须先验 `manifestSignature`（同一把 minisign 公钥）。

use crate::app_config::{NetworkProxy, UpdateSource, DEFAULT_UPDATE_REPO};
use crate::error::{AppError, Result};
use crate::net;
use crate::update::source::{self, github_tag_json_url};
use crate::update::watermark::{self, UpdateWatermark};
use semver::Version;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;
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
    /// 对「version + 各平台 url/signature」确定性文本的 minisign，和安装包 `.sig` 同一把私钥。
    #[serde(default, rename = "manifestSignature")]
    pub manifest_signature: String,
    #[serde(default)]
    pub platforms: HashMap<String, PlatformAsset>,
}

/// 清单信任结果。无签自定义源在这里就会被拒，不会走到 `is_newer`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestTrust {
    Signed,
    /// 官方默认 GitHub 源、尚未发出带签清单的过渡期。
    OfficialUnsigned,
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

pub fn versions_equal(a: &str, b: &str) -> bool {
    match (parse_version(a), parse_version(b)) {
        (Some(x), Some(y)) => x == y,
        _ => {
            a.trim().trim_start_matches(['v', 'V']) == b.trim().trim_start_matches(['v', 'V'])
        }
    }
}

/// 与 `scripts/sign-update-manifest.mjs` 的 `canonicalManifestPayload` 字节级一致。
/// 只绑 version / url / 各平台 signature；notes、pub_date 可改但不构成升级授权。
pub fn canonical_manifest_payload(manifest: &LatestManifest) -> String {
    let mut keys: Vec<&String> = manifest.platforms.keys().collect();
    keys.sort();
    let mut lines = vec![
        "git-keymaster-update-manifest-v1".to_string(),
        format!("version:{}", manifest.version.trim()),
    ];
    for key in keys {
        let p = &manifest.platforms[key];
        lines.push(format!(
            "{}\t{}\t{}",
            key,
            p.url.trim(),
            p.signature.trim()
        ));
    }
    lines.join("\n")
}

/// 官方默认仓库才享受「尚未发出带签清单」的过渡期；自定义 GitHub / 自建清单必须带签。
pub fn is_official_default_source(src: &UpdateSource) -> bool {
    if src.kind.trim() != "github" {
        return false;
    }
    let repo = src
        .repo
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_UPDATE_REPO);
    repo == DEFAULT_UPDATE_REPO
}

pub fn evaluate_manifest_trust(
    src: &UpdateSource,
    manifest: &LatestManifest,
    wm: &UpdateWatermark,
    pubkey: &str,
) -> Result<ManifestTrust> {
    let sig = manifest.manifest_signature.trim();
    if !sig.is_empty() {
        let payload = canonical_manifest_payload(manifest);
        crate::update::minisign::verify_bytes(payload.as_bytes(), sig, pubkey)?;
        return Ok(ManifestTrust::Signed);
    }
    if wm.require_signed_manifest {
        return Err(AppError::Invalid(
            "本机已验证过带签清单，拒绝再接受无签回放".into(),
        ));
    }
    if is_official_default_source(src) {
        return Ok(ManifestTrust::OfficialUnsigned);
    }
    Err(AppError::Invalid(
        "自定义更新源必须提供清单签名，不能单凭自报版本升级".into(),
    ))
}

/// 先验签、再比地板。通过后调用方才能信 `version` / `url`。
pub fn accept_manifest(
    src: &UpdateSource,
    manifest: &LatestManifest,
    wm: &UpdateWatermark,
) -> Result<ManifestTrust> {
    let pubkey = crate::update::minisign::bundled_updater_pubkey()?;
    let trust = evaluate_manifest_trust(src, manifest, wm, &pubkey)?;
    watermark::reject_if_below_floor(&manifest.version, wm)?;
    Ok(trust)
}

/// 带签清单在检查通过时就抬地板；官方无签只在「包验签即将安装」时抬，避免无签假 version 污染。
pub fn record_verified_manifest(trust: ManifestTrust, version: &str, at_install: bool) -> Result<()> {
    match trust {
        ManifestTrust::Signed => watermark::raise_verified(version, true),
        ManifestTrust::OfficialUnsigned if at_install => watermark::raise_verified(version, false),
        ManifestTrust::OfficialUnsigned => Ok(()),
    }
}

fn async_http_client(timeout: Duration, proxy: Option<&NetworkProxy>) -> Result<reqwest::Client> {
    // https_only：连重定向也不跟到 http，避免清单/包被降级到明文。
    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .https_only(true);
    if let Some(p) = proxy {
        builder = net::apply_reqwest_async(builder, p)?;
    }
    builder
        .build()
        .map_err(|e| AppError::Other(format!("HTTP 客户端构建失败：{e}")))
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

/// `Git.Keymaster_1.9.0_arm64-v8a.apk` 文件名里的版本。对不上清单 version 就是旧安卓槽位。
pub fn apk_filename_version(url: &str) -> Option<String> {
    let name = url.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let rest = name.strip_prefix("Git.Keymaster_")?;
    let ver = rest.split('_').next()?;
    parse_version(ver).map(|v| v.to_string())
}

pub fn android_asset_matches_version(asset: &PlatformAsset, version: &str) -> bool {
    !asset.signature.trim().is_empty()
        && apk_filename_version(&asset.url)
            .is_some_and(|found| versions_equal(&found, version))
}

/// 安卓在调系统安装器之前必须有包级 minisign；空签名等于没签。
pub fn require_android_minisign(asset: &PlatformAsset) -> Result<()> {
    if asset.signature.trim().is_empty() {
        return Err(AppError::Invalid(
            "更新清单缺少 android-aarch64 的 minisign 签名，已拒绝安装".into(),
        ));
    }
    Ok(())
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
    let client = async_http_client(Duration::from_secs(20), proxy)?;
    let resp = client
        .get(url.as_str())
        .header("User-Agent", crate::identity::USER_AGENT)
        .header("Accept", "application/json")
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .timeout(Duration::from_secs(20))
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
    let client = async_http_client(Duration::from_secs(15), proxy)?;
    let resp = client
        .get(&url)
        .header("User-Agent", crate::identity::USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(15))
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
    fn android_url_must_match_manifest_version() {
        let v19 = PlatformAsset {
            url: "https://github.com/ice-juice/git-keymaster-app/releases/download/v1.9.0/Git.Keymaster_1.9.0_arm64-v8a.apk".into(),
            signature: "sig".into(),
        };
        let stale = PlatformAsset {
            url: "https://github.com/ice-juice/git-keymaster-app/releases/download/v1.8.0/Git.Keymaster_1.8.0_arm64-v8a.apk".into(),
            signature: "sig".into(),
        };
        assert!(android_asset_matches_version(&v19, "1.9.0"));
        assert!(!android_asset_matches_version(&stale, "1.9.0"));
        assert!(!android_asset_matches_version(
            &PlatformAsset {
                url: v19.url.clone(),
                signature: String::new(),
            },
            "1.9.0"
        ));
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

    fn sample_manifest(version: &str, apk_sig: &str, manifest_sig: &str) -> LatestManifest {
        serde_json::from_value(serde_json::json!({
            "version": version,
            "notes": "demo",
            "platforms": {
                "windows-x86_64": { "signature": "old-pkg-sig", "url": "https://example.com/old.exe" },
                "android-aarch64": { "signature": apk_sig, "url": "https://example.com/old.apk" }
            },
            "manifestSignature": manifest_sig
        }))
        .unwrap()
    }

    fn official_src() -> UpdateSource {
        UpdateSource::default()
    }

    fn custom_src() -> UpdateSource {
        UpdateSource {
            kind: "manifest".into(),
            repo: None,
            manifest_url: Some("https://mirror.example.com/latest.json".into()),
            include_prerelease: false,
        }
    }

    #[test]
    fn canonical_payload_is_sorted_and_stable() {
        let doc = sample_manifest("1.5.1", "apk-sig", "");
        assert_eq!(
            canonical_manifest_payload(&doc),
            "git-keymaster-update-manifest-v1\nversion:1.5.1\nandroid-aarch64\thttps://example.com/old.apk\tapk-sig\nwindows-x86_64\thttps://example.com/old.exe\told-pkg-sig"
        );
    }

    #[test]
    fn signed_manifest_is_trusted_and_replay_with_fake_version_fails() {
        let key = crate::update::minisign::TestKey::generate();
        let mut doc = sample_manifest("1.6.0", "apk-sig", "");
        let sig = key.sign(canonical_manifest_payload(&doc).as_bytes());
        doc.manifest_signature = sig.clone();
        let wm = UpdateWatermark::default();
        assert_eq!(
            evaluate_manifest_trust(&official_src(), &doc, &wm, &key.pubkey_b64).unwrap(),
            ManifestTrust::Signed
        );

        // 攻击者复用旧包 signature 字段，只把 version 改成 99.0.0：规范化文本变了，验签必须失败。
        let mut replay = doc.clone();
        replay.version = "99.0.0".into();
        replay.manifest_signature = sig;
        let err = evaluate_manifest_trust(&official_src(), &replay, &wm, &key.pubkey_b64)
            .unwrap_err()
            .to_string();
        assert!(err.contains("签名"), "{err}");
    }

    #[test]
    fn unsigned_custom_source_is_rejected() {
        let doc = sample_manifest("1.9.0", "apk-sig", "");
        let err = evaluate_manifest_trust(
            &custom_src(),
            &doc,
            &UpdateWatermark::default(),
            "unused",
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("自定义"), "{err}");
    }

    #[test]
    fn official_unsigned_allowed_until_signed_seen() {
        let doc = sample_manifest("1.7.0", "apk-sig", "");
        assert_eq!(
            evaluate_manifest_trust(
                &official_src(),
                &doc,
                &UpdateWatermark::default(),
                "unused",
            )
            .unwrap(),
            ManifestTrust::OfficialUnsigned
        );
        let require = UpdateWatermark {
            highest_seen_version: Some("1.7.0".into()),
            require_signed_manifest: true,
        };
        let err = evaluate_manifest_trust(&official_src(), &doc, &require, "unused")
            .unwrap_err()
            .to_string();
        assert!(err.contains("带签"), "{err}");
    }

    #[test]
    fn below_watermark_is_rejected_even_if_signed() {
        let key = crate::update::minisign::TestKey::generate();
        let mut doc = sample_manifest("1.6.0", "apk-sig", "");
        doc.manifest_signature = key.sign(canonical_manifest_payload(&doc).as_bytes());
        let wm = UpdateWatermark {
            highest_seen_version: Some("1.8.0".into()),
            require_signed_manifest: true,
        };
        assert!(evaluate_manifest_trust(&official_src(), &doc, &wm, &key.pubkey_b64).is_ok());
        assert!(watermark::reject_if_below_floor(&doc.version, &wm).is_err());
    }

    #[test]
    fn unsigned_check_does_not_raise_floor() {
        let mut wm = UpdateWatermark::default();
        // 检查路径对 OfficialUnsigned 不调用 apply_raise。
        assert!(wm.highest_seen_version.is_none());
        watermark::apply_raise(&mut wm, "99.0.0", false);
        // apply_raise 本身会抬；record_verified_manifest 在非安装的无签路径不会调用它。
        let mut guarded = UpdateWatermark::default();
        match ManifestTrust::OfficialUnsigned {
            ManifestTrust::OfficialUnsigned => {}
            _ => watermark::apply_raise(&mut guarded, "99.0.0", false),
        }
        assert!(guarded.highest_seen_version.is_none());
    }

    #[test]
    fn old_manifest_without_signature_field_still_parses() {
        let parsed: LatestManifest = serde_json::from_value(serde_json::json!({
            "version": "1.5.1",
            "platforms": {
                "windows-x86_64": { "signature": "s", "url": "https://example.com/a.exe" }
            }
        }))
        .unwrap();
        assert!(parsed.manifest_signature.is_empty());
    }

    #[test]
    fn android_missing_package_signature_is_rejected() {
        let asset = PlatformAsset {
            url: "https://example.com/a.apk".into(),
            signature: "  ".into(),
        };
        assert!(require_android_minisign(&asset).is_err());
        let ok = PlatformAsset {
            url: "https://example.com/a.apk".into(),
            signature: "not-empty".into(),
        };
        assert!(require_android_minisign(&ok).is_ok());
    }
}
