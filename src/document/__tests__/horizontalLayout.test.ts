/**
 * Horizontal continuous mode: pages advance along x, so every scroll-related
 * helper has to switch axis, and a pointer anywhere in the strip must still
 * project onto the right page's local coordinates.
 */
import { describe, expect, it } from 'vitest';
import { PAGE_GAP, VIEWER_PADDING } from '../constants';
import { anchorForContentPoint, scrollForAnchor } from '../gestures';
import {
  COVER_INDEX,
  currentPageIndex,
  itemAtContent,
  layoutPages,
  mainScroll,
  mainSize,
  mainStart,
  pageToContent,
  projectToPage,
  scrollOffsetForPage,
  visibleRange,
} from '../layout';

const A4 = { width: 794, height: 1123 };
const pages = [{ dimensions: A4 }, { dimensions: A4 }, { dimensions: A4 }];
const base = { zoom: 1, gap: PAGE_GAP, padding: VIEWER_PADDING, containerWidth: 1280, containerHeight: 900 };
const horizontal = layoutPages(pages, { ...base, axis: 'x' });
const vertical = layoutPages(pages, base);

describe('horizontal layout', () => {
  it('advances along x and centres the pages vertically', () => {
    expect(horizontal.axis).toBe('x');
    const [first, second, third] = horizontal.items;
    expect(first!.left).toBe(VIEWER_PADDING);
    expect(second!.left).toBe(VIEWER_PADDING + A4.width + PAGE_GAP);
    expect(third!.left).toBe(VIEWER_PADDING + (A4.width + PAGE_GAP) * 2);
    // Same top for every page; the strip is one row.
    expect(new Set(horizontal.items.map((i) => i.top)).size).toBe(1);
    expect(first!.top).toBe(VIEWER_PADDING); // container shorter than the page
    expect(horizontal.totalWidth).toBe(VIEWER_PADDING * 2 + A4.width * 3 + PAGE_GAP * 2);
    expect(horizontal.totalHeight).toBe(A4.height + VIEWER_PADDING * 2);
  });

  it('centres a short page in a tall viewport', () => {
    const short = layoutPages([{ dimensions: { width: 400, height: 300 } }], { ...base, axis: 'x', containerHeight: 900 });
    expect(short.items[0]!.top).toBe((900 - 300) / 2);
  });

  it('scales with the zoom like the vertical layout', () => {
    const zoomed = layoutPages(pages, { ...base, axis: 'x', zoom: 2 });
    expect(zoomed.items[1]!.left).toBe(VIEWER_PADDING + A4.width * 2 + PAGE_GAP);
    expect(zoomed.items[1]!.width).toBe(A4.width * 2);
  });

  it('reads offsets along the right axis', () => {
    const item = horizontal.items[1]!;
    expect(mainStart(item, 'x')).toBe(item.left);
    expect(mainSize(item, 'x')).toBe(item.width);
    expect(mainStart(vertical.items[1]!, 'y')).toBe(vertical.items[1]!.top);
    expect(mainScroll({ scrollLeft: 120, scrollTop: 30 }, 'x')).toBe(120);
    expect(mainScroll({ scrollLeft: 120, scrollTop: 30 }, 'y')).toBe(30);
  });

  it('virtualises by horizontal position', () => {
    expect(visibleRange(horizontal.items, 0, 1280, 0, 'x')).toEqual({ start: 0, end: 1 });
    expect(visibleRange(horizontal.items, 900, 1280, 0, 'x')).toEqual({ start: 1, end: 2 });
    expect(visibleRange(horizontal.items, 1700, 1280, 0, 'x')).toEqual({ start: 2, end: 2 });
    expect(visibleRange(horizontal.items, 99999, 1280, 0, 'x')).toEqual({ start: 0, end: -1 });
    // The same offsets mean nothing on the other axis.
    expect(visibleRange(horizontal.items, 1700, 1280, 0, 'y')).toEqual({ start: 0, end: -1 });
  });

  it('tracks the current page and scrolls to one horizontally', () => {
    expect(currentPageIndex(horizontal.items, 0, 1280, 'x')).toBe(0);
    expect(currentPageIndex(horizontal.items, 900, 1280, 'x')).toBe(1);
    expect(currentPageIndex(horizontal.items, 1800, 1280, 'x')).toBe(2);
    expect(scrollOffsetForPage(horizontal.items, 0, VIEWER_PADDING, 'x')).toBe(0);
    expect(scrollOffsetForPage(horizontal.items, 2, VIEWER_PADDING, 'x')).toBe(horizontal.items[2]!.left - VIEWER_PADDING);
  });

  it('finds the page under a content point along x, gaps included', () => {
    const second = horizontal.items[1]!;
    expect(itemAtContent(horizontal.items, { x: second.left + 5, y: 0 }, 'x')?.index).toBe(1);
    expect(itemAtContent(horizontal.items, { x: second.left - 6, y: 0 }, 'x')?.index).toBe(1);
    expect(itemAtContent(horizontal.items, { x: -500, y: 0 }, 'x')?.index).toBe(0);
    expect(itemAtContent(horizontal.items, { x: 1e9, y: 0 }, 'x')?.index).toBe(2);
  });
});

