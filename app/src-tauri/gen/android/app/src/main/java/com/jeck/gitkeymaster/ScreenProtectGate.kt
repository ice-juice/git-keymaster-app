package com.jeck.gitkeymaster

import android.app.Activity
import android.view.WindowManager

/** Activity 窗口 FLAG_SECURE。冷启动先按默认禁止截屏，等 Rust 读完配置再改。 */
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
