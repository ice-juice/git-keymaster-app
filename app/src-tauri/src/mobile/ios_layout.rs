//! 关掉 WKWebView 自己垫的安全区，避免和 CSS `env(safe-area-inset-*)` 叠出底栏大空白。

use objc2::encode::{Encode, Encoding, RefEncode};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{msg_send, MainThreadMarker};

#[repr(C)]
#[derive(Clone, Copy)]
struct UIEdgeInsets {
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
}

unsafe impl Encode for UIEdgeInsets {
    const ENCODING: Encoding = Encoding::Struct(
        "UIEdgeInsets",
        &[
            Encoding::Double,
            Encoding::Double,
            Encoding::Double,
            Encoding::Double,
        ],
    );
}

unsafe impl RefEncode for UIEdgeInsets {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
}

const NEVER: i64 = 2; // UIScrollViewContentInsetAdjustmentNever

/// WebView 就绪后调用；主线程执行，可重复。
pub fn install() {
    if MainThreadMarker::new().is_some() {
        unsafe {
            apply();
        }
        return;
    }
    dispatch2::DispatchQueue::main().exec_sync(|| unsafe {
        apply();
    });
}

unsafe fn apply() {
    let window = key_window();
    if window.is_null() {
        return;
    }
    let root: *mut AnyObject = msg_send![window, rootViewController];
    let view: *mut AnyObject = if root.is_null() {
        window
    } else {
        msg_send![root, view]
    };
    let start = if view.is_null() { window } else { view };
    let webview = find_wkwebview(start);
    if webview.is_null() {
        return;
    }
    let scroll: *mut AnyObject = msg_send![webview, scrollView];
    if scroll.is_null() {
        return;
    }
    let _: () = msg_send![scroll, setContentInsetAdjustmentBehavior: NEVER];
    let zero = UIEdgeInsets {
        top: 0.0,
        left: 0.0,
        bottom: 0.0,
        right: 0.0,
    };
    let _: () = msg_send![scroll, setContentInset: zero];
    let _: () = msg_send![scroll, setScrollIndicatorInsets: zero];
    let off = Bool::from(false);
    let _: () = msg_send![scroll, setBounces: off];
    let _: () = msg_send![scroll, setAlwaysBounceVertical: off];
    let sel = objc2::sel!(setAutomaticallyAdjustsScrollIndicatorInsets:);
    let responds: Bool = msg_send![scroll, respondsToSelector: sel];
    if responds.as_bool() {
        let _: () = msg_send![scroll, setAutomaticallyAdjustsScrollIndicatorInsets: off];
    }
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

unsafe fn find_wkwebview(view: *mut AnyObject) -> *mut AnyObject {
    if view.is_null() {
        return std::ptr::null_mut();
    }
    let Some(cls) = AnyClass::get(c"WKWebView") else {
        return std::ptr::null_mut();
    };
    let is_wv: Bool = msg_send![view, isKindOfClass: cls];
    if is_wv.as_bool() {
        return view;
    }
    let subs: *mut AnyObject = msg_send![view, subviews];
    if subs.is_null() {
        return std::ptr::null_mut();
    }
    let count: usize = msg_send![subs, count];
    for i in 0..count {
        let child: *mut AnyObject = msg_send![subs, objectAtIndex: i];
        let found = find_wkwebview(child);
        if !found.is_null() {
            return found;
        }
    }
    std::ptr::null_mut()
}
