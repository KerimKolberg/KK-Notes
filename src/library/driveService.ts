/**
 * Connecting a Google Drive account, from the page's side.
 *
 * Nothing security-relevant happens here. The PKCE verifier, the `state`, the
 * token exchange and the tokens themselves never enter the webview: the page
 * asks Rust to start a sign-in, Rust opens the system browser, and the answer
 * comes back either through a loopback listener Rust is already waiting on
 * (desktop) or through an intent the page forwards without being able to use
 * (Android). All this file knows is a redirect URI and whether it worked.
 *
 * The Android path needs the same pull-then-push shape as "open with", and for
 * the same reason: `addJavascriptInterface` only makes a bridge visible to the
 * *next* navigation, so a redirect that arrived before the page existed has to
 * be asked for, while one that arrives mid-session is pushed as an event.
 */
import { isTauri, tauriInvoke } from '../desktop/tauri';

/** Name `MainActivity` registers the OAuth bridge under. */
export const OAUTH_BRIDGE = '__notexOauth';
/** Event the activity dispatches when a redirect reaches a running app. */
export const OAUTH_EVENT = 'notex-oauth-redirect';

export interface AndroidOauthBridge {
  /** The redirect URI, or null. Consumed on read. */
  take(): string | null;
}

export interface DriveAccountInfo {
  readonly connected: boolean;
  /** The signed-in email, when Google told us one. */
  readonly account: string;
  /** False when consent was given without the Drive scope. */
  readonly hasDriveAccess: boolean;
  /** False in a build with no OAuth client id compiled in. */
  readonly configured: boolean;
  /** Set when a sign-in that finished in the browser failed. */
  readonly error?: string;
}

export const DISCONNECTED: DriveAccountInfo = {
  connected: false,
  account: '',
  hasDriveAccess: false,
  configured: false,
};

export async function driveAccount(): Promise<DriveAccountInfo> {
  if (!isTauri()) return DISCONNECTED;
  return tauriInvoke<DriveAccountInfo>('drive_account');
}

/**
 * Open the consent screen.
 *
 * Resolves as soon as the browser is open, *not* when the sign-in finishes —
 * the user is in another window by then, and on the desktop the result arrives
 * through {@link watchDriveAccount}. Treating this promise as the answer is
 * the mistake it is shaped to prevent.
 */
export async function driveSignIn(): Promise<void> {
  if (!isTauri()) throw new Error('Google Drive sync needs the desktop or Android app.');
  await tauriInvoke<string>('drive_sign_in');
}

export async function driveSignOut(): Promise<DriveAccountInfo> {
  if (!isTauri()) return DISCONNECTED;
  return tauriInvoke<DriveAccountInfo>('drive_sign_out');
}

/** Hand a redirect URI to Rust, which checks the `state` and redeems the code. */
export async function completeDriveSignIn(redirect: string): Promise<DriveAccountInfo> {
  if (!isTauri()) return DISCONNECTED;
  return tauriInvoke<DriveAccountInfo>('drive_complete_sign_in', { redirect });
}

/**
 * Is this string plausibly an OAuth redirect for this app?
 *
 * Only a shape check, to avoid forwarding every stray event to Rust — the
 * `state` comparison that actually matters happens there, against a value the
 * page has never seen.
 */
export function isOauthRedirect(uri: unknown, scheme = 'com.notex.app'): uri is string {
  if (typeof uri !== 'string') return false;
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith(`${scheme.toLowerCase()}:`)) return false;
  return trimmed.includes('code=') || trimmed.includes('error=');
}

/** Take the redirect the app was launched with, if there is one. */
export function takeAndroidRedirect(): string | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as Record<string, AndroidOauthBridge | undefined>)[OAUTH_BRIDGE];
  if (!bridge || typeof bridge.take !== 'function') return null;
  try {
    const redirect = bridge.take();
    return isOauthRedirect(redirect) ? redirect : null;
  } catch {
    // The bridge crosses a language boundary; a throw must not stop boot.
    return null;
  }
}

/** Read the redirect out of the event `MainActivity` dispatches. */
export function readRedirectEvent(detail: unknown): string | null {
  if (typeof detail === 'string') return isOauthRedirect(detail) ? detail : null;
  if (typeof detail !== 'object' || detail === null) return null;
  const redirect = (detail as Record<string, unknown>).redirect;
  return isOauthRedirect(redirect) ? redirect : null;
}

/**
 * Watch for a redirect arriving on Android, whenever it arrives.
 *
 * Both halves are needed: the app is usually already running when the browser
 * hands back (so the event fires), but it can also have been evicted while the
 * consent screen was open (so the bridge holds the answer at boot).
 */
export function onOauthRedirect(handler: (redirect: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const pending = takeAndroidRedirect();
  if (pending) handler(pending);
  const listener = (event: Event): void => {
    const redirect = readRedirectEvent((event as CustomEvent<unknown>).detail);
    if (redirect) handler(redirect);
  };
  window.addEventListener(OAUTH_EVENT, listener);
  return () => window.removeEventListener(OAUTH_EVENT, listener);
}

/** Listen for the account connecting or disconnecting. Returns an unsubscribe. */
export async function watchDriveAccount(onAccount: (info: DriveAccountInfo) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<DriveAccountInfo>('drive://account', (event) => onAccount(event.payload));
  return unlisten;
}

/**
 * One line describing the connection.
 *
 * `inApp` is separate from `configured` because the two unavailable states
 * have completely different answers: a browser cannot sync at all and never
 * will, while a build without a client id is a build problem. Collapsing them
 * would tell a web visitor to go and rebuild the app.
 */
export function describeAccount(info: DriveAccountInfo, inApp = true): string {
  if (!inApp) return 'Cloud sync runs in the desktop and Android apps. In a browser your notes stay in this browser.';
  if (!info.configured) return 'This build has no Google client id, so Drive sync is unavailable.';
  if (!info.connected) return 'Not connected. Your notes stay on this device.';
  if (!info.hasDriveAccess) return 'Connected, but Notex was not given access to Drive. Sign in again to fix it.';
  return info.account ? `Connected as ${info.account}.` : 'Connected.';
}

/** True when there is a Rust side to talk to at all. */
export function cloudSyncAvailable(): boolean {
  return isTauri();
}
