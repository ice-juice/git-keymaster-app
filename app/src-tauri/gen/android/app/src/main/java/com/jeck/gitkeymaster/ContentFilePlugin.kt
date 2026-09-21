package com.jeck.gitkeymaster

import android.app.Activity
import android.net.Uri
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class MaterializeUriArgs {
  lateinit var uri: String
}

/** 系统选图给的是 content://，Rust 的 std::fs 读不到。先拷到缓存文件再交给上传。 */
@TauriPlugin
class ContentFilePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun materialize(invoke: Invoke) {
    val args = invoke.parseArgs(MaterializeUriArgs::class.java)
    try {
      val uri = Uri.parse(args.uri)
      val input = activity.contentResolver.openInputStream(uri)
        ?: throw IllegalStateException("无法读取所选图片")
      val outFile = File(activity.cacheDir, "icon-pick-${System.currentTimeMillis()}")
      input.use { src ->
        outFile.outputStream().use { dst -> src.copyTo(dst) }
      }
      if (outFile.length() == 0L) {
        outFile.delete()
        throw IllegalStateException("所选图片是空的")
      }
      val ret = JSObject()
      ret.put("path", outFile.absolutePath)
      invoke.resolve(ret)
    } catch (e: Exception) {
      invoke.reject(e.message ?: "无法读取所选图片")
    }
  }
}
