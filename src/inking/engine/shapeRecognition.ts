/**
 * Hold-to-snap shape recognition.
 *
 * Pipeline: reject tiny input → straight-line test → closed/open split →
 * (closed) ellipse fit by PCA + radial variance, heart heuristic, corner
 * detection via RDP on the ring → rectangle / triangle / n-gon;
 * (open) RDP → short polyline. Every threshold is relative to the stroke's
 * own size so recognition behaves the same at any zoom or stroke scale.
 */
import type { EllipseShape, Point, RectangleShape, Shape } from '../types';
import { angleOf, interiorAngleDeg, normalizeRadians, snapAngle, snapLineEnd } from './angles';
import { bboxFromPoints } from './geometry';
import { perpendicularDistance, polylineLength, resamplePolyline, simplifyRdp } from './simplify';

export interface RecognitionOptions {
  /** When set, lines and rectangle rotations snap to this increment (degrees). */
  readonly angleSnapDeg?: number;
}

/** Tunables, exported so tests can reference the same thresholds. */
export const RECOGNITION = {
  /** Minimum bounding-box diagonal for any recognition. */
  MIN_DIAGONAL_PX: 8,
  /** A line's chord must cover this fraction of its path length (not folded back). */
  LINE_MIN_CHORD_RATIO: 0.6,
  /** Max deviation from the chord, as a fraction of chord length. */
  LINE_MAX_DEVIATION_RATIO: 0.06,
  LINE_MIN_DEVIATION_PX: 4,
  /** Endpoint gap (fraction of the diagonal) below which a path counts as closed. */
  CLOSED_GAP_RATIO: 0.22,
  CLOSED_GAP_MIN_PX: 12,
  /** Coefficient of variation of the normalised radius for ellipses (a square scores ≈ 0.11). */
  ELLIPSE_MAX_RADIAL_CV: 0.1,
  /**
   * In the fitted ellipse's unit frame the path simplifies to at least this
   * many vertices (a circle gives 8; polygons keep their true corner count).
   */
  ELLIPSE_MIN_VERTICES: 7,
  /** Radii within this relative difference are a circle. */
  CIRCLE_AXIS_RATIO: 0.15,
  /** Ellipse rotation below this snaps to axis-aligned (degrees). */
  ELLIPSE_AXIS_TOLERANCE_DEG: 10,
  /** RDP epsilon for corner detection, fraction of the diagonal. */
  CORNER_EPSILON_RATIO: 0.06,
  /** Corners closer than this fraction of the diagonal are merged. */
  CORNER_MERGE_RATIO: 0.08,
  /** Vertices whose interior angle is within this of 180° are not corners. */
  COLLINEAR_TOLERANCE_DEG: 20,
  /** Interior angle tolerance around 90° for rectangles. */
  RECT_ANGLE_TOLERANCE_DEG: 20,
  /** Rectangle rotation below this snaps to axis-aligned (degrees). */
  RECT_AXIS_TOLERANCE_DEG: 8,
  MAX_POLYGON_CORNERS: 8,
  /** Heart notch must dip at least this fraction of the height below the lobes. */
  HEART_MIN_NOTCH_RATIO: 0.12,
  /** Open polylines: at most this many vertices. */
  MAX_POLYLINE_VERTICES: 6,
  /** Open polylines: each segment at least this fraction of the total length. */
  POLYLINE_MIN_SEGMENT_RATIO: 0.1,
} as const;

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function centroid(points: readonly Point[]): Point {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const n = points.length || 1;
  return { x: sx / n, y: sy / n };
}

/** Is the path's endpoint gap small relative to its overall size? */
export function isClosedPath(points: readonly Point[], diagonal: number): boolean {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return false;
  return dist(first, last) <= Math.max(RECOGNITION.CLOSED_GAP_MIN_PX, RECOGNITION.CLOSED_GAP_RATIO * diagonal);
}

/**
 * Mean and coefficient of variation of each point's normalised radius
 * `√((u/rx)² + (v/ry)²)` in the ellipse's own frame. A perfect ellipse gives
 * mean 1 and cv 0.
 */
