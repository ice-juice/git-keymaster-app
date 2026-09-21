//! 内置图标清单 + 自定义图标裁剪/压缩。

use crate::error::{AppError, Result};
use crate::store;
use crate::vault::Vault;
use image::imageops::FilterType;
use image::{DynamicImage, ExtendedColorType};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinIconInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    pub glyph: String,
}

pub fn list_builtin() -> Vec<BuiltinIconInfo> {
    const ITEMS: &[(&str, &str, &str, &str)] = &[
        ("github", "GitHub", "#181717", "GH"),
        ("gitlab", "GitLab", "#FC6D26", "GL"),
        ("gitee", "Gitee", "#C71D23", "码"),
        ("google", "Google", "#4285F4", "G"),
        ("microsoft", "Microsoft", "#5E5E5E", "MS"),
        ("apple", "Apple", "#000000", "A"),
        ("aws", "AWS", "#FF9900", "AWS"),
        ("cloudflare", "Cloudflare", "#F38020", "CF"),
        ("cloudflare-r2", "R2", "#F38020", "R2"),
        ("openai", "OpenAI", "#412991", "AI"),
        ("claude", "Claude", "#D97757", "C"),
        ("anthropic", "Anthropic", "#191919", "An"),
        ("gemini", "Gemini", "#8E75B2", "Ge"),
        ("deepseek", "DeepSeek", "#5786FE", "DS"),
        ("perplexity", "Perplexity", "#1FB8CD", "Px"),
        ("huggingface", "Hugging Face", "#FFD21E", "HF"),
        ("mistral", "Mistral", "#FA520F", "Mi"),
        ("copilot", "GitHub Copilot", "#000000", "Cp"),
        ("poe", "Poe", "#5D5CDE", "Poe"),
        ("suno", "Suno", "#000000", "Su"),
        ("qwen", "通义千问", "#6950EF", "千问"),
        ("kimi", "Kimi", "#000000", "Ki"),
        ("minimax", "MiniMax", "#E73562", "MM"),
        ("ollama", "Ollama", "#000000", "Ol"),
        ("cursor", "Cursor", "#000000", "Cu"),
        ("metaai", "Meta AI", "#9844FF", "MA"),
        ("openrouter", "OpenRouter", "#94A3B8", "OR"),
        ("coze", "扣子", "#4D53E8", "扣"),
        ("dify", "Dify", "#0033FF", "Dy"),
        ("binance", "币安", "#F0B90B", "币"),
        ("okx", "欧易", "#000000", "OK"),
        ("coinbase", "Coinbase", "#0052FF", "Cb"),
        ("kucoin", "KuCoin", "#01BC8D", "Ku"),
        ("vercel", "Vercel", "#000000", "▲"),
        ("docker", "Docker", "#2496ED", "Dk"),
        ("linux", "Linux", "#FCC624", "Lx"),
        ("npm", "npm", "#CB3837", "npm"),
        ("bitbucket", "Bitbucket", "#0052CC", "BB"),
        ("azure", "Azure", "#0078D4", "Az"),
        ("digitalocean", "DigitalOcean", "#0080FF", "DO"),
        ("figma", "Figma", "#F24E1E", "Fg"),
        ("notion", "Notion", "#000000", "N"),
        ("slack", "Slack", "#4A154B", "Sl"),
        ("discord", "Discord", "#5865F2", "DC"),
        ("telegram", "Telegram", "#26A5E4", "TG"),
        ("facebook", "Facebook", "#0866FF", "f"),
        ("instagram", "Instagram", "#FF0069", "Ig"),
        ("twitter", "Twitter/X", "#000000", "X"),
        ("youtube", "YouTube", "#FF0000", "YT"),
        ("tiktok", "TikTok", "#000000", "Tk"),
        ("douyin", "抖音", "#111111", "抖"),
        ("reddit", "Reddit", "#FF4500", "Rd"),
        ("linkedin", "LinkedIn", "#0A66C2", "in"),
        ("pinterest", "Pinterest", "#BD081C", "Pt"),
        ("snapchat", "Snapchat", "#FFFC00", "Sc"),
        ("twitch", "Twitch", "#9146FF", "Tw"),
        ("weibo", "微博", "#E6162D", "微"),
        ("bilibili", "哔哩哔哩", "#00A1D6", "哔"),
        ("zhihu", "知乎", "#0084FF", "知"),
        ("xiaohongshu", "小红书", "#FF2442", "红"),
        ("threads", "Threads", "#000000", "Th"),
        ("mastodon", "Mastodon", "#6364FF", "Ma"),
        ("bluesky", "Bluesky", "#1185FE", "Bs"),
        ("kuaishou", "快手", "#FF4906", "快"),
        ("douban", "豆瓣", "#2D963D", "豆"),
        ("wechat", "微信", "#07C160", "微"),
        ("qq", "QQ", "#1EBAFC", "Q"),
        ("whatsapp", "WhatsApp", "#25D366", "WA"),
        ("signal", "Signal", "#3B45FD", "Sg"),
        ("messenger", "Messenger", "#0866FF", "Mg"),
        ("line", "LINE", "#00C300", "LN"),
        ("viber", "Viber", "#7360F2", "Vb"),
        ("skype", "Skype", "#00AFF0", "Sk"),
        ("teams", "Teams", "#6264A7", "Tm"),
        ("zoom", "Zoom", "#0B5CFF", "Zm"),
        ("kakaotalk", "KakaoTalk", "#FFCD00", "Kk"),
        ("element", "Element", "#0DBD8B", "El"),
        ("steam", "Steam", "#000000", "St"),
        ("spotify", "Spotify", "#1ED760", "Sp"),
        ("netflix", "Netflix", "#E50914", "Nf"),
        ("paypal", "PayPal", "#002991", "Pp"),
        ("amazon", "Amazon", "#FF9900", "Am"),
        ("taobao", "淘宝", "#E94F20", "淘"),
        ("alipay", "支付宝", "#1677FF", "支"),
        ("baidu", "百度", "#2932E1", "百"),
        ("aliyun", "阿里云", "#FF6A00", "阿里"),
        ("tencentcloud", "腾讯云", "#0052D9", "腾讯"),
        ("outlook", "Outlook", "#0078D4", "Ol"),
        ("gmail", "Gmail", "#EA4335", "Gm"),
        ("yahoo", "Yahoo", "#6001D2", "Yh"),
        ("dropbox", "Dropbox", "#0061FF", "Db"),
        ("proton", "Proton", "#6D4AFF", "P"),
        ("1password", "1Password", "#145FE4", "1P"),
        ("bitwarden", "Bitwarden", "#175DDC", "BW"),
        ("ssh", "SSH", "#0F172A", "SSH"),
        ("email", "邮箱", "#0EA5E9", "@"),
        ("generic", "通用", "#6366F1", "•"),
    ];
    ITEMS
        .iter()
        .map(|(id, name, color, glyph)| BuiltinIconInfo {
            id: (*id).into(),
            name: (*name).into(),
            color: (*color).into(),
            glyph: (*glyph).into(),
        })
        .collect()
}

