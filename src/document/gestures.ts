/**
 * Pure math for two-finger navigation: pinch scale, midpoint pan and the
 * scroll offsets that keep the pinch centroid anchored when a zoom commits
 * and the layout is rebuilt at the new scale.
 */
import type { Point } from '../inking/types';
import { MAX_ZOOM, MIN_ZOOM } from './constants';
import { clampZoom, itemAtContent, pageToContent, type LayoutAxis, type PageLayout } from './layout';

export function centroid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function touchDistance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export interface PinchStart {
  /** Centroid of the two touches when the gesture began (client px). */
  readonly mid: Point;
  /** Distance between the two touches when the gesture began. */
  readonly dist: number;
  /** Document zoom when the gesture began. */
  readonly zoom: number;
}

export interface PinchState {
  /** Zoom the gesture currently asks for (rounded and clamped like the store does). */
  readonly zoom: number;
  /** `zoom / start.zoom`: the visual scale to preview with. */
  readonly scale: number;
  /** How far the centroid moved since the gesture began (client px). */
  readonly pan: Point;
  /** Current centroid (client px). */
  readonly mid: Point;
}

export function pinchStart(a: Point, b: Point, zoom: number): PinchStart {
  return { mid: centroid(a, b), dist: touchDistance(a, b), zoom };
}

/**
 * Pinch state for the current finger positions. A degenerate start distance
 * (fingers on the same spot) keeps the zoom and only pans.
 */
export function pinchUpdate(start: PinchStart, a: Point, b: Point, min = MIN_ZOOM, max = MAX_ZOOM): PinchState {
  const mid = centroid(a, b);
  const dist = touchDistance(a, b);
  const raw = start.dist > 0 ? (start.zoom * dist) / start.dist : start.zoom;
  const zoom = clampZoom(raw, min, max);
  return {
    zoom,
    scale: start.zoom > 0 ? zoom / start.zoom : 1,
    pan: { x: mid.x - start.mid.x, y: mid.y - start.mid.y },
    mid,
  };
}

/** Scroll offsets after a one-finger / midpoint pan of `pan` client px. */
export function panScroll(startScroll: Point, pan: Point): Point {
  return { x: startScroll.x - pan.x, y: startScroll.y - pan.y };
}

/**
 * Scroll offsets that place scroll-content point `anchorContent` at
 * `offset` (px from the scroll container's top-left corner).
 */
export function anchoredScroll(anchorContent: Point, offset: Point): Point {
  return { x: anchorContent.x - offset.x, y: anchorContent.y - offset.y };
}

/** CSS that previews a pinch on the scroll content without relayout. */
export function previewTransform(anchorContent: Point, pan: Point, scale: number): { transform: string; transformOrigin: string } {
  return {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
    transformOrigin: `${anchorContent.x}px ${anchorContent.y}px`,
  };
}

/** A point on a page, remembered together with where on screen it should stay. */
export interface GestureAnchor {
  /** Position in the layout's `items` array (not the document index). */
  readonly itemIndex: number;
  /** Page-local point under the centroid. */
  readonly pagePoint: Point;
  /** Where the point should end up, px from the scroll container's corner. */
  readonly offset: Point;
}

/** The page point under a scroll-content position (pages sit in a single row or column). */
export function anchorForContentPoint(
  items: readonly PageLayout[],
  content: Point,
  zoom: number,
  offset: Point,
  axis: LayoutAxis = 'y',
): GestureAnchor | null {
  const item = itemAtContent(items, content, axis);
  if (!item || zoom <= 0) return null;
  return {
    itemIndex: items.indexOf(item),
    pagePoint: { x: (content.x - item.left) / zoom, y: (content.y - item.top) / zoom },
    offset,
  };
}

/** Scroll offsets that put the anchor's page point back at its screen offset under `zoom`'s layout. */
export function scrollForAnchor(items: readonly PageLayout[], anchor: GestureAnchor, zoom: number): Point | null {
  const item = items[anchor.itemIndex];
  if (!item) return null;
  return anchoredScroll(pageToContent(anchor.pagePoint, item, zoom), anchor.offset);
}