export function radialVariance(
  points: readonly Point[],
  center: Point,
  radiusX: number,
  radiusY: number,
  rotation = 0,
): { mean: number; cv: number } {
  if (points.length === 0 || radiusX <= 0 || radiusY <= 0) return { mean: 0, cv: Number.POSITIVE_INFINITY };
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const radii: number[] = [];
  for (const p of points) {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const u = dx * cos - dy * sin;
    const v = dx * sin + dy * cos;
    radii.push(Math.hypot(u / radiusX, v / radiusY));
  }
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  const variance = radii.reduce((a, r) => a + (r - mean) * (r - mean), 0) / radii.length;
  return { mean, cv: mean === 0 ? Number.POSITIVE_INFINITY : Math.sqrt(variance) / mean };
}

/**
 * PCA ellipse fit: the principal axis gives the rotation, the extents along
 * the rotated axes give the radii. Returns `null` for degenerate input.
 */
export function fitEllipse(points: readonly Point[]): EllipseShape | null {
  if (points.length < 3) return null;
  const c = centroid(points);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  let rotation = 0.5 * Math.atan2(2 * sxy, sxx - syy);

  const project = (theta: number) => {
    const cos = Math.cos(-theta);
    const sin = Math.sin(-theta);
    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (const p of points) {
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const u = dx * cos - dy * sin;
      const v = dx * sin + dy * cos;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    return { minU, maxU, minV, maxV };
  };

  // Nearly axis-aligned fits are reported as exactly axis-aligned.
  const axisTolerance = (RECOGNITION.ELLIPSE_AXIS_TOLERANCE_DEG * Math.PI) / 180;
  const foldedRotation = normalizeRadians(rotation);
  const distanceToAxis = Math.min(
    Math.abs(foldedRotation),
    Math.abs(Math.abs(foldedRotation) - Math.PI / 2),
    Math.abs(Math.abs(foldedRotation) - Math.PI),
  );
  if (distanceToAxis < axisTolerance) rotation = 0;

  const { minU, maxU, minV, maxV } = project(rotation);
  const radiusX = (maxU - minU) / 2;
  const radiusY = (maxV - minV) / 2;
  if (radiusX <= 0 || radiusY <= 0) return null;

  // Move the centre to the middle of the extents (rotated back to canvas space).
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const center: Point = { x: c.x + cu * cos - cv * sin, y: c.y + cu * sin + cv * cos };

  return { type: 'ellipse', center, radiusX, radiusY, rotation };
}

/**
 * Map points into an ellipse's own frame scaled to the unit circle, so an
 * eccentric ellipse and a circle look identical to the corner detector while
 * polygons keep their corners.
 */
export function normalizeToEllipse(points: readonly Point[], ellipse: EllipseShape): Point[] {
  const cos = Math.cos(-ellipse.rotation);
  const sin = Math.sin(-ellipse.rotation);
  return points.map((p) => {
    const dx = p.x - ellipse.center.x;
    const dy = p.y - ellipse.center.y;
    return { x: (dx * cos - dy * sin) / ellipse.radiusX, y: (dx * sin + dy * cos) / ellipse.radiusY };
  });
}

/**
 * Corner detection on a closed ring: start at the point farthest from the
 * centroid (almost always a true corner), simplify with RDP, merge clustered
 * vertices and drop near-collinear ones.
 */
export function detectCorners(ring: readonly Point[], diagonal: number): Point[] {
  if (ring.length < 3) return [...ring];
  const c = centroid(ring);
  let startIndex = 0;
  let best = -1;
  ring.forEach((p, i) => {
    const d = dist(p, c);
    if (d > best) {
      best = d;
      startIndex = i;
    }
  });
  const rotated = [...ring.slice(startIndex), ...ring.slice(0, startIndex)];
  const first = rotated[0];
  if (first) rotated.push(first);

  const simplified = simplifyRdp(rotated, RECOGNITION.CORNER_EPSILON_RATIO * diagonal);
  simplified.pop(); // duplicate closing vertex

  // Merge vertices closer than the merge radius (cyclic).
  const mergeRadius = RECOGNITION.CORNER_MERGE_RATIO * diagonal;
  const merged: Point[] = [];
  for (const p of simplified) {
    const prev = merged[merged.length - 1];
    if (prev && dist(prev, p) < mergeRadius) continue;
    merged.push(p);
  }
  const head = merged[0];
  const tail = merged[merged.length - 1];
  if (merged.length > 1 && head && tail && dist(head, tail) < mergeRadius) merged.pop();

  // Drop near-collinear vertices (cyclic); two passes settle chained removals.
  let corners = merged;
  for (let pass = 0; pass < 2; pass++) {
    if (corners.length <= 3) break;
    const next: Point[] = [];
    for (let i = 0; i < corners.length; i++) {
      const prev = corners[(i - 1 + corners.length) % corners.length];
      const cur = corners[i];
      const nxt = corners[(i + 1) % corners.length];
      if (!prev || !cur || !nxt) continue;
      if (interiorAngleDeg(cur, prev, nxt) < 180 - RECOGNITION.COLLINEAR_TOLERANCE_DEG) next.push(cur);
    }
    if (next.length === corners.length) break;
    corners = next;
  }
  return corners;
}

/** Four corners whose interior angles are all within `toleranceDeg` of 90°. */
export function isRectangle(corners: readonly Point[], toleranceDeg = RECOGNITION.RECT_ANGLE_TOLERANCE_DEG): boolean {
  if (corners.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const prev = corners[(i + 3) % 4];
    const cur = corners[i];
    const next = corners[(i + 1) % 4];
    if (!prev || !cur || !next) return false;
    if (Math.abs(interiorAngleDeg(cur, prev, next) - 90) > toleranceDeg) return false;
  }
  return true;
}

/**
 * Oriented rectangle through the sample cloud. The rotation comes from the
 * longest detected edge (folded into (-45°, 45°]); near-axis rotations snap
 * to zero so the result is the plain bounding box.
 */
export function fitRectangle(points: readonly Point[], corners: readonly Point[], angleSnapDeg?: number): RectangleShape {
  let rotation = 0;
  let longest = -1;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    if (!a || !b) continue;
    const len = dist(a, b);
    if (len > longest) {
      longest = len;
      rotation = angleOf(a, b);
    }
  }
  const quarter = Math.PI / 2;
  rotation = ((rotation % quarter) + quarter) % quarter;
  if (rotation > Math.PI / 4) rotation -= quarter;
  if (angleSnapDeg !== undefined) rotation = snapAngle(rotation, angleSnapDeg);
  if (Math.abs(rotation) < (RECOGNITION.RECT_AXIS_TOLERANCE_DEG * Math.PI) / 180) rotation = 0;

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  let minU = Number.POSITIVE_INFINITY;
  let maxU = Number.NEGATIVE_INFINITY;
  let minV = Number.POSITIVE_INFINITY;
  let maxV = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    const u = p.x * cos + p.y * sin;
    const v = -p.x * sin + p.y * cos;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  return {
    type: 'rectangle',
    center: { x: cu * cos - cv * sin, y: cu * sin + cv * cos },
    width: maxU - minU,
    height: maxV - minV,
    rotation,
  };
}

