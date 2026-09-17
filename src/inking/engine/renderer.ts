/**
 * Canvas rendering for both stroke kinds.
 *
 * - Freehand strokes with a solid pattern are perfect-freehand polygons filled
 *   with `ctx.fill()`.
 * - Anything dashed/dotted, and every geometric primitive, is a stroked path:
 *   `ctx.stroke()` with `setLineDash`, round caps/joins.
 * - Arrowheads are filled triangles appended at the ends of open paths.
 *
 * Committed strokes never change, so their `RenderPlan` (the Path2D objects)
 * is memoised in a WeakMap keyed by the stroke object.
 */
import type { InkPoint, Point, Shape, Stroke, StrokePattern, StrokeStyle, CoordinatePlaneShape } from '../types';
import type { AngleArc } from './angleHud';
import type { LaserRun } from './laser';
import { TAU, normalizeRadians } from './angles';
import {
  arrowheadEnds,
  arrowheadLength,
  arrowheadTriangle,
  coordinatePlaneGeometry,
  heartPoints,
  rectangleCorners,
  type Segment,
} from './shapes';
import { endTangent, resamplePolyline, simplifyRdp, startTangent } from './simplify';
import { getStrokeOutline, outlineToPath2D } from './strokeOutline';

/**
 * `desynchronized` lets Chromium present the canvas outside the compositor's
 * vsync pipeline, shaving a frame or more of pen-to-ink latency on Windows.
 * Browsers that don't support it ignore the hint.
 */
const CONTEXT_ATTRIBUTES: CanvasRenderingContext2DSettings = {
  alpha: true,
  desynchronized: true,
};

const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const HUD_COLOR = '#2563eb';

/**
 * Every drawing routine accepts either an on-screen or an OffscreenCanvas
 * context so the same code renders live pages, thumbnails and worker-side
 * snapshots.
 */
export type InkContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function get2dContext(canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
  return canvas ? canvas.getContext('2d', CONTEXT_ATTRIBUTES) : null;
}

/** Dash array for a pattern at a given line width (empty = solid). */
export function dashArray(pattern: StrokePattern, width: number): number[] {
  const w = Math.max(1, width);
  switch (pattern) {
    case 'solid':
      return [];
    case 'dashed':
      return [3 * w, 2 * w];
    case 'dotted':
      // A (near) zero-length dash with round caps renders as a dot of diameter w.
      return [0.01, 2 * w];
    case 'dash-dot':
      return [3 * w, 1.5 * w, 0.01, 1.5 * w];
    case 'long-dash':
      return [6 * w, 3 * w];
  }
}

interface RenderPlan {
  /** Filled with the stroke colour: solid freehand bodies and arrowheads. */
  readonly fills: readonly Path2D[];
  /** Stroked with the line width and dash pattern. */
  readonly outline: Path2D | null;
}

const planCache = new WeakMap<Stroke, RenderPlan>();

function polylinePath(points: readonly Point[], close = false): Path2D {
  const path = new Path2D();
  const first = points[0];
  if (!first) return path;
  path.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p) path.lineTo(p.x, p.y);
  }
  if (close) path.closePath();
  return path;
}

/** Remove `amount` of arc length from the end of a polyline. */
function trimEnd(points: readonly Point[], amount: number): Point[] {
  const out = [...points];
  let remaining = amount;
  while (out.length >= 2 && remaining > 0) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (!last || !prev) break;
    const seg = Math.hypot(last.x - prev.x, last.y - prev.y);
    if (seg <= remaining) {
      out.pop();
      remaining -= seg;
    } else {
      const t = (seg - remaining) / seg;
      out[out.length - 1] = { x: prev.x + (last.x - prev.x) * t, y: prev.y + (last.y - prev.y) * t };
      remaining = 0;
    }
  }
  return out;
}

/** Shorten arrowed ends so a translucent shaft never shows through the head. */
export function trimForArrowheads(points: readonly Point[], style: StrokeStyle): Point[] {
  const { start, end } = arrowheadEnds(style.arrowheads);
  const trim = arrowheadLength(style.size) * 0.8;
  let out: Point[] = [...points];
  if (end) out = trimEnd(out, trim);
  if (start) out = trimEnd(out.reverse(), trim).reverse();
  return out;
}

/** Arrowhead triangles for an open path, using the tangent at each arrowed end. */
function arrowheadFills(points: readonly Point[], style: StrokeStyle): Path2D[] {
  const { start, end } = arrowheadEnds(style.arrowheads);
  if (!start && !end) return [];
  const window = Math.max(12, style.size * 3);
  const fills: Path2D[] = [];
  const first = points[0];
  const last = points[points.length - 1];
  if (end && last) {
    const angle = endTangent(points, window);
    if (angle !== null) fills.push(polylinePath(arrowheadTriangle(last, angle, style.size), true));
  }
  if (start && first) {
    const angle = startTangent(points, window);
    if (angle !== null) fills.push(polylinePath(arrowheadTriangle(first, angle, style.size), true));
  }
  return fills;
}

