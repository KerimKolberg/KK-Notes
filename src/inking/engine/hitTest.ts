import type { Stroke } from '../types';
import {
  bboxIntersects,
  pointToSegmentDistanceSq,
  segmentToSegmentDistanceSq,
} from './geometry';

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
  if (stroke.tool === 'eraser-pixel') return false;

  const sweep = {
    minX: Math.min(ax, bx) - eraserRadius,
    minY: Math.min(ay, by) - eraserRadius,
    maxX: Math.max(ax, bx) + eraserRadius,
    maxY: Math.max(ay, by) + eraserRadius,
  };
  if (!bboxIntersects(sweep, stroke.bbox)) return false;

  const threshold = eraserRadius + stroke.style.size / 2;
  const thresholdSq = threshold * threshold;
  const pts = stroke.points;
  const first = pts[0];
  if (!first) return false;

  if (pts.length === 1) {
    return pointToSegmentDistanceSq(first.x, first.y, ax, ay, bx, by) <= thresholdSq;
  }

  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    if (!p || !q) continue;
    if (segmentToSegmentDistanceSq(ax, ay, bx, by, p.x, p.y, q.x, q.y) <= thresholdSq) {
      return true;
    }
  }
  return false;
}
