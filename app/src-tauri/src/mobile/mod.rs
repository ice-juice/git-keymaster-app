//! 移动端专有能力。官方 `tauri-plugin-updater` 不编进 Android / iOS。

#[cfg(target_os = "ios")]
pub mod ios_layout;
pub mod nav;
pub mod update;
