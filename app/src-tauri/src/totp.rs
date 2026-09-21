//! RFC 6238 TOTP 生成与 otpauth URI 解析/拼回。

use crate::error::{AppError, Result};
use crate::model::TotpEntry;
use data_encoding::BASE32;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Sha256, Sha512};
use url::Url;

pub fn decode_secret(raw: &str) -> Result<Vec<u8>> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if cleaned.is_empty() {
        return Err(AppError::Invalid("TOTP 密钥为空".into()));
    }
    let padded = match cleaned.len() % 8 {
        0 => cleaned,
        r => format!("{}{}", cleaned, "=".repeat(8 - r)),
    };
    BASE32
        .decode(padded.as_bytes())
        .map_err(|_| AppError::Invalid("TOTP 密钥不是有效的 Base32".into()))
}

pub fn normalize_secret(raw: &str) -> Result<String> {
    let bytes = decode_secret(raw)?;
    Ok(BASE32.encode(&bytes).trim_end_matches('=').to_string())
}

pub fn generate_code(secret: &str, algorithm: &str, digits: u8, period: u32, unix_secs: u64) -> Result<String> {
    let key = decode_secret(secret)?;
    let period = period.max(1) as u64;
    let digits = digits.clamp(6, 8);
    let counter = unix_secs / period;
    let mut msg = [0u8; 8];
    msg.copy_from_slice(&counter.to_be_bytes());
    let hs = hmac_digest(algorithm, &key, &msg)?;
    let offset = (hs[hs.len() - 1] & 0x0f) as usize;
    let bin = ((u32::from(hs[offset]) & 0x7f) << 24)
        | (u32::from(hs[offset + 1]) << 16)
        | (u32::from(hs[offset + 2]) << 8)
        | u32::from(hs[offset + 3]);
    let modulus = 10u32.pow(u32::from(digits));
    Ok(format!("{:0width$}", bin % modulus, width = digits as usize))
}

pub fn remaining_seconds(period: u32, unix_secs: u64) -> u32 {
    let period = period.max(1) as u64;
    (period - (unix_secs % period)) as u32
}

fn hmac_digest(algorithm: &str, key: &[u8], msg: &[u8]) -> Result<Vec<u8>> {
    match algorithm.to_ascii_uppercase().as_str() {
        "SHA256" => {
            let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| AppError::Crypto)?;
            mac.update(msg);
            Ok(mac.finalize().into_bytes().to_vec())
        }
        "SHA512" => {
            let mut mac = Hmac::<Sha512>::new_from_slice(key).map_err(|_| AppError::Crypto)?;
            mac.update(msg);
            Ok(mac.finalize().into_bytes().to_vec())
        }
        "SHA1" | "" => {
            let mut mac = Hmac::<Sha1>::new_from_slice(key).map_err(|_| AppError::Crypto)?;
            mac.update(msg);
            Ok(mac.finalize().into_bytes().to_vec())
        }
        other => Err(AppError::Invalid(format!("不支持的 TOTP 算法：{other}"))),
    }
}

#[derive(Debug, Clone)]
pub struct ParsedOtpauth {
    pub issuer: String,
    pub account: String,
    pub secret: String,
    pub algorithm: String,
    pub digits: u8,
    pub period: u32,
}

pub fn looks_like_migration(uri: &str) -> bool {
    uri.trim().to_ascii_lowercase().starts_with("otpauth-migration://")
}

pub fn parse_import(uri: &str) -> Result<Vec<ParsedOtpauth>> {
    let trimmed = uri.trim();
    if looks_like_migration(trimmed) {
        let batch = parse_otpauth_migration(trimmed)?;
        if batch.entries.is_empty() {
            if batch.skipped_hotp > 0 {
                return Err(AppError::Invalid(
                    "导出里只有计数型 HOTP，本应用仅支持时间型 TOTP".into(),
                ));
            }
            return Err(AppError::Invalid("未识别到可导入的 TOTP 条目".into()));
        }
        return Ok(batch.entries);
    }
    Ok(vec![parse_otpauth(trimmed)?])
}

