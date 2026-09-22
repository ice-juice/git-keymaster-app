//! 本机网络代理：拼 URL、挂到 reqwest / updater / git / ssh。

pub mod proxy;

pub use proxy::{
    apply_git_command, apply_reqwest_async, apply_reqwest_blocking, apply_ssh_command, effective,
    fetch_egress_ip, for_cloud_sync, probe_proxy_tcp, proxied_blocking_client, proxy_url,
    EgressInfo,
    ssh_auth_unsupported, ssh_helper_status, test_github_https, test_github_with_client,
    SshProxyHelper,
};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use proxy::apply_updater;
