/**
 * The arithmetic of snipping: from a drag across a page on screen to a region of the page in page units, how sharp to
 * cut it, and how big and where to put it on another page. Pure; the rest of `snip/` is the browser around it.
 */
import type { PageDimensions } from '../document/types';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Pt {
  readonly x: number;
  readonly y: number;
}

/** A drag smaller than this, in CSS px, is a click and not a snip. */
export const MIN_SNIP_PX = 14;

/** The rectangle between two points, kept inside `frame` (all in the same space). */
export function dragRect(a: Pt, b: Pt, frame: Rect): Rect {
  const x0 = Math.max(frame.x, Math.min(frame.x + frame.width, Math.min(a.x, b.x)));
  const y0 = Math.max(frame.y, Math.min(frame.y + frame.height, Math.min(a.y, b.y)));
  const x1 = Math.max(frame.x, Math.min(frame.x + frame.width, Math.max(a.x, b.x)));
  const y1 = Math.max(frame.y, Math.min(frame.y + frame.height, Math.max(a.y, b.y)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Whether a dragged rectangle is a snip. */
export function isSnip(rect: Rect): boolean {
  return rect.width >= MIN_SNIP_PX && rect.height >= MIN_SNIP_PX;
}

/**
 * A rectangle in screen space as a region of the page it was dragged over, in page units. `frame` is the page as it is
 * on screen; the page is shown at its width, so the ratio of the two is the scale.
 */
export function pageRegion(rect: Rect, frame: Rect, page: PageDimensions): Rect {
  const scale = page.width / frame.width;
  return {
    x: (rect.x - frame.x) * scale,
    y: (rect.y - frame.y) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/** The widest a page is drawn to cut a snip out of it, in pixels: a page that wide is tens of megapixels. */
export const MAX_RENDER_WIDTH = 3200;

/**
 * Pixels per page unit to draw the page at before cutting: sharp enough to read when put on a page and enlarged a
 * little (never below 2), more for a small region (so one line of text is still crisp), never so much that the
 * page is drawn wider than {@link MAX_RENDER_WIDTH}.
 */
export function snipScale(regionWidth: number, pageWidth: number): number {
  const wanted = Math.max(2, Math.min(4, 900 / Math.max(1, regionWidth)));
  return Math.max(0.5, Math.min(wanted, MAX_RENDER_WIDTH / Math.max(1, pageWidth)));
}

/** How big a snip is put on a page: as big as it was, but not more than this fraction of the page's width or height. */
export const SNIP_MAX_FRACTION = 0.9;

export function fitOnPage(size: { width: number; height: number }, page: PageDimensions): { width: number; height: number } {
  const fit = Math.min(1, (page.width * SNIP_MAX_FRACTION) / Math.max(1, size.width), (page.height * SNIP_MAX_FRACTION) / Math.max(1, size.height));
  return { width: Math.max(8, size.width * fit), height: Math.max(8, size.height * fit) };
}

/** The top-left for something `size` big centred on `centre`, kept wholly on the page where it can be. */
export function topLeftFor(centre: Pt, size: { width: number; height: number }, page: PageDimensions): Pt {
  const x = centre.x - size.width / 2;
  const y = centre.y - size.height / 2;
  return {
    x: Math.max(0, Math.min(page.width - size.width, x)),
    y: Math.max(0, Math.min(page.height - size.height, y)),
  };
}

/**
 * Where "Place on page" puts a snip: across the middle of the page, a little way down, and a little further along for
 * each thing already on the page so several placed in a row are not stacked exactly. The middle, because the snip
 * tray sits over a corner of the page and the first thing wanted is to see what was placed.
 */
export function defaultCentre(size: { width: number; height: number }, page: PageDimensions, alreadyThere: number): Pt {
  const step = (alreadyThere % 6) * 28;
  return { x: page.width / 2 + step, y: 96 + size.height / 2 + step };
}
