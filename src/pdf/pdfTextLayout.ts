/**
 * Where the text of a PDF page is on a note's page, for selecting it.
 *
 * Read with PDF.js from the file it already holds parsed, and kept for the pages read most recently: selecting
 * reads the page under the pointer at every move, and the text of a page does not change.
 */
import type { PdfPageRef } from '../document/types';
import { runsFromItems, type RawTextItem, type RawTextStyle, type TextRun } from '../textselect/geometry';
import { pdfPointToPage } from './pdfCoords';

const MAX_CACHED_PAGES = 60;
const cache = new Map<string, Promise<readonly TextRun[]>>();

function keyOf(ref: PdfPageRef): string {
  return `${ref.sourceId}:${ref.pageIndex}:${ref.scale}:${ref.rotation}:${ref.viewBox.join(',')}`;
}

/** The text runs of the PDF page behind a note's page, in that page's units. */
export function pdfPageTextRuns(ref: PdfPageRef): Promise<readonly TextRun[]> {
  const key = keyOf(ref);
  const cached = cache.get(key);
  if (cached) {
    // Most recently used last, so the oldest is the one let go.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const pending = (async () => {
    const { getPdfDocument } = await import('./pdfRenderer');
    const doc = await getPdfDocument(ref);
    const page = await doc.getPage(ref.pageIndex + 1);
    const content = await page.getTextContent();
    return runsFromItems(
      content.items as readonly RawTextItem[],
      (content.styles ?? {}) as Readonly<Record<string, RawTextStyle>>,
      (x, y) => pdfPointToPage(x, y, ref.viewBox, ref.rotation, ref.scale),
    );
  })();
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  if (cache.size > MAX_CACHED_PAGES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return pending;
}
