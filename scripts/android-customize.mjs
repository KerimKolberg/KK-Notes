#!/usr/bin/env node
/**
 * Apply this project's Android customizations to `src-tauri/gen/android`.
 *
 * `tauri android init` regenerates that folder from Tauri's own templates, so
 * anything we change there by hand would be lost the next time someone runs
 * it. Keeping the edits here makes them repeatable: the build script runs this
 * after an init, and `--check` verifies (in CI, or before a release) that the
 * committed project still carries them.
 *
 *   node scripts/android-customize.mjs           apply, print what changed
 *   node scripts/android-customize.mjs --check    exit 1 if anything is missing
 *
 * Everything here is idempotent: applying twice changes nothing.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * True only when this file is *run*, not imported.
 *
 * The pure helpers below (`xmlProblems`, `kotlinProblems`, the manifest
 * fragments) are unit-tested, and a test suite that rewrote the generated
 * Android project as a side effect of importing them would be a nasty
 * surprise. Imported, the script computes everything and writes nothing.
 */
const RUNNING = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

const ROOT = new URL('..', import.meta.url).pathname;
const ANDROID = join(ROOT, 'src-tauri/gen/android');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
const ANDROID_CONFIG = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.android.conf.json'), 'utf8'));

export const IDENTIFIER = CONFIG.identifier;
/** What the launcher, the task switcher and the share sheet call this app. */
export const PRODUCT_NAME = CONFIG.productName;
/** The folio navy, behind the adaptive icon's foreground layer. */
export const LAUNCHER_BACKGROUND = '#23415E';
export const MIN_SDK = CONFIG.bundle?.android?.minSdkVersion ?? 26;
/** Android 14. Tauri's template compiles against the newest SDK and targets it too. */
export const TARGET_SDK = 34;

const check = process.argv.includes('--check') || !RUNNING;
const problems = [];
const changes = [];

function edit(relative, transform) {
  const path = join(ANDROID, relative);
  if (!existsSync(path)) {
    problems.push(`${relative} is missing — run \`npm run android:init\` first`);
    return;
  }
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) return;
  if (check) problems.push(`${relative} is missing this project's Android customizations`);
  else {
    writeFileSync(path, after);
    changes.push(relative);
  }
}

function write(relative, contents) {
  const path = join(ANDROID, relative);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (before === contents) return;
  if (check) problems.push(`${relative} is out of date`);
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    changes.push(relative);
  }
}

// ---------------------------------------------------------------------------
// Permissions and window behaviour
// ---------------------------------------------------------------------------

/**
 * Saving a `.notex` file or exporting a PDF goes through the Storage Access
 * Framework (`plugin-dialog` → ACTION_CREATE_DOCUMENT / ACTION_OPEN_DOCUMENT),
 * which grants access per file and needs no permission on any Android version.
 * What the permissions below cover is everything else:
 *
 *  - READ_MEDIA_IMAGES: the image picker behind "Insert image" on Android 13+.
 *  - READ/WRITE_EXTERNAL_STORAGE: the same thing on Android 12 and older, where
 *    scoped storage did not exist yet; capped with maxSdkVersion so newer
 *    devices never see a broad storage prompt.
 *
 * (Android has no READ_MEDIA_DOCUMENTS permission — documents are reached
 * through the Storage Access Framework, which is what the file plugins use.)
 */
const PERMISSIONS = `    <uses-permission android:name="android.permission.INTERNET" />

    <!-- notex: scoped storage. Saving and opening documents uses the Storage
         Access Framework (no permission needed); these cover the image picker. -->
    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission
        android:name="android.permission.WRITE_EXTERNAL_STORAGE"
        android:maxSdkVersion="28"
        tools:ignore="ScopedStorage" />

    <!-- A stylus is the point of this app, but a finger works too. -->
    <uses-feature android:name="android.hardware.touchscreen" android:required="true" />
    <uses-feature android:name="android.hardware.touchscreen.multitouch" android:required="true" />`;

/**
 * "Open with" support.
 *
 * Android routes a document to an app through intent filters, and matching a
 * file needs more than one: `ACTION_VIEW` with the MIME type covers a file
 * manager or a mail client that knows what it is holding, and the
 * extension-matching filter below it covers the ones that hand over a
 * `content://` URI typed `application/octet-stream`, which is common. The
 * `pathPattern` has to escape its own dot — `\\\\.` in the manifest — or it
 * matches any character before `pdf`.
 *
 * `.notex` gets the same treatment, since the app is the only thing that can
 * open one.
 */
