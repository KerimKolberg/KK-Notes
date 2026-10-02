/**
 * The contents list of a note made from PDFs: each PDF's own table of contents, pointed at the note's pages.
 *
 * A note is not its PDF. Pages may have been reordered, deleted, or had blank pages put between them, and a
 * note can hold pages of several PDFs. So an entry's page in the PDF is looked up among the note's pages — the
 * first page made from it — and an entry whose page is no longer in the note is still listed, but leads nowhere.
 *
 * Pure: pages and outlines in, rows out.
 */
import type { OutlineItem } from '../pdf/outline';
import type { Page, PdfPageRef } from './types';

/** A PDF some of the note's pages were made from. */
export interface ContentsSource {
  readonly sourceId: string;
  readonly name: string;
  /** Enough to read its outline. */
  readonly ref: Pick<PdfPageRef, 'sourceId' | 'data'>;
}

/** One line of the list. */
export interface ContentsRow {
  /** Its position in the outline (`0.2.1`), unique within one source. */
  readonly key: string;
  readonly title: string;
  readonly depth: number;
  /** The note's page it leads to, or `null` when that page is not in the note (or the entry points nowhere). */
  readonly pageIndex: number | null;
  /** How far down that page, in page units. */
  readonly within: number;
  readonly hasChildren: boolean;
  /** The keys of the rows it is nested under, outermost first. */
  readonly ancestors: readonly string[];
}

/** The PDFs the note's pages came from, in the order they first appear. */
export function pdfSourcesOf(pages: readonly Pick<Page, 'pdf'>[]): ContentsSource[] {
  const seen = new Map<string, ContentsSource>();
  for (const page of pages) {
    const pdf = page.pdf;
    if (!pdf || seen.has(pdf.sourceId)) continue;
    seen.set(pdf.sourceId, { sourceId: pdf.sourceId, name: pdf.sourceName, ref: { sourceId: pdf.sourceId, data: pdf.data } });
  }
  return [...seen.values()];
}

/** How far down a note's page a PDF user-space y is, in page units; the top for a page shown turned. */
export function withinPage(pdf: Pick<PdfPageRef, 'viewBox' | 'rotation' | 'scale'>, top: number | null, pageHeight: number): number {
  if (top === null || pdf.rotation % 360 !== 0) return 0;
  const y = (pdf.viewBox[3] - top) * pdf.scale;
  return Math.min(Math.max(0, y), Math.max(0, pageHeight));
}

/** One source's outline as rows, each pointed at the note's page made from its page of the PDF. */
export function contentsRows(
  outline: readonly OutlineItem[],
  pages: readonly Pick<Page, 'pdf' | 'dimensions'>[],
  sourceId: string,
): ContentsRow[] {
  const firstPage = new Map<number, number>();
  pages.forEach((page, index) => {
    if (page.pdf?.sourceId === sourceId && !firstPage.has(page.pdf.pageIndex)) firstPage.set(page.pdf.pageIndex, index);
  });
  const rows: ContentsRow[] = [];
  const walk = (items: readonly OutlineItem[], depth: number, prefix: string, ancestors: readonly string[]): void => {
    items.forEach((item, i) => {
      const key = prefix ? `${prefix}.${i}` : String(i);
      const pageIndex = item.pdfPageIndex === null ? null : (firstPage.get(item.pdfPageIndex) ?? null);
      const page = pageIndex === null ? undefined : pages[pageIndex];
      rows.push({
        key,
        title: item.title,
        depth,
        pageIndex,
        within: page?.pdf ? withinPage(page.pdf, item.top, page.dimensions.height) : 0,
        hasChildren: item.items.length > 0,
        ancestors,
      });
      walk(item.items, depth + 1, key, [...ancestors, key]);
    });
  };
  walk(outline, 0, '', []);
  return rows;
}

/** Above this many rows, the list opens with only its first two levels showing. */
export const OPEN_ALL_BELOW = 40;

/** The rows that start folded away: in a long list, everything nested under the second level. */
export function initiallyCollapsed(rows: readonly ContentsRow[]): Set<string> {
  if (rows.length <= OPEN_ALL_BELOW) return new Set();
  return new Set(rows.filter((r) => r.hasChildren && r.depth >= 1).map((r) => r.key));
}

/** The rows to show, given which are folded. */
export function visibleRows(rows: readonly ContentsRow[], collapsed: ReadonlySet<string>): ContentsRow[] {
  if (collapsed.size === 0) return [...rows];
  return rows.filter((r) => !r.ancestors.some((a) => collapsed.has(a)));
}

/**
 * The entry the reader is in: the last one, in outline order, that starts at or before the page in view. Outlines
 * are in reading order, so that is the chapter the page belongs to.
 */
export function currentRow(rows: readonly ContentsRow[], pageIndex: number): string | null {
  let current: string | null = null;
  let best = -1;
  for (const row of rows) {
    if (row.pageIndex === null || row.pageIndex > pageIndex) continue;
    if (row.pageIndex >= best) {
      best = row.pageIndex;
      current = row.key;
    }
  }
  return current;
}
