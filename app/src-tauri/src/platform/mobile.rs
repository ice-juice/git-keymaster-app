//! Android / iOS 实现：沙箱目录本身只有本应用可读，不需要再收紧 ACL / chmod。
//!
//! - `secure_key_file`：移动端沙箱即隔离，空操作即可。
//! - `ssh_dir`：返回沙箱内占位目录，供身份/密钥路径拼接。
//!   真正会 spawn `git` / `ssh` / `ssh-agent` 的命令在移动端返回 `AppError::Unsupported`。

use super::PlatformOps;
use crate::error::Result;
use std::path::{Path, PathBuf};

pub struct Mobile;

impl PlatformOps for Mobile {
    fn secure_key_file(&self, _path: &Path) -> Result<()> {
        Ok(())
    }

    fn ssh_dir(&self) -> PathBuf {
        crate::identity::app_config_dir().join("ssh")
    }
}
