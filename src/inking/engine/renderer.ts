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
import {
  GRAIN_TILE,
  PENCIL_MAX_CHUNKS,
  chunkRanges,
  grainTileData,
  meanPressureTilt,
  pencilAlpha,
  pencilWidthScale,
  streamlinePoints,
  strokeBrush,
} from './brushes';
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

/**
 * One painting operation of a stroke. `fill` is the body or an arrowhead,
 * `texture` fills the same path with the brush's grain pattern, and `bleed`
 * strokes a soft wide edge around it (marker / wet brush).
 */
interface PlanPass {
  readonly path: Path2D;
  readonly kind: 'fill' | 'texture' | 'bleed';
  /** Multiplies the style's opacity. */
  readonly alpha: number;
  /** `bleed` only: line width in drawing units. */
  readonly width?: number;
  /** `bleed` only: Gaussian blur radius in drawing units. */
  readonly blur?: number;
}

interface RenderPlan {
  readonly passes: readonly PlanPass[];
  /** Stroked with the line width and dash pattern. */
  readonly outline: Path2D | null;
}

/** Plain body fill, the shape of every stroke before brushes got involved. */
function fillPass(path: Path2D, alpha = 1): PlanPass {
  return { path, kind: 'fill', alpha };
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

/**
 * The body of a freehand stroke, as the passes its brush asks for:
 *
 * - a pencil is painted in overlapping chunks, each with its own opacity
 *   taken from the pressure and tilt of the samples in it, and filled with
 *   the grain pattern instead of a flat colour;
 * - a marker or wet brush gets a wide, low-alpha edge pass before the body,
 *   which reads as ink bleeding into the paper;
 * - everything else is the single filled outline it always was.
 */
function freehandBody(points: readonly InkPoint[], style: StrokeStyle, complete: boolean): PlanPass[] {
  const brush = strokeBrush(style);
  const smooth = brush ? brush.smoothOutline : true;
  if (brush?.texture === 'pencil') {
    const passes: PlanPass[] = [];
    // Smooth once for the whole stroke, then let each chunk take its samples
    // as they are, so neighbouring chunks share their boundary exactly.
    const smoothed = streamlinePoints(points, style.streamline);
    const chunked = { ...style, streamline: 0 };
    const ranges = chunkRanges(smoothed.length, PENCIL_MAX_CHUNKS);
    ranges.forEach(([start, end], i) => {
      const slice = smoothed.slice(start, end);
      const { pressure, tilt } = meanPressureTilt(slice);
      // The lean of the pencil over this run widens the nib and lightens it.
      const scale = pencilWidthScale(tilt, brush.tiltResponse);
      const chunkStyle = scale === 1 ? chunked : { ...chunked, size: style.size * scale };
      // Interior ends are flat and untapered, so neighbouring chunks tile edge
      // to edge: rounded ends would overlap and paint that seam twice.
      const path = outlineToPath2D(
        getStrokeOutline(slice, chunkStyle, complete || end < smoothed.length, {
          ...(i > 0 ? { start: false } : {}),
          ...(i < ranges.length - 1 ? { end: false } : {}),
        }),
        smooth,
      );
      passes.push({ path, kind: 'texture', alpha: pencilAlpha(pressure, tilt, brush.tiltResponse) });
    });
    if (passes.length > 0) return passes;
  }
  const path = outlineToPath2D(getStrokeOutline(points, style, complete), smooth);
  const passes: PlanPass[] = [];
  if (brush && brush.bleed > 0) {
    // Two graduated passes under the body: a faint wide halo and a stronger
    // narrow one, so the edge fades out instead of ending in a hard band.
    // A soft brush blurs them on top of that, which is what turns the halo
    // from a band into the gradient of ink spreading through wet paper.
    const width = style.size * brush.bleed * 2;
    const blur = style.size * brush.softness;
    passes.push({ path, kind: 'bleed', alpha: brush.bleedAlpha * 0.5, width, blur });
    passes.push({ path, kind: 'bleed', alpha: brush.bleedAlpha, width: width * 0.5, blur: blur * 0.5 });
  }
  passes.push(fillPass(path));
  return passes;
}

function buildFreehandPlan(points: readonly InkPoint[], style: StrokeStyle, complete: boolean): RenderPlan {
  const isEraser = style.compositeOperation === 'destination-out';
  if (isEraser || (style.pattern === 'solid' && style.arrowheads === 'none')) {
    return { passes: freehandBody(points, style, complete), outline: null };
  }
  const arrows = arrowheadFills(points, style).map((path) => fillPass(path));
  if (style.pattern === 'solid') {
    return { passes: [...freehandBody(points, style, complete), ...arrows], outline: null };
  }
  return { passes: arrows, outline: polylinePath(trimForArrowheads(freehandCentreline(points, style), style)) };
}

function buildShapePlan(shape: Shape, style: StrokeStyle): RenderPlan {
  switch (shape.type) {
    case 'line': {
      const pts = [shape.from, shape.to];
      return { passes: arrowheadFills(pts, style).map((p) => fillPass(p)), outline: polylinePath(trimForArrowheads(pts, style)) };
    }
    case 'polyline':
      return {
        passes: arrowheadFills(shape.points, style).map((p) => fillPass(p)),
        outline: polylinePath(trimForArrowheads(shape.points, style)),
      };
    case 'polygon':
      return { passes: [], outline: polylinePath(shape.points, true) };
    case 'rectangle':
      return { passes: [], outline: polylinePath(rectangleCorners(shape), true) };
    case 'ellipse': {
      const path = new Path2D();
      path.ellipse(shape.center.x, shape.center.y, shape.radiusX, shape.radiusY, shape.rotation, 0, TAU);
      return { passes: [], outline: path };
    }
    case 'heart':
      return { passes: [], outline: outlineToPath2D(heartPoints(shape).map((p) => [p.x, p.y] as const)) };
    case 'coordinate-plane':
      // Drawn directly: it needs several line widths and text.
      return { passes: [], outline: null };
  }
}

/**
 * Grain tiles, one per colour: white noise masked to the stroke colour. Built
 * lazily so importing the renderer stays safe where no canvas exists (tests),
 * and capped because a tile is only 64² px but there is no reason to keep one
 * per colour the user ever tried.
 */
const grainTiles = new Map<string, CanvasImageSource | null>();
const MAX_GRAIN_TILES = 12;

function createTileCanvas(size: number): { canvas: CanvasImageSource; ctx: InkContext } | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    return ctx ? { canvas, ctx } : null;
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
}

