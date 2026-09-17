import { describe, expect, it } from 'vitest';
import { A4_DIMENSIONS } from '../constants';
import {
  currentPageIndex,
  inRange,
  layoutPages,
  pageToContent,
  projectToPage,
  scrollOffsetForPage,
  viewportToPagePoint,
  visibleRange,
} from '../layout';

const pages = [{ dimensions: A4_DIMENSIONS }, { dimensions: A4_DIMENSIONS }, { dimensions: A4_DIMENSIONS }];
const opts = { zoom: 1, gap: 24, padding: 24, containerWidth: 1000 };

describe('layoutPages', () => {
  it('stacks pages vertically with gaps and centres them', () => {
    const { items, totalHeight, totalWidth } = layoutPages(pages, opts);
    expect(items.map((i) => i.top)).toEqual([24, 24 + 1123 + 24, 24 + 2 * (1123 + 24)]);
    expect(items.every((i) => i.left === (1000 - 794) / 2)).toBe(true);
    expect(totalHeight).toBe(24 + 3 * 1123 + 2 * 24 + 24);
    expect(totalWidth).toBe(794 + 48);
  });

  it('scales with zoom and never centres past the padding', () => {
    const { items } = layoutPages(pages, { ...opts, zoom: 0.5 });
    expect(items[0]?.width).toBe(397);
    expect(items[1]?.top).toBe(24 + 561.5 + 24);
    const narrow = layoutPages(pages, { ...opts, zoom: 2, containerWidth: 500 });
    expect(narrow.items[0]?.left).toBe(24);
  });

  it('handles an empty document', () => {
    const { items, totalHeight } = layoutPages([], opts);
    expect(items).toEqual([]);
    expect(totalHeight).toBe(48);
  });
});

describe('visibleRange / currentPageIndex', () => {
  const { items } = layoutPages(pages, opts);

  it('returns the pages intersecting the (overscanned) viewport', () => {
    expect(visibleRange(items, 0, 800, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(items, 1100, 800, 0)).toEqual({ start: 0, end: 1 });
    expect(visibleRange(items, 1100, 800, 800)).toEqual({ start: 0, end: 2 });
    expect(visibleRange(items, 2500, 800, 0)).toEqual({ start: 2, end: 2 });
  });

  it('reports an empty range beyond the content', () => {
    const r = visibleRange(items, 99999, 800, 0);
    expect(r.end).toBeLessThan(r.start);
    expect(inRange(r, 0)).toBe(false);
  });

  it('picks the page under the reference line, else the most visible one', () => {
    expect(currentPageIndex(items, 0, 800)).toBe(0);
    expect(currentPageIndex(items, 1000, 800)).toBe(1); // reference 1320 lies in page 2 (top 1171)
    expect(currentPageIndex(items, 2400, 800)).toBe(2);
    // Reference in the gap between pages 0 and 1 (top 1147..1171): most visible wins.
    expect(currentPageIndex(items, 1147 - 320, 800)).toBe(0);
  });

  it('scrollOffsetForPage aligns the page top below the padding', () => {
    expect(scrollOffsetForPage(items, 0, 24)).toBe(0);
    expect(scrollOffsetForPage(items, 1, 24)).toBe(1171 - 24);
    expect(scrollOffsetForPage(items, 7, 24)).toBe(0);
  });
});

describe('coordinate projection', () => {
  it('maps viewport → page-local units through the page rect and zoom', () => {
    expect(viewportToPagePoint(300, 400, { left: 100, top: 50 }, 2)).toEqual({ x: 100, y: 175 });
    expect(viewportToPagePoint(100, 50, { left: 100, top: 50 }, 0.5)).toEqual({ x: 0, y: 0 });
  });

  it('projects through the scroll container frame and layout item', () => {
    const { items } = layoutPages(pages, opts);
    const item = items[1];
    if (!item) throw new Error('layout');
    const frame = { left: 10, top: 20, scrollLeft: 0, scrollTop: 1500 };
    // content = (203 - 10 + 0, 120 - 20 + 1500) = (193, 1600); page = (193 - 103, 1600 - 1171)
    expect(projectToPage(203, 120, frame, item, 1)).toEqual({ x: 90, y: 429 });
    const zoomed = layoutPages(pages, { ...opts, zoom: 2 }).items[1];
    if (!zoomed) throw new Error('layout');
    const p = projectToPage(203, 120, frame, zoomed, 2);
    expect(pageToContent(p, zoomed, 2)).toEqual({ x: 193, y: 1600 });
  });
});
