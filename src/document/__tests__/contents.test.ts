import { describe, expect, it } from 'vitest';
import type { OutlineItem } from '../../pdf/outline';
import { contentsRows, currentRow, initiallyCollapsed, OPEN_ALL_BELOW, pdfSourcesOf, visibleRows, withinPage } from '../contents';
import { createPage } from '../operations';
import type { Page, PdfPageRef } from '../types';

const data = new ArrayBuffer(4);

function pdfRef(sourceId: string, pageIndex: number, extra: Partial<PdfPageRef> = {}): PdfPageRef {
  return { sourceId, sourceName: `${sourceId}.pdf`, data, pageCount: 10, pageIndex, viewBox: [0, 0, 600, 800], rotation: 0, scale: 1.25, ...extra };
}

function pdfPage(sourceId: string, pageIndex: number, extra: Partial<PdfPageRef> = {}): Page {
  return { ...createPage({ dimensions: { width: 750, height: 1000 } }), template: 'pdf', pdf: pdfRef(sourceId, pageIndex, extra) };
}

const blank = (): Page => createPage();

const item = (title: string, pdfPageIndex: number | null, items: OutlineItem[] = [], top: number | null = null): OutlineItem => ({ title, pdfPageIndex, top, items });

describe('pdfSourcesOf', () => {
  it('lists each PDF once, in the order its pages first appear, and skips plain pages', () => {
    const sources = pdfSourcesOf([blank(), pdfPage('b', 0), pdfPage('a', 0), pdfPage('b', 1), blank()]);
    expect(sources.map((s) => [s.sourceId, s.name])).toEqual([['b', 'b.pdf'], ['a', 'a.pdf']]);
    expect(sources[0]!.ref.data).toBe(data);
  });
});

describe('withinPage', () => {
  it('turns a PDF y (from the bottom, in points) into page units down from the top', () => {
    expect(withinPage(pdfRef('a', 0), 800, 1000)).toBe(0);
    expect(withinPage(pdfRef('a', 0), 400, 1000)).toBe(500);
    expect(withinPage(pdfRef('a', 0), null, 1000)).toBe(0);
  });
  it('stays on the page, and is the top for a turned page', () => {
    expect(withinPage(pdfRef('a', 0), -100, 1000)).toBe(1000);
    expect(withinPage(pdfRef('a', 0), 900, 1000)).toBe(0);
    expect(withinPage(pdfRef('a', 0, { rotation: 90 }), 400, 1000)).toBe(0);
  });
});

describe('contentsRows', () => {
  it('points each entry at the first page of the note made from its page of the PDF', () => {
    // Blank pages between, page 1 of the PDF twice, page 2 deleted.
    const pages = [pdfPage('a', 0), blank(), pdfPage('a', 1), pdfPage('a', 1), pdfPage('a', 3), pdfPage('other', 2)];
    const rows = contentsRows(
      [item('Intro', 0), item('Part one', 1, [item('Deleted', 2), item('Later', 3, [], 400)]), item('Link', null)],
      pages,
      'a',
    );
    expect(rows.map((r) => [r.key, r.title, r.depth, r.pageIndex])).toEqual([
      ['0', 'Intro', 0, 0],
      ['1', 'Part one', 0, 2],
      ['1.0', 'Deleted', 1, null],
      ['1.1', 'Later', 1, 4],
      ['2', 'Link', 0, null],
    ]);
    expect(rows[1]!.hasChildren).toBe(true);
    expect(rows[3]!.ancestors).toEqual(['1']);
    expect(rows[3]!.within).toBe(500);
  });

  it('does not take a page of another PDF with the same page number', () => {
    const rows = contentsRows([item('Two', 2)], [pdfPage('other', 2)], 'a');
    expect(rows[0]!.pageIndex).toBeNull();
  });
});

describe('folding and the current chapter', () => {
  const rows = contentsRows(
    [item('A', 0, [item('A.1', 1, [item('A.1.a', 1)])]), item('B', 3, [item('B.1', 4)])],
    [0, 1, 2, 3, 4].map((i) => pdfPage('a', i)),
    'a',
  );

  it('opens a short list fully and a long one to its second level', () => {
    expect(initiallyCollapsed(rows).size).toBe(0);
    const many: OutlineItem[] = Array.from({ length: OPEN_ALL_BELOW }, (_, i) => item(`S${i}`, 0, [item(`S${i}.1`, 0, [item('deep', 0)])]));
    const long = contentsRows(many, [pdfPage('a', 0)], 'a');
    const folded = initiallyCollapsed(long);
    expect(folded.has('0')).toBe(false);
    expect(folded.has('0.0')).toBe(true);
    expect(visibleRows(long, folded).some((r) => r.title === 'deep')).toBe(false);
    expect(visibleRows(long, folded).some((r) => r.title === 'S0.1')).toBe(true);
  });

  it('hides what is under a folded row', () => {
    expect(visibleRows(rows, new Set(['0'])).map((r) => r.title)).toEqual(['A', 'B', 'B.1']);
  });

  it('marks the last entry starting at or before the page in view', () => {
    expect(currentRow(rows, 0)).toBe('0');
    expect(currentRow(rows, 1)).toBe('0.0.0');
    expect(currentRow(rows, 2)).toBe('0.0.0');
    expect(currentRow(rows, 3)).toBe('1');
    expect(currentRow(rows, 4)).toBe('1.0');
  });
});
