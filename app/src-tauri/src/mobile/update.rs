//! 安卓侧载更新：拉 `latest.json` 的 `android-aarch64`，下载 APK，交给系统安装器。
//! iOS 只允许检查版本并提示去商店，禁止 IPA 换包。

use crate::app_config::{NetworkProxy, UpdateSource};
use crate::error::{AppError, Result};
use crate::platform;
use crate::update::manifest::{self, android_asset_matches_version, platform_asset, ANDROID_PLATFORM_KEY};
use crate::update::UpdateCheckResult;
use tauri::{AppHandle, Runtime};
#[cfg(target_os = "android")]
use crate::net;
#[cfg(target_os = "android")]
use serde::Serialize;
#[cfg(target_os = "android")]
use serde_json::json;
#[cfg(target_os = "android")]
use std::fs::File;
#[cfg(target_os = "android")]
use std::io::Write;
#[cfg(target_os = "android")]
use std::path::PathBuf;
#[cfg(target_os = "android")]
use tauri::{Emitter, Manager};
#[cfg(any(target_os = "android", test))]
use url::Url;

#[cfg(target_os = "android")]
struct SideloadHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// 注册安卓侧载安装插件。桌面 / iOS 为空插件，避免把官方 updater 拉进 APK。
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("sideload-update")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("com.jeck.gitkeymaster", "SideloadUpdatePlugin")?;
                app.manage(SideloadHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}

pub async fn check(
    app: &AppHandle,
    src: &UpdateSource,
    proxy: Option<&NetworkProxy>,
) -> Result<UpdateCheckResult> {
    let current_version = app.package_info().version.to_string();
    let platform = platform::updater_platform_key();
    let fallback = manifest::manual_download_url(src);
    let sideload = platform::sideload_update_supported();
    let store = platform::store_update_supported();

    match manifest::fetch_manifest(src, proxy).await {
        Ok(Some(doc)) => {
            let wm = crate::update::watermark::load();
            let trust = manifest::accept_manifest(src, &doc, &wm)?;
            if matches!(trust, manifest::ManifestTrust::Signed) {
                let _ = manifest::record_verified_manifest(trust, &doc.version, false);
            }
            let latest = doc.version.clone();
            let newer = manifest::is_newer(&current_version, &latest);
            let asset_url = if cfg!(target_os = "android") {
                platform_asset(&doc, ANDROID_PLATFORM_KEY)
                    .filter(|asset| android_asset_matches_version(asset, &doc.version))
                    .map(|a| a.url.clone())
            } else {
                None
            };
            Ok(UpdateCheckResult {
                available: newer && (asset_url.is_some() || !sideload),
                current_version,
                latest_version: Some(latest),
                notes: doc.notes,
                pub_date: doc.pub_date,
                source: src.clone(),
                download_url: asset_url.clone().or(fallback),
                platform,
                self_update_supported: false,
                sideload_update_supported: sideload && asset_url.is_some(),
                store_update_supported: store,
            })
        }
        Ok(None) => Ok(UpdateCheckResult::none(
            current_version,
            src.clone(),
            fallback,
            platform,
            false,
            sideload,
            store,
        )),
        Err(e) => Err(e),
    }
}

#[cfg(target_os = "android")]
pub async fn download_and_install(
    app: &AppHandle,
    src: &UpdateSource,
    proxy: Option<&NetworkProxy>,
) -> Result<()> {
    if !platform::sideload_update_supported() {
        return Err(AppError::Unsupported("安卓侧载更新"));
    }
    let current_version = app.package_info().version.to_string();
    let doc = manifest::fetch_manifest(src, proxy)
        .await?
        .ok_or_else(|| AppError::Invalid("远端尚未发布更新清单".into()))?;
    let wm = crate::update::watermark::load();
    let trust = manifest::accept_manifest(src, &doc, &wm)?;
    if !manifest::is_newer(&current_version, &doc.version) {
        return Err(AppError::Invalid("不允许安装更低或相同版本".into()));
    }
    let asset = platform_asset(&doc, ANDROID_PLATFORM_KEY)
        .filter(|item| android_asset_matches_version(item, &doc.version))
        .ok_or_else(|| {
            AppError::Invalid("更新清单里的安卓包还不是当前版本，请稍后再检查更新".into())
        })?;
    manifest::require_android_minisign(asset)?;
    let url = parse_https_download(&asset.url)?;
    let apk_signature = asset.signature.clone();

    let dest = apk_cache_path(app, &doc.version)?;
    let _ = app.emit(
        "update-progress",
        json!({ "phase": "started", "downloaded": 0, "total": null }),
    );
    download_apk(&url, &dest, proxy, app).await?;
    verify_downloaded_apk(&dest, &apk_signature)?;
    let _ = app.emit("update-progress", json!({ "phase": "finished" }));
    // 包字节已验签；官方无签过渡期也只在这一刻抬地板，避免无签假 version 在检查时污染。
    let _ = manifest::record_verified_manifest(trust, &doc.version, true);

    let path = dest.to_string_lossy().to_string();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || invoke_installer(&app, &path))
        .await
        .map_err(|e| AppError::Other(format!("调起安装器中断：{e}")))?
}

