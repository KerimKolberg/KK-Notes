/**
 * Polyline simplification and resampling.
 *
 * Both hold-to-snap recognition and dashed rendering want a *clean* centreline
 * rather than the 240 Hz jitter the digitiser reports: RDP removes the noise,
 * and arc-length resampling then yields equidistant points so dash patterns
 * and turning-angle statistics are independent of pen speed.
 */
import type { Point } from '../types';

/** Distance from `p` to the infinite line through `a` and `b` (or to `a` if a == b). */
export function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

/**
 * Ramer–Douglas–Peucker, iterative (no recursion-depth limit for long
 * strokes). Always keeps the first and last point; preserves input order and
 * the original point objects.
 */
export function simplifyRdp<P extends Point>(points: readonly P[], epsilon: number): P[] {
  const n = points.length;
  if (n < 3) return [...points];

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: Array<readonly [number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const range = stack.pop();
    if (!range) break;
    const [start, end] = range;
    const a = points[start];
    const b = points[end];
    if (!a || !b) continue;

    let maxDistance = -1;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const p = points[i];
      if (!p) continue;
      const d = perpendicularDistance(p, a, b);
      if (d > maxDistance) {
        maxDistance = d;
        index = i;
      }
    }
    if (index !== -1 && maxDistance > epsilon) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }

  const out: P[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (keep[i] && p) out.push(p);
  }
  return out;
}

export function polylineLength(points: readonly Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return length;
}

/**
 * Equidistant points along the polyline, `spacing` apart in arc length. The
 * first and last input points are always included.
 */
export function resamplePolyline(points: readonly Point[], spacing: number): Point[] {
  const first = points[0];
  if (!first) return [];
  if (points.length === 1 || spacing <= 0) return [{ x: first.x, y: first.y }];

  const out: Point[] = [{ x: first.x, y: first.y }];
  /** Arc length already travelled since the last emitted sample. */
  let carry = 0;
  let prev: Point = first;

  for (let i = 1; i < points.length; i++) {
    const cur = points[i];
    if (!cur) continue;
    const segLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    if (segLen === 0) continue;

    let d = spacing - carry;
    while (d <= segLen) {
      const t = d / segLen;
      out.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t });
      d += spacing;
    }
    carry = segLen - (d - spacing);
    prev = cur;
  }

  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (last && tail && (tail.x !== last.x || tail.y !== last.y)) {
    out.push({ x: last.x, y: last.y });
  }
  return out;
}

/**
 * Direction of travel at the end of a path, estimated over the trailing
 * `window` px of arc length so a single jittery sample can't swing it.
 * Returns radians in canvas orientation, or `null` for a degenerate path.
 */
export function endTangent(points: readonly Point[], window: number): number | null {
  const n = points.length;
  const last = points[n - 1];
  if (!last || n < 2) return null;
  let travelled = 0;
  let anchor: Point | undefined;
  for (let i = n - 1; i > 0; i--) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    travelled += Math.hypot(b.x - a.x, b.y - a.y);
    anchor = a;
    if (travelled >= window) break;
  }
  if (!anchor || (anchor.x === last.x && anchor.y === last.y)) return null;
  return Math.atan2(last.y - anchor.y, last.x - anchor.x);
}

/** Same as `endTangent` but pointing *out of* the start of the path. */
export function startTangent(points: readonly Point[], window: number): number | null {
  const reversed = [...points].reverse();
  return endTangent(reversed, window);
}
