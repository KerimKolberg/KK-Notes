/**
 * Lasso selection: point-in-polygon containment for both stroke kinds and
 * the pure stroke transforms the selection box applies. Transforms keep
 * stroke ids, so a selection stays valid across undo / redo of its own edits.
 */
import type { BBox, GeometricStroke, Point, Shape, Stroke, StrokePattern } from '../types';
import { createStrokeId } from './ids';
import { bboxFromPoints, bboxIntersects, bboxUnion, EMPTY_BBOX } from './geometry';
import { inLassoFilter, LASSO_ALL_LAYERS, type LassoFilter } from './lassoFilter';
import { curveParams, isEditableCurve, reshapeCurve, shapeBBox, shapeToPolylines, type CurveEdit } from './shapes';
import { freehandBBox } from './strokeBuilder';

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

/**
 * A lasso path as a closed polygon.
 *
 * The loop is closed by joining the last sample back to the first — the edge
 * the user never draws, because they lift the pen where they lift it. Every
 * containment test needs that edge to exist, so it is made explicit here
 * rather than left to each caller to remember.
 *
 * A trailing duplicate of the first point is dropped: it would be a
 * zero-length edge, and `closeLasso` is called on paths that may already have
 * been closed.
 */
export function closeLasso(points: readonly Point[]): readonly Point[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 3) return points;
  return first.x === last.x && first.y === last.y ? points.slice(0, -1) : points;
}

/**
 * Ray casting, **non-zero winding**: cast a ray from `p` towards +x and sum
 * the signed crossings of the closed loop. Inside means the total is not zero.
 *
 * Winding rather than the even–odd rule because a lasso is drawn by hand and
 * hands backtrack. Under even–odd, a loop that crosses its own path carves
 * the overlap back out again — draw a circle and let the end of the stroke
 * run past the start, and the sliver you just double-enclosed counts as
 * *outside*, so the strokes in it are silently not selected. Winding treats
 * anything the path went round as enclosed however many times it went round
 * it, which is what someone scribbling a loop means.
 *
 * The two rules agree exactly on any loop that does not cross itself, so
 * nothing about a careful lasso changes.
 *
 * Crossings use the half-open rule (an edge counts when exactly one endpoint
 * is above the ray), so a vertex exactly on the ray is counted once rather
 * than twice.
 */
export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  const ring = closeLasso(polygon);
  const n = ring.length;
  if (n < 3) return false;
  let winding = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    const upward = a.y <= p.y && b.y > p.y;
    const downward = b.y <= p.y && a.y > p.y;
    if (!upward && !downward) continue;
    const xAtY = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (p.x >= xAtY) continue;
    winding += upward ? 1 : -1;
  }
  return winding !== 0;
}

export function polygonBBox(polygon: readonly Point[]): BBox {
  return polygon.length === 0 ? EMPTY_BBOX : bboxFromPoints(polygon);
}

/** Evenly pick up to `max` points (always keeping the first and last). */
function subsample(points: readonly Point[], max: number): Point[] {
  if (points.length <= max) return [...points];
  const out: Point[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    const p = points[Math.round(i * step)];
    if (p) out.push(p);
  }
  return out;
}