#[cfg(not(target_os = "android"))]
pub async fn download_and_install(
    _app: &AppHandle,
    _src: &UpdateSource,
    _proxy: Option<&NetworkProxy>,
) -> Result<()> {
    Err(AppError::Unsupported("iOS 应用内换包"))
}

#[cfg(target_os = "android")]
fn invoke_installer(app: &AppHandle, path: &str) -> Result<()> {
    let handle = app.state::<SideloadHandle<tauri::Wry>>();
    handle
        .0
        .run_mobile_plugin::<SideloadInstallResult>("installApk", json!({ "path": path }))
        .map_err(|e| map_sideload_err(&e.to_string()))?;
    Ok(())
}

#[cfg(target_os = "android")]
fn map_sideload_err(msg: &str) -> AppError {
    if msg.contains("SIGNATURE_MISMATCH") {
        AppError::Invalid("不是同一发布者，请卸载重装".into())
    } else if msg.contains("DEBUG_OVER_RELEASE") {
        AppError::Invalid("调试包不能覆盖正式安装，请改用同一渠道的安装包".into())
    } else if msg.contains("UNKNOWN_SOURCE") {
        AppError::Invalid("未允许安装未知应用，请在系统设置中开启后重试".into())
    } else if msg.contains("USER_DENIED") {
        AppError::Invalid("已取消安装".into())
    } else {
        AppError::Other(format!("调起系统安装器失败：{msg}"))
    }
}

#[cfg(any(target_os = "android", test))]
fn parse_https_download(raw: &str) -> Result<Url> {
    let url = Url::parse(raw.trim()).map_err(|e| AppError::Invalid(format!("APK 地址无效：{e}")))?;
    if url.scheme() != "https" {
        return Err(AppError::Invalid("更新包必须使用 HTTPS".into()));
    }
    if url.host_str().is_none() {
        return Err(AppError::Invalid("APK 地址缺少主机名".into()));
    }
    Ok(url)
}

#[cfg(target_os = "android")]
fn verify_downloaded_apk(path: &std::path::Path, signature: &str) -> Result<()> {
    let bytes = std::fs::read(path)?;
    let pubkey = crate::update::minisign::bundled_updater_pubkey()?;
    crate::update::minisign::verify_bytes(&bytes, signature, &pubkey).map_err(|_| {
        AppError::Invalid("APK minisign 校验失败，已拒绝安装".into())
    })
}

#[cfg(target_os = "android")]
fn apk_cache_path(app: &AppHandle, version: &str) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Other(format!("无法解析缓存目录：{e}")))?;
    std::fs::create_dir_all(&dir)?;
    let _ = std::fs::remove_file(dir.join("git-keymaster-update.apk"));
    let safe: String = version
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    Ok(dir.join(format!("git-keymaster-update-{safe}.apk")))
}

#[cfg(target_os = "android")]
async fn download_apk(
    url: &Url,
    dest: &PathBuf,
    proxy: Option<&NetworkProxy>,
    app: &AppHandle,
) -> Result<()> {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .https_only(true);
    if let Some(p) = proxy {
        builder = net::apply_reqwest_async(builder, p)?;
    }
    let client = builder
        .build()
        .map_err(|e| AppError::Other(format!("HTTP 客户端构建失败：{e}")))?;
    let resp = client
        .get(url.as_str())
        .header("User-Agent", crate::identity::USER_AGENT)
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .send()
        .await
        .map_err(|e| AppError::Other(format!("下载更新包失败：{e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "下载更新包失败：HTTP {}",
            resp.status()
        )));
    }
    let total = resp.content_length();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Other(format!("读取更新包失败：{e}")))?;
    if let Some(total) = total {
        let _ = app.emit(
            "update-progress",
            json!({
                "phase": "downloading",
                "downloaded": bytes.len() as u64,
                "total": total
            }),
        );
    }
    if dest.exists() {
        let _ = std::fs::remove_file(dest);
    }
    let mut file = File::create(dest)?;
    file.write_all(&bytes)?;
    file.flush()?;
    Ok(())
}

#[cfg(target_os = "android")]
#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SideloadInstallResult {
    #[serde(default)]
    launched: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apk_url_must_be_https() {
        assert!(parse_https_download("http://example.com/a.apk").is_err());
        assert!(parse_https_download("https://example.com/a.apk").is_ok());
    }

    #[test]
    fn apk_minisign_empty_or_wrong_is_rejected() {
        assert!(manifest::require_android_minisign(&manifest::PlatformAsset {
            url: "https://example.com/a.apk".into(),
            signature: String::new(),
        })
        .is_err());
        let key = crate::update::minisign::TestKey::generate();
        let apk = b"fake-apk-bytes";
        let sig = key.sign(apk);
        crate::update::minisign::verify_bytes(apk, &sig, &key.pubkey_b64).unwrap();
        assert!(crate::update::minisign::verify_bytes(b"other", &sig, &key.pubkey_b64).is_err());
    }
}