/**
 * Heart heuristic: two lobes at the top with a notch between them that dips
 * well below the lobe tops, and the lowest point near the horizontal centre.
 */
export function isHeart(points: readonly Point[]): boolean {
  if (points.length < 12) return false;
  const box = bboxFromPoints(points);
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  if (w <= 0 || h <= 0) return false;
  const cx = (box.minX + box.maxX) / 2;

  let leftTop = Number.POSITIVE_INFINITY;
  let rightTop = Number.POSITIVE_INFINITY;
  let notchY = Number.NEGATIVE_INFINITY;
  let bottom: Point | undefined;
  for (const p of points) {
    if (p.x < cx - 0.1 * w && p.y < leftTop) leftTop = p.y;
    if (p.x > cx + 0.1 * w && p.y < rightTop) rightTop = p.y;
    if (Math.abs(p.x - cx) <= 0.2 * w && p.y < box.minY + 0.45 * h && p.y > notchY) notchY = p.y;
    if (!bottom || p.y > bottom.y) bottom = p;
  }
  if (!Number.isFinite(leftTop) || !Number.isFinite(rightTop) || !Number.isFinite(notchY) || !bottom) return false;

  const lobesHigh = leftTop < box.minY + 0.3 * h && rightTop < box.minY + 0.3 * h;
  const notchDepth = notchY - Math.max(leftTop, rightTop);
  const bottomCentred = Math.abs(bottom.x - cx) <= 0.2 * w;
  return lobesHigh && notchDepth >= RECOGNITION.HEART_MIN_NOTCH_RATIO * h && bottomCentred;
}

