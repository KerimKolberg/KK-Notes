/**
 * The document the app was asked to open.
 *
 * Two platforms, two mechanisms. On the desktop it is a command-line argument
 * (the `.notex` file association), read through `get_startup_file`. On Android
 * it is an Intent, which never reaches the process as an argument at all:
 * `MainActivity` catches it and exposes it through a bridge object, the same
 * pull-then-push shape the inset bridge uses and for the same reason — a
 * JavaScript interface added to a WebView is only visible to the *next*
 * navigation, so the page has to ask rather than wait to be told.
 *
 * The Android payload is consumed on read. Opening the app again a week later
 * must not re-import the PDF someone opened once.
 */

/** Name `MainActivity` registers the bridge under (`addJavascriptInterface`). */
export const OPEN_WITH_BRIDGE = '__notexOpenWith';

/** Event the activity dispatches when an intent arrives at a running app. */
export const OPEN_WITH_EVENT = 'notex-open-with';

export interface AndroidOpenWithBridge {
  /** JSON `{"uri":"…","mime":"…"}`, or null. Consumed on read. */
  take(): string | null;
}

export interface OpenWithRequest {
  /** A path, or a `content://` URI on Android. */
  readonly uri: string;
  /** What the sender declared. May be empty or wrong; the extension decides. */
  readonly mime: string;
}

export type OpenWithKind = 'pdf' | 'notex' | 'unknown';

/**
 * What kind of document this is.
 *
 * The extension is consulted before the declared MIME type, because senders
 * lie: a file manager handing over a `content://` URI routinely types it
 * `application/octet-stream`, and a `content://` URI often has no visible
 * extension at all — hence both being checked.
 */
export function classifyOpenWith(request: OpenWithRequest): OpenWithKind {
  const uri = request.uri.toLowerCase();
  // Query strings and fragments are not part of the name.
  const path = uri.split(/[?#]/)[0] ?? uri;
  if (path.endsWith('.pdf')) return 'pdf';
  if (path.endsWith('.notex') || path.endsWith('.json')) return 'notex';
  const mime = request.mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/x-notex+json') return 'notex';
  return 'unknown';
}

/** Parse the bridge's payload. Anything that is not the expected shape is `null`. */
export function parseOpenWith(json: string | null | undefined): OpenWithRequest | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const uri = typeof record.uri === 'string' ? record.uri.trim() : '';
  if (uri === '') return null;
  return { uri, mime: typeof record.mime === 'string' ? record.mime : '' };
}

/** Take the pending Android intent, if there is one. Consumed on read. */
export function takeAndroidOpenWith(): OpenWithRequest | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as Record<string, AndroidOpenWithBridge | undefined>)[OPEN_WITH_BRIDGE];
  if (!bridge || typeof bridge.take !== 'function') return null;
  try {
    return parseOpenWith(bridge.take());
  } catch {
    // The bridge crosses a language boundary; a throw here must not stop the
    // app from starting.
    return null;
  }
}

/** Listen for an intent that arrives while the app is already running. */
export function onOpenWith(handler: (request: OpenWithRequest) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    const request = typeof detail === 'string' ? parseOpenWith(detail) : parseOpenWith(JSON.stringify(detail));
    if (request) handler(request);
  };
  window.addEventListener(OPEN_WITH_EVENT, listener);
  return () => window.removeEventListener(OPEN_WITH_EVENT, listener);
}
