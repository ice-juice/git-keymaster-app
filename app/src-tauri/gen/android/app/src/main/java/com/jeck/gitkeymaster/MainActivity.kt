package com.jeck.gitkeymaster

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          val webView = appWebView
          if (webView == null) {
            finishAffinity()
            return
          }
          webView.evaluateJavascript(
            "(function(){try{var r=window.__kmAndroidBack&&window.__kmAndroidBack();return r||'exit'}catch(e){return 'exit'}})()"
          ) { raw ->
            val result = raw?.trim()?.trim('"') ?: "exit"
            runOnUiThread {
              when (result) {
                "stay" -> {}
                "home" -> moveTaskToBack(true)
                else -> finishAffinity()
              }
            }
          }
        }
      },
    )
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    CameraChromeClient.wrap(this, webView)
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == CameraPermissionBroker.REQ_CAMERA) {
      val granted = grantResults.isNotEmpty() &&
        grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED
      CameraPermissionBroker.deliver(granted)
    }
  }
}