describe('pointer projection in horizontal mode', () => {
  const frame = { left: 0, top: 64, scrollLeft: 1000, scrollTop: 0 };

  it('projects a viewport point onto the page under it', () => {
    const second = horizontal.items[1]!;
    // Aim at page-local (120, 240) of page 2.
    const clientX = second.left + 120 - frame.scrollLeft + frame.left;
    const clientY = second.top + 240 - frame.scrollTop + frame.top;
    const point = projectToPage(clientX, clientY, frame, second, 1);
    expect(point.x).toBeCloseTo(120);
    expect(point.y).toBeCloseTo(240);
  });

  it('undoes the zoom the same way on both axes', () => {
    const zoomed = layoutPages(pages, { ...base, axis: 'x', zoom: 1.5 });
    const third = zoomed.items[2]!;
    const clientX = third.left + 100 * 1.5 - frame.scrollLeft + frame.left;
    const clientY = third.top + 50 * 1.5 - frame.scrollTop + frame.top;
    const point = projectToPage(clientX, clientY, frame, third, 1.5);
    expect(point.x).toBeCloseTo(100);
    expect(point.y).toBeCloseTo(50);
  });

  it('round-trips through pageToContent', () => {
    const item = horizontal.items[2]!;
    const content = pageToContent({ x: 300, y: 700 }, item, 1);
    expect(content).toEqual({ x: item.left + 300, y: item.top + 700 });
    const back = projectToPage(content.x - frame.scrollLeft + frame.left, content.y - frame.scrollTop + frame.top, frame, item, 1);
    expect(back.x).toBeCloseTo(300);
    expect(back.y).toBeCloseTo(700);
  });

  it('anchors a pinch on the page under the fingers, along x', () => {
    const second = horizontal.items[1]!;
    const content = { x: second.left + 200, y: second.top + 300 };
    const offset = { x: 640, y: 450 };
    const anchor = anchorForContentPoint(horizontal.items, content, 1, offset, 'x');
    expect(anchor).toEqual({ itemIndex: 1, pagePoint: { x: 200, y: 300 }, offset });

    const zoomed = layoutPages(pages, { ...base, axis: 'x', zoom: 2 });
    const scroll = scrollForAnchor(zoomed.items, anchor!, 2)!;
    const target = zoomed.items[1]!;
    expect(scroll.x + offset.x).toBeCloseTo(target.left + 200 * 2);
    expect(scroll.y + offset.y).toBeCloseTo(target.top + 300 * 2);
  });
});

describe('cover in the layout', () => {
  it('takes the first slot and pushes the pages along, vertically', () => {
    const withCover = layoutPages(pages, { ...base, cover: A4 });
    expect(withCover.cover).not.toBeNull();
    expect(withCover.cover!.index).toBe(COVER_INDEX);
    expect(withCover.cover!.top).toBe(VIEWER_PADDING);
    expect(withCover.items[0]!.top).toBe(VIEWER_PADDING + A4.height + PAGE_GAP);
    expect(withCover.items[0]!.index).toBe(0); // numbering is unaffected
    expect(withCover.totalHeight).toBe(vertical.totalHeight + A4.height + PAGE_GAP);
  });

  it('takes the first slot horizontally too', () => {
    const withCover = layoutPages(pages, { ...base, axis: 'x', cover: A4 });
    expect(withCover.cover!.left).toBe(VIEWER_PADDING);
    expect(withCover.items[0]!.left).toBe(VIEWER_PADDING + A4.width + PAGE_GAP);
    expect(withCover.totalWidth).toBe(horizontal.totalWidth + A4.width + PAGE_GAP);
  });

  it('is absent when the document has none', () => {
    expect(vertical.cover).toBeNull();
    expect(layoutPages([], base).cover).toBeNull();
  });

  it('leaves page tracking to the pages', () => {
    const withCover = layoutPages(pages, { ...base, cover: A4 });
    // Scrolled to the cover: the nearest page is still page 1.
    expect(currentPageIndex(withCover.items, 0, 900)).toBe(0);
    expect(scrollOffsetForPage(withCover.items, 0, VIEWER_PADDING)).toBe(A4.height + PAGE_GAP);
  });
});
