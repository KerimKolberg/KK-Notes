import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a build script, not TypeScript; imported for its pure
// helpers. It writes nothing unless it is run as a script, so importing it
// here cannot rewrite the generated Android project.
import { OPEN_WITH_FILTERS, generatedActivitySource, kotlinProblems, xmlProblems } from '../../../scripts/android-customize.mjs';

const filters: string = OPEN_WITH_FILTERS;
const problems = (xml: string, label = 'test'): string[] => xmlProblems(xml, label) as string[];
const kotlin = (source: string, label = 'test'): string[] => kotlinProblems(source, label) as string[];

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
