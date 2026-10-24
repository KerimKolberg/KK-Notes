import { beforeEach, describe, expect, it } from 'vitest';
import {
  createDocument,
  createPage,
  duplicatePagesAt,
  formatPageList,
  groupDropStart,
  movePagesTo,
  normalizeIndices,
  parsePageList,
  removePages,
} from '../operations';
import { useDocumentStore } from '../store';

/** Page n is called "n", so a list of names reads as the page order. */
function named(n: number) {
  return createDocument(n).pages.map((p, i) => ({ ...p, id: String(i + 1) }));
}
const ids = (pages: readonly { id: string }[]) => pages.map((p) => p.id);

describe('picking several pages', () => {
  it('reads page numbers as typed, and writes them back the same way', () => {
    expect(parsePageList('2, 15, 20-25, 73', 100)).toEqual([1, 14, 19, 20, 21, 22, 23, 24, 72]);
    expect(parsePageList('5–3 3 ;9', 10)).toEqual([2, 3, 4, 8]);
    expect(parsePageList('0, 4, 120', 10)).toEqual([3]);
    expect(parsePageList('98-1000000000', 100)).toEqual([97, 98, 99]);
    expect(parsePageList('2, seven', 10)).toBeNull();
    expect(parsePageList('  ', 10)).toBeNull();
    expect(formatPageList([72, 1, 14, 19, 20, 21, 22, 23, 24])).toBe('2, 15, 20–25, 73');
    expect(formatPageList([0, 1, 4])).toBe('1, 2, 5');
    expect(formatPageList([])).toBe('');
    expect(normalizeIndices([3, 1, 3, -1, 9, 2.7], 5)).toEqual([1, 2, 3]);
  });

  it('gathers pages, in their order, at a place counted in the result', () => {
    const pages = named(8);
    expect(ids(movePagesTo(pages, [1, 4, 6], 0))).toEqual(['2', '5', '7', '1', '3', '4', '6', '8']);
    expect(ids(movePagesTo(pages, [6, 1, 4], 5))).toEqual(['1', '3', '4', '6', '8', '2', '5', '7']);
    expect(ids(movePagesTo(pages, [0, 7], 3))).toEqual(['2', '3', '4', '1', '8', '5', '6', '7']);
    expect(movePagesTo(pages, [1, 4], 99).map((p) => p.pageNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('lands a dragged group where one page dragged alone would', () => {
    const pages = named(8);
    // Pages 2 and 5 dragged by page 2 onto page 7 (down): after page 7.
    const down = groupDropStart([1, 4], 1, 6);
    expect(ids(movePagesTo(pages, [1, 4], down!))).toEqual(['1', '3', '4', '6', '7', '2', '5', '8']);
    // Dragged by page 5 onto page 1 (up): before page 1.
    const up = groupDropStart([1, 4], 4, 0);
    expect(ids(movePagesTo(pages, [1, 4], up!))).toEqual(['2', '5', '1', '3', '4', '6', '7', '8']);
    expect(groupDropStart([1, 4], 1, 4)).toBeNull();
  });

  it('deletes several pages but never all of them, and copies each beside itself', () => {
    const pages = named(5);
    expect(ids(removePages(pages, [0, 3])!)).toEqual(['2', '3', '5']);
    expect(removePages(pages, [0, 1, 2, 3, 4])).toBeNull();
    const copied = duplicatePagesAt(pages, [1, 3]);
    expect(copied.map((p) => p.id).filter((id) => id.length === 1)).toEqual(['1', '2', '3', '4', '5']);
    expect(copied[2]!.id).not.toBe('2');
    expect(copied[2]!.template).toBe(pages[1]!.template);
    expect(copied.map((p) => p.pageNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('changing several pages in the note', () => {
  const s = () => useDocumentStore.getState();
  const doc = () => s().document;
  beforeEach(() => {
    s().setReadOnly(false);
    s().newDocument();
    s().appendPages(Array.from({ length: 9 }, () => createPage({}, 1)));
  });

  it('deletes pages 2, 5 and 9 as one step, and Undo brings them all back', () => {
    const before = ids(doc().pages);
    s().jumpToPage(5);
    const reading = before[5];
    s().deletePages([1, 4, 8]);
    expect(ids(doc().pages)).toEqual(before.filter((_, i) => ![1, 4, 8].includes(i)));
    expect(doc().pages[doc().activePageIndex]!.id).toBe(reading);
    expect(s().undoLast()).toBe('deleting 3 pages');
    expect(ids(doc().pages)).toEqual(before);
  });

  it('stays at the place of the page being read when it goes too', () => {
    s().jumpToPage(4);
    s().deletePages([1, 4]);
    expect(doc().activePageIndex).toBe(3);
  });

  it('will not delete every page', () => {
    s().deletePages(doc().pages.map((_, i) => i));
    expect(doc().pages.length).toBe(10);
  });

  it('moves and copies several pages as one step each', () => {
    const before = ids(doc().pages);
    s().movePages([3, 7], 0);
    expect(ids(doc().pages).slice(0, 2)).toEqual([before[3], before[7]]);
    expect(s().undoLast()).toBe('moving 2 pages');
    expect(ids(doc().pages)).toEqual(before);

    s().duplicatePages([0, 2]);
    expect(doc().pages.length).toBe(12);
    expect(doc().activePageIndex).toBe(1);
    expect(s().undoLast()).toBe('duplicating 2 pages');
    expect(ids(doc().pages)).toEqual(before);
  });

  it('gives the picked pages a template and colour, and leaves the rest alone', () => {
    s().setPageTemplate([1, 3], 'grid');
    s().setPageBackground([1, 3], '#fff8e1');
    s().setTemplateConfig([3], { spacing: 30 });
    expect(doc().pages.map((p) => p.template)).toEqual(['blank', 'grid', 'blank', 'grid', ...Array(6).fill('blank')]);
    expect(doc().pages.filter((p) => p.backgroundColor === '#fff8e1').length).toBe(2);
    expect(doc().pages[3]!.templateConfig.spacing).toBe(30);
    expect(doc().pages[1]!.templateConfig.spacing).not.toBe(30);
  });

  it('changes nothing in a locked note', () => {
    s().setReadOnly(true);
    const before = ids(doc().pages);
    s().deletePages([1, 2]);
    s().movePages([4], 0);
    s().duplicatePages([0]);
    expect(ids(doc().pages)).toEqual(before);
  });
});