#[derive(Debug, Clone, Default)]
pub struct MigrationBatch {
    pub entries: Vec<ParsedOtpauth>,
    pub skipped_hotp: u32,
    pub skipped_unsupported: u32,
    pub version: i32,
    pub batch_size: i32,
    pub batch_index: i32,
    pub batch_id: i32,
}

pub fn parse_otpauth_migration(uri: &str) -> Result<MigrationBatch> {
    let trimmed = uri.trim();
    if !looks_like_migration(trimmed) {
        return Err(AppError::Invalid("不是 Google 身份验证器导出链接".into()));
    }
    let data = extract_migration_data(trimmed)?;
    let bytes = decode_migration_data(&data)?;
    decode_migration_payload(&bytes)
}

fn extract_migration_data(uri: &str) -> Result<String> {
    if let Ok(url) = Url::parse(uri) {
        for (k, v) in url.query_pairs() {
            if k.eq_ignore_ascii_case("data") && !v.is_empty() {
                return Ok(v.into_owned());
            }
        }
    }
    let lower = uri.to_ascii_lowercase();
    if let Some(idx) = lower.find("data=") {
        let rest = &uri[idx + 5..];
        let end = rest.find('&').unwrap_or(rest.len());
        return Ok(percent_decode(&rest[..end]));
    }
    Err(AppError::Invalid("Google 导出链接缺少 data".into()))
}

fn decode_migration_data(raw: &str) -> Result<Vec<u8>> {
    // query 里的 `+` 常被解成空格，必须还原；换行等空白才丢掉。
    let compact: String = raw
        .chars()
        .filter(|c| *c == ' ' || !c.is_ascii_whitespace())
        .map(|c| if c == ' ' { '+' } else { c })
        .collect();
    let std = compact.replace('-', "+").replace('_', "/");
    try_base64(&std)
        .or_else(|| try_base64(&compact))
        .ok_or_else(|| AppError::Invalid("Google 导出数据不是有效的 Base64".into()))
}

fn try_base64(input: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let engines = [
        base64::engine::general_purpose::STANDARD,
        base64::engine::general_purpose::STANDARD_NO_PAD,
    ];
    for engine in engines {
        if let Ok(bytes) = engine.decode(input.as_bytes()) {
            if !bytes.is_empty() {
                return Some(bytes);
            }
        }
    }
    None
}

fn decode_migration_payload(buf: &[u8]) -> Result<MigrationBatch> {
    let mut reader = ProtoReader { buf, pos: 0 };
    let mut batch = MigrationBatch {
        batch_size: 1,
        ..MigrationBatch::default()
    };
    while reader.remaining() {
        let (field, wire) = reader.read_key()?;
        match (field, wire) {
            (1, 2) => {
                let nested = reader.read_bytes()?.to_vec();
                match decode_otp_parameters(&nested) {
                    Ok(OtpParamKind::Totp(entry)) => batch.entries.push(entry),
                    Ok(OtpParamKind::Hotp) => batch.skipped_hotp += 1,
                    Ok(OtpParamKind::Unsupported) => batch.skipped_unsupported += 1,
                    Err(_) => batch.skipped_unsupported += 1,
                }
            }
            (2, 0) => batch.version = reader.read_varint()? as i32,
            (3, 0) => batch.batch_size = (reader.read_varint()? as i32).max(1),
            (4, 0) => batch.batch_index = reader.read_varint()? as i32,
            (5, 0) => batch.batch_id = reader.read_varint()? as i32,
            (_, wire) => reader.skip(wire)?,
        }
    }
    Ok(batch)
}

enum OtpParamKind {
    Totp(ParsedOtpauth),
    Hotp,
    Unsupported,
}

