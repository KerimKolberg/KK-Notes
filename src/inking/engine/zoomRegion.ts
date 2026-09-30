/**
 * The zoom window's geometry: which part of a page it is showing, and how that part
 * moves as the person writes.
 *
 * The window is a strip of the screen that shows a region of the page at 2 to 4
 * times its size. The region is where the writing is going: a line of handwriting
 * goes along it, and when the pen gets near its right edge it moves on so there is
 * room for more. All numbers are page units unless they say otherwise.
 */
import type { Point } from '../types';

export const ZOOM_MAGNIFICATIONS = [2, 3, 4] as const;
export type ZoomMagnification = (typeof ZOOM_MAGNIFICATIONS)[number];
export const DEFAULT_ZOOM_MAGNIFICATION: ZoomMagnification = 3;

/** How tall the drawing area of the window may be, in CSS px: a short strip, a taller one, a tall one. */
export const ZOOM_WINDOW_HEIGHTS = [180, 260, 360] as const;
export const DEFAULT_ZOOM_WINDOW_HEIGHT = ZOOM_WINDOW_HEIGHTS[1];
/** The window's strip of controls above the drawing area, in CSS px. */
export const ZOOM_HEADER_PX = 36;

export interface Size {
  readonly w: number;
  readonly h: number;
}

/** The region of the page a window of `panel` CSS px shows at `mag` times its size. */
export function regionSize(panel: { readonly width: number; readonly height: number }, mag: number): Size {
  const m = mag > 0 ? mag : 1;
  return { w: panel.width / m, h: panel.height / m };
}

/** An origin kept so that the region stays on the page (or at its top-left if it is bigger than the page). */
export function clampOrigin(o: Point, region: Size, page: Size): Point {
  const maxX = Math.max(0, page.w - region.w);
  const maxY = Math.max(0, page.h - region.h);
  const x = Math.min(maxX, Math.max(0, o.x));
  const y = Math.min(maxY, Math.max(0, o.y));
  return x === o.x && y === o.y ? o : { x, y };
}

export type ZoomStep = 'left' | 'right' | 'up' | 'down';

/** The region moved along by a fraction of its own size, so each step keeps some of what was in view. */
export function stepOrigin(o: Point, region: Size, page: Size, step: ZoomStep, fraction = 0.6): Point {
  const dx = region.w * fraction;
  const dy = region.h * fraction;
  const moved =
    step === 'left' ? { x: o.x - dx, y: o.y } : step === 'right' ? { x: o.x + dx, y: o.y } : step === 'up' ? { x: o.x, y: o.y - dy } : { x: o.x, y: o.y + dy };
  return clampOrigin(moved, region, page);
}

/**
 * The next line of writing: back to where the last one started, and down by most of the
 * window's height, so the last line just written is still partly in view above.
 */
export function nextLineOrigin(o: Point, anchorX: number, region: Size, page: Size, fraction = 0.7): Point {
  return clampOrigin({ x: anchorX, y: o.y + region.h * fraction }, region, page);
}

/** How far across the region the pen has to have got for the window to move on. */
export const ADVANCE_THRESHOLD = 0.85;

/**
 * Whether a stroke that ended at page x `right` means the window should move along: it is in
 * the last of the region, and there is more page to the right to move onto.
 */
export function shouldAdvance(right: number, o: Point, region: Size, page: Size, threshold = ADVANCE_THRESHOLD): boolean {
  return right > o.x + region.w * threshold && o.x + region.w < page.w - 1;
}

/**
 * The region for a window opened on the part of a page at `centre` (what the person is looking at):
 * at the page's left edge, where a line of writing starts, and centred on `centre` vertically.
 */
export function initialOrigin(centre: Point, region: Size, page: Size): Point {
  return clampOrigin({ x: 0, y: centre.y - region.h / 2 }, region, page);
}

/** A page point under a pointer in the window, given the window's corner on screen. */
export function windowToPage(clientX: number, clientY: number, corner: Point, mag: number, origin: Point): Point {
  return { x: origin.x + (clientX - corner.x) / mag, y: origin.y + (clientY - corner.y) / mag };
}