export const OPEN_WITH_FILTERS = `
            <!-- notex: open-with. PDFs are imported as pages; .notex files open directly. -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:mimeType="application/pdf" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="content" />
                <data android:scheme="file" />
                <data android:host="*" />
                <data android:mimeType="*/*" />
                <data android:pathPattern=".*\\\\.pdf" />
                <data android:pathPattern=".*\\\\.notex" />
            </intent-filter>`;

/**
 * The OAuth redirect.
 *
 * Android has no loopback port a browser will reach, so the desktop's
 * "become a web server for a moment" trick is out; the app claims a custom
 * scheme instead and Google redirects to it. Three details are the difference
 * between this working and failing silently:
 *
 * - **`BROWSABLE`.** Without it the system refuses to start an activity from a
 *   link a browser followed, and the consent screen ends on "can't open page".
 *   It is the single most common way this is got wrong.
 * - **`DEFAULT`.** An implicit `ACTION_VIEW` is only delivered to activities
 *   that declare it.
 * - **The scheme is the application id.** Google only issues a redirect on a
 *   scheme it can attribute to the app, and any app on the device may register
 *   any scheme it likes — which is exactly why PKCE is not optional here: an
 *   intercepted code is worthless without the verifier.
 *
 * `android:host` is deliberately absent. The redirect is `com.notex.app:/…`,
 * with no authority at all, and a filter that demanded a host would not match
 * it.
 */
export const OAUTH_REDIRECT_FILTER = `
            <!-- notex: OAuth redirect. Google sends the authorization code back here. -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${IDENTIFIER}" />
            </intent-filter>`;

edit('app/src/main/AndroidManifest.xml', (xml) => {
  let out = xml;
  if (!out.includes('xmlns:tools=')) {
    out = out.replace(
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n    xmlns:tools="http://schemas.android.com/tools">',
    );
  }
  if (!out.includes('notex: scoped storage')) {
    out = out.replace('    <uses-permission android:name="android.permission.INTERNET" />', PERMISSIONS);
  }
  // A canvas app wants the GPU and room for several page bitmaps at once.
  if (!out.includes('android:hardwareAccelerated')) {
    out = out.replace('    <application\n', '    <application\n        android:hardwareAccelerated="true"\n        android:largeHeap="true"\n');
  }
  // adjustResize + interactive-widget=resizes-content keeps the canvas still
  // when the keyboard opens over an AcroForm field.
  if (!out.includes('android:windowSoftInputMode')) {
    out = out.replace('            android:launchMode="singleTask"\n', '            android:launchMode="singleTask"\n            android:windowSoftInputMode="adjustResize"\n');
  }
  // Google's OAuth redirect comes back as a link on our own scheme.
  if (!out.includes('notex: OAuth redirect')) {
    out = out.replace('        </activity>', `${OAUTH_REDIRECT_FILTER}\n        </activity>`);
  }
  // "Open with" from a file manager or a mail attachment.
  if (!out.includes('notex: open-with')) {
    out = out.replace('        </activity>', `${OPEN_WITH_FILTERS}\n        </activity>`);
  }
  return out;
});

// ---------------------------------------------------------------------------
// Name and launcher icon
// ---------------------------------------------------------------------------

/**
 * The launcher label.
 *
 * `tauri android init` writes these from `productName`, so a regenerate would
 * get them right on its own — but the generated project is committed, and
 * without this the committed copy would keep whatever name it was generated
 * with. Derived from the config rather than typed out, so there is one place
 * the app's name lives.
 */
export function renameStrings(xml, name) {
  return xml
    .replace(/<string name="app_name">[^<]*<\/string>/, `<string name="app_name">"${name}"</string>`)
    .replace(/<string name="main_activity_title">[^<]*<\/string>/, `<string name="main_activity_title">"${name}"</string>`);
}

edit('app/src/main/res/values/strings.xml', (xml) => renameStrings(xml, PRODUCT_NAME));

// ---------------------------------------------------------------------------
// SDK levels
// ---------------------------------------------------------------------------

edit('app/build.gradle.kts', (gradle) => {
  let out = gradle.replace(/targetSdk = \d+/, `targetSdk = ${TARGET_SDK}`);
  out = out.replace(/minSdk = \d+/, `minSdk = ${MIN_SDK}`);
  return out;
});

// ---------------------------------------------------------------------------
// WebView: stylus input and edge-to-edge insets
// ---------------------------------------------------------------------------

