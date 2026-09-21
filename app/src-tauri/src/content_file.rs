//! Android 系统选图返回 content://，不能用 std::fs 直接读。

#[cfg(target_os = "android")]
use tauri::Manager;

use tauri::Runtime;

#[cfg(target_os = "android")]
struct ContentFileHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("content-file")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.jeck.gitkeymaster", "ContentFilePlugin")?;
                app.manage(ContentFileHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}

/// 桌面路径直接读。Android 的 content:// 先由系统拷到缓存文件。
pub fn read_picked_bytes(app: &tauri::AppHandle, file_path: &str) -> crate::error::Result<Vec<u8>> {
    #[cfg(target_os = "android")]
    {
        if file_path.starts_with("content:") {
            #[derive(serde::Deserialize)]
            struct Materialized {
                path: String,
            }
            let handle = app.state::<ContentFileHandle<tauri::Wry>>();
            let materialized = handle
                .0
                .run_mobile_plugin::<Materialized>(
                    "materialize",
                    serde_json::json!({ "uri": file_path }),
                )
                .map_err(|e| crate::error::AppError::Io(format!("无法读取所选图片：{e}")))?;
            let bytes = std::fs::read(&materialized.path).map_err(|e| {
                crate::error::AppError::Io(format!("无法读取所选图片：{e}"))
            })?;
            let _ = std::fs::remove_file(&materialized.path);
            return Ok(bytes);
        }
    }
    let _ = app;
    std::fs::read(file_path).map_err(|e| crate::error::AppError::Io(format!("无法读取所选图片：{e}")))
}
