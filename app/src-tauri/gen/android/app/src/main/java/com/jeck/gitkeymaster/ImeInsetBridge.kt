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
 * 把系统栏 / 输入法盖住 WebView 的高度交给 JS。
 *
 * `enableEdgeToEdge()` 之后 WebView 经常画到状态栏和导航栏底下；
 * Android 10（如一加 5T）上 `env(safe-area-inset-*)` 又经常是 0。
 * 这里用 WindowInsets 写出 `--km-safe-*-from-native` 和 `--km-ime-inset`。
 *
 * API 30+ 用 `WindowInsetsCompat.Type.ime()`；更老的系统
 * 用可见窗和 WebView 底边的重叠高度估键盘。
 */
object ImeInsetBridge {
  private const val TAG = "KmIme"
  private const val IME_MIN_DP = 80

  @Volatile
  var lastCssPx: Int = 0
    private set

  @Volatile
  var lastSafeTopCss: Int = 0
    private set

  @Volatile
  var lastSafeBottomCss: Int = 0
    private set

  @Volatile
  var lastSafeLeftCss: Int = 0
    private set

  @Volatile
  var lastSafeRightCss: Int = 0
    private set

  private var activityRef: WeakReference<Activity>? = null
  private var webViewRef: WeakReference<WebView>? = null
  private var hookedDecor: android.view.View? = null
  private var injectedIme = false
  private var injectedSafe = false

  class JsBridge {
    @JavascriptInterface
    fun getInset(): Int = lastCssPx
  }

  class SafeJsBridge {
    @JavascriptInterface
    fun getTop(): Int = lastSafeTopCss

    @JavascriptInterface
    fun getBottom(): Int = lastSafeBottomCss

    @JavascriptInterface
    fun getLeft(): Int = lastSafeLeftCss

    @JavascriptInterface
    fun getRight(): Int = lastSafeRightCss
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
      try {
        webView.removeJavascriptInterface("kmSafe")
      } catch (_: Exception) {
      }
      webView.addJavascriptInterface(JsBridge(), "kmIme")
      webView.addJavascriptInterface(SafeJsBridge(), "kmSafe")

      ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
        publishIme(insets.getInsets(WindowInsetsCompat.Type.ime()).bottom, force = false)
        publishSafe(insets, force = false)
        insets
      }
      ViewCompat.requestApplyInsets(webView)

      val decor = activity.window.decorView
      if (hookedDecor !== decor) {
        hookedDecor = decor
        decor.viewTreeObserver.addOnGlobalLayoutListener {
          publishIme(null, force = false)
          publishSafe(null, force = false)
        }
      }
      webView.post {
        publishIme(null, force = true)
        publishSafe(null, force = true)
      }
    } catch (e: Exception) {
      Log.e(TAG, "attach failed", e)
    }
  }

  fun republish() {
    publishIme(null, force = true)
    publishSafe(null, force = true)
  }

  private fun publishIme(dispatchedImePx: Int?, force: Boolean) {
    val activity = activityRef?.get() ?: return
    val webView = webViewRef?.get() ?: return
    val density = activity.resources.displayMetrics.density.coerceAtLeast(0.01f)
    val minPx = (IME_MIN_DP * density).roundToInt()
    val coveredPx = readCoveredBottomPx(activity, webView, dispatchedImePx, minPx)
    val imePx = if (coveredPx >= minPx) coveredPx else 0
    val cssPx = (imePx / density).roundToInt()
    if (!force && injectedIme && cssPx == lastCssPx) return
    lastCssPx = cssPx
    injectedIme = true
    Log.i(TAG, "coveredPx=$coveredPx cssPx=$cssPx")
    val js =
      "(function(){window.__kmAndroidImeInset=$cssPx;" +
        "window.dispatchEvent(new CustomEvent('km-android-ime',{detail:$cssPx}));})()"
    webView.post {
      webView.evaluateJavascript(js, null)
    }
  }

  /**
   * 只报「盖住 WebView」的系统栏高度（CSS 像素）。
   * WebView 已经被窗口垫到状态栏下方时，对应方向报 0，避免和 CSS padding 叠两次。
   */
  private fun publishSafe(dispatched: WindowInsetsCompat?, force: Boolean) {
    val activity = activityRef?.get() ?: return
    val webView = webViewRef?.get() ?: return
    val density = activity.resources.displayMetrics.density.coerceAtLeast(0.01f)
    val raw = readSystemBarPx(activity, webView, dispatched)
    val topCss = (raw[0] / density).roundToInt()
    val bottomCss = (raw[1] / density).roundToInt()
    val leftCss = (raw[2] / density).roundToInt()
    val rightCss = (raw[3] / density).roundToInt()
    if (
      !force &&
      injectedSafe &&
      topCss == lastSafeTopCss &&
      bottomCss == lastSafeBottomCss &&
      leftCss == lastSafeLeftCss &&
      rightCss == lastSafeRightCss
    ) {
      return
    }
    lastSafeTopCss = topCss
    lastSafeBottomCss = bottomCss
    lastSafeLeftCss = leftCss
    lastSafeRightCss = rightCss
    injectedSafe = true
    Log.i(TAG, "safeCss top=$topCss bottom=$bottomCss left=$leftCss right=$rightCss")
    val js =
      "(function(){" +
        "var r=document.documentElement;" +
        "r.style.setProperty('--km-safe-top-from-native','${topCss}px');" +
        "r.style.setProperty('--km-safe-bottom-from-native','${bottomCss}px');" +
        "r.style.setProperty('--km-safe-left-from-native','${leftCss}px');" +
        "r.style.setProperty('--km-safe-right-from-native','${rightCss}px');" +
        "window.__kmAndroidSafeInsets={top:$topCss,bottom:$bottomCss,left:$leftCss,right:$rightCss};" +
        "window.dispatchEvent(new CustomEvent('km-android-safe-insets'," +
        "{detail:window.__kmAndroidSafeInsets}));" +
        "})()"
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

  private fun readSystemBarPx(
    activity: Activity,
    webView: WebView,
    dispatched: WindowInsetsCompat?,
  ): IntArray {
    val insets = dispatched
      ?: ViewCompat.getRootWindowInsets(webView)
      ?: ViewCompat.getRootWindowInsets(activity.window.decorView)
    val typeMask =
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    val sys = insets?.getInsets(typeMask)
    var topPx = sys?.top ?: 0
    var bottomPx = sys?.bottom ?: 0
    var leftPx = sys?.left ?: 0
    var rightPx = sys?.right ?: 0
    if (topPx <= 0) topPx = resourceDimenPx(activity, "status_bar_height")
    if (bottomPx <= 0) bottomPx = resourceDimenPx(activity, "navigation_bar_height")

    val loc = IntArray(2)
    webView.getLocationInWindow(loc)
    val decor = activity.window.decorView
    val unusedAbove = loc[1].coerceAtLeast(0)
    val unusedBelow = max(0, decor.height - (loc[1] + webView.height))
    val unusedLeft = loc[0].coerceAtLeast(0)
    val unusedRight = max(0, decor.width - (loc[0] + webView.width))

    return intArrayOf(
      max(0, topPx - unusedAbove),
      max(0, bottomPx - unusedBelow),
      max(0, leftPx - unusedLeft),
      max(0, rightPx - unusedRight),
    )
  }

  private fun resourceDimenPx(activity: Activity, name: String): Int {
    val id = activity.resources.getIdentifier(name, "dimen", "android")
    return if (id > 0) activity.resources.getDimensionPixelSize(id).coerceAtLeast(0) else 0
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