function tryLine(raw: readonly Point[], length: number, angleSnapDeg?: number): Shape | null {
  const first = raw[0];
  const last = raw[raw.length - 1];
  if (!first || !last) return null;
  const chord = dist(first, last);
  if (chord < RECOGNITION.LINE_MIN_CHORD_RATIO * length) return null;
  const limit = Math.max(RECOGNITION.LINE_MIN_DEVIATION_PX, RECOGNITION.LINE_MAX_DEVIATION_RATIO * chord);
  for (const p of raw) {
    if (perpendicularDistance(p, first, last) > limit) return null;
  }
  const to = angleSnapDeg !== undefined ? snapLineEnd(first, last, angleSnapDeg) : last;
  return { type: 'line', from: first, to };
}

/**
 * Classify a raw freehand path. Returns `null` when nothing matches with
 * confidence, in which case the caller keeps the freehand stroke.
 */
export function recognizeShape(raw: readonly Point[], options: RecognitionOptions = {}): Shape | null {
  if (raw.length < 3) return null;
  const box = bboxFromPoints(raw);
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const diagonal = Math.hypot(width, height);
  if (diagonal < RECOGNITION.MIN_DIAGONAL_PX) return null;
  const length = polylineLength(raw);
  if (length === 0) return null;

  const line = tryLine(raw, length, options.angleSnapDeg);
  if (line) return line;

  // Uniform resampling makes every later statistic independent of pen speed.
  const points = resamplePolyline(raw, Math.max(2, length / 128));
  if (points.length < 3) return null;

  if (isClosedPath(raw, diagonal)) {
    const ellipse = fitEllipse(points);
    if (ellipse) {
      // Unit-circle diagonal is 2√2; corners are counted in that frame.
      const unitCorners = detectCorners(normalizeToEllipse(points, ellipse), 2 * Math.SQRT2);
      const { cv } = radialVariance(points, ellipse.center, ellipse.radiusX, ellipse.radiusY, ellipse.rotation);
      if (unitCorners.length >= RECOGNITION.ELLIPSE_MIN_VERTICES && cv < RECOGNITION.ELLIPSE_MAX_RADIAL_CV) {
        const { radiusX, radiusY } = ellipse;
        if (Math.abs(radiusX - radiusY) / Math.max(radiusX, radiusY) < RECOGNITION.CIRCLE_AXIS_RATIO) {
          const r = (radiusX + radiusY) / 2;
          return { type: 'ellipse', center: ellipse.center, radiusX: r, radiusY: r, rotation: 0 };
        }
        return ellipse;
      }
    }

    if (isHeart(points)) {
      return {
        type: 'heart',
        center: { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 },
        width,
        height,
      };
    }

    const corners = detectCorners(points, diagonal);
    if (corners.length === 4 && isRectangle(corners)) {
      return fitRectangle(points, corners, options.angleSnapDeg);
    }
    if (corners.length >= 3 && corners.length <= RECOGNITION.MAX_POLYGON_CORNERS) {
      return { type: 'polygon', points: corners };
    }
    return null;
  }

  // Open path: a short chain of straight segments (L, V, Z, staircase…).
  const vertices = simplifyRdp(points, 0.05 * diagonal);
  if (vertices.length >= 3 && vertices.length <= RECOGNITION.MAX_POLYLINE_VERTICES) {
    let minSegment = Number.POSITIVE_INFINITY;
    for (let i = 1; i < vertices.length; i++) {
      const a = vertices[i - 1];
      const b = vertices[i];
      if (a && b) minSegment = Math.min(minSegment, dist(a, b));
    }
    if (minSegment >= RECOGNITION.POLYLINE_MIN_SEGMENT_RATIO * length) {
      return { type: 'polyline', points: vertices };
    }
  }
  return null;
}
