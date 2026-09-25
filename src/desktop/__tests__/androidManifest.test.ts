import { describe, expect, it } from 'vitest';
// A build script, not TypeScript; imported for its pure helpers. It writes
// nothing unless it is run as a script, so importing it here cannot rewrite
// the generated Android project.
import {
  IDENTIFIER,
  OAUTH_REDIRECT_FILTER,
  OPEN_WITH_FILTERS,
  generatedActivitySource,
  kotlinProblems,
  oauthFilterProblems,
  xmlProblems,
  // @ts-expect-error -- untyped .mjs
} from '../../../scripts/android-customize.mjs';

const filters: string = OPEN_WITH_FILTERS;
const oauthFilter: string = OAUTH_REDIRECT_FILTER;
const identifier: string = IDENTIFIER;
const problems = (xml: string, label = 'test'): string[] => xmlProblems(xml, label) as string[];
const kotlin = (source: string, label = 'test'): string[] => kotlinProblems(source, label) as string[];
const oauthProblems = (xml: string, scheme = identifier, label = 'test'): string[] =>
  oauthFilterProblems(xml, scheme, label) as string[];

/**
 * The manifest is generated, not committed, so this checks the fragment the
 * generator splices in. A malformed intent filter does not fail the JS build
 * or the Rust build — it fails `aapt2` deep inside a 20-minute Gradle run, or
 * worse, builds an APK that the system quietly never offers to open a PDF.
 */
describe('the open-with intent filters', () => {
  it('is well-formed XML', () => {
    expect(problems(`<activity>${filters}</activity>`)).toEqual([]);
  });

  it('is still well-formed once spliced into an activity', () => {
    const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="Notes">
        <activity android:name=".MainActivity" android:launchMode="singleTask">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>${filters}
        </activity>
    </application>
</manifest>`;
    expect(problems(manifest, 'AndroidManifest.xml')).toEqual([]);
  });

  it('declares the PDF MIME type, which is what makes the app an option at all', () => {
    expect(filters).toContain('android:mimeType="application/pdf"');
    expect(filters).toContain('android.intent.action.VIEW');
    expect(filters).toContain('android.intent.category.DEFAULT');
  });

  it('also matches by extension, for senders that type a file as octet-stream', () => {
    // A file manager handing over a `content://` URI often declares
    // `application/octet-stream`; only the path pattern catches those.
    expect(filters).toContain('android:pathPattern=".*\\\\.pdf"');
    expect(filters).toContain('android:pathPattern=".*\\\\.notex"');
    // A GoodNotes notebook has no MIME type worth matching — it is a ZIP — so
    // the extension is the only thing that can put the app in the chooser.
    expect(filters).toContain('android:pathPattern=".*\\\\.goodnotes"');
  });

  it('does not claim every ZIP on the device', () => {
    // Which is what declaring `application/zip` would do: a notebook is a ZIP,
    // and so is every download, backup and font pack.
    expect(filters).not.toContain('application/zip');
  });

  it('escapes the dot in every path pattern', () => {
    // An unescaped `.` is "any character", so `.*.pdf` would match `notesXpdf`
    // and, more to the point, claim files the app cannot open.
    const patterns = [...filters.matchAll(/android:pathPattern="([^"]+)"/g)].map((m) => m[1]!);
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) expect(pattern).toMatch(/^\.\*\\\\\./);
  });

  it('quotes every attribute', () => {
    // The generator writes this as a template literal, where a missing quote
    // is silent until aapt2 rejects the build.
    expect(problems(`<activity>${filters}</activity>`).filter((p) => p.includes('not quoted'))).toEqual([]);
  });
});

/**
 * `MainActivity.kt` is emitted from a JavaScript template literal, so every
 * backslash has to survive two levels of escaping. One that did not cost a CI
 * run: the Kotlin string ended at its first inner quote and the rest of the
 * line became stray identifiers, which only `kotlinc` noticed, three minutes
 * into a Gradle build.
 */
