package com.jeck.gitkeymaster

import android.app.Activity
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@TauriPlugin
class AppNavPlugin(private val activity: Activity) : Plugin(activity) {
  override fun load(webView: WebView) {
    val host = activity as? ComponentActivity ?: return
    host.onBackPressedDispatcher.addCallback(
      host,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          webView.evaluateJavascript(
            "(function(){try{var r=window.__kmAndroidBack&&window.__kmAndroidBack();return r||'exit'}catch(e){return 'exit'}})()"
          ) { raw ->
            val result = raw?.trim()?.trim('"') ?: "exit"
            host.runOnUiThread {
              when (result) {
                "stay" -> {}
                "home" -> activity.moveTaskToBack(true)
                else -> activity.finishAffinity()
              }
            }
          }
        }
      },
    )
  }

  @Command
  fun leaveToHome(invoke: Invoke) {
    activity.moveTaskToBack(true)
    invoke.resolve()
  }
}
