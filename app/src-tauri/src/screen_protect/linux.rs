//! Linux：Wayland / X11 没有可靠的应用级「排除截屏」接口。
//! 这里故意空操作，设置页用 `unsupported` 能力告知用户。

use tauri::AppHandle;

pub fn apply(_app: &AppHandle, _protect: bool) {}
