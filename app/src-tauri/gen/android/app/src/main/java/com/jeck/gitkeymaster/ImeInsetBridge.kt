package com.jeck.gitkeymaster

import android.app.Activity
import android.graphics.Rect
import android.util.Log
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.lang.ref.WeakReference
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * 把输入法盖住 WebView 的高度交给 JS。
 *
 * `enableEdgeToEdge()` 之后 WebView 经常不随键盘缩小，`visualViewport` 也就一直是 0。
 * API 30+ 用 `WindowInsetsCompat.Type.ime()`；更老的系统（如一加 5T / Android 10）
 * 用可见窗和 WebView 底边的重叠高度。
 */
object ImeInsetBridge {
  private const val TAG = "KmIme"
  private const val IME_MIN_DP = 80

  @Volatile
  var lastCssPx: Int = 0
    private set

  private var activityRef: WeakReference<Activity>? = null
  private var webViewRef: WeakReference<WebView>? = null
  private var hookedDecor: android.view.View? = null
  private var injected = false

  class JsBridge {
    @JavascriptInterface
    fun getInset(): Int = lastCssPx
  }

  fun attach(activity: Activity, webView: WebView) {
    try {
      activityRef = WeakReference(activity)
      webViewRef = WeakReference(webView)
      Log.i(TAG, "attach")

      try {
        webView.removeJavascriptInterface("kmIme")
      } catch (_: Exception) {
      }
      webView.addJavascriptInterface(JsBridge(), "kmIme")

      ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
        publish(insets.getInsets(WindowInsetsCompat.Type.ime()).bottom, force = false)
        insets
      }
      ViewCompat.requestApplyInsets(webView)

      val decor = activity.window.decorView
      if (hookedDecor !== decor) {
        hookedDecor = decor
        decor.viewTreeObserver.addOnGlobalLayoutListener {
          publish(null, force = false)
        }
      }
      webView.post { publish(null, force = true) }
    } catch (e: Exception) {
      Log.e(TAG, "attach failed", e)
    }
  }

  fun republish() {
    publish(null, force = true)
  }

  private fun publish(dispatchedImePx: Int?, force: Boolean) {
    val activity = activityRef?.get() ?: return
    val webView = webViewRef?.get() ?: return
    val density = activity.resources.displayMetrics.density.coerceAtLeast(0.01f)
    val minPx = (IME_MIN_DP * density).roundToInt()
    val coveredPx = readCoveredBottomPx(activity, webView, dispatchedImePx, minPx)
    val imePx = if (coveredPx >= minPx) coveredPx else 0
    val cssPx = (imePx / density).roundToInt()
    if (!force && injected && cssPx == lastCssPx) return
    lastCssPx = cssPx
    injected = true
    Log.i(TAG, "coveredPx=$coveredPx cssPx=$cssPx")
    val js =
      "(function(){window.__kmAndroidImeInset=$cssPx;" +
        "window.dispatchEvent(new CustomEvent('km-android-ime',{detail:$cssPx}));})()"
    webView.post {
      webView.evaluateJavascript(js, null)
    }
  }

  /**
   * 只报「盖住 WebView 底部」的高度。
   * 一加 5T / Android 10 上 `getWindowVisibleDisplayFrame` 会在半屏高度来回跳，不能单独当键盘。
   * 先信 WindowInsets IME 和 IMM 的可见高度；窗口已被 adjustResize 缩小则报 0。
   */
  private fun readCoveredBottomPx(
    activity: Activity,
    webView: WebView,
    dispatchedImePx: Int?,
    minPx: Int,
  ): Int {
    if (webView.height < minPx) return 0
    val fromDispatch = dispatchedImePx ?: 0
    val fromImm = imeWindowVisibleHeightPx(activity)
    val trusted = max(fromDispatch, fromImm)
    if (trusted < minPx) return 0

    val loc = IntArray(2)
    webView.getLocationInWindow(loc)
    val unusedBelowWeb = max(0, activity.window.decorView.height - (loc[1] + webView.height))
    if (unusedBelowWeb >= minPx) return 0

    val decor = activity.window.decorView
    val frame = Rect()
    decor.getWindowVisibleDisplayFrame(frame)
    val frameGap = max(0, decor.height - frame.bottom)
    val overlap = max(0, frameGap - unusedBelowWeb)
    return if (overlap >= minPx) kotlin.math.min(trusted, overlap) else trusted
  }

  @Suppress("PrivateApi")
  private fun imeWindowVisibleHeightPx(activity: Activity): Int {
    return try {
      val imm = activity.getSystemService(Activity.INPUT_METHOD_SERVICE) as? InputMethodManager
        ?: return 0
      val method = imm.javaClass.getMethod("getInputMethodWindowVisibleHeight")
      (method.invoke(imm) as? Int)?.coerceAtLeast(0) ?: 0
    } catch (_: Exception) {
      0
    }
  }
}
