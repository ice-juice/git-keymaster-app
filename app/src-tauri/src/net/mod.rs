//! 本机网络代理：拼 URL、挂到 reqwest / updater / git / ssh。

pub mod proxy;

pub use proxy::{
    apply_git_command, apply_reqwest_async, apply_reqwest_blocking, apply_ssh_command, effective,
    for_cloud_sync, proxy_url, ssh_auth_unsupported, ssh_helper_status, test_github_https,
    SshProxyHelper,
};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use proxy::apply_updater;
