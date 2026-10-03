/**
 * Where the text of a PDF page is on a note's page, for selecting it.
 *
 * Read with PDF.js from the file it already holds parsed, and kept for the pages read most recently: selecting
 * reads the page under the pointer at every move, and the text of a page does not change.
 */
import type { PdfPageRef } from '../document/types';
import { runsFromItems, type RawTextItem, type RawTextStyle, type TextRun } from '../textselect/geometry';
import { pdfPointToPage } from './pdfCoords';
import { SourceCache } from './sourceCache';

const cache = new SourceCache<readonly TextRun[]>(60);

/** The text runs of the PDF page behind a note's page, in that page's units. */
export function pdfPageTextRuns(ref: PdfPageRef): Promise<readonly TextRun[]> {
  const key = `${ref.pageIndex}:${ref.scale}:${ref.rotation}:${ref.viewBox.join(',')}`;
  return cache.get(ref.sourceId, key, async () => {
    const { getPdfDocument } = await import('./pdfRenderer');
    const doc = await getPdfDocument(ref);
    const page = await doc.getPage(ref.pageIndex + 1);
    const content = await page.getTextContent();
    return runsFromItems(
      content.items as readonly RawTextItem[],
      (content.styles ?? {}) as Readonly<Record<string, RawTextStyle>>,
      (x, y) => pdfPointToPage(x, y, ref.viewBox, ref.rotation, ref.scale),
    );
  });
}
