//! 二维码解码（图片/屏幕）与 otpauth 二维码生成。

use crate::error::{AppError, Result};
use crate::model::TotpEntry;
use crate::totp::{parse_otpauth, parse_otpauth_migration, ParsedOtpauth};
use image::{DynamicImage, ImageFormat};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenHit {
    pub display: String,
    pub uri: String,
    pub parsed: ScreenParsed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenParsed {
    pub issuer: String,
    pub account: String,
    pub algorithm: String,
    pub digits: u8,
    pub period: u32,
    pub secret: String,
}

impl From<&ParsedOtpauth> for ScreenParsed {
    fn from(p: &ParsedOtpauth) -> Self {
        ScreenParsed {
            issuer: p.issuer.clone(),
            account: p.account.clone(),
            algorithm: p.algorithm.clone(),
            digits: p.digits,
            period: p.period,
            secret: p.secret.clone(),
        }
    }
}

pub fn decode_image_bytes(bytes: &[u8]) -> Result<Vec<String>> {
    let img = image::load_from_memory(bytes)
        .or_else(|_| {
            let fmt = image::guess_format(bytes)?;
            image::ImageReader::with_format(std::io::Cursor::new(bytes), fmt).decode()
        })
        .map_err(|_| AppError::Invalid("无法读取二维码图片".into()))?;
    decode_dynamic(&img)
}

fn decode_dynamic(img: &DynamicImage) -> Result<Vec<String>> {
    let luma = img.to_luma8();
    let mut prepared = rqrr::PreparedImage::prepare(luma);
    let mut out = Vec::new();
    for grid in prepared.detect_grids() {
        if let Ok((_, content)) = grid.decode() {
            let t = content.trim().to_string();
            if !t.is_empty() && !out.contains(&t) {
                out.push(t);
            }
        }
    }
    Ok(out)
}

pub fn import_from_image(bytes: &[u8]) -> Result<ParsedOtpauth> {
    let entries = import_all_from_image(bytes)?;
    Ok(entries.into_iter().next().unwrap())
}

pub fn import_all_from_image(bytes: &[u8]) -> Result<Vec<ParsedOtpauth>> {
    let texts = decode_image_bytes(bytes)?;
    let entries = collect_totp_from_texts(&texts);
    if entries.is_empty() {
        return Err(AppError::Invalid(
            "图片中未识别到 otpauth 或 Google 身份验证器导出二维码".into(),
        ));
    }
    Ok(entries)
}

pub fn collect_totp_from_texts(texts: &[String]) -> Vec<ParsedOtpauth> {
    let mut out = Vec::new();
    for t in texts {
        let lower = t.to_ascii_lowercase();
        if lower.starts_with("otpauth-migration://") {
            if let Ok(batch) = parse_otpauth_migration(t) {
                out.extend(batch.entries);
            }
        } else if lower.starts_with("otpauth://") {
            if let Ok(parsed) = parse_otpauth(t) {
                out.push(parsed);
            }
        }
    }
    out
}

fn stub_entry(p: &ParsedOtpauth) -> TotpEntry {
    TotpEntry {
        id: String::new(),
        issuer: p.issuer.clone(),
        account: p.account.clone(),
        note: None,
        url: None,
        group: None,
        algorithm: p.algorithm.clone(),
        digits: p.digits,
        period: p.period,
        icon: None,
        sort_order: 0,
        created_at: String::new(),
        updated_at: String::new(),
        has_seed: true,
    }
}

#[cfg(mobile)]
pub fn scan_screen() -> Result<Vec<ScreenHit>> {
    Err(AppError::Unsupported("屏幕扫码"))
}

#[cfg(all(desktop, target_os = "linux"))]
pub fn scan_screen() -> Result<Vec<ScreenHit>> {
    Err(AppError::Other(
        "当前 Linux 安装包未包含屏幕扫码（系统截屏库与 Ubuntu 22.04 不兼容）。请改用图片或 otpauth URI 导入。".into(),
    ))
}

#[cfg(all(desktop, not(target_os = "linux")))]
pub fn scan_screen() -> Result<Vec<ScreenHit>> {
    let monitors = xcap::Monitor::all().map_err(|e| AppError::Other(format!("截屏失败：{e}")))?;
    let mut hits = Vec::new();
    for (idx, mon) in monitors.iter().enumerate() {
        let name = {
            let n = mon.name().unwrap_or_default();
            if n.is_empty() {
                format!("显示器 {}", idx + 1)
            } else {
                n
            }
        };
        let captured = mon
            .capture_image()
            .map_err(|e| AppError::Other(format!("截取 {name} 失败：{e}")))?;
        let dyn_img = DynamicImage::ImageRgba8(captured);
        if let Ok(texts) = decode_dynamic(&dyn_img) {
            for t in texts {
                let lower = t.to_ascii_lowercase();
                if lower.starts_with("otpauth-migration://") {
                    if let Ok(batch) = parse_otpauth_migration(&t) {
                        for parsed in batch.entries {
                            hits.push(ScreenHit {
                                display: name.clone(),
                                uri: crate::totp::build_otpauth(&stub_entry(&parsed), &parsed.secret),
                                parsed: ScreenParsed::from(&parsed),
                            });
                        }
                    }
                } else if let Ok(parsed) = parse_otpauth(&t) {
                    hits.push(ScreenHit {
                        display: name.clone(),
                        uri: t,
                        parsed: ScreenParsed::from(&parsed),
                    });
                }
            }
        }
    }
    Ok(hits)
}

pub fn render_otpauth_png_b64(uri: &str) -> Result<String> {
    render_qr_png_b64(uri)
}

pub fn render_qr_png_b64(payload: &str) -> Result<String> {
    let code = qrcode::QrCode::new(payload.as_bytes())
        .map_err(|_| AppError::Invalid("无法生成二维码（内容过长或非法）".into()))?;
    let img = code
        .render::<image::Luma<u8>>()
        .quiet_zone(true)
        .min_dimensions(240, 240)
        .build();
    let mut png = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut png);
        img.write_to(&mut cursor, ImageFormat::Png)
            .map_err(|_| AppError::Invalid("二维码 PNG 编码失败".into()))?;
    }
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_scan_screen_explains_fallback() {
        let err = super::scan_screen().expect_err("linux build must not call xcap");
        let msg = err.to_string();
        assert!(msg.contains("图片") || msg.contains("URI"));
    }
}
