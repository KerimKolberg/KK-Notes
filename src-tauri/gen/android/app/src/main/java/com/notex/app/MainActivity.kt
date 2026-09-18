package com.notex.app

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  /**
   * The latest system-bar insets in CSS px, as JSON. Read from the WebView's
   * own thread through the bridge below, written from the inset listener on
   * the main thread.
   */
  @Volatile
  private var insetsJson: String = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

  /**
   * Lets the page *pull* the insets. Pushing them alone loses the race: the
   * inset listener fires while the WebView still holds the blank document it
   * starts with, and loading the app discards whatever that push set.
   */
  private inner class InsetBridge {
    @JavascriptInterface
    fun get(): String = insetsJson
  }

  /**
   * The document this launch was asked to open, as JSON, or null.
   *
   * Written when the intent arrives, read once by the page on startup. It is
   * consumed on read: opening the app again later must not re-import the PDF
   * someone opened days ago.
   */
  @Volatile
  private var openWithJson: String? = null

  @Volatile
  private var webViewRef: WebView? = null

  private inner class OpenWithBridge {
    @JavascriptInterface
    fun take(): String? {
      val payload = openWithJson
      openWithJson = null
      return payload
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Draw under the status bar and the gesture pill; the web layer pads itself
    // with the --safe-* CSS variables fed below.
    enableEdgeToEdge()
    noteOpenWith(intent)
    super.onCreate(savedInstanceState)
  }

  // singleTask: a second "open with" while the app is already running arrives
  // here rather than as a fresh onCreate.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    noteOpenWith(intent)
    pushOpenWith()
  }

  /** Remember the document this launch was asked to open, if any. */
  private fun noteOpenWith(intent: Intent?) {
    val uri = intent?.data ?: return
    if (intent.action != Intent.ACTION_VIEW && intent.action != Intent.ACTION_SEND) return
    // The MIME the sender declared, falling back to what the resolver knows.
    val mime = intent.type ?: contentResolver.getType(uri) ?: ""
    // Built with JSONObject rather than string concatenation: this file is
    // emitted from a JavaScript template literal, where a backslash has to
    // survive two levels of escaping to reach Kotlin. It did not, and the
    // string terminated at its first inner quote — a compile error three
    // minutes into a Gradle run. There is nothing to escape this way.
    openWithJson = JSONObject().put("uri", uri.toString()).put("mime", mime).toString()
  }

  /** Push a later intent into a page that has already booted. */
  private fun pushOpenWith() {
    val payload = openWithJson ?: return
    runOnUiThread {
      webViewRef?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('notex-open-with', { detail: $payload }));",
        null,
      )
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  override fun onWebViewCreate(webView: WebView) {
    // Nothing here may swallow stylus input: the canvas engine relies on the
    // WebView delivering MotionEvents with TOOL_TYPE_STYLUS as pointer events
    // of type "pen", carrying pressure and tilt. The WebView does that out of
    // the box, so this only turns off the features that would intercept them.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      // Android 14's system handwriting would otherwise capture pen strokes
      // that begin on a focusable element (an AcroForm field).
      webView.isAutoHandwritingEnabled = false
    }
    // The overscroll glow fights the app's own two-finger panning.
    webView.overScrollMode = View.OVER_SCROLL_NEVER
    webView.isHapticFeedbackEnabled = false
    webView.settings.apply {
      // Pinch zoom is handled in JavaScript; the built-in one would eat the
      // second finger and rescale the canvas.
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
      // Keep the UI at its designed size whatever the system font scale is.
      textZoom = 100
    }

    // env(safe-area-inset-*) only reports display cutouts on Android, so hand
    // the real window insets to CSS as --android-inset-*. The page reads
    // __notexInsets.get() on startup and this pushes every later change.
    webView.addJavascriptInterface(InsetBridge(), "__notexInsets")
    // The document this launch was asked to open. Read once on startup, the
    // same pull-then-push shape as the insets above: a JavaScript interface
    // added here is only visible to the *next* navigation, so the page asks
    // for it rather than waiting to be told.
    webView.addJavascriptInterface(OpenWithBridge(), "__notexOpenWith")
    webViewRef = webView
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val density = view.resources.displayMetrics.density
      fun dp(value: Int) = (value / density).toInt()
      insetsJson =
        "{\"top\":${dp(bars.top)},\"right\":${dp(bars.right)}," +
          "\"bottom\":${dp(bars.bottom)},\"left\":${dp(bars.left)}}"
      webView.evaluateJavascript(
        """
        (() => {
          const s = document.documentElement.style;
          s.setProperty('--android-inset-top', '${dp(bars.top)}px');
          s.setProperty('--android-inset-right', '${dp(bars.right)}px');
          s.setProperty('--android-inset-bottom', '${dp(bars.bottom)}px');
          s.setProperty('--android-inset-left', '${dp(bars.left)}px');
        })();
        """.trimIndent(),
        null,
      )
      insets
    }

    if (BuildConfig.DEBUG) {
      WebView.setWebContentsDebuggingEnabled(true)
    }
  }
}
