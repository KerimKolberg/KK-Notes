import { useEffect } from 'react';
import { useDocumentStore } from '../document/store';
import type { InkText, InkWord, Page } from '../document/types';
import { isPenNearby } from '../inking/engine/gestureState';
import { usePreferencesStore } from '../preferences/store';
import { DEFAULT_RECOGNIZER, inkKey, inkTextIsCurrent, inReadingOrder, MAX_INK_WORDS, recognizerInput } from './inkText';
import { checkRecognizers, recognizeInk, useRecognizerStore } from './recognizer';

/** Quiet this long — no pen, no tap, no key, no edit — before a page is read. */
export const IDLE_MS = 1500;
/** Between one page and the next, so a note full of handwriting is read a page at a time, not in one go. */
export const BETWEEN_PAGES_MS = 120;
/** Failures in a row before reading stops for the session (a recogniser that cannot read anything). */
export const MAX_FAILURES = 3;

/** The pages to read, the one in view first and then outwards from it, so what is being looked at is found first. */
export function nextToRead(pages: readonly Page[], active: number, by: string, skip: ReadonlyMap<string, string>): Page | null {
  for (let d = 0; d < pages.length; d++) {
    for (const i of d === 0 ? [active] : [active + d, active - d]) {
      const page = pages[i];
      if (!page || inkTextIsCurrent(page, by)) continue;
      if (skip.get(page.id) === inkKey(page.strokes)) continue;
      return page;
    }
  }
  return null;
}

export interface ReaderOptions {
  /** The recogniser to read with, by name; `null` for the system's own pick. */
  readonly recognizer: string | null;
  /** Reads one page's handwriting (see `recognizerInput`). */
  readonly recognize: (strokes: { points: number[] }[], recognizer: string | null) => Promise<InkWord[]>;
  /** Whether a pen is near the screen, which holds reading off as writing does. */
  readonly penNearby?: () => boolean;
  /** Told when a page could not be read, and whether reading has stopped because of it. */
  readonly onError?: (message: string, stopped: boolean) => void;
  /** Told when a page has been read. */
  readonly onRead?: () => void;
}

/**
 * Keep the open note's handwriting read: start reading, and get back the function that stops it.
 *
 * A page is read again whenever its handwriting changes — a fingerprint of its pen strokes is kept with the words
 * (`inkText.ts`) — but only once everything has been still for a moment and no pen is near, so reading never competes
 * with writing; and one page at a time, the one in view first. What is read is put on the page without marking the
 * note as changed (`setPageInkText`): opening an old note to have its handwriting read does not ask to be saved, and
 * the words go to disk with the next save. Writing that went on while a page was being read is not overwritten by
 * the older reading; the page is read again.
 */
export function startHandwritingReader(options: ReaderOptions): () => void {
  const { recognizer, recognize, penNearby = isPenNearby, onError, onRead } = options;
  const by = recognizer ?? DEFAULT_RECOGNIZER;
  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastActivity = performance.now();
  let failures = 0;
  /** Page id → the handwriting that would not read, so it is not tried again until it changes. */
  const failed = new Map<string, string>();
  /** True while the reader itself is putting words on a page: that is not someone at work. */
  let own = false;
  const put = (pageId: string, inkText: InkText | null): void => {
    own = true;
    try {
      useDocumentStore.getState().setPageInkText(pageId, inkText);
    } finally {
      own = false;
    }
  };

  const schedule = (delay: number): void => {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => void run(), Math.max(0, delay));
  };
  const touched = (): void => {
    lastActivity = performance.now();
    schedule(IDLE_MS);
  };

  async function run(): Promise<void> {
    timer = null;
    if (stopped || busy) return;
    const quiet = performance.now() - lastActivity;
    if (quiet < IDLE_MS || penNearby()) {
      schedule(Math.max(200, IDLE_MS - quiet));
      return;
    }
    const { document } = useDocumentStore.getState();
    const page = nextToRead(document.pages, document.activePageIndex, by, failed);
    if (!page) return;
    const key = inkKey(page.strokes);
    if (key === '') {
      // The handwriting is gone: so are its words.
      put(page.id, null);
      schedule(0);
      return;
    }
    busy = true;
    try {
      const words = await recognize(recognizerInput(page.strokes), recognizer);
      failures = 0;
      const now = useDocumentStore.getState().document.pages.find((p) => p.id === page.id);
      if (!stopped && now && inkKey(now.strokes) === key) {
        put(page.id, { key, by, words: inReadingOrder(words).slice(0, MAX_INK_WORDS) });
        onRead?.();
      }
    } catch (error) {
      failed.set(page.id, key);
      failures += 1;
      const halt = failures >= MAX_FAILURES;
      if (halt) stopped = true;
      onError?.(error instanceof Error ? error.message : String(error), halt);
    } finally {
      busy = false;
    }
    schedule(BETWEEN_PAGES_MS);
  }

  // Writing, tapping and typing hold reading off; so does any edit (which is also what makes a page need reading).
  const unsubscribe = useDocumentStore.subscribe((state, previous) => {
    if (own) return;
    if (state.document.pages !== previous.document.pages || state.document.activePageIndex !== previous.document.activePageIndex) touched();
  });
  const listen = typeof window !== 'undefined';
  if (listen) {
    window.addEventListener('pointerdown', touched, true);
    window.addEventListener('keydown', touched, true);
  }
  schedule(IDLE_MS);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    unsubscribe();
    if (listen) {
      window.removeEventListener('pointerdown', touched, true);
      window.removeEventListener('keydown', touched, true);
    }
  };
}

/** Reads the open note's handwriting wherever the device can, while handwriting search is on (see above). */
export function useHandwritingReader(): void {
  const enabled = usePreferencesStore((s) => s.handwritingSearch);
  const chosen = usePreferencesStore((s) => s.handwritingRecognizer);
  const status = useRecognizerStore((s) => s.status);
  const names = useRecognizerStore((s) => s.names);

  useEffect(() => {
    if (enabled) void checkRecognizers();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || status !== 'ready') return;
    // A recogniser that has been uninstalled since it was chosen: Windows' own pick reads instead.
    const recognizer = chosen && names.includes(chosen) ? chosen : null;
    return startHandwritingReader({
      recognizer,
      recognize: recognizeInk,
      onRead: () => {
        if (useRecognizerStore.getState().error) useRecognizerStore.setState({ error: null });
      },
      onError: (message, stopped) => useRecognizerStore.setState(stopped ? { status: 'failed', error: message } : { error: message }),
    });
  }, [enabled, status, chosen, names]);
}
