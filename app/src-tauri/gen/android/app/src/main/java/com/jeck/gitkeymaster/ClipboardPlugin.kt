package com.jeck.gitkeymaster

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.os.SystemClock
import java.util.UUID
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class ClipboardWriteArgs {
  lateinit var text: String
  var secret: Boolean = false
  var clearSeconds: Long = 0
}

/** 用系统 ClipboardManager 读写/清空，避免 WebView 的 localhost 剪贴板权限框。 */
@TauriPlugin
class ClipboardPlugin(private val activity: Activity) : Plugin(activity) {
  private val handler = Handler(Looper.getMainLooper())
  private val ownerKey = "com.jeck.gitkeymaster.clip-owner"
  private var ownedToken: String? = null
  private var ownedSecret = false
  private var expiresAt: Long = 0
  private var clearTask: Runnable? = null

  private fun clearOwned() {
    val token = ownedToken ?: return
    val cm = clipboard()
    val current = cm.primaryClipDescription?.extras?.getString(ownerKey)
    if (current == token) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) cm.clearPrimaryClip()
      else cm.setPrimaryClip(ClipData.newPlainText("", ""))
    }
    clearTask?.let { handler.removeCallbacks(it) }
    clearTask = null
    ownedToken = null
    ownedSecret = false
    expiresAt = 0
  }

  override fun onResume() {
    super.onResume()
    if (expiresAt > 0 && SystemClock.elapsedRealtime() >= expiresAt) {
      runCatching { clearOwned() }
    }
  }

  override fun onDestroy(activity: AppCompatActivity) {
    if (ownedSecret) runCatching { clearOwned() }
    clearTask?.let { handler.removeCallbacks(it) }
    super.onDestroy(activity)
  }

  @Command
  fun writeText(invoke: Invoke) {
    val args = invoke.parseArgs(ClipboardWriteArgs::class.java)
    activity.runOnUiThread {
      try {
        clearTask?.let { handler.removeCallbacks(it) }
        val token = UUID.randomUUID().toString()
        val clip = ClipData.newPlainText("gitkeymaster", args.text)
        clip.description.extras = PersistableBundle().apply {
          putString(ownerKey, token)
          // Stable key also works below API 33, where the named constant is absent.
          putBoolean("android.content.extra.IS_SENSITIVE", args.secret)
        }
        clipboard().setPrimaryClip(clip)
        ownedToken = token
        ownedSecret = args.secret
        expiresAt = 0
        clearTask = null
        if (args.secret && args.clearSeconds > 0) {
          val delay = args.clearSeconds.coerceAtMost(86_400) * 1000
          expiresAt = SystemClock.elapsedRealtime() + delay
          clearTask = Runnable {
            if (ownedToken == token) runCatching { clearOwned() }
          }.also { handler.postDelayed(it, delay) }
        }
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: "写入系统剪贴板失败")
      }
    }
  }

  @Command
  fun readText(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        val clip = clipboard().primaryClip
        val text = if (clip != null && clip.itemCount > 0) {
          clip.getItemAt(0).coerceToText(activity).toString()
        } else {
          ""
        }
        val ret = JSObject()
        ret.put("text", text)
        invoke.resolve(ret)
      } catch (e: Exception) {
        invoke.reject(e.message ?: "读取系统剪贴板失败")
      }
    }
  }

  @Command
  fun clear(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        clearOwned()
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
