package com.notex.app

import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Draw under the status bar and the gesture pill; the web layer pads itself
    // with the --safe-* CSS variables fed below.
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
    // the real window insets to CSS as --android-inset-*.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val density = view.resources.displayMetrics.density
      fun dp(value: Int) = (value / density).toInt()
      view.evaluateJavascript(
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