function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** `count` points spread evenly along a polyline's length (endpoints included). */
function resampleByLength(points: readonly Point[], count: number): Point[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [];
  if (points.length === 1 || count <= 1) return [first];
  const total = polylineLength(points);
  if (total === 0) return [first];
  const out: Point[] = [first];
  const step = total / (count - 1);
  let segmentStart = 0;
  let i = 0;
  for (let k = 1; k < count - 1; k++) {
    const target = k * step;
    let a = points[i];
    let b = points[i + 1];
    let segment = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
    while (i < points.length - 2 && segmentStart + segment < target) {
      segmentStart += segment;
      i++;
      a = points[i];
      b = points[i + 1];
      segment = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
    }
    if (!a || !b) break;
    const t = segment > 0 ? Math.min(1, (target - segmentStart) / segment) : 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  out.push(last);
  return out;
}

/**
 * Representative points of a stroke for containment tests: the raw samples
 * of a freehand stroke, or points spread evenly along the outline of a
 * geometric shape (so the verdict reflects how much of the outline is
 * inside, not how many corners happen to be).
 */
export function strokeSamplePoints(stroke: Stroke, maxSamples = 64): Point[] {
  if (stroke.kind === 'freehand') return subsample(stroke.points, maxSamples);
  const polylines = shapeToPolylines(stroke.shape).filter((p) => p.length > 0);
  const lengths = polylines.map(polylineLength);
  const total = lengths.reduce((sum, l) => sum + l, 0);
  const out: Point[] = [];
  polylines.forEach((polyline, i) => {
    const share = total > 0 ? (lengths[i] ?? 0) / total : 1 / polylines.length;
    out.push(...resampleByLength(polyline, Math.max(2, Math.round(maxSamples * share))));
  });
  return out;
}

/** Fraction of a stroke's sample vertices that must fall inside the lasso. */
export const LASSO_MIN_INSIDE_FRACTION = 0.5;

/**
 * How much of a stroke the lasso has to catch.
 *
 * `enclose` is the careful one: the whole stroke has to be inside the loop,
 * so a lasso drawn around a word takes the word and not the line it sits on.
 * `touch` selects anything the loop so much as crosses, which makes a stroke
 * dragged straight through a diagram a valid selection gesture — far quicker
 * on a phone, where drawing an accurate loop around something small is the
 * hard part.
 */
export type LassoMode = 'enclose' | 'touch';

export const LASSO_MODES: readonly { readonly id: LassoMode; readonly label: string; readonly hint: string }[] = [
  { id: 'enclose', label: 'Enclose entirely', hint: 'Only strokes that fall (almost) completely inside the loop' },
  { id: 'touch', label: 'Partial touch', hint: 'Anything the loop crosses — draw a line through it to select it' },
];

export interface LassoOptions {
  readonly mode?: LassoMode;
  readonly filter?: LassoFilter;
}

/**
 * Is a stroke enclosed by the lasso? Bounding boxes reject quickly; the
 * verdict comes from the share of sampled vertices inside the polygon.
 */
export function isStrokeEnclosed(
  stroke: Stroke,
  polygon: readonly Point[],
  lassoBounds: BBox = polygonBBox(polygon),
  minInsideFraction = LASSO_MIN_INSIDE_FRACTION,
): boolean {
  if (polygon.length < 3) return false;
  if (!bboxIntersects(stroke.bbox, lassoBounds)) return false;
  const samples = strokeSamplePoints(stroke);
  if (samples.length === 0) return false;
  let inside = 0;
  for (const p of samples) if (pointInPolygon(p, polygon)) inside++;
  return inside / samples.length >= minInsideFraction;
}

/**
 * How much of a stroke has to be inside for "enclose entirely" to take it.
 *
 * Not 1. Demanding every last sample point sounds like what "entirely" means,
 * but a lasso is drawn by hand around ink that has width, and the failure mode
 * is brutal: loop a word, clip the tail of one descender by two pixels, and
 * the whole word is left behind with nothing to say why. At 85% a stroke has
 * to be substantially inside — a stroke merely straddling the edge is still
 * refused — while a near miss on one end is forgiven.
 */
export const LASSO_ENCLOSE_FRACTION = 0.85;

/**
 * Is a stroke enclosed by the lasso?
 *
 * The padded bounding box has to *overlap* the loop's, which is only a cheap
 * reject; the verdict is the share of sample points inside the polygon
 * itself, since a box says nothing about a concave loop. Note the box is not
 * required to be contained: that was the old rule, and it meant the halo of
 * padding around a thick stroke — half its width, plus any arrowhead — could
 * fail a stroke whose every sample was well inside the loop.
 */
export function isStrokeWhollyInside(
  stroke: Stroke,
  polygon: readonly Point[],
  lassoBounds: BBox = polygonBBox(polygon),
  fraction = LASSO_ENCLOSE_FRACTION,
): boolean {
  if (polygon.length < 3) return false;
  if (!bboxIntersects(stroke.bbox, lassoBounds)) return false;
  const samples = strokeSamplePoints(stroke);
  if (samples.length === 0) return false;
  let inside = 0;
  for (const p of samples) if (pointInPolygon(p, polygon)) inside++;
  return inside / samples.length >= fraction;
}

/** Which side of the line a→b the point c falls on: >0 left, <0 right, 0 collinear. */
function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Is `p` inside the bounding box of segment a–b, given it is already collinear with it? */
function withinSegment(a: Point, b: Point, p: Point): boolean {
  return (
    p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)
  );
}