/// 与 `app/src/shared/iconAliases.ts` 保持一致。
fn alias_id(token: &str) -> Option<&'static str> {
    Some(match token {
        "x" | "x.com" | "推特" => "twitter",
        "fb" | "fb.com" | "meta" | "脸书" => "facebook",
        "ig" => "instagram",
        "youtu.be" | "yt" => "youtube",
        "t.me" | "电报" => "telegram",
        "wa" | "wa.me" => "whatsapp",
        "微信" | "weixin" | "weixin.qq" => "wechat",
        "微博" => "weibo",
        "哔哩哔哩" | "b站" | "b23.tv" => "bilibili",
        "小红书" | "xhs" | "rednote" => "xiaohongshu",
        "知乎" => "zhihu",
        "抖音" => "douyin",
        "快手" => "kuaishou",
        "豆瓣" => "douban",
        "支付宝" => "alipay",
        "淘宝" | "tb" => "taobao",
        "百度" => "baidu",
        "阿里云" | "alibabacloud" => "aliyun",
        "腾讯云" => "tencentcloud",
        "gh" => "github",
        "chatgpt" => "openai",
        "克劳德" | "claude.ai" => "claude",
        "gemini" | "bard" | "双子座" | "aistudio" => "gemini",
        "深度求索" => "deepseek",
        "hf" | "hf.co" => "huggingface",
        "通义" | "千问" | "tongyi" => "qwen",
        "moonshot" | "月之暗面" => "kimi",
        "扣子" => "coze",
        "币安" | "bnb" => "binance",
        "欧易" | "okex" => "okx",
        "icloud" => "apple",
        "protonmail" | "proton.me" => "proton",
        "amazonaws" => "aws",
        "microsoftteams" => "teams",
        "hotmail" => "outlook",
        "谷歌" => "google",
        "npmjs" => "npm",
        "kakao" => "kakaotalk",
        "bsky" => "bluesky",
        _ => return None,
    })
}

