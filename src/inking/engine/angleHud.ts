/**
 * Live angle read-outs for straight lines: the absolute angle from the
 * horizontal, the interior angle where the new line meets an existing
 * segment's endpoint, and the acute angle where it crosses one.
 */
import { CONNECT_TOLERANCE_PX } from '../constants';
import type { LineShape, Point, Stroke } from '../types';
import {
  acuteAngleDeg,
  angleOf,
  canvasAngleToMathDegrees,
  formatDegrees,
  interiorAngleDeg,
  normalizeRadians,
} from './angles';
import { distance, segmentIntersection } from './geometry';
import type { Segment } from './shapes';

export interface AngleArc {
  readonly vertex: Point;
  /** Canvas radians; the arc is drawn the short way from `startAngle` to `endAngle`. */
  readonly startAngle: number;
  readonly endAngle: number;
  /** `0` draws only the label. */
  readonly radius: number;
  readonly label: string;
}

const MAX_CONNECTIONS_PER_END = 2;
const MAX_INTERSECTIONS = 3;

/** Straight segments from committed geometric lines and polylines. */
export function geometricSegments(strokes: readonly Stroke[], hidden?: ReadonlySet<string>): Segment[] {
  const segments: Segment[] = [];
  for (const stroke of strokes) {
    if (stroke.kind !== 'geometric' || (hidden && hidden.has(stroke.id))) continue;
    const shape = stroke.shape;
    if (shape.type === 'line') {
      segments.push({ a: shape.from, b: shape.to });
    } else if (shape.type === 'polyline') {
      for (let i = 1; i < shape.points.length; i++) {
        const a = shape.points[i - 1];
        const b = shape.points[i];
        if (a && b) segments.push({ a, b });
      }
    }
  }
  return segments;
}

function arcRadius(length: number): number {
  return Math.min(36, Math.max(16, length * 0.35));
}

/** Build the HUD for a line being drawn against the committed segments. */
export function buildLineHud(line: LineShape, segments: readonly Segment[]): AngleArc[] {
  const { from, to } = line;
  const length = distance(from, to);
  if (length < 4) return [];
  const direction = angleOf(from, to);
  const radius = arcRadius(length);
  const arcs: AngleArc[] = [];

  // Interior angles where either end of the new line touches an existing endpoint.
  let connectedAtStart = false;
  const ends: Array<{ vertex: Point; other: Point }> = [
    { vertex: from, other: to },
    { vertex: to, other: from },
  ];
  for (const end of ends) {
    let count = 0;
    for (const seg of segments) {
      if (count >= MAX_CONNECTIONS_PER_END) break;
      let far: Point | null = null;
      if (distance(seg.a, end.vertex) <= CONNECT_TOLERANCE_PX) far = seg.b;
      else if (distance(seg.b, end.vertex) <= CONNECT_TOLERANCE_PX) far = seg.a;
      if (!far) continue;
      const deg = interiorAngleDeg(end.vertex, end.other, far);
      if (deg < 0.5 || deg > 179.5) continue;
      arcs.push({
        vertex: end.vertex,
        startAngle: angleOf(end.vertex, end.other),
        endAngle: angleOf(end.vertex, far),
        radius,
        label: `∠ = ${formatDegrees(deg)}`,
      });
      if (end.vertex === from) connectedAtStart = true;
      count++;
    }
  }

  // Acute angles at proper crossings.
  let crossings = 0;
  for (const seg of segments) {
    if (crossings >= MAX_INTERSECTIONS) break;
    const hit = segmentIntersection(from, to, seg.a, seg.b);
    if (!hit || hit.t < 0.02 || hit.t > 0.98 || hit.u < 0.02 || hit.u > 0.98) continue;
    const segDirection = angleOf(seg.a, seg.b);
    const deg = acuteAngleDeg(direction, segDirection);
    if (deg < 0.5) continue;
    // Point the second ray along whichever direction of the segment makes the acute angle.
    const forward = Math.abs(normalizeRadians(segDirection - direction)) <= Math.PI / 2;
    arcs.push({
      vertex: hit.point,
      startAngle: direction,
      endAngle: forward ? segDirection : segDirection + Math.PI,
      radius: Math.min(radius, 24),
      label: `θ = ${formatDegrees(deg)}`,
    });
    crossings++;
  }

  // Absolute angle from +x, math convention, at the start (unless something is already there).
  const absolute = `θ = ${formatDegrees(canvasAngleToMathDegrees(direction))}`;
  if (connectedAtStart) {
    arcs.push({
      vertex: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      startAngle: 0,
      endAngle: 0,
      radius: 0,
      label: absolute,
    });
  } else {
    arcs.push({ vertex: from, startAngle: 0, endAngle: direction, radius, label: absolute });
  }
  return arcs;
}