describe('the generated Kotlin checker', () => {
  it('catches the escaping bug that broke the build', () => {
    // The literal line that failed. Note it has an *even* number of quotes,
    // so a parity check would pass it: what makes it invalid is `"{"` sitting
    // against `uri` with no operator between them.
    const broken = 'openWithJson = "{"uri":${JSONObject.quote(u)},"mime":${JSONObject.quote(m)}}"';
    expect((broken.match(/"/g) ?? []).length % 2).toBe(0);
    expect(kotlin(broken)).not.toEqual([]);
    expect(kotlin(broken)[0]).toContain('identifier');
  });

  it('passes the form that replaced it', () => {
    expect(kotlin('openWithJson = JSONObject().put("uri", uri.toString()).put("mime", mime).toString()')).toEqual([]);
  });

  it('catches a string that never closes', () => {
    expect(kotlin('val s = "hello')[0]).toContain('never closed');
  });

  it('does not cry wolf over ordinary Kotlin', () => {
    for (const line of [
      'webView.addJavascriptInterface(InsetBridge(), "__notexInsets")',
      'insetsJson = "{\\"top\\":${dp(bars.top)}}"',
      "val marker = \"a${'$'}b\"",
      '// a comment mentioning the "open with" bridge',
      'val s = "a" + b + "c"',
      'private var openWithJson: String? = null',
    ]) {
      expect(kotlin(line)).toEqual([]);
    }
  });

  it('reads through a raw string without tripping on its contents', () => {
    const raw = [
      'webView.evaluateJavascript(',
      '  """',
      '  (() => { const s = "x"; })();',
      '  """.trimIndent(),',
      '  null,',
      ')',
    ].join('\n');
    expect(kotlin(raw)).toEqual([]);
  });

  it('checks the file the build actually compiles', () => {
    // The committed generated activity, not a fixture: this is the exact text
    // Gradle hands to kotlinc.
    const activity = generatedActivitySource() as string | null;
    expect(activity).not.toBeNull();
    expect(kotlin(activity ?? '', 'MainActivity.kt')).toEqual([]);
    // And it still carries the bridge the boot sequence reads.
    expect(activity).toContain('__notexOpenWith');
  });
});

describe('the XML checker itself', () => {
  it('catches the mistakes it exists to catch', () => {
    expect(problems('<a><b></a>')).toContain('test: </a> closes <b>');
    expect(problems('<a>')).toContain('test: unclosed <a>');
    expect(problems('<a x=1 />')).toContain('test: attribute x on <a> is not quoted');
    expect(problems('<a x="1" />')).toEqual([]);
  });
});

/**
 * The OAuth redirect filter.
 *
 * Verified for *shape*, not just for parsing. A filter that is perfectly
 * well-formed and missing `BROWSABLE` produces a perfectly good APK in which
 * signing in to Google Drive ends on the browser's "can't open page" — and
 * nothing in the build says a word about it. That failure is invisible until
 * someone installs the APK and taps the button, so it is asserted here.
 */
describe('the OAuth redirect intent filter', () => {
  it('is well-formed XML on its own and inside an activity', () => {
    expect(problems(`<activity>${oauthFilter}</activity>`)).toEqual([]);
    const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="Notes">
        <activity android:name=".MainActivity" android:launchMode="singleTask">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>${filters}${oauthFilter}
        </activity>
    </application>
</manifest>`;
    expect(problems(manifest, 'AndroidManifest.xml')).toEqual([]);
    expect(oauthProblems(manifest)).toEqual([]);
  });

  it('claims the application id as its scheme', () => {
    // Google issues the redirect on a scheme it can attribute to the app, and
    // it has to be the same string in three places: here, the URI Rust builds,
    // and the Cloud console. `RedirectTarget::CustomScheme` is asserted
    // against this same value on the Rust side.
    expect(identifier).toBe('com.notex.app');
    expect(oauthFilter).toContain(`android:scheme="${identifier}"`);
  });

  it('declares BROWSABLE, which is what lets a browser start the app at all', () => {
    expect(oauthFilter).toContain('android.intent.category.BROWSABLE');
    expect(oauthFilter).toContain('android.intent.category.DEFAULT');
    expect(oauthFilter).toContain('android.intent.action.VIEW');
  });

  it('demands neither a host nor a MIME type, which the redirect does not carry', () => {
    // The redirect is `com.notex.app:/oauth2redirect` — no authority, no type.
    // A `<data android:host>` or `android:mimeType` would simply never match.
    expect(oauthFilter).not.toContain('android:host');
    expect(oauthFilter).not.toContain('android:mimeType');
  });

  it('quotes every attribute', () => {
    for (const attribute of oauthFilter.matchAll(/([\w:]+)\s*=\s*(.)/g)) {
      expect(attribute[2]).toBe('"');
    }
  });
});

describe('the OAuth filter checker itself', () => {
  const wrap = (inner: string): string => `<manifest><application><activity>${inner}</activity></application></manifest>`;
  const good = `<intent-filter>
      <action android:name="android.intent.action.VIEW" />
      <category android:name="android.intent.category.DEFAULT" />
      <category android:name="android.intent.category.BROWSABLE" />
      <data android:scheme="com.notex.app" />
    </intent-filter>`;

  it('passes a filter that works', () => {
    expect(oauthProblems(wrap(good))).toEqual([]);
  });

  it('catches a missing filter', () => {
    expect(oauthProblems(wrap('')).join(' ')).toContain('no <intent-filter>');
    // A filter for a different scheme is not this one.
    expect(oauthProblems(wrap(good.replace('com.notex.app', 'com.other.app'))).join(' ')).toContain('no <intent-filter>');
  });

  it('catches the mistake that fails silently on a device', () => {
    const noBrowsable = good.replace(/\s*<category android:name="android.intent.category.BROWSABLE" \/>/, '');
    expect(oauthProblems(wrap(noBrowsable)).join(' ')).toContain('BROWSABLE');

    const noDefault = good.replace(/\s*<category android:name="android.intent.category.DEFAULT" \/>/, '');
    expect(oauthProblems(wrap(noDefault)).join(' ')).toContain('DEFAULT');
  });

  it('catches data constraints the redirect cannot satisfy', () => {
    const withHost = good.replace('<data android:scheme="com.notex.app" />', '<data android:scheme="com.notex.app" android:host="oauth2redirect" />');
    expect(oauthProblems(wrap(withHost)).join(' ')).toContain('requires a host');

    const withMime = good.replace('<data android:scheme="com.notex.app" />', '<data android:scheme="com.notex.app" android:mimeType="*/*" />');
    expect(oauthProblems(wrap(withMime)).join(' ')).toContain('requires a mimeType');
  });

  it('is not fooled by a filter that only exists in a comment', () => {
    expect(oauthProblems(wrap(`<!-- ${good} -->`)).join(' ')).toContain('no <intent-filter>');
  });

  it('does not mistake the open-with filter for this one', () => {
    // That filter legitimately carries a host and a MIME type; complaining
    // about them would be a false alarm on every build.
    expect(oauthProblems(`<activity>${filters}${oauthFilter}</activity>`)).toEqual([]);
  });
});

describe('the generated activity', () => {
  it('exposes the OAuth bridge and keeps a redirect out of the document importer', () => {
    const activity = (generatedActivitySource() as string | null) ?? '';
    expect(activity).toContain('__notexOauth');
    // A redirect arrives as ACTION_VIEW, exactly like a document. Without this
    // check the importer would be handed an authorization code to open.
    expect(activity).toContain('uri.scheme == BuildConfig.APPLICATION_ID');
    expect(activity).toContain('notex-oauth-redirect');
    expect(kotlin(activity, 'MainActivity.kt')).toEqual([]);
  });
});
