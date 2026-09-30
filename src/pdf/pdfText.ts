/**
 * The words of a PDF page, for searching it.
 *
 * Read with PDF.js (`getTextContent`), which is already loaded for drawing the page and keeps the
 * document parsed, so this costs a page's worth of text layout and nothing to open. Cached by page,
 * because a search reads the same pages again with every letter typed.
 */
import type { PdfPageRef } from '../document/types';

interface TextItemLike {
  readonly str?: string;
  readonly hasEOL?: boolean;
}

/**
 * The page's text as one string: the pieces PDF.js hands back, with a space wherever a line ended. (Most
 * PDFs carry their spaces as pieces of their own; the ones that do not would otherwise run every line's
 * last word into the next line's first.)
 */
export function joinTextItems(items: readonly TextItemLike[]): string {
  let out = '';
  for (const item of items) {
    if (typeof item.str === 'string') out += item.str;
    if (item.hasEOL && !out.endsWith(' ')) out += ' ';
  }
  return out.replace(/\s+/g, ' ').trim();
}

const MAX_CACHED_PAGES = 400;
const cache = new Map<string, Promise<string>>();

function keyOf(ref: Pick<PdfPageRef, 'sourceId' | 'pageIndex'>): string {
  return `${ref.sourceId}:${ref.pageIndex}`;
}

export function pdfPageText(ref: PdfPageRef): Promise<string> {
  const key = keyOf(ref);
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const { getPdfDocument } = await import('./pdfRenderer');
    const doc = await getPdfDocument(ref);
    const page = await doc.getPage(ref.pageIndex + 1);
    const content = await page.getTextContent();
    return joinTextItems(content.items as readonly TextItemLike[]);
  })();
  cache.set(key, pending);
  // A failed read is not remembered: the next search tries again.
  pending.catch(() => cache.delete(key));
  if (cache.size > MAX_CACHED_PAGES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return pending;
}

/** Forget a source's pages, when it is released. */
export function releasePdfText(sourceId: string): void {
  const prefix = `${sourceId}:`;
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

/** How many pages' text is held, for tests. */
export function cachedPdfTexts(): number {
  return cache.size;
}
