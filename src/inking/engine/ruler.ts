/**
 * The straightedge: a ruler lying on the page that a pen can be drawn along.
 *
 * Pure geometry in page units. The ruler is a rectangle, `length` long and
 * `RULER_WIDTH` wide, centred on a point and turned about it. A stroke that starts
 * at one of its long edges becomes a straight line along that edge, however the
 * hand wanders, and stops where the ruler does.
 *
 * A page unit is a CSS pixel, which is 1/96 inch, so the ruler's own marks are
 * true to size at 100% zoom: a centimetre is 37.8 units.
 */
import type { Point } from '../types';

export interface Ruler {
  /** Centre of the ruler on the page. */
  readonly x: number;
  readonly y: number;
  /** Radians, clockwise on the page: 0 has the ruler lying along the page's top edge. */
  readonly angle: number;
  /** Along the edge. */
  readonly length: number;
}

/** Across the ruler, between its two edges. */
export const RULER_WIDTH = 72;
/** The ruler a page starts with, at most: it is narrowed to fit a narrower page. */
export const RULER_DEFAULT_LENGTH = 560;
/** How close to an edge a stroke has to start for it to follow that edge, in page units. */
export const RULER_SNAP_DISTANCE = 18;
/** Page units in a centimetre. */
export const PX_PER_CM = 96 / 2.54;
/** Page units in a millimetre. */
export const PX_PER_MM = PX_PER_CM / 10;

export interface Edge {
  readonly from: Point;
  readonly to: Point;
}

/** A point in the ruler's own frame (x along it, y across, origin at its centre) on the page. */
export function rulerPoint(r: Ruler, local: Point): Point {
  const cos = Math.cos(r.angle);
  const sin = Math.sin(r.angle);
  return { x: r.x + local.x * cos - local.y * sin, y: r.y + local.x * sin + local.y * cos };
}

/** The two long edges, left end to right end (the ruler's own left and right). Upper one first. */
export function rulerEdges(r: Ruler): [Edge, Edge] {
  const half = r.length / 2;
  const across = RULER_WIDTH / 2;
  return [
    { from: rulerPoint(r, { x: -half, y: -across }), to: rulerPoint(r, { x: half, y: -across }) },
    { from: rulerPoint(r, { x: -half, y: across }), to: rulerPoint(r, { x: half, y: across }) },
  ];
}

/** The nearest point to `p` on the edge, with how far along it that is (0 at `from`, 1 at `to`, clamped). */
export function projectToEdge(edge: Edge, p: Point): { readonly point: Point; readonly t: number; readonly distance: number } {
  const dx = edge.to.x - edge.from.x;
  const dy = edge.to.y - edge.from.y;
  const lengthSq = dx * dx + dy * dy;
  const raw = lengthSq === 0 ? 0 : ((p.x - edge.from.x) * dx + (p.y - edge.from.y) * dy) / lengthSq;
  const t = Math.min(1, Math.max(0, raw));
  const point = { x: edge.from.x + dx * t, y: edge.from.y + dy * t };
  return { point, t, distance: Math.hypot(p.x - point.x, p.y - point.y) };
}

/**
 * The edge a stroke that starts at `p` should follow, or `null` when it starts
 * nowhere near one. Near means within `snap` of the edge itself, which takes in the
 * side the pen is on and the strip of ruler just inside it, but not the middle of
 * the body, where writing on the ruler is still writing.
 */
export function edgeForStart(r: Ruler, p: Point, snap = RULER_SNAP_DISTANCE): Edge | null {
  let best: Edge | null = null;
  let bestDistance = snap;
  for (const edge of rulerEdges(r)) {
    const { distance } = projectToEdge(edge, p);
    if (distance <= bestDistance) {
      best = edge;
      bestDistance = distance;
    }
  }
  return best;
}

/** How long a segment is, in centimetres. */
export function lengthCm(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y) / PX_PER_CM;
}

/** The ruler's angle as degrees in [0, 360), for a reading. */
export function angleDegrees(r: Ruler): number {
  const deg = ((r.angle * 180) / Math.PI) % 360;
  return Math.round(deg < 0 ? deg + 360 : deg);
}

/**
 * A ruler for a page of this size: centred, across the upper middle, as long as the
 * page is wide up to the default.
 */
export function initialRuler(page: { readonly width: number; readonly height: number }): Ruler {
  return {
    x: page.width / 2,
    y: page.height * 0.3,
    angle: 0,
    length: Math.min(RULER_DEFAULT_LENGTH, Math.max(120, page.width - 120)),
  };
}

/** The ruler kept from leaving its page altogether: its centre stays on the page. */
export function keepOnPage(r: Ruler, page: { readonly width: number; readonly height: number }): Ruler {
  const x = Math.min(page.width, Math.max(0, r.x));
  const y = Math.min(page.height, Math.max(0, r.y));
  return x === r.x && y === r.y ? r : { ...r, x, y };
}

export interface RulerTick {
  /** From the ruler's left end, in page units. */
  readonly at: number;
  readonly kind: 'cm' | 'half' | 'mm';
  /** Set on centimetre marks: the number to print beside it. */
  readonly label?: number;
}

/** Every millimetre mark along a ruler `length` long, the centimetres and half centimetres marked out. */
export function rulerTicks(length: number): RulerTick[] {
  const out: RulerTick[] = [];
  const count = Math.floor(length / PX_PER_MM);
  for (let i = 0; i <= count; i++) {
    const at = i * PX_PER_MM;
    if (i % 10 === 0) out.push({ at, kind: 'cm', label: i / 10 });
    else if (i % 5 === 0) out.push({ at, kind: 'half' });
    else out.push({ at, kind: 'mm' });
  }
  return out;
}
