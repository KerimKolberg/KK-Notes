/**
 * The words of a PDF page, for searching it.
 *
 * Read with PDF.js (`getTextContent`), which is already loaded for drawing the page and keeps the
 * document parsed, so this costs a page's worth of text layout and nothing to open. Cached by page
 * (`sourceCache.ts`), because a search reads the same pages again with every letter typed.
 */
import type { PdfPageRef } from '../document/types';
import { SourceCache } from './sourceCache';

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

const cache = new SourceCache<string>(400);

export function pdfPageText(ref: PdfPageRef): Promise<string> {
  return cache.get(ref.sourceId, String(ref.pageIndex), async () => {
    const { getPdfDocument } = await import('./pdfRenderer');
    const doc = await getPdfDocument(ref);
    const page = await doc.getPage(ref.pageIndex + 1);
    const content = await page.getTextContent();
    return joinTextItems(content.items as readonly TextItemLike[]);
  });
}