/**
 * Do the closed segments a–b and c–d meet?
 *
 * The usual orientation test: the segments cross when each straddles the
 * other's line. A zero orientation means a point lies *on* the other line, so
 * the collinear and touching-endpoint cases are settled by asking whether it
 * also lies within that segment's extent — which matters here, because a
 * lasso drawn exactly along a ruled line is a real gesture, not a degenerate
 * one to be swept under an epsilon.
 */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && withinSegment(c, d, a)) return true;
  if (d2 === 0 && withinSegment(c, d, b)) return true;
  if (d3 === 0 && withinSegment(a, b, c)) return true;
  if (d4 === 0 && withinSegment(a, b, d)) return true;
  return false;
}

/** Does the polyline cross the closed polygon's outline anywhere? */
export function polylineCrossesPolygon(points: readonly Point[], polygon: readonly Point[]): boolean {
  if (points.length < 2 || polygon.length < 2) return false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    for (let j = 0, k = polygon.length - 1; j < polygon.length; k = j++) {
      const c = polygon[k];
      const e = polygon[j];
      if (!c || !e) continue;
      if (segmentsIntersect(a, b, c, e)) return true;
    }
  }
  return false;
}

/** How finely the lasso loop itself is sampled for the crossing test. */
const LASSO_EDGE_SAMPLES = 160;

/**
 * Does the lasso touch this stroke at all?
 *
 * Two ways to qualify, because neither covers the other: a point of the
 * stroke inside the loop catches a small stroke swallowed whole by a big
 * loop, and a crossing catches a big shape that a small loop was dragged
 * across — there, every sample of the shape is outside the loop and only the
 * segments give it away.
 */
export function strokeTouchesLasso(
  stroke: Stroke,
  polygon: readonly Point[],
  lassoBounds: BBox = polygonBBox(polygon),
): boolean {
  if (polygon.length < 2) return false;
  if (!bboxIntersects(stroke.bbox, lassoBounds)) return false;
  const samples = strokeSamplePoints(stroke);
  if (samples.length === 0) return false;
  if (polygon.length >= 3) {
    for (const p of samples) if (pointInPolygon(p, polygon)) return true;
  }
  return polylineCrossesPolygon(samples, subsample(polygon, LASSO_EDGE_SAMPLES));
}

/** Ids of the strokes the lasso caught, in document order. */
export function selectStrokesInLasso(
  strokes: readonly Stroke[],
  polygon: readonly Point[],
  options: LassoOptions = {},
): string[] {
  const { mode = 'enclose', filter = LASSO_ALL_LAYERS } = options;
  const bounds = polygonBBox(polygon);
  const ids: string[] = [];
  for (const stroke of strokes) {
    if (!inLassoFilter(stroke, filter)) continue;
    const caught = mode === 'touch' ? strokeTouchesLasso(stroke, polygon, bounds) : isStrokeWhollyInside(stroke, polygon, bounds);
    if (caught) ids.push(stroke.id);
  }
  return ids;
}

