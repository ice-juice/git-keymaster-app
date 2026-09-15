package com.jeck.gitkeymaster

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class ClipboardWriteArgs {
  lateinit var text: String
}

/** 用系统 ClipboardManager 写入/清空，避免 WebView 的 localhost 剪贴板权限框。 */
@TauriPlugin
class ClipboardPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun writeText(invoke: Invoke) {
    val args = invoke.parseArgs(ClipboardWriteArgs::class.java)
    activity.runOnUiThread {
      try {
        clipboard().setPrimaryClip(ClipData.newPlainText("gitkeymaster", args.text))
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: "写入系统剪贴板失败")
      }
    }
  }

  @Command
  fun clear(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        val cm = clipboard()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          cm.clearPrimaryClip()
        } else {
          cm.setPrimaryClip(ClipData.newPlainText("", ""))
        }
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: "清空系统剪贴板失败")
      }
    }
  }

  private fun clipboard(): ClipboardManager {
    return activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  }
}
