package com.jeck.gitkeymaster

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class BgSyncArgs {
    var enabled: Boolean = false
}

/**
 * 退到后台时拉起前台服务保活，回到前台就停掉。同步本身仍在 Rust 调度器里。
 */
@TauriPlugin
class ForegroundSyncPlugin(private val activity: Activity) : Plugin(activity) {
    @Volatile
    private var enabled: Boolean = false

    private val lifecycleObserver = object : DefaultLifecycleObserver {
        override fun onStop(owner: LifecycleOwner) {
            if (enabled) startService()
        }

        override fun onStart(owner: LifecycleOwner) {
            stopService()
        }
    }

    override fun load(webView: WebView) {
        requestPostNotifications()
        activity.runOnUiThread {
            ProcessLifecycleOwner.get().lifecycle.addObserver(lifecycleObserver)
        }
    }

    @Command
    fun setEnabled(invoke: Invoke) {
        val args = invoke.parseArgs(BgSyncArgs::class.java)
        activity.runOnUiThread {
            val next = args.enabled
            val changed = enabled != next
            enabled = next
            if (!next) {
                stopService()
            } else if (changed && !isInForeground()) {
                startService()
            }
            invoke.resolve()
        }
    }

    private fun requestPostNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        val granted = ContextCompat.checkSelfPermission(
            activity,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) return
        try {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                POST_NOTIFICATIONS_REQUEST,
            )
        } catch (e: Exception) {
            Log.w(TAG, "申请通知权限失败，后台同步通知可能发不出去", e)
        }
    }

    private fun isInForeground(): Boolean {
        return ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
    }

    private fun startService() {
        try {
            val intent = Intent(activity, ForegroundSyncService::class.java)
            ContextCompat.startForegroundService(activity, intent)
        } catch (e: Exception) {
            Log.w(TAG, "前台同步服务启动失败", e)
        }
    }

    private fun stopService() {
        try {
            activity.stopService(Intent(activity, ForegroundSyncService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "前台同步服务停止失败", e)
        }
    }

    companion object {
        private const val TAG = "ForegroundSync"
        private const val POST_NOTIFICATIONS_REQUEST = 41014
    }
}
