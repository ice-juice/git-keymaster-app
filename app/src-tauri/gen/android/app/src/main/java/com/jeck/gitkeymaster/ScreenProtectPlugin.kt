package com.jeck.gitkeymaster

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class ScreenProtectArgs {
  var secure: Boolean = true
}

@TauriPlugin
class ScreenProtectPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun setSecure(invoke: Invoke) {
    val args = invoke.parseArgs(ScreenProtectArgs::class.java)
    activity.runOnUiThread {
      try {
        ScreenProtectGate.setSecure(activity, args.secure)
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: "无法更新截屏防护")
      }
    }
  }
}