/**
 * Centreline for patterned freehand strokes: RDP removes sensor jitter, then
 * arc-length resampling yields equidistant vertices so the dash pattern is
 * uniform regardless of pen speed.
 */
export function freehandCentreline(points: readonly InkPoint[], style: StrokeStyle): Point[] {
  const simplified = simplifyRdp(points, Math.max(1, style.size * 0.35));
  return resamplePolyline(simplified, Math.max(1.5, style.size * 0.5));
}

function buildFreehandPlan(points: readonly InkPoint[], style: StrokeStyle, complete: boolean): RenderPlan {
  const isEraser = style.compositeOperation === 'destination-out';
  if (isEraser || (style.pattern === 'solid' && style.arrowheads === 'none')) {
    return { fills: [outlineToPath2D(getStrokeOutline(points, style, complete))], outline: null };
  }
  const arrows = arrowheadFills(points, style);
  if (style.pattern === 'solid') {
    return { fills: [outlineToPath2D(getStrokeOutline(points, style, complete)), ...arrows], outline: null };
  }
  return { fills: arrows, outline: polylinePath(trimForArrowheads(freehandCentreline(points, style), style)) };
}

function buildShapePlan(shape: Shape, style: StrokeStyle): RenderPlan {
  switch (shape.type) {
    case 'line': {
      const pts = [shape.from, shape.to];
      return { fills: arrowheadFills(pts, style), outline: polylinePath(trimForArrowheads(pts, style)) };
    }
    case 'polyline':
      return {
        fills: arrowheadFills(shape.points, style),
        outline: polylinePath(trimForArrowheads(shape.points, style)),
      };
    case 'polygon':
      return { fills: [], outline: polylinePath(shape.points, true) };
    case 'rectangle':
      return { fills: [], outline: polylinePath(rectangleCorners(shape), true) };
    case 'ellipse': {
      const path = new Path2D();
      path.ellipse(shape.center.x, shape.center.y, shape.radiusX, shape.radiusY, shape.rotation, 0, TAU);
      return { fills: [], outline: path };
    }
    case 'heart':
      return { fills: [], outline: outlineToPath2D(heartPoints(shape).map((p) => [p.x, p.y] as const)) };
    case 'coordinate-plane':
      // Drawn directly: it needs several line widths and text.
      return { fills: [], outline: null };
  }
}

function paintPlan(ctx: InkContext, plan: RenderPlan, style: StrokeStyle): void {
  ctx.save();
  ctx.globalCompositeOperation = style.compositeOperation;
  ctx.globalAlpha = style.opacity;
  ctx.fillStyle = style.color;
  ctx.strokeStyle = style.color;
  if (plan.outline) {
    ctx.lineWidth = style.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash(dashArray(style.pattern, style.size));
    ctx.stroke(plan.outline);
    ctx.setLineDash([]);
  }
  for (const fill of plan.fills) {
    // Outlines self-intersect at sharp turns; nonzero winding keeps them solid.
    ctx.fill(fill, 'nonzero');
  }
  ctx.restore();
}

function strokeSegments(ctx: InkContext, segments: readonly Segment[], width: number, alpha: number): void {
  if (segments.length === 0) return;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (const s of segments) {
    ctx.moveTo(s.a.x, s.a.y);
    ctx.lineTo(s.b.x, s.b.y);
  }
  ctx.stroke();
}

function drawCoordinatePlane(ctx: InkContext, shape: CoordinatePlaneShape, style: StrokeStyle): void {
  const g = coordinatePlaneGeometry(shape);
  ctx.save();
  ctx.globalCompositeOperation = style.compositeOperation;
  ctx.strokeStyle = style.color;
  ctx.fillStyle = style.color;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.setLineDash([]);

  strokeSegments(ctx, g.grid, Math.max(0.75, style.size * 0.3), style.opacity * 0.25);
  strokeSegments(ctx, g.axes, style.size, style.opacity);
  strokeSegments(ctx, g.ticks, Math.max(1, style.size * 0.6), style.opacity);

  ctx.globalAlpha = style.opacity;
  for (const arrow of g.arrows) {
    ctx.fill(polylinePath(arrowheadTriangle(arrow.tip, arrow.angle, style.size), true));
  }
  for (const label of g.labels) {
    ctx.font = `${label.italic ? 'italic ' : ''}${g.fontPx}px ${UI_FONT}`;
    ctx.textAlign = label.align;
    ctx.textBaseline = label.baseline;
    ctx.fillText(label.text, label.x, label.y);
  }
  ctx.restore();
}

