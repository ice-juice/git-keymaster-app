//! 本机最高已验证版本地板，单独落盘，不写进 `AppConfig`。
//!
//! 清掉应用配置目录会丢掉这份文件——已知限制；不能靠它防「重装后再喂旧包」。
//! 只有通过清单验签（或过渡期官方无签但安装包即将按包签名安装）的版本才能抬升，
//! 攻击者不能拿一张无签假清单把地板抬到 99.0.0。

use crate::error::Result;
use crate::update::manifest::parse_version;
use crate::vault::atomic_write;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "update-watermark.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWatermark {
    #[serde(default)]
    pub highest_seen_version: Option<String>,
    /// 一旦本机成功验过带 `manifestSignature` 的清单，之后拒绝无签回放。
    #[serde(default)]
    pub require_signed_manifest: bool,
}

pub fn watermark_path() -> PathBuf {
    crate::app_config::config_dir().join(FILE_NAME)
}

pub fn load() -> UpdateWatermark {
    load_from(&watermark_path())
}

pub fn load_from(path: &Path) -> UpdateWatermark {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => UpdateWatermark::default(),
    }
}

pub fn save(wm: &UpdateWatermark) -> Result<()> {
    save_to(&watermark_path(), wm)
}

pub fn save_to(path: &Path, wm: &UpdateWatermark) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(wm)?;
    atomic_write(path, json.as_bytes())
}

/// 清单声称的 version 低于本机已验证地板则拒绝，防止装回旧版。
pub fn reject_if_below_floor(version: &str, wm: &UpdateWatermark) -> crate::error::Result<()> {
    use crate::error::AppError;
    let Some(floor) = wm
        .highest_seen_version
        .as_deref()
        .and_then(parse_version)
    else {
        return Ok(());
    };
    let Some(v) = parse_version(version) else {
        return Err(AppError::Invalid("更新清单版本号无效".into()));
    };
    if v < floor {
        return Err(AppError::Invalid(format!(
            "拒绝回退到 {version}：本机已见过更高的已验证版本 {floor}"
        )));
    }
    Ok(())
}

/// 只抬升、不降低。`require_signed` 一旦为真就粘住。
pub fn raise_verified(version: &str, require_signed: bool) -> Result<()> {
    let path = watermark_path();
    raise_verified_at(&path, version, require_signed)
}

pub fn raise_verified_at(path: &Path, version: &str, require_signed: bool) -> Result<()> {
    let mut wm = load_from(path);
    apply_raise(&mut wm, version, require_signed);
    save_to(path, &wm)
}

pub fn apply_raise(wm: &mut UpdateWatermark, version: &str, require_signed: bool) {
    if let Some(new_v) = parse_version(version) {
        let raise = match wm.highest_seen_version.as_deref().and_then(parse_version) {
            Some(old) => new_v > old,
            None => true,
        };
        if raise {
            wm.highest_seen_version = Some(new_v.to_string());
        }
    }
    if require_signed {
        wm.require_signed_manifest = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("gam-watermark-{name}-{nanos}.json"))
    }

    #[test]
    fn unsigned_claim_cannot_raise_floor() {
        let wm = UpdateWatermark::default();
        // 调用方必须先判定信任；本函数只负责抬升。测试模拟「无签假清单」没走到这里。
        assert!(wm.highest_seen_version.is_none());
        assert!(!wm.require_signed_manifest);
    }

    #[test]
    fn signed_version_raises_and_sticks_require_signed() {
        let path = temp_path("raise");
        raise_verified_at(&path, "1.8.0", true).unwrap();
        let wm = load_from(&path);
        assert_eq!(wm.highest_seen_version.as_deref(), Some("1.8.0"));
        assert!(wm.require_signed_manifest);
        raise_verified_at(&path, "1.7.0", true).unwrap();
        let wm = load_from(&path);
        assert_eq!(
            wm.highest_seen_version.as_deref(),
            Some("1.8.0"),
            "地板只升不降"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn below_floor_is_rejected() {
        let wm = UpdateWatermark {
            highest_seen_version: Some("1.8.0".into()),
            require_signed_manifest: true,
        };
        assert!(reject_if_below_floor("1.7.0", &wm).is_err());
        assert!(reject_if_below_floor("1.8.0", &wm).is_ok());
        assert!(reject_if_below_floor("1.9.0", &wm).is_ok());
    }
}
