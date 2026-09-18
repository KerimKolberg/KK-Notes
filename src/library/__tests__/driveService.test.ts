import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISCONNECTED,
  OAUTH_BRIDGE,
  OAUTH_EVENT,
  describeAccount,
  isOauthRedirect,
  onOauthRedirect,
  readRedirectEvent,
  takeAndroidRedirect,
  type DriveAccountInfo,
} from '../driveService';

/**
 * The page's side of the OAuth flow.
 *
 * Everything here is deliberately dumb — the verifier, the `state` check and
 * the token exchange all happen in Rust, where the page cannot reach them — so
 * what is worth testing is that the page forwards the right things and, more
 * importantly, *does not* forward or act on the wrong ones.
 */

const globalWindow = globalThis as unknown as {
  window?: Record<string, unknown> & {
    addEventListener: (type: string, listener: (event: Event) => void) => void;
    removeEventListener: (type: string, listener: (event: Event) => void) => void;
    dispatchEvent: (event: Event) => boolean;
  };
};

/** A minimal window with the event plumbing these functions use. */
function fakeWindow(): NonNullable<typeof globalWindow.window> {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  return {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== listener));
    },
    dispatchEvent(event: Event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };
}

afterEach(() => {
  delete globalWindow.window;
  vi.restoreAllMocks();
});

const REDIRECT = 'com.notex.app:/oauth2redirect?state=abc&code=4%2F0AX4';

describe('isOauthRedirect', () => {
  it('accepts a redirect on this app’s scheme that carries an answer', () => {
    expect(isOauthRedirect(REDIRECT)).toBe(true);
    expect(isOauthRedirect('com.notex.app:/oauth2redirect?error=access_denied&state=abc')).toBe(true);
    // Android normalises scheme case, so neither end may depend on it.
    expect(isOauthRedirect('COM.NOTEX.APP:/oauth2redirect?code=x')).toBe(true);
  });

  it('rejects anything that is not one', () => {
    expect(isOauthRedirect(null)).toBe(false);
    expect(isOauthRedirect(undefined)).toBe(false);
    expect(isOauthRedirect(42)).toBe(false);
    expect(isOauthRedirect('')).toBe(false);
    // A document, which arrives through the very same Android intent action.
    expect(isOauthRedirect('content://downloads/1234')).toBe(false);
    expect(isOauthRedirect('file:///sdcard/notes.pdf')).toBe(false);
    // Our scheme, but no code and no error: not an answer to anything.
    expect(isOauthRedirect('com.notex.app:/oauth2redirect')).toBe(false);
    // Another app's scheme that merely starts the same way.
    expect(isOauthRedirect('com.notex.apple:/oauth2redirect?code=x')).toBe(false);
  });
});

describe('the Android bridge', () => {
  it('takes a pending redirect exactly once', () => {
    let remaining: string | null = REDIRECT;
    globalWindow.window = fakeWindow();
    globalWindow.window[OAUTH_BRIDGE] = {
      take: () => {
        const value = remaining;
        remaining = null;
        return value;
      },
    };

    expect(takeAndroidRedirect()).toBe(REDIRECT);
    // An authorization code is single use; replaying one only produces a
    // confusing error from Google on the next launch.
    expect(takeAndroidRedirect()).toBeNull();
  });

  it('ignores a bridge that is absent, empty or broken', () => {
    globalWindow.window = fakeWindow();
    expect(takeAndroidRedirect()).toBeNull();

    globalWindow.window[OAUTH_BRIDGE] = { take: () => null };
    expect(takeAndroidRedirect()).toBeNull();

    globalWindow.window[OAUTH_BRIDGE] = {
      take: () => {
        throw new Error('the WebView interface threw');
      },
    };
    // A throw across the JavaScript/Kotlin boundary must not stop the app
    // from starting.
    expect(takeAndroidRedirect()).toBeNull();
  });

  it('does not treat a document intent as a redirect', () => {
    globalWindow.window = fakeWindow();
    globalWindow.window[OAUTH_BRIDGE] = { take: () => 'content://downloads/99' };
    expect(takeAndroidRedirect()).toBeNull();
  });
});

