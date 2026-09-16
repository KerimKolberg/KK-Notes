import type { Point, Stroke } from '../types';
import {
  bboxIntersects,
  pointToSegmentDistanceSq,
  segmentToSegmentDistanceSq,
} from './geometry';
import { shapeToPolylines } from './shapes';

const polylineCache = new WeakMap<Stroke, ReadonlyArray<readonly Point[]>>();

/** Straight-segment representation of any stroke, memoised per stroke. */
export function strokePolylines(stroke: Stroke): ReadonlyArray<readonly Point[]> {
  if (stroke.kind === 'freehand') return [stroke.points];
  let cached = polylineCache.get(stroke);
  if (!cached) {
    cached = shapeToPolylines(stroke.shape);
    polylineCache.set(stroke, cached);
  }
  return cached;
}

/**
 * Does the eraser segment A→B (swept circle of `eraserRadius`) touch `stroke`?
 *
 * Uses segment–segment distance rather than point sampling so fast eraser
 * sweeps with sparse samples still register. Pixel-eraser strokes are never
 * hit: removing one would resurrect previously erased ink.
 */
export function strokeHitBySegment(
  stroke: Stroke,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  eraserRadius: number,
): boolean {
  if (stroke.kind === 'freehand' && stroke.tool === 'eraser-pixel') return false;

  const sweep = {
    minX: Math.min(ax, bx) - eraserRadius,
    minY: Math.min(ay, by) - eraserRadius,
    maxX: Math.max(ax, bx) + eraserRadius,
    maxY: Math.max(ay, by) + eraserRadius,
  };
  if (!bboxIntersects(sweep, stroke.bbox)) return false;

  const threshold = eraserRadius + stroke.style.size / 2;
  const thresholdSq = threshold * threshold;

  for (const pts of strokePolylines(stroke)) {
    const first = pts[0];
    if (!first) continue;
    if (pts.length === 1) {
      if (pointToSegmentDistanceSq(first.x, first.y, ax, ay, bx, by) <= thresholdSq) return true;
      continue;
    }
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1];
      const q = pts[i];
      if (!p || !q) continue;
      if (segmentToSegmentDistanceSq(ax, ay, bx, by, p.x, p.y, q.x, q.y) <= thresholdSq) return true;
    }
  }
  return false;
}
