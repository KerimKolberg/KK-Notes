import type { BBox, InkPoint } from '../types';

export const EMPTY_BBOX: BBox = {
  minX: Number.POSITIVE_INFINITY,
  minY: Number.POSITIVE_INFINITY,
  maxX: Number.NEGATIVE_INFINITY,
  maxY: Number.NEGATIVE_INFINITY,
};

export function bboxFromPoints(points: readonly InkPoint[], pad = 0): BBox {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function expandBBox(b: BBox, pad: number): BBox {
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** Squared distance from point P to segment AB. */
export function pointToSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return distanceSq(px, py, ax, ay);
  let t = ((px - ax) * abx + (py - ay) * aby) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return distanceSq(px, py, ax + t * abx, ay + t * aby);
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** True when segments AB and CD share at least one point (collinear touching counts). */
export function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }

  const onSegment = (
    sx: number,
    sy: number,
    ex: number,
    ey: number,
    px: number,
    py: number,
  ): boolean =>
    Math.min(sx, ex) <= px && px <= Math.max(sx, ex) && Math.min(sy, ey) <= py && py <= Math.max(sy, ey);

  if (d1 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
  if (d2 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
  if (d3 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
  if (d4 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
  return false;
}

/** Squared minimum distance between segments AB and CD (0 if they intersect). */
export function segmentToSegmentDistanceSq(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointToSegmentDistanceSq(ax, ay, cx, cy, dx, dy),
    pointToSegmentDistanceSq(bx, by, cx, cy, dx, dy),
    pointToSegmentDistanceSq(cx, cy, ax, ay, bx, by),
    pointToSegmentDistanceSq(dx, dy, ax, ay, bx, by),
  );
}