fn stem_host(value: &str) -> &str {
    const SUFFIXES: &[&str] = &[
        ".com", ".cn", ".net", ".org", ".io", ".co", ".cc", ".app", ".dev", ".me", ".tv", ".be", ".ai",
    ];
    for suffix in SUFFIXES {
        if let Some(stem) = value.strip_suffix(suffix) {
            return stem;
        }
    }
    value
}

pub fn suggest_builtin(name: &str) -> Option<String> {
    let q = name.trim().to_ascii_lowercase();
    if q.is_empty() {
        return None;
    }
    let tokens = [q.as_str(), stem_host(&q)];
    for token in tokens {
        if let Some(id) = alias_id(token) {
            return Some(format!("builtin:{id}"));
        }
        if let Some(hit) = list_builtin().into_iter().find(|i| {
            i.id.to_ascii_lowercase() == token || i.name.to_ascii_lowercase() == token
        }) {
            return Some(format!("builtin:{}", hit.id));
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomIconInfo {
    pub icon_ref: String,
    pub data_url: String,
    pub bytes: usize,
}

pub fn process_and_store(vault: &Vault, bytes: &[u8]) -> Result<CustomIconInfo> {
    if bytes.len() > 12 * 1024 * 1024 {
        return Err(AppError::Invalid("图片超过 12MB".into()));
    }
    let img = image::load_from_memory(bytes)
        .or_else(|_| detect_and_load(bytes))
        .map_err(|_| AppError::Invalid("无法解码图片，请改用 PNG / JPG / WEBP / ICO".into()))?;
    let webp = crop_square_and_encode(&img)?;
    let hash = hex_sha256(&webp);
    store::save_icon(vault, &hash, &webp)?;
    Ok(CustomIconInfo {
        icon_ref: format!("custom:{hash}"),
        data_url: data_url(&webp),
        bytes: webp.len(),
    })
}

fn detect_and_load(bytes: &[u8]) -> image::ImageResult<DynamicImage> {
    let format = image::guess_format(bytes)?;
    let cursor = std::io::Cursor::new(bytes);
    let reader = image::ImageReader::with_format(cursor, format);
    reader.decode()
}

fn crop_square_and_encode(img: &DynamicImage) -> Result<Vec<u8>> {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err(AppError::Invalid("图片尺寸无效".into()));
    }
    let side = w.min(h);
    let x = (w - side) / 2;
    let y = (h - side) / 2;
    let cropped = img.crop_imm(x, y, side, side);
    let resized = cropped.resize_exact(128, 128, FilterType::Lanczos3);
    let rgba = resized.to_rgba8();
    let mut out = Vec::new();
    let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
    encoder
        .encode(rgba.as_raw(), 128, 128, ExtendedColorType::Rgba8)
        .map_err(|_| AppError::Invalid("WebP 编码失败".into()))?;
    Ok(out)
}

pub fn data_url(webp: &[u8]) -> String {
    use base64::Engine;
    format!(
        "data:image/webp;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(webp)
    )
}

fn hex_sha256(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

pub fn parse_custom_hash(icon_ref: &str) -> Option<&str> {
    icon_ref.strip_prefix("custom:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_square_from_rect() {
        let img = DynamicImage::new_rgba8(200, 100);
        let webp = crop_square_and_encode(&img).unwrap();
        assert!(webp.len() > 10);
        assert!(webp.len() < 20_000);
    }

    #[test]
    fn suggest_github() {
        assert_eq!(suggest_builtin("GitHub").as_deref(), Some("builtin:github"));
        assert_eq!(suggest_builtin("x.com").as_deref(), Some("builtin:twitter"));
        assert_eq!(suggest_builtin("微信").as_deref(), Some("builtin:wechat"));
        assert_eq!(suggest_builtin("facebook.com").as_deref(), Some("builtin:facebook"));
        assert_eq!(suggest_builtin("币安").as_deref(), Some("builtin:binance"));
        assert_eq!(suggest_builtin("claude.ai").as_deref(), Some("builtin:claude"));
    }
}
