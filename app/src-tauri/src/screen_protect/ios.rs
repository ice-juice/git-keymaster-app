//! iOS 不能像 Android 那样彻底禁止截屏。
//! 切到后台时盖一层遮罩，避免任务切换器预览泄露；收到系统截屏通知则提醒前端。

use block2::RcBlock;
use objc2::encode::{Encode, Encoding, RefEncode};
use objc2::runtime::{AnyClass, AnyObject};
use objc2::msg_send;
use objc2_foundation::{ns_string, NSNotification, NSNotificationCenter};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, Once};
use tauri::{AppHandle, Emitter, Runtime};

static PROTECT: AtomicBool = AtomicBool::new(true);
static INSTALLED: Once = Once::new();
static ON_SCREENSHOT: Mutex<Option<Box<dyn Fn() + Send + Sync>>> = Mutex::new(None);

/// 自定义 tag，用来找到并摘掉遮罩，避免叠多层。
const COVER_TAG: isize = 0x5343_5254;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

unsafe impl Encode for CGRect {
    const ENCODING: Encoding = Encoding::Struct(
        "CGRect",
        &[
            Encoding::Struct("CGPoint", &[Encoding::Double, Encoding::Double]),
            Encoding::Struct("CGSize", &[Encoding::Double, Encoding::Double]),
        ],
    );
}

unsafe impl RefEncode for CGRect {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
}

pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    *ON_SCREENSHOT.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(Box::new(move || {
            let _ = app.emit("screen-captured", ());
        }));
    INSTALLED.call_once(|| unsafe {
        install_observers();
    });
}

pub fn set_enabled(protect: bool) {
    PROTECT.store(protect, Ordering::SeqCst);
    if !protect {
        unsafe {
            remove_cover();
        }
    }
}

unsafe fn install_observers() {
    let center = NSNotificationCenter::defaultCenter();

    let resign = RcBlock::new(|_n: NonNull<NSNotification>| {
        if PROTECT.load(Ordering::SeqCst) {
            unsafe {
                add_cover();
            }
        }
    });
    let active = RcBlock::new(|_n: NonNull<NSNotification>| {
        unsafe {
            remove_cover();
        }
    });
    let shot = RcBlock::new(|_n: NonNull<NSNotification>| {
        if !PROTECT.load(Ordering::SeqCst) {
            return;
        }
        let cb = ON_SCREENSHOT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cb) = cb.as_ref() {
            cb();
        }
    });

    let _ = center.addObserverForName_object_queue_usingBlock(
        Some(ns_string!("UIApplicationWillResignActiveNotification")),
        None,
        None,
        &resign,
    );
    let _ = center.addObserverForName_object_queue_usingBlock(
        Some(ns_string!("UIApplicationDidEnterBackgroundNotification")),
        None,
        None,
        &resign,
    );
    let _ = center.addObserverForName_object_queue_usingBlock(
        Some(ns_string!("UIApplicationDidBecomeActiveNotification")),
        None,
        None,
        &active,
    );
    let _ = center.addObserverForName_object_queue_usingBlock(
        Some(ns_string!("UIApplicationUserDidTakeScreenshotNotification")),
        None,
        None,
        &shot,
    );
}

unsafe fn key_window() -> *mut AnyObject {
    let Some(cls) = AnyClass::get(c"UIApplication") else {
        return std::ptr::null_mut();
    };
    let app: *mut AnyObject = msg_send![cls, sharedApplication];
    if app.is_null() {
        return std::ptr::null_mut();
    }
    let mut window: *mut AnyObject = msg_send![app, keyWindow];
    if window.is_null() {
        let windows: *mut AnyObject = msg_send![app, windows];
        if !windows.is_null() {
            let count: usize = msg_send![windows, count];
            if count > 0 {
                window = msg_send![windows, objectAtIndex: 0usize];
            }
        }
    }
    window
}

unsafe fn add_cover() {
    let window = key_window();
    if window.is_null() {
        return;
    }
    let existing: *mut AnyObject = msg_send![window, viewWithTag: COVER_TAG];
    if !existing.is_null() {
        return;
    }
    let Some(view_cls) = AnyClass::get(c"UIView") else {
        return;
    };
    let Some(color_cls) = AnyClass::get(c"UIColor") else {
        return;
    };
    let bounds: CGRect = msg_send![window, bounds];
    let alloc: *mut AnyObject = msg_send![view_cls, alloc];
    let cover: *mut AnyObject = msg_send![alloc, initWithFrame: bounds];
    if cover.is_null() {
        return;
    }
    let black: *mut AnyObject = msg_send![color_cls, colorWithWhite: 0.07f64 alpha: 1.0f64];
    let _: () = msg_send![cover, setBackgroundColor: black];
    let _: () = msg_send![cover, setTag: COVER_TAG];
    let _: () = msg_send![window, addSubview: cover];
}

unsafe fn remove_cover() {
    let window = key_window();
    if window.is_null() {
        return;
    }
    let cover: *mut AnyObject = msg_send![window, viewWithTag: COVER_TAG];
    if !cover.is_null() {
        let _: () = msg_send![cover, removeFromSuperview];
    }
}
