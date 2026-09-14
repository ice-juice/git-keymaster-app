package com.jeck.gitkeymaster

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.PermissionState
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * 向系统申请 CAMERA 运行时权限，并在 WebView 请求镜头时二次确认。
 * 仅声明 Manifest 不够；Android 6+ 必须弹出系统授权框。
 */
@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.CAMERA], alias = "camera")
  ]
)
class CameraPermPlugin(private val activity: Activity) : Plugin(activity) {
  override fun load(webView: WebView) {
    CameraChromeClient.wrap(activity, webView)
  }

  @Command
  fun requestCamera(invoke: Invoke) {
    if (hasCameraPermission()) {
      invoke.resolve(result(granted = true, permanentlyDenied = false))
      return
    }
    requestPermissionForAlias("camera", invoke, "onCameraPermission")
  }

  @PermissionCallback
  fun onCameraPermission(invoke: Invoke) {
    val granted = hasCameraPermission()
    invoke.resolve(result(granted, !granted && isPermanentlyDenied()))
  }

  @Command
  fun openAppSettings(invoke: Invoke) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
      data = Uri.fromParts("package", activity.packageName, null)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    activity.startActivity(intent)
    invoke.resolve()
  }

  private fun hasCameraPermission(): Boolean {
    return getPermissionState("camera") == PermissionState.GRANTED ||
      ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED
  }

  private fun isPermanentlyDenied(): Boolean {
    return !ActivityCompat.shouldShowRequestPermissionRationale(
      activity,
      Manifest.permission.CAMERA,
    )
  }

  private fun result(granted: Boolean, permanentlyDenied: Boolean): JSObject {
    val ret = JSObject()
    ret.put("granted", granted)
    ret.put("permanentlyDenied", permanentlyDenied)
    return ret
  }
}

/** 把系统相机权限结果接到 WebView 的 getUserMedia。转发原 ChromeClient，避免打断文件选择。 */
class CameraChromeClient(
  private val activity: Activity,
  private val delegate: WebChromeClient?,
) : WebChromeClient() {
  override fun onPermissionRequest(request: PermissionRequest) {
    activity.runOnUiThread {
      val wantsCamera = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
      if (!wantsCamera) {
        if (delegate != null) {
          delegate.onPermissionRequest(request)
        } else {
          request.grant(request.resources)
        }
        return@runOnUiThread
      }
      CameraPermissionBroker.request(activity) { granted ->
        activity.runOnUiThread {
          if (granted) {
            request.grant(request.resources)
          } else {
            request.deny()
          }
        }
      }
    }
  }

  override fun onShowFileChooser(
    webView: WebView?,
    filePathCallback: ValueCallback<Array<Uri>>?,
    fileChooserParams: FileChooserParams?,
  ): Boolean {
    return delegate?.onShowFileChooser(webView, filePathCallback, fileChooserParams)
      ?: super.onShowFileChooser(webView, filePathCallback, fileChooserParams)
  }

  override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
    return delegate?.onConsoleMessage(consoleMessage) ?: super.onConsoleMessage(consoleMessage)
  }

  override fun onProgressChanged(view: WebView?, newProgress: Int) {
    if (delegate != null) {
      delegate.onProgressChanged(view, newProgress)
    } else {
      super.onProgressChanged(view, newProgress)
    }
  }

  override fun onPermissionRequestCanceled(request: PermissionRequest?) {
    if (delegate != null) {
      delegate.onPermissionRequestCanceled(request)
    } else {
      super.onPermissionRequestCanceled(request)
    }
  }

  companion object {
    fun wrap(activity: Activity, webView: WebView) {
      webView.post {
        val current = webView.webChromeClient
        if (current is CameraChromeClient) return@post
        webView.webChromeClient = CameraChromeClient(activity, current)
      }
    }
  }
}

object CameraPermissionBroker {
  @Volatile
  var pending: MutableList<(Boolean) -> Unit> = mutableListOf()

  fun request(activity: Activity, callback: (Boolean) -> Unit) {
    if (
      ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED
    ) {
      callback(true)
      return
    }
    synchronized(pending) {
      pending.add(callback)
    }
    ActivityCompat.requestPermissions(
      activity,
      arrayOf(Manifest.permission.CAMERA),
      REQ_CAMERA,
    )
  }

  fun deliver(granted: Boolean) {
    val callbacks = synchronized(pending) {
      val copy = pending.toList()
      pending.clear()
      copy
    }
    callbacks.forEach { it(granted) }
  }

  const val REQ_CAMERA = 2101
}