fn decode_otp_parameters(buf: &[u8]) -> Result<OtpParamKind> {
    let mut reader = ProtoReader { buf, pos: 0 };
    let mut secret = Vec::new();
    let mut name = String::new();
    let mut issuer = String::new();
    let mut algorithm = 0u64;
    let mut digits = 0u64;
    let mut otp_type = 0u64;
    while reader.remaining() {
        let (field, wire) = reader.read_key()?;
        match (field, wire) {
            (1, 2) => secret = reader.read_bytes()?.to_vec(),
            (2, 2) => name = reader.read_string()?,
            (3, 2) => issuer = reader.read_string()?,
            (4, 0) => algorithm = reader.read_varint()?,
            (5, 0) => digits = reader.read_varint()?,
            (6, 0) => otp_type = reader.read_varint()?,
            (_, wire) => reader.skip(wire)?,
        }
    }
    match otp_type {
        1 => return Ok(OtpParamKind::Hotp),
        0 | 2 => {}
        _ => return Ok(OtpParamKind::Unsupported),
    }
    let algorithm = match algorithm {
        0 | 1 => "SHA1",
        2 => "SHA256",
        3 => "SHA512",
        _ => return Ok(OtpParamKind::Unsupported),
    };
    if secret.is_empty() {
        return Ok(OtpParamKind::Unsupported);
    }
    let digits: u8 = match digits {
        0 | 1 => 6,
        2 => 8,
        other => other.clamp(6, 8) as u8,
    };
    let secret = BASE32.encode(&secret).trim_end_matches('=').to_string();
    let (issuer, account) = split_migration_label(&issuer, &name);
    Ok(OtpParamKind::Totp(ParsedOtpauth {
        issuer,
        account,
        secret,
        algorithm: algorithm.into(),
        digits,
        period: 30,
    }))
}

fn split_migration_label(issuer: &str, name: &str) -> (String, String) {
    let issuer = issuer.trim();
    let name = name.trim();
    if issuer.is_empty() {
        if let Some((a, b)) = name.split_once(':') {
            let left = a.trim();
            let right = b.trim();
            return (
                if left.is_empty() { "未命名".into() } else { left.into() },
                if right.is_empty() { "default".into() } else { right.into() },
            );
        }
        return (
            "未命名".into(),
            if name.is_empty() { "default".into() } else { name.into() },
        );
    }
    let account = if let Some(rest) = name
        .strip_prefix(&format!("{issuer}:"))
        .or_else(|| name.strip_prefix(&format!("{issuer}：")))
    {
        rest.trim()
    } else {
        name
    };
    (
        issuer.to_string(),
        if account.is_empty() { "default".into() } else { account.into() },
    )
}

struct ProtoReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl ProtoReader<'_> {
    fn remaining(&self) -> bool {
        self.pos < self.buf.len()
    }

    fn read_varint(&mut self) -> Result<u64> {
        let mut result = 0u64;
        let mut shift = 0;
        loop {
            if self.pos >= self.buf.len() {
                return Err(AppError::Invalid("Google 导出数据不完整".into()));
            }
            let b = self.buf[self.pos];
            self.pos += 1;
            result |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
            if shift > 63 {
                return Err(AppError::Invalid("Google 导出数据损坏".into()));
            }
        }
    }

    fn read_key(&mut self) -> Result<(u32, u8)> {
        let v = self.read_varint()?;
        Ok(((v >> 3) as u32, (v & 7) as u8))
    }

    fn read_bytes(&mut self) -> Result<&[u8]> {
        let len = self.read_varint()? as usize;
        if self.pos + len > self.buf.len() {
            return Err(AppError::Invalid("Google 导出数据不完整".into()));
        }
        let start = self.pos;
        self.pos += len;
        Ok(&self.buf[start..self.pos])
    }

    fn read_string(&mut self) -> Result<String> {
        Ok(String::from_utf8_lossy(self.read_bytes()?).into_owned())
    }

    fn skip(&mut self, wire: u8) -> Result<()> {
        match wire {
            0 => {
                self.read_varint()?;
                Ok(())
            }
            1 => self.skip_n(8),
            2 => {
                let len = self.read_varint()? as usize;
                self.skip_n(len)
            }
            5 => self.skip_n(4),
            _ => Err(AppError::Invalid("Google 导出数据含未知字段".into())),
        }
    }

    fn skip_n(&mut self, n: usize) -> Result<()> {
        if self.pos + n > self.buf.len() {
            return Err(AppError::Invalid("Google 导出数据不完整".into()));
        }
        self.pos += n;
        Ok(())
    }
}