const MAIN_ACTIVITY = `package ${IDENTIFIER}

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
  private var insetsJson: String = "{\\"top\\":0,\\"right\\":0,\\"bottom\\":0,\\"left\\":0}"

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

  /**
   * The OAuth redirect this launch was asked to handle, or null.
   *
   * Same pull-then-push shape as the open-with bridge, and for the same
   * reason: the intent is known before the page exists, so the page has to be
   * able to ask. Consumed on read, because an authorization code is single-use
   * and replaying a stale one only produces a confusing error.
   */
  @Volatile
  private var oauthRedirect: String? = null

  private inner class OauthBridge {
    @JavascriptInterface
    fun take(): String? {
      val payload = oauthRedirect
      oauthRedirect = null
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
    pushOauthRedirect()
  }

  /** Remember the document this launch was asked to open, if any. */
  private fun noteOpenWith(intent: Intent?) {
    val uri = intent?.data ?: return
    if (intent.action != Intent.ACTION_VIEW && intent.action != Intent.ACTION_SEND) return
    // Google's redirect arrives as ACTION_VIEW too, on this app's own scheme.
    // It is not a document, and handing it to the importer would try to open
    // an authorization code as a PDF.
    if (uri.scheme == BuildConfig.APPLICATION_ID) {
      oauthRedirect = uri.toString()
      return
    }
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
        "window.dispatchEvent(new CustomEvent('notex-open-with', { detail: ${'$'}payload }));",
        null,
      )
    }
  }

  /**
   * Push a redirect into a page that is already up.
   *
   * This is the usual case, not the exception: the app was running when the
   * browser was opened, singleTask brings that same instance forward, and the
   * redirect arrives through onNewIntent with the page mid-session.
   */
  private fun pushOauthRedirect() {
    val payload = oauthRedirect ?: return
    oauthRedirect = null
    val detail = JSONObject().put("redirect", payload).toString()
    runOnUiThread {
      webViewRef?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('notex-oauth-redirect', { detail: ${'$'}detail }));",
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
    webView.addJavascriptInterface(OauthBridge(), "__notexOauth")
    webViewRef = webView
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val density = view.resources.displayMetrics.density
      fun dp(value: Int) = (value / density).toInt()
      insetsJson =
        "{\\"top\\":${'$'}{dp(bars.top)},\\"right\\":${'$'}{dp(bars.right)}," +
          "\\"bottom\\":${'$'}{dp(bars.bottom)},\\"left\\":${'$'}{dp(bars.left)}}"
      webView.evaluateJavascript(
        """
        (() => {
          const s = document.documentElement.style;
          s.setProperty('--android-inset-top', '${'$'}{dp(bars.top)}px');
          s.setProperty('--android-inset-right', '${'$'}{dp(bars.right)}px');
          s.setProperty('--android-inset-bottom', '${'$'}{dp(bars.bottom)}px');
          s.setProperty('--android-inset-left', '${'$'}{dp(bars.left)}px');
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
`;

write(`app/src/main/java/${IDENTIFIER.split('.').join('/')}/MainActivity.kt`, MAIN_ACTIVITY);

// A night variant of the generated theme, so the system bars follow the app.
write(
  'app/src/main/res/values-night/themes.xml',
  `<resources xmlns:tools="http://schemas.android.com/tools">
    <!-- Dark counterpart of the generated day theme. -->
    <style name="Theme.notes" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <item name="android:windowLightStatusBar" tools:targetApi="m">false</item>
    </style>
</resources>
`,
);

/**
 * Adaptive launcher icon (API 26+, which is our minSdk).
 *
 * No `<monochrome>`: a themed icon is drawn from the foreground's *alpha*
 * alone, and this foreground is a filled page with the monogram on it, so as a
 * silhouette it would be a featureless rounded rectangle. Leaving the element
 * out makes Android use the normal icon, which is what it did before themed
 * icons existed and is better than a blank tile.
 */
const ADAPTIVE = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
write('app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml', ADAPTIVE);
write('app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml', ADAPTIVE);

// The colour the launcher paints behind the adaptive icon's foreground, and
// therefore what a circular or squircle mask crops down to.
edit('app/src/main/res/values/colors.xml', (xml) =>
  xml.includes('ic_launcher_background')
    ? xml.replace(/<color name="ic_launcher_background">[^<]*<\/color>/, `<color name="ic_launcher_background">${LAUNCHER_BACKGROUND}</color>`)
    : xml.replace('</resources>', `    <color name="ic_launcher_background">${LAUNCHER_BACKGROUND}</color>\n</resources>`),
);

