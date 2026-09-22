//! 解析 `git clone --progress` 写到 stderr 的进度行。
//!
//! 无 TTY 时 git 默认不刷进度；加上 `--progress` 后仍用 `\r` 刷新同一行，
//! 读取端要把 `\r` / `\n` 都当成行分隔符。

use serde::Serialize;

/// 推给前端的克隆进度。`step` 是稳定键，文案由界面按语言翻译。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgressEvent {
    pub step: &'static str,
    pub percent: Option<u8>,
}

/// 从一行 stderr 抽出步骤与百分比。无法识别时返回 `None`。
pub fn parse_git_progress_line(line: &str) -> Option<CloneProgressEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let lower = line.to_ascii_lowercase();

    if lower.starts_with("receiving objects:") {
        return Some(CloneProgressEvent {
            step: "receiving",
            percent: extract_percent(line),
        });
    }
    if lower.starts_with("resolving deltas:") {
        return Some(CloneProgressEvent {
            step: "resolving",
            percent: extract_percent(line),
        });
    }
    if lower.starts_with("updating files:") || lower.starts_with("checking out files:") {
        return Some(CloneProgressEvent {
            step: "checkingOut",
            percent: extract_percent(line),
        });
    }
    if lower.starts_with("remote:")
        || lower.starts_with("cloning into")
        || lower.starts_with("enumerating objects:")
        || lower.starts_with("counting objects:")
        || lower.starts_with("compressing objects:")
    {
        return Some(CloneProgressEvent {
            step: "connecting",
            percent: extract_percent(line),
        });
    }
    None
}

fn extract_percent(line: &str) -> Option<u8> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'%' {
                let num = std::str::from_utf8(&bytes[start..i]).ok()?.parse::<u16>().ok()?;
                return Some(num.min(100) as u8);
            }
            continue;
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_receiving_resolving_checkout() {
        assert_eq!(
            parse_git_progress_line("Receiving objects:  45% (1234/2745), 1.2 MiB | 800 KiB/s"),
            Some(CloneProgressEvent {
                step: "receiving",
                percent: Some(45),
            })
        );
        assert_eq!(
            parse_git_progress_line("Resolving deltas: 100% (890/890), done."),
            Some(CloneProgressEvent {
                step: "resolving",
                percent: Some(100),
            })
        );
        assert_eq!(
            parse_git_progress_line("Updating files:  12% (45/380)"),
            Some(CloneProgressEvent {
                step: "checkingOut",
                percent: Some(12),
            })
        );
        assert_eq!(
            parse_git_progress_line("Checking out files:  50% (100/200)"),
            Some(CloneProgressEvent {
                step: "checkingOut",
                percent: Some(50),
            })
        );
    }

    #[test]
    fn connects_without_requiring_percent() {
        assert_eq!(
            parse_git_progress_line("Cloning into 'D:/coding_program/test'..."),
            Some(CloneProgressEvent {
                step: "connecting",
                percent: None,
            })
        );
        assert_eq!(
            parse_git_progress_line("remote: Enumerating objects: 1200, done."),
            Some(CloneProgressEvent {
                step: "connecting",
                percent: None,
            })
        );
        assert_eq!(
            parse_git_progress_line("Counting objects: 100% (120/120), done."),
            Some(CloneProgressEvent {
                step: "connecting",
                percent: Some(100),
            })
        );
    }

    #[test]
    fn ignores_unrelated_stderr() {
        assert_eq!(parse_git_progress_line(""), None);
        assert_eq!(parse_git_progress_line("warning: redirecting to https://..."), None);
        assert_eq!(
            parse_git_progress_line("fatal: Could not read from remote repository."),
            None
        );
    }
}