/** Render a committed stroke (memoised geometry). */
export function drawStroke(ctx: InkContext, stroke: Stroke): void {
  if (stroke.kind === 'geometric' && stroke.shape.type === 'coordinate-plane') {
    drawCoordinatePlane(ctx, stroke.shape, stroke.style);
    return;
  }
  let plan = planCache.get(stroke);
  if (!plan) {
    plan =
      stroke.kind === 'freehand'
        ? buildFreehandPlan(stroke.points, stroke.style, true)
        : buildShapePlan(stroke.shape, stroke.style);
    planCache.set(stroke, plan);
  }
  paintPlan(ctx, plan, stroke.style);
}

/** Render an in-progress freehand stroke (no end cap, not cached). */
export function drawLiveStroke(
  ctx: InkContext,
  points: readonly InkPoint[],
  style: StrokeStyle,
): void {
  if (points.length === 0) return;
  paintPlan(ctx, buildFreehandPlan(points, style, false), style);
}

/** Render a shape that is not (yet) a committed stroke. */
export function drawShape(ctx: InkContext, shape: Shape, style: StrokeStyle): void {
  if (shape.type === 'coordinate-plane') drawCoordinatePlane(ctx, shape, style);
  else paintPlan(ctx, buildShapePlan(shape, style), style);
}

/** Clear the whole surface. Expects the DPR transform to be set on `ctx`. */
export function clearSurface(ctx: InkContext, cssWidth: number, cssHeight: number): void {
  ctx.clearRect(0, 0, cssWidth, cssHeight);
}

/** Full redraw of the committed layer, skipping any ids in `hidden`. */
export function replayStrokes(
  ctx: InkContext,
  strokes: readonly Stroke[],
  cssWidth: number,
  cssHeight: number,
  hidden?: ReadonlySet<string>,
): void {
  clearSurface(ctx, cssWidth, cssHeight);
  for (const stroke of strokes) {
    if (hidden && hidden.has(stroke.id)) continue;
    drawStroke(ctx, stroke);
  }
}

/** Ring that follows the pointer while an eraser tool is active. */
export function drawEraserCursor(
  ctx: InkContext,
  x: number,
  y: number,
  radius: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(17, 17, 17, 0.6)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.beginPath();
  ctx.arc(x, y, Math.max(radius, 2), 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** In-progress lasso loop: dashed outline, closing segment and a faint fill. */
export function drawLassoPreview(ctx: InkContext, points: readonly Point[]): void {
  if (points.length < 2) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = HUD_COLOR;
  ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
  const path = polylinePath(points, true);
  ctx.fill(path);
  ctx.setLineDash([6, 4]);
  ctx.stroke(path);
  ctx.restore();
}

/**
 * Laser passes, outermost first: a wide soft glow, the coloured beam, and a
 * bright core that reads as light rather than ink.
 */
const LASER_PASSES: readonly { readonly width: number; readonly alpha: number; readonly color?: string }[] = [
  { width: 2.8, alpha: 0.3 },
  { width: 1, alpha: 1 },
  { width: 0.3, alpha: 0.5, color: 'rgba(255, 255, 255, 0.95)' },
];

/**
 * Disappearing laser trail. Drawn on the live layer only — these runs are
 * never part of a stroke, so nothing here ever reaches the document.
 */
export function drawLaserTrail(ctx: InkContext, runs: readonly LaserRun[]): void {
  if (runs.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.setLineDash([]);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const paths = runs.map((run) => polylinePath(run.points, false));
  for (const pass of LASER_PASSES) {
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const path = paths[i];
      if (!run || !path) continue;
      const width = run.width * pass.width;
      if (width < 0.4) continue;
      ctx.globalAlpha = Math.min(1, run.alpha * pass.alpha);
      ctx.lineWidth = width;
      ctx.strokeStyle = pass.color ?? run.color;
      ctx.stroke(path);
    }
  }
  ctx.restore();
}

/** Non-committed angle overlay: arcs plus haloed degree read-outs. */
export function drawAngleHud(ctx: InkContext, arcs: readonly AngleArc[]): void {
  if (arcs.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.lineCap = 'round';
  ctx.font = `12px ${UI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const arc of arcs) {
    let labelX = arc.vertex.x;
    let labelY = arc.vertex.y - 14;
    if (arc.radius > 0) {
      const delta = normalizeRadians(arc.endAngle - arc.startAngle);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = HUD_COLOR;
      ctx.beginPath();
      ctx.arc(arc.vertex.x, arc.vertex.y, arc.radius, arc.startAngle, arc.startAngle + delta, delta < 0);
      ctx.stroke();
      const mid = arc.startAngle + delta / 2;
      const offset = arc.radius + 14;
      labelX = arc.vertex.x + Math.cos(mid) * offset;
      labelY = arc.vertex.y + Math.sin(mid) * offset;
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.strokeText(arc.label, labelX, labelY);
    ctx.fillStyle = HUD_COLOR;
    ctx.fillText(arc.label, labelX, labelY);
  }
  ctx.restore();
}
