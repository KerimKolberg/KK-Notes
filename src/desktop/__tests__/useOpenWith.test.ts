import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_WITH_EVENT, onOpenWith, type OpenWithRequest } from '../openWith';

/**
 * "Open with", when the app is already running.
 *
 * This is the case that was broken, and it was broken by omission rather than
 * by a mistake in any one line: `MainActivity` dispatched the event, and
 * nothing in the page listened for it. The app came to the front showing
 * whatever it had been showing, and the file vanished.
 *
 * So what these tests pin is the *wiring* — that a dispatched event reaches a
 * handler at all — plus the rules around it that are easy to get wrong when
 * reconnecting it: unsaved work is not replaced without asking, a failed open
 * does not navigate away from what the user is looking at, and unsubscribing
 * really unsubscribes.
 */

const globalWindow = globalThis as unknown as {
  window?: {
    addEventListener: (type: string, listener: (event: Event) => void) => void;
    removeEventListener: (type: string, listener: (event: Event) => void) => void;
    dispatchEvent: (event: Event) => boolean;
  } & Record<string, unknown>;
};

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

const PDF: OpenWithRequest = { uri: 'content://com.android.providers.downloads/document/42', mime: 'application/pdf' };

beforeEach(() => {
  globalWindow.window = fakeWindow();
});

afterEach(() => {
  delete globalWindow.window;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('the running-app listener', () => {
  it('delivers an intent that arrives while the app is up', () => {
    // The regression. `onOpenWith` existed and was exported, and for a while
    // nothing imported it; an intent to a running app went nowhere.
    const seen: OpenWithRequest[] = [];
    const stop = onOpenWith((request) => seen.push(request));

    globalWindow.window!.dispatchEvent(new CustomEvent(OPEN_WITH_EVENT, { detail: PDF }));
    expect(seen).toEqual([PDF]);
    stop();
  });

  it('stops delivering once unsubscribed', () => {
    const seen: OpenWithRequest[] = [];
    const stop = onOpenWith((request) => seen.push(request));
    stop();
    globalWindow.window!.dispatchEvent(new CustomEvent(OPEN_WITH_EVENT, { detail: PDF }));
    expect(seen).toEqual([]);
  });

  it('ignores an event carrying something that is not a file', () => {
    const seen: OpenWithRequest[] = [];
    const stop = onOpenWith((request) => seen.push(request));
    globalWindow.window!.dispatchEvent(new CustomEvent(OPEN_WITH_EVENT, { detail: { mime: 'application/pdf' } }));
    globalWindow.window!.dispatchEvent(new CustomEvent(OPEN_WITH_EVENT, { detail: null }));
    expect(seen).toEqual([]);
    stop();
  });
});

describe('handleOpenWith', () => {
  /** Load the module with `boot` and `fileActions` replaced. */
  async function load(options: { dirty?: boolean; opened?: { view: 'document'; path: string | null } | null }) {
    const openRequested = vi.fn().mockResolvedValue(options.opened ?? null);
    const confirmDiscardIfDirty = vi.fn().mockResolvedValue(!options.dirty);
    const openDocument = vi.fn();

    vi.doMock('../boot', () => ({ openRequested }));
    vi.doMock('../fileActions', () => ({ confirmDiscardIfDirty }));
    vi.doMock('../../library/routeStore', () => ({
      useRouteStore: { getState: () => ({ openDocument }) },
    }));
    const { handleOpenWith } = await import('../useOpenWith');
    return { handleOpenWith, openRequested, confirmDiscardIfDirty, openDocument };
  }

  it('opens the file and routes to it', async () => {
    const m = await load({ opened: { view: 'document', path: null } });
    await m.handleOpenWith(PDF);
    expect(m.openRequested).toHaveBeenCalledWith(PDF);
    // A PDF becomes a *new* document, so there is no path to route to — the
    // route still has to change, or the library stays on screen over it.
    expect(m.openDocument).toHaveBeenCalledWith(null);
  });

  it('routes to the path a .notex opened at', async () => {
    const m = await load({ opened: { view: 'document', path: '/sdcard/week 1.notex' } });
    await m.handleOpenWith({ uri: '/sdcard/week 1.notex', mime: '' });
    expect(m.openDocument).toHaveBeenCalledWith('/sdcard/week 1.notex');
  });

  it('asks before replacing unsaved work, and obeys a refusal', async () => {
    // Someone mid-page who taps a PDF in another app has two things they care
    // about, and the one already on screen is the one that cannot be recovered.
    const m = await load({ dirty: true, opened: { view: 'document', path: null } });
    await m.handleOpenWith(PDF);
    expect(m.confirmDiscardIfDirty).toHaveBeenCalled();
    expect(m.openRequested).not.toHaveBeenCalled();
    expect(m.openDocument).not.toHaveBeenCalled();
  });

  it('stays put when the file could not be opened', async () => {
    // `openRequested` raises its own notice and returns null. Navigating
    // anyway would swap the user's document for an empty one to show them a
    // failure.
    const m = await load({ opened: null });
    await m.handleOpenWith(PDF);
    expect(m.openRequested).toHaveBeenCalled();
    expect(m.openDocument).not.toHaveBeenCalled();
  });
});
