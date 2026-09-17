/**
 * Continuous-scroll layout and coordinate projection. Everything here is in
 * viewport CSS pixels unless a name says "page" — page-local units are the
 * inking engine's coordinate system (CSS px at zoom 1, origin at the page's
 * top-left corner).
 *
 * Pages stack along one **main axis**: `y` for vertical continuous scrolling,
 * `x` for horizontal. Every scroll-related helper takes that axis so the
 * viewer, the virtualisation ranges and the touch gestures all agree on which
 * offset they are talking about. Positions themselves are always plain
 * `left`/`top` pairs, so projection works the same either way.
 */
import type { Point } from '../inking/types';
import { MAX_ZOOM, MIN_ZOOM } from './constants';
import type { PageDimensions } from './types';

/** Which axis pages advance along. */
export type LayoutAxis = 'y' | 'x';

export interface PageLayout {
  /** Index in the laid-out list; `COVER_INDEX` for the notebook cover. */
  readonly index: number;
  /** Offset of the page's top edge inside the scroll content. */
  readonly top: number;
  /** Offset of the page's left edge inside the scroll content. */
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** `PageLayout.index` of the cover sheet, which is not a page. */
export const COVER_INDEX = -1;

export interface DocumentLayout {
  readonly items: readonly PageLayout[];
  readonly totalWidth: number;
  readonly totalHeight: number;
  readonly axis: LayoutAxis;
  /** Laid out before the first page when the document has a cover. */
  readonly cover: PageLayout | null;
}

export interface LayoutOptions {
  readonly zoom: number;
  readonly gap: number;
  readonly padding: number;
  /** Width of the scroll viewport; pages are centred in it when narrower. */
  readonly containerWidth: number;
  /** Height of the scroll viewport; used to centre pages in horizontal mode. */
  readonly containerHeight?: number;
  /** Axis pages advance along. Default `'y'`. */
  readonly axis?: LayoutAxis;
  /** Size of the notebook cover, laid out before the first page. */
  readonly cover?: PageDimensions | null;
}

/** Offset of an item along the main axis. */
export function mainStart(item: PageLayout, axis: LayoutAxis): number {
  return axis === 'y' ? item.top : item.left;
}

/** Extent of an item along the main axis. */
export function mainSize(item: PageLayout, axis: LayoutAxis): number {
  return axis === 'y' ? item.height : item.width;
}

/** Scroll offset of a container along the main axis. */
export function mainScroll(el: { scrollTop: number; scrollLeft: number }, axis: LayoutAxis): number {
  return axis === 'y' ? el.scrollTop : el.scrollLeft;
}

/** Stack pages along `axis`, centred on the cross axis, at the given zoom. */
export function layoutPages(
  pages: ReadonlyArray<{ readonly dimensions: PageDimensions }>,
  options: LayoutOptions,
): DocumentLayout {
  const { zoom, gap, padding, containerWidth, containerHeight = 0, axis = 'y', cover = null } = options;
  const items: PageLayout[] = [];
  let main = padding;
  let maxWidth = 0;
  let maxHeight = 0;

  /** Place one sheet at the running main offset and advance past it. */
  const place = (index: number, dimensions: PageDimensions): PageLayout => {
    const width = dimensions.width * zoom;
    const height = dimensions.height * zoom;
    if (width > maxWidth) maxWidth = width;
    if (height > maxHeight) maxHeight = height;
    const item: PageLayout =
      axis === 'y'
        ? { index, top: main, left: Math.max(padding, (containerWidth - width) / 2), width, height }
        : { index, top: Math.max(padding, (containerHeight - height) / 2), left: main, width, height };
    main += (axis === 'y' ? height : width) + gap;
    return item;
  };

  const coverItem = cover ? place(COVER_INDEX, cover) : null;
  pages.forEach((page, index) => items.push(place(index, page.dimensions)));

  const empty = items.length === 0 && !coverItem;
  const totalMain = empty ? padding * 2 : main - gap + padding;
  return axis === 'y'
    ? { items, cover: coverItem, axis, totalWidth: maxWidth + padding * 2, totalHeight: totalMain }
    : { items, cover: coverItem, axis, totalWidth: totalMain, totalHeight: maxHeight + padding * 2 };
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
  scroll: number,
  viewportSize: number,
  overscan: number,
  axis: LayoutAxis = 'y',
): IndexRange {
  const min = scroll - overscan;
  const max = scroll + viewportSize + overscan;
  let start = -1;
  let end = -2;
  for (const item of items) {
    const itemStart = mainStart(item, axis);
    const itemEnd = itemStart + mainSize(item, axis);
    if (itemEnd < min) continue;
    if (itemStart > max) break;
    if (start === -1) start = item.index;
    end = item.index;
  }
  return start === -1 ? { start: 0, end: -1 } : { start, end };
}

export function inRange(range: IndexRange, index: number): boolean {
  return index >= range.start && index <= range.end;
}

/**
 * The page the reader is "on": the one under the reference line 40 % into the
 * viewport, or, when that line falls in a gap, the page with the largest
 * visible extent.
 */
export function currentPageIndex(
  items: readonly PageLayout[],
  scroll: number,
  viewportSize: number,
  axis: LayoutAxis = 'y',
): number {
  if (items.length === 0) return 0;
  const reference = scroll + viewportSize * 0.4;
  let bestIndex = 0;
  let bestOverlap = -1;
  for (const item of items) {
    const itemStart = mainStart(item, axis);
    const itemEnd = itemStart + mainSize(item, axis);
    if (reference >= itemStart && reference <= itemEnd) return item.index;
    const overlap = Math.min(itemEnd, scroll + viewportSize) - Math.max(itemStart, scroll);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIndex = item.index;
    }
  }
  return bestIndex;
}

