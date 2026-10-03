import { useDocumentStore } from '../document/store';
import { useToolStore } from '../document/toolStore';
import type { InkWord } from '../document/types';
import { inReadingOrder } from '../handwriting/inkText';
import { useFlashStore, type FlashBox } from './flashStore';
import { fold, queryWords, type TextKind } from './text';

/** Where a piece of found text is, in the note that is open. */
export interface RevealTarget {
  readonly pageIndex: number;
  readonly pageId: string;
  readonly mediaId: string | null;
  readonly kind?: TextKind;
  /** Where on the page to point (page units), for a match with no object to select: a handwritten word. */
  readonly box?: FlashBox | null;
}

/** How far above a pointed-at word the view starts, in page units, so it is not hard against the top. */
const ABOVE = 60;

/** The first word on a page that holds the first word of a query. */
export function inkWordFor(words: readonly InkWord[], query: string): InkWord | null {
  const first = queryWords(query)[0];
  if (!first) return null;
  return inReadingOrder(words).find((w) => fold(w.text).text.includes(first)) ?? null;
}

/**
 * Take the reader to something found: its page, and for an object on the page, the object itself
 * selected. Objects can only be picked with the select tool, so that becomes the tool. Handwriting has
 * no object to select, so the word is scrolled to and marked for a moment instead.
 *
 * Read from the stores rather than passed in, so it works from the library's results as well as from
 * the panel inside a note. A handwriting match from the library comes without its word's place; `query`
 * finds it on the page.
 */
export function revealText(target: RevealTarget, query?: string): void {
  if (target.pageIndex < 0) return;
  const doc = useDocumentStore.getState();
  let box: FlashBox | null = target.box ?? null;
  if (!box && target.kind === 'ink' && query) {
    const words = doc.document.pages[target.pageIndex]?.inkText?.words;
    box = words ? inkWordFor(words, query) : null;
  }
  if (box) {
    const page = doc.document.pages[target.pageIndex];
    doc.jumpToPage(target.pageIndex, Math.max(0, box.y - ABOVE));
    if (page) useFlashStore.getState().show(page.id, { x: box.x, y: box.y, width: box.width, height: box.height });
    return;
  }
  doc.jumpToPage(target.pageIndex);
  if (target.mediaId) {
    useToolStore.getState().update({ tool: 'select' });
    doc.selectMedia({ pageId: target.pageId, mediaId: target.mediaId });
  }
}
