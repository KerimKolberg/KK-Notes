/**
 * Continuous-scroll layout and coordinate projection. Everything here is in
 * viewport CSS pixels unless a name says "page" — page-local units are the
 * inking engine's coordinate system (CSS px at zoom 1, origin at the page's
 * top-left corner).
 */
import type { Point } from '../inking/types';
import type { PageDimensions } from './types';

export interface PageLayout {
  readonly index: number;
  /** Offset of the page's top edge inside the scroll content. */
  readonly top: number;
  /** Offset of the page's left edge inside the scroll content. */
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface DocumentLayout {
  readonly items: readonly PageLayout[];
  readonly totalWidth: number;
  readonly totalHeight: number;
}

export interface LayoutOptions {
  readonly zoom: number;
  readonly gap: number;
  readonly padding: number;
  /** Width of the scroll viewport; pages are centred in it when narrower. */
  readonly containerWidth: number;
}

/** Stack pages vertically, centred, at the given zoom. */
export function layoutPages(pages: ReadonlyArray<{ readonly dimensions: PageDimensions }>, options: LayoutOptions): DocumentLayout {
  const { zoom, gap, padding, containerWidth } = options;
  const items: PageLayout[] = [];
  let top = padding;
  let maxWidth = 0;
  pages.forEach((page, index) => {
    const width = page.dimensions.width * zoom;
    const height = page.dimensions.height * zoom;
    if (width > maxWidth) maxWidth = width;
    items.push({ index, top, left: Math.max(padding, (containerWidth - width) / 2), width, height });
    top += height + gap;
  });
  const totalHeight = items.length === 0 ? padding * 2 : top - gap + padding;
  return { items, totalWidth: maxWidth + padding * 2, totalHeight };
}

export interface IndexRange {
  /** Inclusive. */
  readonly start: number;
  /** Inclusive; `end < start` means empty. */
  readonly end: number;
}

/** Pages intersecting the viewport expanded by `overscan` on both sides. */
export function visibleRange(
  items: readonly PageLayout[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): IndexRange {
  const min = scrollTop - overscan;
  const max = scrollTop + viewportHeight + overscan;
  let start = -1;
  let end = -2;
  for (const item of items) {
    const bottom = item.top + item.height;
    if (bottom < min) continue;
    if (item.top > max) break;
    if (start === -1) start = item.index;
    end = item.index;
  }
  return start === -1 ? { start: 0, end: -1 } : { start, end };
}

export function inRange(range: IndexRange, index: number): boolean {
  return index >= range.start && index <= range.end;
}

/**
 * The page the reader is "on": the one under the reference line 40 % down the
 * viewport, or, when that line falls in a gap, the page with the largest
 * visible area.
 */
export function currentPageIndex(items: readonly PageLayout[], scrollTop: number, viewportHeight: number): number {
  if (items.length === 0) return 0;
  const reference = scrollTop + viewportHeight * 0.4;
  let bestIndex = 0;
  let bestOverlap = -1;
  for (const item of items) {
    const bottom = item.top + item.height;
    if (reference >= item.top && reference <= bottom) return item.index;
    const overlap = Math.min(bottom, scrollTop + viewportHeight) - Math.max(item.top, scrollTop);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIndex = item.index;
    }
  }
  return bestIndex;
}

/** Scroll offset that places a page's top just inside the viewport. */
export function scrollTopForPage(items: readonly PageLayout[], index: number, padding: number): number {
  const item = items[index];
  if (!item) return 0;
  return Math.max(0, item.top - padding);
}

/**
 * Project a viewport position onto a page given the page's on-screen rect.
 * `getBoundingClientRect()` is already viewport-relative, so scrolling is
 * accounted for; only the zoom has to be undone.
 */
export function viewportToPagePoint(clientX: number, clientY: number, pageRect: { left: number; top: number }, zoom: number): Point {
  return { x: (clientX - pageRect.left) / zoom, y: (clientY - pageRect.top) / zoom };
}

export interface ScrollContainerFrame {
  /** Viewport-relative position of the scroll container. */
  readonly left: number;
  readonly top: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

/**
 * Project a viewport position onto a page using the scroll container's frame
 * and the page's layout item instead of a measured page rect (useful when
 * the page element is not mounted, e.g. a snapshot).
 */
export function projectToPage(clientX: number, clientY: number, frame: ScrollContainerFrame, item: PageLayout, zoom: number): Point {
  const contentX = clientX - frame.left + frame.scrollLeft;
  const contentY = clientY - frame.top + frame.scrollTop;
  return { x: (contentX - item.left) / zoom, y: (contentY - item.top) / zoom };
}

/** Inverse of `projectToPage`: page-local → scroll-content coordinates. */
export function pageToContent(point: Point, item: PageLayout, zoom: number): Point {
  return { x: item.left + point.x * zoom, y: item.top + point.y * zoom };
}