/** Scroll offset that places a page's leading edge just inside the viewport. */
export function scrollOffsetForPage(
  items: readonly PageLayout[],
  index: number,
  padding: number,
  axis: LayoutAxis = 'y',
): number {
  const item = items[index];
  if (!item) return 0;
  return Math.max(0, mainStart(item, axis) - padding);
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
 * the page element is not mounted, e.g. a snapshot). Works in either axis:
 * the item's own `left`/`top` carry the layout direction.
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

/** A rendered page and where it currently sits on screen. */
export interface PageRect {
  readonly pageId: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Distance from a viewport point to a rect; zero when the point is inside. */
function distanceToRect(rect: PageRect, x: number, y: number): number {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}

/**
 * The page a drop at a viewport point belongs to: the one under it, or failing
 * that the nearest, so releasing over the gap between two sheets still lands
 * somewhere rather than cancelling the move.
 */
export function pageAtViewportPoint(pages: readonly PageRect[], x: number, y: number): PageRect | undefined {
  let best: PageRect | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const page of pages) {
    const distance = distanceToRect(page, x, y);
    if (distance === 0) return page;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = page;
    }
  }
  return best;
}

/**
 * Where strokes dragged off `from` have to land on `to` to stay under the
 * pointer: page-local units, from the two sheets' on-screen positions.
 */
export function pageHandoffOffset(from: PageRect, to: PageRect, zoom: number): Point {
  return { x: (from.left - to.left) / zoom, y: (from.top - to.top) / zoom };
}

/** Zoom rounded to 1% and clamped to the supported range. */
export function clampZoom(zoom: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  const z = Math.round(zoom * 100) / 100;
  return Math.min(max, Math.max(min, Number.isFinite(z) ? z : min));
}

/**
 * The layout item under a scroll-content position, or the nearest one when
 * the point falls in a gap / the padding. `undefined` only for an empty
 * layout. Only the main axis is considered: the cross axis is centred, so a
 * point beside a page still belongs to it.
 */
export function itemAtContent(items: readonly PageLayout[], content: Point, axis: LayoutAxis = 'y'): PageLayout | undefined {
  const value = axis === 'y' ? content.y : content.x;
  let best: PageLayout | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const start = mainStart(item, axis);
    const end = start + mainSize(item, axis);
    if (value >= start && value <= end) return item;
    const d = value < start ? start - value : value - end;
    if (d < bestDistance) {
      bestDistance = d;
      best = item;
    }
  }
  return best;
}