describe('readRedirectEvent', () => {
  it('reads the shape MainActivity dispatches', () => {
    expect(readRedirectEvent({ redirect: REDIRECT })).toBe(REDIRECT);
    // And a bare string, in case the detail is ever sent unwrapped.
    expect(readRedirectEvent(REDIRECT)).toBe(REDIRECT);
  });

  it('returns null for anything else', () => {
    expect(readRedirectEvent(null)).toBeNull();
    expect(readRedirectEvent({})).toBeNull();
    expect(readRedirectEvent({ redirect: 'content://x' })).toBeNull();
    expect(readRedirectEvent({ uri: REDIRECT })).toBeNull();
  });
});

describe('onOauthRedirect', () => {
  it('delivers a redirect that was waiting before the page existed', () => {
    // The app can be evicted while the consent screen is open and relaunched
    // by the redirect itself, so the answer is already in the bridge at boot.
    globalWindow.window = fakeWindow();
    globalWindow.window[OAUTH_BRIDGE] = { take: () => REDIRECT };

    const seen: string[] = [];
    const stop = onOauthRedirect((redirect) => seen.push(redirect));
    expect(seen).toEqual([REDIRECT]);
    stop();
  });

  it('delivers one that arrives while the app is already running', () => {
    const win = fakeWindow();
    globalWindow.window = win;

    const seen: string[] = [];
    const stop = onOauthRedirect((redirect) => seen.push(redirect));

    win.dispatchEvent(new CustomEvent(OAUTH_EVENT, { detail: { redirect: REDIRECT } }));
    expect(seen).toEqual([REDIRECT]);

    // Unsubscribing really unsubscribes: the panel unmounts when the dialog
    // closes, and a leaked listener would redeem a code into a dead component.
    stop();
    win.dispatchEvent(new CustomEvent(OAUTH_EVENT, { detail: { redirect: REDIRECT } }));
    expect(seen).toEqual([REDIRECT]);
  });

  it('ignores events that carry something else', () => {
    const win = fakeWindow();
    globalWindow.window = win;
    const seen: string[] = [];
    const stop = onOauthRedirect((redirect) => seen.push(redirect));

    win.dispatchEvent(new CustomEvent(OAUTH_EVENT, { detail: { uri: 'content://x', mime: 'application/pdf' } }));
    win.dispatchEvent(new CustomEvent(OAUTH_EVENT, { detail: null }));
    expect(seen).toEqual([]);
    stop();
  });

  it('is inert with no window at all', () => {
    // The module is imported by tests and by anything server-rendered; it must
    // not reach for a global that is not there.
    expect(() => onOauthRedirect(() => {})()).not.toThrow();
    expect(takeAndroidRedirect()).toBeNull();
  });
});

describe('describeAccount', () => {
  const base: DriveAccountInfo = { ...DISCONNECTED, configured: true };

  it('says what is actually true in each state', () => {
    // A browser is a different kind of "no" from a misbuilt app, and telling
    // a web visitor to rebuild something would be nonsense.
    expect(describeAccount(base, false)).toContain('desktop and Android apps');
    expect(describeAccount({ ...base, configured: false })).toContain('no Google client id');
    expect(describeAccount(base)).toContain('stay on this device');
    expect(describeAccount({ ...base, connected: true, hasDriveAccess: true, account: 'a@b.com' })).toBe(
      'Connected as a@b.com.',
    );
    expect(describeAccount({ ...base, connected: true, hasDriveAccess: true })).toBe('Connected.');
  });

  it('calls out a consent that left Drive unticked', () => {
    // Connected but useless: Google's consent screen lets an individual scope
    // be refused, and without this the only symptom is a 403 on first upload.
    const narrow = { ...base, connected: true, hasDriveAccess: false, account: 'a@b.com' };
    expect(describeAccount(narrow)).toContain('not given access to Drive');
  });
});
