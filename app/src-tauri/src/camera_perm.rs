//! 移动端向系统申请相机运行时权限。桌面端直接视为已授权。

#[cfg(any(target_os = "android", target_os = "ios"))]
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

    #[cfg(target_os = "ios")]
    {
        let _ = app;
        return tauri::async_runtime::spawn_blocking(ios::request)
            .await
            .map_err(|e| AppError::Other(format!("申请相机权限中断：{e}")))?;
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
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

    #[cfg(target_os = "ios")]
    {
        let _ = app;
        return ios::open_settings();
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        Ok(())
    }
}

/// iOS：用 AVCaptureDevice 实问相机权限，禁止假装 granted。
#[cfg(target_os = "ios")]
mod ios {
    use super::CameraPermissionStatus;
    use crate::error::{AppError, Result};
    use block2::RcBlock;
    use objc2::runtime::{AnyClass, Bool};
    use objc2::{msg_send, MainThreadMarker};
    use objc2_foundation::{ns_string, NSString, NSURL};
    use objc2_ui_kit::UIApplication;
    use std::sync::mpsc;
    use std::time::Duration;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    const TIMEOUT: Duration = Duration::from_secs(120);

    fn authorization_status() -> i64 {
        unsafe {
            let Some(cls) = AnyClass::get(c"AVCaptureDevice") else {
                return 0;
            };
            let media = ns_string!("vide");
            msg_send![cls, authorizationStatusForMediaType: media]
        }
    }

    pub fn request() -> Result<CameraPermissionStatus> {
        match authorization_status() {
            3 => Ok(CameraPermissionStatus {
                granted: true,
                permanently_denied: false,
            }),
            1 | 2 => Ok(CameraPermissionStatus {
                granted: false,
                permanently_denied: true,
            }),
            _ => request_access(),
        }
    }

    fn request_access() -> Result<CameraPermissionStatus> {
        let (tx, rx) = mpsc::channel();
        let kick = move || {
            unsafe {
                let Some(cls) = AnyClass::get(c"AVCaptureDevice") else {
                    let _ = tx.send(None);
                    return;
                };
                let media = ns_string!("vide");
                let block = RcBlock::new(move |granted: Bool| {
                    let _ = tx.send(Some(bool::from(granted)));
                });
                let _: () = msg_send![
                    cls,
                    requestAccessForMediaType: media,
                    completionHandler: &*block
                ];
            }
        };

        // 系统弹窗必须在主线程发起；等待放在 spawn_blocking 工作线程，避免卡死 UI。
        if MainThreadMarker::new().is_some() {
            return Err(AppError::Other("不能在主线程阻塞等待相机权限".into()));
        }
        dispatch2::DispatchQueue::main().exec_sync(kick);

        match rx.recv_timeout(TIMEOUT) {
            Ok(Some(true)) => Ok(CameraPermissionStatus {
                granted: true,
                permanently_denied: false,
            }),
            Ok(Some(false)) => Ok(CameraPermissionStatus {
                granted: false,
                permanently_denied: true,
            }),
            Ok(None) => Ok(CameraPermissionStatus {
                granted: false,
                permanently_denied: false,
            }),
            Err(_) => Err(AppError::Other("申请相机权限超时".into())),
        }
    }

    pub fn open_settings() -> Result<()> {
        fn open_now(mtm: MainThreadMarker) -> Result<()> {
            let ns = NSString::from_str("app-settings:");
            let nsurl = unsafe { NSURL::URLWithString(&ns) }
                .ok_or_else(|| AppError::Io("无法打开系统设置".into()))?;
            #[allow(deprecated)]
            let ok = unsafe { UIApplication::sharedApplication(mtm).openURL(&nsurl) };
            if !ok {
                return Err(AppError::Io("无法打开系统设置".into()));
            }
            Ok(())
        }

        if let Some(mtm) = MainThreadMarker::new() {
            return open_now(mtm);
        }
        let (tx, rx) = mpsc::channel();
        dispatch2::DispatchQueue::main().exec_sync(move || {
            let outcome = MainThreadMarker::new()
                .ok_or_else(|| AppError::Io("无法打开系统设置".into()))
                .and_then(open_now);
            let _ = tx.send(outcome);
        });
        rx.recv()
            .map_err(|_| AppError::Io("无法打开系统设置".into()))?
    }
}