pub fn parse_otpauth(uri: &str) -> Result<ParsedOtpauth> {
    let trimmed = uri.trim();
    if looks_like_migration(trimmed) {
        let entries = parse_import(trimmed)?;
        if entries.len() == 1 {
            return Ok(entries.into_iter().next().unwrap());
        }
        return Err(AppError::Invalid(
            "这是 Google 身份验证器批量导出，请一次导入其中的多条验证码".into(),
        ));
    }
    if !trimmed.to_ascii_lowercase().starts_with("otpauth://totp/") {
        return Err(AppError::Invalid("只支持 otpauth://totp/ 链接或 Google 身份验证器导出".into()));
    }
    let url = Url::parse(trimmed).map_err(|_| AppError::Invalid("otpauth 链接格式无效".into()))?;
    let mut pairs = std::collections::HashMap::new();
    for (k, v) in url.query_pairs() {
        pairs.insert(k.to_ascii_lowercase(), v.to_string());
    }
    let secret = pairs
        .get("secret")
        .cloned()
        .ok_or_else(|| AppError::Invalid("otpauth 缺少 secret".into()))?;
    let secret = normalize_secret(&secret)?;

    let label = url
        .path_segments()
        .and_then(|mut s| s.next())
        .unwrap_or("")
        .to_string();
    let label = percent_decode(&label);
    let (label_issuer, account) = if let Some((a, b)) = label.split_once(':') {
        (a.trim().to_string(), b.trim().to_string())
    } else if let Some((a, b)) = label.split_once('%') {
        let _ = (a, b);
        (String::new(), label)
    } else {
        (String::new(), label)
    };
    let issuer = pairs
        .get("issuer")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(label_issuer);

    let algorithm = pairs
        .get("algorithm")
        .map(|s| s.to_ascii_uppercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "SHA1".into());
    let digits = pairs
        .get("digits")
        .and_then(|s| s.parse::<u8>().ok())
        .unwrap_or(6)
        .clamp(6, 8);
    let period = pairs
        .get("period")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(30)
        .max(1);

    if account.is_empty() && issuer.is_empty() {
        return Err(AppError::Invalid("otpauth 缺少账号标识".into()));
    }

    Ok(ParsedOtpauth {
        issuer: if issuer.is_empty() { "未命名".into() } else { issuer },
        account: if account.is_empty() { "default".into() } else { account },
        secret,
        algorithm,
        digits,
        period,
    })
}

pub fn build_otpauth(entry: &TotpEntry, secret: &str) -> String {
    let label = format!("{}:{}", encode_component(&entry.issuer), encode_component(&entry.account));
    format!(
        "otpauth://totp/{label}?secret={}&issuer={}&algorithm={}&digits={}&period={}",
        secret,
        encode_component(&entry.issuer),
        entry.algorithm,
        entry.digits,
        entry.period
    )
}

fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6238_sha1_8digits() {
        // secret ASCII "12345678901234567890" = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        assert_eq!(generate_code(secret, "SHA1", 8, 30, 59).unwrap(), "94287082");
        assert_eq!(generate_code(secret, "SHA1", 8, 30, 1_111_111_109).unwrap(), "07081804");
    }

    #[test]
    fn otpauth_roundtrip() {
        let parsed = parse_otpauth(
            "otpauth://totp/GitHub:techn4950?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA1&digits=6&period=30",
        )
        .unwrap();
        assert_eq!(parsed.issuer, "GitHub");
        assert_eq!(parsed.account, "techn4950");
        let entry = TotpEntry {
            id: "x".into(),
            issuer: parsed.issuer.clone(),
            account: parsed.account.clone(),
            note: None,
            url: None,
            group: None,
            algorithm: parsed.algorithm.clone(),
            digits: parsed.digits,
            period: parsed.period,
            icon: None,
            sort_order: 0,
            created_at: String::new(),
            updated_at: String::new(),
            has_seed: true,
        };
        let uri = build_otpauth(&entry, &parsed.secret);
        let again = parse_otpauth(&uri).unwrap();
        assert_eq!(again.secret, parsed.secret);
        assert_eq!(again.issuer, parsed.issuer);
        assert_eq!(again.account, parsed.account);
    }

    // GNOME Authenticator 公开向量：Discord / johndoe@example.com
    const GOOGLE_EXPORT_DISCORD: &str = "otpauth-migration://offline?data=CjYKEExyJfPiZeroMa/MdF%2BnkTISE2pvaG5kb2VAZXhhbXBsZS5jb20aB0Rpc2NvcmQgASgBMAIQARgBIAA%3D";

    #[test]
    fn google_migration_known_vector() {
        let batch = parse_otpauth_migration(GOOGLE_EXPORT_DISCORD).unwrap();
        assert_eq!(batch.entries.len(), 1);
        assert_eq!(batch.skipped_hotp, 0);
        assert_eq!(batch.batch_size, 1);
        let e = &batch.entries[0];
        assert_eq!(e.account, "johndoe@example.com");
        assert_eq!(e.issuer, "Discord");
        assert_eq!(e.secret, "JRZCL47CMXVOQMNPZR2F7J4RGI");
        assert_eq!(e.algorithm, "SHA1");
        assert_eq!(e.digits, 6);
        assert_eq!(e.period, 30);
    }

    #[test]
    fn google_migration_roundtrip_multi_and_hotp() {
        let secret = decode_secret("JBSWY3DPEHPK3PXP").unwrap();
        let mut otp1 = Vec::new();
        proto_bytes(&mut otp1, 1, &secret);
        proto_string(&mut otp1, 2, "alice@example.com");
        proto_string(&mut otp1, 3, "GitHub");
        proto_varint(&mut otp1, 4, 1);
        proto_varint(&mut otp1, 5, 1);
        proto_varint(&mut otp1, 6, 2);

        let secret2 = decode_secret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").unwrap();
        let mut otp2 = Vec::new();
        proto_bytes(&mut otp2, 1, &secret2);
        proto_string(&mut otp2, 2, "Cloudflare:bob");
        proto_string(&mut otp2, 3, "Cloudflare");
        proto_varint(&mut otp2, 4, 2);
        proto_varint(&mut otp2, 5, 2);
        proto_varint(&mut otp2, 6, 2);

        let mut hotp = Vec::new();
        proto_bytes(&mut hotp, 1, &secret);
        proto_string(&mut hotp, 2, "legacy");
        proto_string(&mut hotp, 3, "OldBank");
        proto_varint(&mut hotp, 6, 1);

        let mut payload = Vec::new();
        proto_bytes(&mut payload, 1, &otp1);
        proto_bytes(&mut payload, 1, &otp2);
        proto_bytes(&mut payload, 1, &hotp);
        proto_varint(&mut payload, 2, 1);
        proto_varint(&mut payload, 3, 2);
        proto_varint(&mut payload, 4, 0);

        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&payload);
        let uri = format!("otpauth-migration://offline?data={b64}");
        let batch = parse_otpauth_migration(&uri).unwrap();
        assert_eq!(batch.entries.len(), 2);
        assert_eq!(batch.skipped_hotp, 1);
        assert_eq!(batch.batch_size, 2);
        assert_eq!(batch.entries[0].issuer, "GitHub");
        assert_eq!(batch.entries[0].account, "alice@example.com");
        assert_eq!(batch.entries[0].algorithm, "SHA1");
        assert_eq!(batch.entries[0].digits, 6);
        assert_eq!(batch.entries[1].issuer, "Cloudflare");
        assert_eq!(batch.entries[1].account, "bob");
        assert_eq!(batch.entries[1].algorithm, "SHA256");
        assert_eq!(batch.entries[1].digits, 8);
    }

    fn proto_varint_raw(out: &mut Vec<u8>, mut v: u64) {
        loop {
            let mut b = (v & 0x7f) as u8;
            v >>= 7;
            if v != 0 {
                b |= 0x80;
            }
            out.push(b);
            if v == 0 {
                break;
            }
        }
    }

    fn proto_key(out: &mut Vec<u8>, field: u32, wire: u8) {
        proto_varint_raw(out, (u64::from(field) << 3) | u64::from(wire));
    }

    fn proto_varint(out: &mut Vec<u8>, field: u32, v: u64) {
        proto_key(out, field, 0);
        proto_varint_raw(out, v);
    }

    fn proto_bytes(out: &mut Vec<u8>, field: u32, data: &[u8]) {
        proto_key(out, field, 2);
        proto_varint_raw(out, data.len() as u64);
        out.extend_from_slice(data);
    }

    fn proto_string(out: &mut Vec<u8>, field: u32, s: &str) {
        proto_bytes(out, field, s.as_bytes());
    }
}
