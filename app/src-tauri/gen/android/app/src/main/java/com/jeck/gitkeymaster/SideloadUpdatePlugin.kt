package com.jeck.gitkeymaster

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class InstallApkArgs {
  var path: String = ""
}

/**
 * 侧载更新第三道：Rust 已对 APK 字节做过 minisign（与桌面同一把公钥）。
 * 这里再比已装包与 APK 的 Android 证书，挡住「同发布者旧包」之外的换包。
 * 不覆盖签名不一致的包；debug（.debug 后缀）不得覆盖正式包。
 */
@TauriPlugin
class SideloadUpdatePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun installApk(invoke: Invoke) {
    val args = invoke.parseArgs(InstallApkArgs::class.java)
    val apk = File(args.path)
    if (!apk.isFile) {
      invoke.reject("INVALID:找不到已下载的安装包")
      return
    }
    if (!canInstallPackages()) {
      openUnknownSourceSettings()
      invoke.reject("UNKNOWN_SOURCE:未允许安装未知应用")
      return
    }
    try {
      val pm = activity.packageManager
      val flags = PackageManager.GET_SIGNING_CERTIFICATES
      val installed = pm.getPackageInfo(activity.packageName, flags)
      val incoming = pm.getPackageArchiveInfo(apk.absolutePath, flags)
      if (incoming == null) {
        invoke.reject("INVALID:无法读取更新包")
        return
      }
      if (isDebugPackage(installed.packageName) && !isDebugPackage(incoming.packageName)) {
        invoke.reject("DEBUG_OVER_RELEASE:调试包不能覆盖正式安装")
        return
      }
      if (!isDebugPackage(installed.packageName) && isDebugPackage(incoming.packageName)) {
        invoke.reject("DEBUG_OVER_RELEASE:正式包不能被调试包覆盖")
        return
      }
      val installedBase = stripDebugSuffix(installed.packageName)
      val incomingBase = stripDebugSuffix(incoming.packageName ?: "")
      if (installedBase.isEmpty() || incomingBase != installedBase) {
        invoke.reject("SIGNATURE_MISMATCH:不是同一发布者，请卸载重装")
        return
      }
      if (!samePublisher(certsOf(installed), certsOf(incoming))) {
        invoke.reject("SIGNATURE_MISMATCH:不是同一发布者，请卸载重装")
        return
      }
      val uri = FileProvider.getUriForFile(
        activity,
        "${activity.packageName}.fileprovider",
        apk,
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      activity.startActivity(intent)
      val ret = JSObject()
      ret.put("launched", true)
      invoke.resolve(ret)
    } catch (e: Exception) {
      invoke.reject("OTHER:${e.message ?: "调起安装器失败"}")
    }
  }

  private fun canInstallPackages(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      activity.packageManager.canRequestPackageInstalls()
    } else {
      true
    }
  }

  private fun openUnknownSourceSettings() {
    val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
      data = Uri.parse("package:${activity.packageName}")
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    activity.startActivity(intent)
  }

  private fun isDebugPackage(name: String?): Boolean {
    return name?.endsWith(".debug") == true
  }

  private fun stripDebugSuffix(name: String): String {
    return if (name.endsWith(".debug")) name.removeSuffix(".debug") else name
  }

  private fun certsOf(info: PackageInfo): List<ByteArray> {
    val signing = info.signingInfo ?: return emptyList()
    val signers = if (signing.hasMultipleSigners()) {
      signing.apkContentsSigners
    } else {
      signing.signingCertificateHistory
    }
    return signers.orEmpty().map { it.toByteArray() }
  }

  private fun samePublisher(a: List<ByteArray>, b: List<ByteArray>): Boolean {
    if (a.isEmpty() || b.isEmpty()) return false
    return a.any { left -> b.any { right -> left.contentEquals(right) } }
  }
}