/** Union of the selected strokes' (padded) bounding boxes, or `null` when empty. */
export function selectionBounds(strokes: readonly Stroke[]): BBox | null {
  let box: BBox | null = null;
  for (const stroke of strokes) box = box ? bboxUnion(box, stroke.bbox) : stroke.bbox;
  return box;
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

export type StrokeTransform =
  | { readonly kind: 'translate'; readonly dx: number; readonly dy: number }
  | { readonly kind: 'scale'; readonly origin: Point; readonly sx: number; readonly sy: number };

export function transformPoint<P extends Point>(p: P, t: StrokeTransform): P {
  if (t.kind === 'translate') return { ...p, x: p.x + t.dx, y: p.y + t.dy };
  return { ...p, x: t.origin.x + (p.x - t.origin.x) * t.sx, y: t.origin.y + (p.y - t.origin.y) * t.sy };
}

export function transformBBox(box: BBox, t: StrokeTransform): BBox {
  const a = transformPoint({ x: box.minX, y: box.minY }, t);
  const b = transformPoint({ x: box.maxX, y: box.maxY }, t);
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

function scaleFactors(t: StrokeTransform): { sx: number; sy: number } {
  return t.kind === 'scale' ? { sx: Math.abs(t.sx), sy: Math.abs(t.sy) } : { sx: 1, sy: 1 };
}

function transformShape(shape: Shape, t: StrokeTransform): Shape {
  const { sx, sy } = scaleFactors(t);
  switch (shape.type) {
    case 'line':
      return { ...shape, from: transformPoint(shape.from, t), to: transformPoint(shape.to, t) };
    case 'polyline':
    case 'polygon':
      return { ...shape, points: shape.points.map((p) => transformPoint(p, t)) };
    case 'rectangle':
      return { ...shape, center: transformPoint(shape.center, t), width: shape.width * sx, height: shape.height * sy };
    case 'ellipse':
      return { ...shape, center: transformPoint(shape.center, t), radiusX: shape.radiusX * sx, radiusY: shape.radiusY * sy };
    case 'heart':
      return { ...shape, center: transformPoint(shape.center, t), width: shape.width * sx, height: shape.height * sy };
    case 'curve':
      // The amplitude is measured across the chord, so it follows whichever
      // axis the chord runs least along — the mean is the honest answer for a
      // diagonal, and is exact for a curve lying on either axis.
      return {
        ...shape,
        from: transformPoint(shape.from, t),
        to: transformPoint(shape.to, t),
        amplitude: shape.amplitude * ((sx + sy) / 2),
      };
    case 'coordinate-plane':
      return { ...shape, origin: transformPoint(shape.origin, t), extentX: shape.extentX * sx, extentY: shape.extentY * sy };
  }
}

/** Apply a transform, keeping the id. Uniform scales also scale the line width. */
export function transformStroke(stroke: Stroke, t: StrokeTransform): Stroke {
  const { sx, sy } = scaleFactors(t);
  const widthFactor = t.kind === 'scale' ? Math.sqrt(sx * sy) : 1;
  const style = widthFactor === 1 ? stroke.style : { ...stroke.style, size: Math.max(0.5, stroke.style.size * widthFactor) };
  if (stroke.kind === 'freehand') {
    const points = stroke.points.map((p) => transformPoint(p, t));
    return { ...stroke, points, style, bbox: freehandBBox(points, style) };
  }
  const shape = transformShape(stroke.shape, t);
  return { ...stroke, shape, style, bbox: shapeBBox(shape, style) };
}

/** New stroke list with the selected strokes transformed in place (same ids, same order). */
export function transformStrokes(strokes: readonly Stroke[], ids: ReadonlySet<string>, t: StrokeTransform): Stroke[] {
  return strokes.map((s) => (ids.has(s.id) ? transformStroke(s, t) : s));
}

export interface StyleChange {
  readonly color?: string;
  readonly size?: number;
  readonly pattern?: StrokePattern;
}

/** Recolour / resize the selected strokes (pixel-eraser strokes keep their colour). */
export function restyleStrokes(strokes: readonly Stroke[], ids: ReadonlySet<string>, change: StyleChange): Stroke[] {
  return strokes.map((s) => {
    if (!ids.has(s.id)) return s;
    const isEraser = s.kind === 'freehand' && s.tool === 'eraser-pixel';
    const style = {
      ...s.style,
      ...(change.color !== undefined && !isEraser ? { color: change.color } : {}),
      ...(change.size !== undefined ? { size: Math.max(0.5, change.size) } : {}),
      ...(change.pattern !== undefined ? { pattern: change.pattern } : {}),
    };
    if (style === s.style) return s;
    if (s.kind === 'freehand') return { ...s, style, bbox: freehandBBox(s.points, style) };
    return { ...s, style, bbox: shapeBBox(s.shape, style) };
  });
}

/**
 * Re-cut the selected lines and curves with new parameters, keeping their
 * ids and their endpoints. Anything else in the selection is left alone, so
 * a mixed selection edits only the parts the toolbar is offering to edit.
 */
export function reshapeStrokes(strokes: readonly Stroke[], ids: ReadonlySet<string>, edit: CurveEdit): Stroke[] {
  let changed = false;
  const next = strokes.map((stroke) => {
    if (!ids.has(stroke.id) || stroke.kind !== 'geometric' || !isEditableCurve(stroke.shape)) return stroke;
    const shape = reshapeCurve(stroke.shape, edit);
    changed = true;
    return { ...stroke, shape, bbox: shapeBBox(shape, stroke.style) };
  });
  return changed ? next : [...strokes];
}

/** The parameters shared by every editable curve in a selection, if any. */
export function selectionCurveParams(strokes: readonly Stroke[]): Required<CurveEdit> | null {
  const editable = strokes.filter(
    (s): s is GeometricStroke => s.kind === 'geometric' && isEditableCurve(s.shape),
  );
  const first = editable[0];
  if (!first || !isEditableCurve(first.shape)) return null;
  return curveParams(first.shape);
}

export const DUPLICATE_OFFSET: Point = { x: 16, y: 16 };

/** Append offset copies of the selected strokes; returns the new list and the copies' ids. */
export function duplicateStrokes(
  strokes: readonly Stroke[],
  ids: ReadonlySet<string>,
  offset: Point = DUPLICATE_OFFSET,
): { strokes: Stroke[]; ids: string[] } {
  const copies: Stroke[] = [];
  for (const s of strokes) {
    if (!ids.has(s.id)) continue;
    const moved = transformStroke(s, { kind: 'translate', dx: offset.x, dy: offset.y });
    copies.push({ ...moved, id: createStrokeId(), createdAt: performance.now() } as Stroke);
  }
  return { strokes: [...strokes, ...copies], ids: copies.map((c) => c.id) };
}

export function removeStrokesById(strokes: readonly Stroke[], ids: ReadonlySet<string>): Stroke[] {
  return strokes.filter((s) => !ids.has(s.id));
}

// ---------------------------------------------------------------------------
// Selection-box geometry
// ---------------------------------------------------------------------------

/**
 * Corners scale both axes at once; edges scale the one they face and leave
 * the other alone, which is how a selection gets stretched or squashed.
 */
export type ScaleHandle = 'nw' | 'ne' | 'se' | 'sw' | 'n' | 'e' | 's' | 'w';
export const SCALE_HANDLES: readonly ScaleHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Axes a handle is free to scale. */
export function handleAxes(handle: ScaleHandle): { x: boolean; y: boolean } {
  return {
    x: handle.includes('w') || handle.includes('e'),
    y: handle.includes('n') || handle.includes('s'),
  };
}

/**
 * The fixed point of the scale: the corner or edge opposite the handle. On the
 * axis a handle does not scale the coordinate is arbitrary, because a factor
 * of 1 leaves every point on that axis where it is.
 */
export function scaleAnchor(bounds: BBox, handle: ScaleHandle): Point {
  return {
    x: handle.includes('w') ? bounds.maxX : bounds.minX,
    y: handle.includes('n') ? bounds.maxY : bounds.minY,
  };
}

/**
 * Scale transform for dragging `handle` to `pointer`. A corner is uniform by
 * default (the dominant axis wins) unless `free`; an edge is always a pure 1D
 * scale, which is the point of having it. Never collapses below `minSize` px
 * on either axis.
 */
export function scaleFromHandle(bounds: BBox, handle: ScaleHandle, pointer: Point, free: boolean, minSize = 8): StrokeTransform {
  const origin = scaleAnchor(bounds, handle);
  const axes = handleAxes(handle);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const signX = handle.includes('w') ? -1 : 1;
  const signY = handle.includes('n') ? -1 : 1;
  let sx = axes.x && width > 0 ? Math.max(minSize, signX * (pointer.x - origin.x)) / width : 1;
  let sy = axes.y && height > 0 ? Math.max(minSize, signY * (pointer.y - origin.y)) / height : 1;
  if (!free && axes.x && axes.y) {
    const uniform = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    sx = uniform;
    sy = uniform;
  }
  return { kind: 'scale', origin, sx, sy };
}