function grainTile(color: string): CanvasImageSource | null {
  const cached = grainTiles.get(color);
  if (cached !== undefined) return cached;
  let tile: CanvasImageSource | null = null;
  const made = createTileCanvas(GRAIN_TILE);
  if (made) {
    const image = new ImageData(grainTileData(), GRAIN_TILE, GRAIN_TILE);
    made.ctx.putImageData(image, 0, 0);
    // Tint the mask: keep the noise alpha, replace the white with the ink.
    made.ctx.globalCompositeOperation = 'source-in';
    made.ctx.fillStyle = color;
    made.ctx.fillRect(0, 0, GRAIN_TILE, GRAIN_TILE);
    tile = made.canvas;
  }
  if (grainTiles.size >= MAX_GRAIN_TILES) grainTiles.clear();
  grainTiles.set(color, tile);
  return tile;
}

function grainPattern(ctx: InkContext, color: string): CanvasPattern | null {
  const tile = grainTile(color);
  return tile ? ctx.createPattern(tile, 'repeat') : null;
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
  for (const pass of plan.passes) {
    ctx.globalAlpha = Math.min(1, style.opacity * pass.alpha);
    if (pass.kind === 'bleed') {
      ctx.lineWidth = pass.width ?? style.size * 0.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([]);
      // `filter` is resolved in the current transform, so the radius stays the
      // same fraction of the stroke at any DPR or zoom. Browsers without it
      // ignore the assignment and just draw the unblurred halo.
      const blur = pass.blur ?? 0;
      if (blur > 0) ctx.filter = `blur(${blur}px)`;
      ctx.stroke(pass.path);
      if (blur > 0) ctx.filter = 'none';
      continue;
    }
    if (pass.kind === 'texture') {
      ctx.fillStyle = grainPattern(ctx, style.color) ?? style.color;
    }
    // Outlines self-intersect at sharp turns; nonzero winding keeps them solid.
    ctx.fill(pass.path, 'nonzero');
    if (pass.kind === 'texture') ctx.fillStyle = style.color;
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
