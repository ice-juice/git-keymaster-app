//! Android 返回键：回系统桌面（保活）或结束任务。

use tauri::{AppHandle, Runtime};

#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
struct AppNavHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("app-nav")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.jeck.gitkeymaster", "AppNavPlugin")?;
                app.manage(AppNavHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}

pub fn leave_to_home(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.state::<AppNavHandle<tauri::Wry>>();
        return handle
            .0
            .run_mobile_plugin::<()>("leaveToHome", ())
            .map_err(|e| format!("无法回到系统桌面：{e}"));
    }
    let _ = app;
    Ok(())
}
