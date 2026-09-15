//! 移动端向系统申请相机运行时权限。桌面端直接视为已授权。

#[cfg(target_os = "android")]
use crate::error::AppError;
use crate::error::Result;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
#[cfg(target_os = "android")]
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraPermissionStatus {
    pub granted: bool,
    #[serde(default)]
    pub permanently_denied: bool,
}

#[cfg(target_os = "android")]
struct CameraPermHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("camera-perm")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.jeck.gitkeymaster", "CameraPermPlugin")?;
                app.manage(CameraPermHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn request_camera_permission(app: AppHandle) -> Result<CameraPermissionStatus> {
    #[cfg(target_os = "android")]
    {
        let app = app.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let handle = app.state::<CameraPermHandle<tauri::Wry>>();
            handle
                .0
                .run_mobile_plugin::<CameraPermissionStatus>("requestCamera", ())
                .map_err(|e| AppError::Other(format!("申请相机权限失败：{e}")))
        })
        .await
        .map_err(|e| AppError::Other(format!("申请相机权限中断：{e}")))?;
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(CameraPermissionStatus {
            granted: true,
            permanently_denied: false,
        })
    }
}

#[tauri::command]
pub fn open_app_permission_settings(app: AppHandle) -> Result<()> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<CameraPermHandle<tauri::Wry>>();
        handle
            .0
            .run_mobile_plugin::<serde_json::Value>("openAppSettings", ())
            .map_err(|e| AppError::Other(format!("无法打开系统设置：{e}")))?;
        return Ok(());
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}
