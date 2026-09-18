//! iOS 系统剪贴板：UIPasteboard.general。

use objc2_foundation::NSString;
use objc2_ui_kit::UIPasteboard;

pub fn write_plain(text: &str) -> Result<(), String> {
    let pb = unsafe { UIPasteboard::generalPasteboard() };
    unsafe {
        pb.setString(Some(&NSString::from_str(text)));
    }
    Ok(())
}

pub fn read() -> Result<String, String> {
    let pb = unsafe { UIPasteboard::generalPasteboard() };
    Ok(unsafe { pb.string() }
        .map(|s| s.to_string())
        .unwrap_or_default())
}

pub fn clear() -> Result<(), String> {
    write_plain("")
}
