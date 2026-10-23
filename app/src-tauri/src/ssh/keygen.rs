//! 密钥生成：ed25519，以及 RSA 2048/4096。私钥一律用随机强口令加密。
//! 生成的私钥文件本身即密文（OpenSSH bcrypt-pbkdf + AES）。

use crate::error::{AppError, Result};
use crate::vault::crypto::random_vec;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey};
use zeroize::Zeroize;

/// 生成结果（私钥为带口令的密文；口令与私钥都要存进 vault）。
pub struct GeneratedKey {
    /// 带口令加密的 OpenSSH 私钥文本。
    pub private_openssh_encrypted: String,
    pub public_openssh: String,
    pub fingerprint: String,
    /// 随机口令（调用方负责写入 vault 后清零）。
    pub passphrase: String,
    /// `ed25519` 或 `rsa`。
    pub algorithm: String,
    pub bits: Option<u32>,
}

/// 生成一个 24 字节熵的强随机口令（URL-safe base64，约 192bit）。
pub fn random_passphrase() -> String {
    let mut bytes = random_vec(24);
    let s = B64URL.encode(&bytes);
    bytes.zeroize();
    s
}

/// 生成 ed25519 密钥对，带随机强口令。
pub fn generate_ed25519(comment: &str) -> Result<GeneratedKey> {
    let sk = PrivateKey::random(&mut rand_core::OsRng, Algorithm::Ed25519)
        .map_err(|e| AppError::Other(format!("密钥生成失败：{e}")))?;
    seal(sk, comment, "ed25519", Some(256))
}

/// 生成 RSA 密钥对（2048 或 4096），公钥为 `ssh-rsa` 单行，私钥带随机强口令。
pub fn generate_rsa(bits: u32, comment: &str) -> Result<GeneratedKey> {
    if bits != 2048 && bits != 4096 {
        return Err(AppError::Invalid("RSA 只支持 2048 或 4096".into()));
    }
    let kp = ssh_key::private::RsaKeypair::random(&mut rand_core::OsRng, bits as usize)
        .map_err(|e| AppError::Other(format!("密钥生成失败：{e}")))?;
    seal(PrivateKey::from(kp), comment, "rsa", Some(bits))
}

fn seal(mut sk: PrivateKey, comment: &str, algorithm: &str, bits: Option<u32>) -> Result<GeneratedKey> {
    sk.set_comment(comment);
    let public_openssh = sk
        .public_key()
        .to_openssh()
        .map_err(|_| AppError::Crypto)?;
    let fingerprint = sk.public_key().fingerprint(HashAlg::Sha256).to_string();
    let passphrase = random_passphrase();
    let encrypted = sk
        .encrypt(&mut rand_core::OsRng, &passphrase)
        .map_err(|_| AppError::Crypto)?;
    let private_openssh_encrypted = encrypted
        .to_openssh(LineEnding::LF)
        .map_err(|_| AppError::Crypto)?
        .to_string();
    Ok(GeneratedKey {
        private_openssh_encrypted,
        public_openssh,
        fingerprint,
        passphrase,
        algorithm: algorithm.into(),
        bits,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::key;

    #[test]
    fn generated_key_is_encrypted_and_pub_matches() {
        let g = generate_ed25519("techn4950@gam").unwrap();
        // 私钥带口令。
        let info = key::parse_private_openssh(&g.private_openssh_encrypted).unwrap();
        assert_eq!(info.encrypted, Some(true));
        assert_eq!(info.algorithm, "ed25519");
        // 公钥与私钥配对、指纹一致。
        assert!(key::pair_matches(&g.private_openssh_encrypted, &g.public_openssh).unwrap());
        assert_eq!(info.fingerprint, g.fingerprint);
    }

    #[test]
    fn generated_passphrase_unlocks_private_key() {
        let g = generate_ed25519("x").unwrap();
        assert!(key::verify_passphrase(&g.private_openssh_encrypted, &g.passphrase).is_ok());
        assert!(key::verify_passphrase(&g.private_openssh_encrypted, "wrong").is_err());
    }

    #[test]
    fn ed25519_cannot_export_pkcs1_pem() {
        let g = generate_ed25519("x").unwrap();
        assert!(key::rsa_openssh_to_pkcs1_pem(&g.private_openssh_encrypted, &g.passphrase).is_err());
    }

    #[test]
    fn passphrases_are_random_and_strong() {
        let a = random_passphrase();
        let b = random_passphrase();
        assert_ne!(a, b);
        assert!(a.len() >= 30, "约 192bit 熵，base64 长度足够");
    }

    #[test]
    fn generated_rsa_2048_is_openssh_and_encrypted() {
        let g = generate_rsa(2048, "lab host").unwrap();
        assert_eq!(g.algorithm, "rsa");
        assert_eq!(g.bits, Some(2048));
        assert!(g.public_openssh.starts_with("ssh-rsa "), "{}", g.public_openssh);
        assert!(g.public_openssh.ends_with("lab host"));
        assert!(!g.public_openssh.contains("BEGIN PUBLIC KEY"));
        let info = key::parse_private_openssh(&g.private_openssh_encrypted).unwrap();
        assert_eq!(info.encrypted, Some(true));
        assert_eq!(info.algorithm, "rsa");
        assert_eq!(info.bits, Some(2048));
        assert!(key::pair_matches(&g.private_openssh_encrypted, &g.public_openssh).unwrap());
        assert_eq!(info.fingerprint, g.fingerprint);
        assert!(key::verify_passphrase(&g.private_openssh_encrypted, &g.passphrase).is_ok());
        let pem = key::rsa_openssh_to_pkcs1_pem(&g.private_openssh_encrypted, &g.passphrase).unwrap();
        assert!(pem.starts_with("-----BEGIN RSA PRIVATE KEY-----"));
        assert!(pem.trim_end().ends_with("-----END RSA PRIVATE KEY-----"));
        assert!(!pem.contains("Proc-Type"));
        use rsa::pkcs1::DecodeRsaPrivateKey;
        use rsa::traits::PublicKeyParts;
        let parsed = rsa::RsaPrivateKey::from_pkcs1_pem(&pem).unwrap();
        assert_eq!(parsed.size() * 8, 2048);
        assert!(key::rsa_openssh_to_pkcs1_pem(&g.private_openssh_encrypted, "wrong").is_err());
    }

    #[test]
    fn generated_rsa_4096_public_is_ssh_rsa() {
        let g = generate_rsa(4096, "wide").unwrap();
        assert_eq!(g.bits, Some(4096));
        assert!(g.public_openssh.starts_with("ssh-rsa "));
        let info = key::parse_private_openssh(&g.private_openssh_encrypted).unwrap();
        assert_eq!(info.bits, Some(4096));
        assert_eq!(info.fingerprint, g.fingerprint);
    }

    #[test]
    fn rsa_rejects_other_sizes() {
        assert!(generate_rsa(1024, "x").is_err());
        assert!(generate_rsa(3072, "x").is_err());
    }
}
