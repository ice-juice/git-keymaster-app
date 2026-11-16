package com.jeck.gitkeymaster

import android.app.Activity
import android.view.WindowManager

/** 配置未知时先保护窗口；Rust 读完后按真实配置应用，新设备默认允许截图。 */
object ScreenProtectGate {
  @Volatile
  var rustConfigured: Boolean = false
    private set

  fun applyDefault(activity: Activity) {
    setWindowSecure(activity, true)
  }

  fun ensureDefaultUntilConfigured(activity: Activity) {
    if (!rustConfigured) {
      setWindowSecure(activity, true)
    }
  }

  fun setSecure(activity: Activity, secure: Boolean) {
    rustConfigured = true
    setWindowSecure(activity, secure)
  }

  private fun setWindowSecure(activity: Activity, secure: Boolean) {
    val window = activity.window ?: return
    val flag = WindowManager.LayoutParams.FLAG_SECURE
    if (secure) {
      window.addFlags(flag)
    } else {
      window.clearFlags(flag)
    }
  }
}
