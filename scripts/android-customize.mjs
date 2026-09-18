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

const ROOT = new URL('..', import.meta.url).pathname;
const ANDROID = join(ROOT, 'src-tauri/gen/android');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
const ANDROID_CONFIG = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.android.conf.json'), 'utf8'));

export const IDENTIFIER = CONFIG.identifier;
export const MIN_SDK = CONFIG.bundle?.android?.minSdkVersion ?? 26;
/** Android 14. Tauri's template compiles against the newest SDK and targets it too. */
export const TARGET_SDK = 34;

const check = process.argv.includes('--check');
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
  // "Open with" from a file manager or a mail attachment.
  if (!out.includes('notex: open-with')) {
    out = out.replace('        </activity>', `${OPEN_WITH_FILTERS}\n        </activity>`);
  }
  return out;
});

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
    openWithJson = "{\"uri\":${'$'}{JSONObject.quote(uri.toString())},\"mime\":${'$'}{JSONObject.quote(mime)}}"
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

// Adaptive launcher icon (API 26+, which is our minSdk).
const ADAPTIVE = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
write('app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml', ADAPTIVE);
write('app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml', ADAPTIVE);

edit('app/src/main/res/values/colors.xml', (xml) =>
  xml.includes('ic_launcher_background')
    ? xml
    : xml.replace('</resources>', '    <color name="ic_launcher_background">#1F1F24</color>\n</resources>'),
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


const appGradle = existsSync(join(ANDROID, 'app/build.gradle.kts'))
  ? readFileSync(join(ANDROID, 'app/build.gradle.kts'), 'utf8')
  : '';
if (!appGradle.includes(`minSdk = ${MIN_SDK}`)) problems.push(`app/build.gradle.kts does not set minSdk = ${MIN_SDK}`);
if (!appGradle.includes(`targetSdk = ${TARGET_SDK}`)) problems.push(`app/build.gradle.kts does not set targetSdk = ${TARGET_SDK}`);
if (!appGradle.includes(`applicationId = "${IDENTIFIER}"`)) problems.push(`app/build.gradle.kts does not set applicationId = ${IDENTIFIER}`);
const compileSdk = Number(/compileSdk = (\d+)/.exec(appGradle)?.[1] ?? 0);
if (compileSdk < TARGET_SDK) problems.push(`compileSdk (${compileSdk}) must be at least targetSdk (${TARGET_SDK})`);

const activity = join(ANDROID, `app/src/main/java/${IDENTIFIER.split('.').join('/')}/MainActivity.kt`);
if (!existsSync(activity)) problems.push(`MainActivity.kt is not under the ${IDENTIFIER} package`);

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