// ---------------------------------------------------------------------------
// Sanity checks: the Android toolchain is not available on every machine that
// touches this repo, so catch a malformed resource before it reaches Gradle.
// ---------------------------------------------------------------------------

/** Minimal well-formedness scan: balanced elements and quoted attributes. */
export function xmlProblems(xml, label) {
  const found = [];
  const stack = [];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const body = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  let match;
  while ((match = tag.exec(body)) !== null) {
    const [, closing, name, attrs, selfClosing] = match;
    for (const attr of attrs.matchAll(/([\w.:-]+)\s*=\s*(.)/g)) {
      if (attr[2] !== '"' && attr[2] !== "'") found.push(`${label}: attribute ${attr[1]} on <${name}> is not quoted`);
    }
    if (closing) {
      const open = stack.pop();
      if (open !== name) found.push(`${label}: </${name}> closes <${open ?? 'nothing'}>`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  if (stack.length > 0) found.push(`${label}: unclosed <${stack.join('>, <')}>`);
  return found;
}

/**
 * Is there an intent filter that can actually receive an OAuth redirect?
 *
 * Stronger than well-formedness on purpose. An intent filter that parses
 * perfectly and is missing `BROWSABLE` builds a perfectly good APK in which
 * signing in ends on the browser's "can't open page" — and nothing in the
 * build says a word about it. The failure is invisible until someone installs
 * the thing and taps a button, which is the worst possible moment to find out,
 * so the shape is asserted here instead.
 *
 * Returns a list of problems; an empty list means a browser following
 * `<scheme>:/oauth2redirect` will reach the app.
 */
export function oauthFilterProblems(xml, scheme, label) {
  const found = [];
  // Comments can contain anything, including a plausible-looking filter.
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const filters = [...body.matchAll(/<intent-filter[\s\S]*?<\/intent-filter>/g)].map((m) => m[0]);

  const matching = filters.filter(
    (filter) =>
      filter.includes(`android:scheme="${scheme}"`) && filter.includes('android.intent.action.VIEW'),
  );
  if (matching.length === 0) {
    found.push(`${label}: no <intent-filter> with android:scheme="${scheme}" and action VIEW`);
    return found;
  }

  for (const filter of matching) {
    // Without BROWSABLE the system will not start the activity from a link,
    // which is the only way this redirect ever arrives.
    if (!filter.includes('android.intent.category.BROWSABLE')) {
      found.push(`${label}: the ${scheme} intent filter is missing category BROWSABLE, so a browser cannot open it`);
    }
    // An implicit intent is only delivered to activities declaring DEFAULT.
    if (!filter.includes('android.intent.category.DEFAULT')) {
      found.push(`${label}: the ${scheme} intent filter is missing category DEFAULT`);
    }
    // The redirect has no authority. A host requirement would never match it.
    if (/<data[^>]*android:host=/.test(filter)) {
      found.push(`${label}: the ${scheme} intent filter requires a host, but the redirect URI has none`);
    }
    // A MIME type turns a scheme match into a typed-data match, and a browser
    // following a link declares no type.
    if (/<data[^>]*android:mimeType=/.test(filter)) {
      found.push(`${label}: the ${scheme} intent filter requires a mimeType, which a browser redirect does not carry`);
    }
  }
  found.push(...xmlProblems(`<activity>${matching.join('')}</activity>`, label));
  return found;
}

/**
 * Broken string literals in generated Kotlin.
 *
 * `MainActivity.kt` is emitted from a JavaScript template literal, so every
 * backslash in it has to survive two levels of escaping. One that does not
 * ends the Kotlin string early, and the rest of the line becomes stray
 * identifiers — which `kotlinc` only reports three minutes into a Gradle run,
 * on CI, after the whole web and Rust build has already passed. This catches
 * it in a second.
 *
 * Two signatures, because the interesting one is not a parity error. Losing
 * the escaping in `"{\"uri\":…}"` produces `"{"uri":…}"`, which has an
 * *even* number of quotes: what makes it invalid is the literal `"{"` sitting
 * directly against the identifier `uri` with no operator between them. That
 * is precisely what kotlinc calls "Unsupported [literal prefixes and
 * suffixes]", so it is what this looks for — along with the simpler case of a
 * string that never closes at all.
 *
 * It is a scanner, not a parser: raw (`"""`) strings, comments and character
 * literals are skipped, and everything else is read a character at a time.
 */
export function kotlinProblems(source, label) {
  const found = [];
  const identifier = /[A-Za-z0-9_]/;
  const lines = source.split('\n');
  let inRaw = false;
  let inBlockComment = false;

  lines.forEach((line, index) => {
    const number = index + 1;
    let i = 0;
    while (i < line.length) {
      const rest = line.slice(i);

      if (inBlockComment) {
        const close = rest.indexOf('*/');
        if (close === -1) return;
        i += close + 2;
        inBlockComment = false;
        continue;
      }
      if (inRaw) {
        const close = rest.indexOf('"""');
        if (close === -1) return;
        i += close + 3;
        inRaw = false;
        continue;
      }
      if (rest.startsWith('"""')) {
        inRaw = true;
        i += 3;
        continue;
      }
      if (rest.startsWith('/*')) {
        inBlockComment = true;
        i += 2;
        continue;
      }
      if (rest.startsWith('//')) return;
      if (rest.startsWith("'")) {
        // A character literal — `'$'` and friends, which contain a quote often
        // enough to matter.
        const close = line.indexOf("'", i + 1);
        i = close === -1 ? line.length : close + 1;
        continue;
      }
      if (rest.startsWith('"')) {
        const before = i > 0 ? line[i - 1] : '';
        // Walk to the closing quote, respecting escapes.
        let j = i + 1;
        let closed = false;
        while (j < line.length) {
          if (line[j] === '\\') {
            j += 2;
            continue;
          }
          if (line[j] === '"') {
            closed = true;
            break;
          }
          j += 1;
        }
        if (!closed) {
          found.push(`${label}:${number}: string literal is never closed`);
          return;
        }
        const after = line[j + 1] ?? '';
        if (identifier.test(before) || identifier.test(after)) {
          found.push(
            `${label}:${number}: a string literal runs straight into an identifier — an escaped quote was probably lost between the generator and the file`,
          );
          return;
        }
        i = j + 1;
        continue;
      }
      i += 1;
    }
  });

  if (inRaw) found.push(`${label}: a raw string is never closed`);
  return found;
}

/**
 * The `MainActivity.kt` currently committed under `src-tauri/gen/android`.
 *
 * Exported so a unit test can check the file the Gradle build will actually
 * compile, without the test needing Node's filesystem types.
 */
export function generatedActivitySource() {
  const path = join(ANDROID, `app/src/main/java/${IDENTIFIER.split('.').join('/')}/MainActivity.kt`);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

const RESOURCES = [
  'app/src/main/AndroidManifest.xml',
  'app/src/main/res/values/colors.xml',
  'app/src/main/res/values/strings.xml',
  'app/src/main/res/values/themes.xml',
  'app/src/main/res/values-night/themes.xml',
  'app/src/main/res/xml/file_paths.xml',
  'app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
  'app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml',
  'app/src/main/res/layout/activity_main.xml',
  'app/src/main/res/drawable/ic_launcher_background.xml',
  'app/src/main/res/drawable-v24/ic_launcher_foreground.xml',
];
for (const relative of RESOURCES) {
  const path = join(ANDROID, relative);
  if (!existsSync(path)) {
    problems.push(`${relative} is missing`);
    continue;
  }
  problems.push(...xmlProblems(readFileSync(path, 'utf8'), relative));
}

const manifest = existsSync(join(ANDROID, 'app/src/main/AndroidManifest.xml'))
  ? readFileSync(join(ANDROID, 'app/src/main/AndroidManifest.xml'), 'utf8')
  : '';
for (const permission of ['INTERNET', 'READ_MEDIA_IMAGES', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE']) {
  if (!manifest.includes(`android.permission.${permission}`)) problems.push(`AndroidManifest.xml does not declare ${permission}`);
}
if (!manifest.includes('android:windowSoftInputMode="adjustResize"')) {
  problems.push('AndroidManifest.xml does not set windowSoftInputMode=adjustResize');
}
// "Open with": a PDF handed over by a file manager or a mail client.
if (!manifest.includes('android:mimeType="application/pdf"')) {
  problems.push('AndroidManifest.xml has no application/pdf intent filter');
}
if (!manifest.includes('android:pathPattern=".*\\\\.pdf"')) {
  problems.push('AndroidManifest.xml has no .pdf pathPattern filter (senders that type files as octet-stream)');
}
// The OAuth redirect. Checked for shape, not just presence: see above.
if (manifest) problems.push(...oauthFilterProblems(manifest, IDENTIFIER, 'AndroidManifest.xml'));

const strings = existsSync(join(ANDROID, 'app/src/main/res/values/strings.xml'))
  ? readFileSync(join(ANDROID, 'app/src/main/res/values/strings.xml'), 'utf8')
  : '';
if (strings && !strings.includes(`>"${PRODUCT_NAME}"<`)) {
  problems.push(`strings.xml does not call the app ${PRODUCT_NAME}`);
}

const colors = existsSync(join(ANDROID, 'app/src/main/res/values/colors.xml'))
  ? readFileSync(join(ANDROID, 'app/src/main/res/values/colors.xml'), 'utf8')
  : '';
if (colors && !colors.includes(`<color name="ic_launcher_background">${LAUNCHER_BACKGROUND}</color>`)) {
  problems.push(`colors.xml does not set ic_launcher_background to ${LAUNCHER_BACKGROUND}`);
}


const appGradle = existsSync(join(ANDROID, 'app/build.gradle.kts'))
  ? readFileSync(join(ANDROID, 'app/build.gradle.kts'), 'utf8')
  : '';
if (!appGradle.includes(`minSdk = ${MIN_SDK}`)) problems.push(`app/build.gradle.kts does not set minSdk = ${MIN_SDK}`);
if (!appGradle.includes(`targetSdk = ${TARGET_SDK}`)) problems.push(`app/build.gradle.kts does not set targetSdk = ${TARGET_SDK}`);
if (!appGradle.includes(`applicationId = "${IDENTIFIER}"`)) problems.push(`app/build.gradle.kts does not set applicationId = ${IDENTIFIER}`);
const compileSdk = Number(/compileSdk = (\d+)/.exec(appGradle)?.[1] ?? 0);
if (compileSdk < TARGET_SDK) problems.push(`compileSdk (${compileSdk}) must be at least targetSdk (${TARGET_SDK})`);

const activity = join(ANDROID, `app/src/main/java/${IDENTIFIER.split('.').join('/')}/MainActivity.kt`);
if (!existsSync(activity)) {
  problems.push(`MainActivity.kt is not under the ${IDENTIFIER} package`);
} else {
  // Cheap syntax guard: the alternative is finding out from kotlinc, three
  // minutes into a Gradle run on CI.
  problems.push(...kotlinProblems(readFileSync(activity, 'utf8'), 'MainActivity.kt'));
  if (!readFileSync(activity, 'utf8').includes('__notexOpenWith')) {
    problems.push('MainActivity.kt does not expose the open-with bridge');
  }
  if (!readFileSync(activity, 'utf8').includes('__notexOauth')) {
    problems.push('MainActivity.kt does not expose the OAuth redirect bridge');
  }
}

// Regression guard: `tauri android init` generates buildSrc's Gradle plugin
// classes (BuildTask.kt, RustPlugin.kt) fresh under buildSrc/src/main/java/,
// package-named per this project's identifier, on every machine that
// doesn't already have them. A second copy at the legacy buildSrc/src/main/kotlin/
// path (committed by mistake once already — see git history) declares the
// same root-package symbols and breaks the Kotlin compile with
// "Redeclaration" errors, so make sure it can never come back.
const staleBuildSrc = ['BuildTask.kt', 'RustPlugin.kt']
  .map((f) => `buildSrc/src/main/kotlin/${f}`)
  .filter((relative) => existsSync(join(ANDROID, relative)));
if (staleBuildSrc.length > 0) {
  problems.push(
    `stale buildSrc Kotlin source(s) present (duplicate the ones 'tauri android init' generates under buildSrc/src/main/java/): ${staleBuildSrc.join(', ')}`,
  );
}

if (ANDROID_CONFIG.identifier && ANDROID_CONFIG.identifier !== IDENTIFIER) {
  problems.push(`tauri.android.conf.json identifier (${ANDROID_CONFIG.identifier}) does not match ${IDENTIFIER}`);
}

if (RUNNING) {
  if (problems.length > 0) {
    console.error('android-customize: problems found\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }
  console.log(
    check
      ? `android-customize: OK (${IDENTIFIER}, minSdk ${MIN_SDK}, targetSdk ${TARGET_SDK})`
      : changes.length > 0
        ? `android-customize: updated\n${changes.map((c) => `  - ${c}`).join('\n')}`
        : 'android-customize: already up to date',
  );
}
