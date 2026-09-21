//! 仓库管理与地址智能识别（M5）。

pub mod gitee;
pub mod github;
pub mod gitlab;
pub mod infer;
pub mod owners;
pub mod repo;
pub mod url;

use serde::{Deserialize, Serialize};

/// 支持 PAT 的代码托管平台。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitProvider {
    Github,
    Gitlab,
    Gitee,
}

impl GitProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Gitlab => "gitlab",
            Self::Gitee => "gitee",
        }
    }
}
