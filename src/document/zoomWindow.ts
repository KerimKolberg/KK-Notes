/**
 * The zoom window: a strip along the bottom of the screen that shows part of one page
 * magnified, to write in. Whatever is written in it lands on the page at its own size.
 *
 * View state, not content: nothing here is saved or undone. The window belongs to one
 * page until it is closed or opened on another.
 */
import { create } from 'zustand';
import type { Point } from '../inking/types';
import {
  DEFAULT_ZOOM_MAGNIFICATION,
  DEFAULT_ZOOM_WINDOW_HEIGHT,
  clampOrigin,
  initialOrigin,
  nextLineOrigin,
  regionSize,
  stepOrigin,
  type Size,
  type ZoomMagnification,
  type ZoomStep,
} from '../inking/engine/zoomRegion';

interface PageDims {
  readonly width: number;
  readonly height: number;
}

interface ZoomWindowStore {
  readonly open: boolean;
  readonly pageId: string | null;
  readonly mag: ZoomMagnification;
  /** The drawing area's height in CSS px. */
  readonly height: number;
  /** The drawing area's width in CSS px, as last measured. */
  readonly width: number;
  /** The page point at the window's top-left corner. */
  readonly origin: Point;
  /** Where the current line of writing started, so the next one can begin under it. */
  readonly anchorX: number;

  /** Open on this page, at the part of it the person is looking at; or close, if it is open on this one already. */
  toggle: (page: { readonly id: string; readonly dimensions: PageDims }, centre: Point) => void;
  close: () => void;
  setMag: (mag: ZoomMagnification, page: PageDims) => void;
  setHeight: (height: number, page: PageDims) => void;
  /** The drawing area's measured width. */
  setWidth: (width: number, page: PageDims) => void;
  /** Put the region somewhere: by a hand, which also becomes where the next line starts. */
  moveTo: (origin: Point, page: PageDims) => void;
  /** Move along on its own, as the writing reaches the edge: the line's start is unchanged. */
  follow: (origin: Point, page: PageDims) => void;
  step: (step: ZoomStep, page: PageDims) => void;
  nextLine: (page: PageDims) => void;
}

const pageSize = (page: PageDims): Size => ({ w: page.width, h: page.height });
const regionOf = (s: Pick<ZoomWindowStore, 'width' | 'height' | 'mag'>): Size => regionSize({ width: s.width, height: s.height }, s.mag);

export const useZoomWindowStore = create<ZoomWindowStore>()((set) => ({
  open: false,
  pageId: null,
  mag: DEFAULT_ZOOM_MAGNIFICATION,
  height: DEFAULT_ZOOM_WINDOW_HEIGHT,
  // A guess until the window measures itself, so the first frame has a region to draw.
  width: 1000,
  origin: { x: 0, y: 0 },
  anchorX: 0,

  toggle: (page, centre) =>
    set((s) => {
      if (s.open && s.pageId === page.id) return { open: false };
      const origin = initialOrigin(centre, regionOf(s), { w: page.dimensions.width, h: page.dimensions.height });
      return { open: true, pageId: page.id, origin, anchorX: origin.x };
    }),
  close: () => set((s) => (s.open ? { open: false } : s)),

  setMag: (mag, page) =>
    set((s) => {
      const next = { ...s, mag };
      const origin = clampOrigin(s.origin, regionOf(next), pageSize(page));
      return { mag, origin, anchorX: Math.min(s.anchorX, origin.x) === s.anchorX ? s.anchorX : origin.x };
    }),
  setHeight: (height, page) =>
    set((s) => ({ height, origin: clampOrigin(s.origin, regionOf({ ...s, height }), pageSize(page)) })),
  setWidth: (width, page) =>
    set((s) => {
      if (Math.abs(width - s.width) < 1) return s;
      return { width, origin: clampOrigin(s.origin, regionOf({ ...s, width }), pageSize(page)) };
    }),

  moveTo: (origin, page) =>
    set((s) => {
      const next = clampOrigin(origin, regionOf(s), pageSize(page));
      return { origin: next, anchorX: next.x };
    }),
  follow: (origin, page) => set((s) => ({ origin: clampOrigin(origin, regionOf(s), pageSize(page)) })),
  step: (step, page) =>
    set((s) => {
      const next = stepOrigin(s.origin, regionOf(s), pageSize(page), step);
      // Stepping sideways is the person choosing where the writing is; stepping down is going on.
      return step === 'left' || step === 'right' ? { origin: next, anchorX: next.x } : { origin: next };
    }),
  nextLine: (page) =>
    set((s) => ({ origin: nextLineOrigin(s.origin, s.anchorX, regionOf(s), pageSize(page)) })),
}));

/** The region the window is showing, in page units. */
export function zoomRegion(s: Pick<ZoomWindowStore, 'width' | 'height' | 'mag'>): Size {
  return regionOf(s);
}

/**
 * The page point at the middle of what the person is looking at, for the window to open on:
 * where the viewer's centre falls on the page, in page units. The top-left of the page when
 * the page is not on screen.
 *
 * `shrinkBy` is how many CSS px shorter the viewer is about to get, because opening the window takes
 * its room from below it: the middle of what will be left, not of what there was.
 */
export function viewCentreOnPage(pageId: string, pageWidthUnits: number, shrinkBy = 0): Point {
  if (typeof document === 'undefined') return { x: 0, y: 0 };
  const viewer = document.querySelector('[data-viewer]');
  const pageEl = document.querySelector(`[data-page-id="${pageId}"]`);
  if (!viewer || !pageEl || !(pageWidthUnits > 0)) return { x: 0, y: 0 };
  const v = viewer.getBoundingClientRect();
  const p = pageEl.getBoundingClientRect();
  const scale = p.width / pageWidthUnits || 1;
  // `shrinkBy`: how much shorter the viewer is about to get, when the window takes its room.
  return { x: (v.left + v.width / 2 - p.left) / scale, y: (v.top + (v.height - shrinkBy) / 2 - p.top) / scale };
}
