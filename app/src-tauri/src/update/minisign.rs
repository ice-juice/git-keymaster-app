//! 与 `tauri-plugin-updater` 同一条 minisign 验签路径。
//!
//! 桌面插件只在下载安装包后验 `platforms.*.signature`。清单里的 `version` /
//! `url` 本身没有密码学绑定，所以新客户端必须再用同一把公钥验清单签名，
//! 以及安卓 APK 字节。不要另造哈希协议，否则发版脚本签的 `.sig` 对不上。

use crate::error::{AppError, Result};
use base64::Engine;
use minisign_verify::{PublicKey, Signature};

/// 编译期从 `tauri.conf.json` 抽出 updater 公钥，避免运行时再读配置文件。
const TAURI_CONF_JSON: &str = include_str!("../../tauri.conf.json");

/// 与官方 updater 一致：`pubkey` / `.sig` 都是「minisign 文本再包一层 Base64」。
pub fn verify_bytes(data: &[u8], signature_b64: &str, pubkey_b64: &str) -> Result<()> {
    let pub_key_decoded = decode_b64_utf8(pubkey_b64, "更新公钥")?;
    let public_key = PublicKey::decode(&pub_key_decoded)
        .map_err(|e| AppError::Invalid(format!("更新公钥无法解码：{e}")))?;
    let signature_text = decode_b64_utf8(signature_b64, "更新签名")?;
    let signature = Signature::decode(&signature_text)
        .map_err(|e| AppError::Invalid(format!("更新签名无法解码：{e}")))?;
    // 第三个参数 true：允许 minisign 预哈希模式，和 tauri-plugin-updater 保持一致。
    public_key
        .verify(data, &signature, true)
        .map_err(|_| AppError::Invalid("更新签名校验失败，已拒绝".into()))?;
    Ok(())
}

pub fn bundled_updater_pubkey() -> Result<String> {
    let v: serde_json::Value = serde_json::from_str(TAURI_CONF_JSON)
        .map_err(|e| AppError::Other(format!("解析 tauri.conf.json 失败：{e}")))?;
    v["plugins"]["updater"]["pubkey"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Other("tauri.conf.json 缺少 plugins.updater.pubkey".into()))
}

fn decode_b64_utf8(raw: &str, what: &str) -> Result<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|_| AppError::Invalid(format!("{what} 不是合法的 Base64")))?;
    String::from_utf8(bytes).map_err(|_| AppError::Invalid(format!("{what} 不是合法的 UTF-8")))
}

#[cfg(test)]
pub(crate) fn encode_minisign_text(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
}

#[cfg(test)]
pub(crate) struct TestKey {
    pub pubkey_b64: String,
    sk: minisign::SecretKey,
}

#[cfg(test)]
impl TestKey {
    pub fn generate() -> Self {
        // 测试只需要能被 minisign-verify 验过的密钥对；加密私钥会把 sk 字节搅乱，sign(pk, sk) 对不上。
        let minisign::KeyPair { pk, sk } =
            minisign::KeyPair::generate_unencrypted_keypair().expect("生成测试 minisign 密钥");
        let pk_file = pk.to_box().expect("导出测试公钥").to_string();
        Self {
            pubkey_b64: encode_minisign_text(&pk_file),
            sk,
        }
    }

    pub fn sign(&self, data: &[u8]) -> String {
        let signed = minisign::sign(None, &self.sk, data, None, None).expect("测试签名");
        encode_minisign_text(&signed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_pubkey_is_present() {
        let pk = bundled_updater_pubkey().unwrap();
        assert!(pk.starts_with("dW50"));
        decode_b64_utf8(&pk, "内置公钥").unwrap();
    }

    #[test]
    fn verify_accepts_matching_bytes_and_rejects_tamper() {
        let key = TestKey::generate();
        let data = b"git-keymaster-update-manifest-v1\nversion:1.8.0";
        let sig = key.sign(data);
        verify_bytes(data, &sig, &key.pubkey_b64).unwrap();
        assert!(verify_bytes(b"tampered", &sig, &key.pubkey_b64).is_err());
        assert!(verify_bytes(data, "", &key.pubkey_b64).is_err());
    }
}
