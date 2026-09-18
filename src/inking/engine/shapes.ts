/**
 * Geometric primitives: construction helpers, flattening to polylines (for
 * hit-testing and bounds) and the coordinate-plane layout. Nothing here
 * touches the DOM so it is unit-testable and reusable by the renderer.
 */
import type {
  ArrowheadMode,
  BBox,
  CoordinatePlaneConfig,
  CoordinatePlaneShape,
  CurveKind,
  CurveShape,
  EllipseShape,
  GeometricStroke,
  GeometricTool,
  HeartShape,
  InkPointerType,
  LineShape,
  Point,
  RectangleShape,
  Shape,
  StrokeStyle,
} from '../types';
import { DEFAULT_AXIS_STEP, DEFAULT_CURVE_AMPLITUDE, DEFAULT_CURVE_CYCLES } from '../constants';
import { snapLineEnd } from './angles';
import { EMPTY_BBOX, bboxFromPoints, bboxUnion, expandBBox } from './geometry';
import { createStrokeId } from './ids';

export interface Segment {
  readonly a: Point;
  readonly b: Point;
}

export interface ArrowMarker {
  readonly tip: Point;
  /** Direction the arrow points, canvas radians. */
  readonly angle: number;
}

export interface TextLabel {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly align: CanvasTextAlign;
  readonly baseline: CanvasTextBaseline;
  readonly italic: boolean;
}

/** Arrowhead length for a given line width. */
export function arrowheadLength(size: number): number {
  return Math.max(10, size * 3.5);
}

/** Triangle vertices of an arrowhead whose tip is at `tip`, pointing along `angle`. */
export function arrowheadTriangle(tip: Point, angle: number, size: number): [Point, Point, Point] {
  const length = arrowheadLength(size);
  const halfWidth = length * 0.45;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const baseX = tip.x - dx * length;
  const baseY = tip.y - dy * length;
  return [
    tip,
    { x: baseX - dy * halfWidth, y: baseY + dx * halfWidth },
    { x: baseX + dy * halfWidth, y: baseY - dx * halfWidth },
  ];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Construction from drags
// ---------------------------------------------------------------------------

export function lineFromDrag(start: Point, end: Point, angleSnapDeg?: number): LineShape {
  const to = angleSnapDeg !== undefined ? snapLineEnd(start, end, angleSnapDeg) : end;
  return { type: 'line', from: start, to };
}

/**
 * A curve from the same drag a straight line would use. Its depth is a
 * fraction of the chord, so a long sweep bows proportionally rather than
 * flattening out, and the sign decides which side it falls on.
 */
export function curveFromDrag(
  start: Point,
  end: Point,
  kind: CurveKind,
  amplitudeRatio: number,
  cycles: number,
  flip: boolean,
  angleSnapDeg?: number,
): CurveShape {
  const to = angleSnapDeg !== undefined ? snapLineEnd(start, end, angleSnapDeg) : end;
  const length = Math.hypot(to.x - start.x, to.y - start.y);
  return {
    type: 'curve',
    kind,
    from: start,
    to,
    amplitude: length * amplitudeRatio * (flip ? -1 : 1),
    cycles: Math.max(1, Math.round(cycles)),
  };
}

/**
 * Unit vector along the chord and the left-hand normal to it. A degenerate
 * chord has no direction to speak of; the caller draws nothing in that case,
 * so any consistent answer will do.
 */
function chordFrame(shape: CurveShape): { length: number; ux: number; uy: number; nx: number; ny: number } {
  const dx = shape.to.x - shape.from.x;
  const dy = shape.to.y - shape.from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { length: 0, ux: 1, uy: 0, nx: 0, ny: -1 };
  const ux = dx / length;
  const uy = dy / length;
  return { length, ux, uy, nx: uy, ny: -ux };
}

/** A point at arc fraction `t` along the chord, displaced `offset` off it. */
function alongChord(shape: CurveShape, t: number, offset: number): Point {
  const { length, ux, uy, nx, ny } = chordFrame(shape);
  const d = t * length;
  return { x: shape.from.x + ux * d + nx * offset, y: shape.from.y + uy * d + ny * offset };
}

/** Samples per cycle of a wave; enough that the polyline reads as smooth. */
const WAVE_SEGMENTS_PER_CYCLE = 24;
/** Samples across a parabola's span. */
const PARABOLA_SEGMENTS = 48;

/**
 * The curve as a polyline. Everything downstream — canvas, hit tests, bounds,
 * the PDF exporter — consumes exactly these points, so what is exported is
 * literally what was drawn. A zigzag yields only its corners; the other two
 * are sampled densely enough to read as smooth at any sane zoom.
 */
export function curvePoints(shape: CurveShape): Point[] {
  const { length } = chordFrame(shape);
  if (length === 0) return [shape.from];
  const cycles = Math.max(1, Math.round(shape.cycles));

  if (shape.kind === 'zigzag') {
    // Corners only: the peaks alternate, with the endpoints back on the chord.
    const points: Point[] = [shape.from];
    for (let k = 0; k < cycles * 2; k++) {
      points.push(alongChord(shape, (2 * k + 1) / (4 * cycles), k % 2 === 0 ? shape.amplitude : -shape.amplitude));
    }
    points.push(shape.to);
    return points;
  }

  if (shape.kind === 'wave') {
    const steps = cycles * WAVE_SEGMENTS_PER_CYCLE;
    const points: Point[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      points.push(alongChord(shape, t, shape.amplitude * Math.sin(2 * Math.PI * cycles * t)));
    }
    return points;
  }

  // Parabola: a quadratic Bézier whose control point sits twice the amplitude
  // off the midpoint, because a quadratic reaches only half way to its control
  // at t = 0.5 — which puts the apex exactly on the amplitude.
  const control = alongChord(shape, 0.5, shape.amplitude * 2);
  const points: Point[] = [];
  for (let i = 0; i <= PARABOLA_SEGMENTS; i++) {
    const t = i / PARABOLA_SEGMENTS;
    const m = 1 - t;
    points.push({
      x: m * m * shape.from.x + 2 * m * t * control.x + t * t * shape.to.x,
      y: m * m * shape.from.y + 2 * m * t * control.y + t * t * shape.to.y,
    });
  }
  return points;
}

/**
 * The pointer-down point is the origin; the drag distance sets the half-axis
 * extents. Quadrant I grows up/right from the origin, four quadrants mirror.
 */
export function coordinatePlaneFromDrag(
  origin: Point,
  drag: Point,
  config: CoordinatePlaneConfig,
): CoordinatePlaneShape {
  return {
    type: 'coordinate-plane',
    origin,
    extentX: Math.max(1, Math.abs(drag.x - origin.x)),
    extentY: Math.max(1, Math.abs(drag.y - origin.y)),
    config,
  };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

export function rectangleCorners(r: RectangleShape): [Point, Point, Point, Point] {
  const cos = Math.cos(r.rotation);
  const sin = Math.sin(r.rotation);
  const hw = r.width / 2;
  const hh = r.height / 2;
  const corner = (sx: number, sy: number): Point => ({
    x: r.center.x + sx * hw * cos - sy * hh * sin,
    y: r.center.y + sx * hw * sin + sy * hh * cos,
  });
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}

export function ellipsePoints(e: EllipseShape, segments = 48): Point[] {
  const cos = Math.cos(e.rotation);
  const sin = Math.sin(e.rotation);
  const out: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const px = Math.cos(t) * e.radiusX;
    const py = Math.sin(t) * e.radiusY;
    out.push({ x: e.center.x + px * cos - py * sin, y: e.center.y + px * sin + py * cos });
  }
  return out;
}

/**
 * Classic parametric heart (x = 16 sin³t, y = 13 cos t − 5 cos 2t − 2 cos 3t − cos 4t),
 * normalised to the requested box. Starts at the bottom cusp.
 */
export function heartPoints(h: HeartShape, segments = 64): Point[] {
  const raw: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const t = Math.PI + (i / segments) * Math.PI * 2;
    const s = Math.sin(t);
    raw.push({
      x: 16 * s * s * s,
      y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
    });
  }
  const box = bboxFromPoints(raw);
  const sx = h.width / (box.maxX - box.minX);
  const sy = h.height / (box.maxY - box.minY);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  return raw.map((p) => ({ x: h.center.x + (p.x - cx) * sx, y: h.center.y + (p.y - cy) * sy }));
}

function closeRing(points: readonly Point[]): Point[] {
  const first = points[0];
  return first ? [...points, first] : [];
}

// ---------------------------------------------------------------------------
// Coordinate plane layout
// ---------------------------------------------------------------------------

export interface CoordinatePlaneGeometry {
  readonly axes: readonly Segment[];
  readonly arrows: readonly ArrowMarker[];
  readonly ticks: readonly Segment[];
  readonly grid: readonly Segment[];
  readonly labels: readonly TextLabel[];
  /** Outer frame of the plane, for hit-testing and bounds. */
  readonly frame: readonly Point[];
  readonly fontPx: number;
}

/**
 * A tick's printed value.
 *
 * `index * step` is exactly the arithmetic binary floating point is worst at:
 * three steps of 0.1 lands on 0.30000000000000004, and a plane labelled that
 * way is unusable. Rounding through `toPrecision(12)` and back drops the
 * error — 12 significant figures is far more than any step a person types,
 * and far fewer than the 17 it takes to expose the representation — and
 * `parseFloat` then strips the trailing zeros `toPrecision` leaves behind.
 */
export function formatTickValue(index: number, step: number): string {
  const value = index * step;
  if (!Number.isFinite(value)) return '0';
  return String(Number.parseFloat(value.toPrecision(12)));
}

/** A plane's step per grid cell, defaulting to whole cells for older shapes. */
export function axisSteps(config: CoordinatePlaneConfig): { x: number; y: number } {
  const usable = (step: number | undefined): number =>
    step !== undefined && Number.isFinite(step) && step > 0 ? step : DEFAULT_AXIS_STEP;
  return { x: usable(config.stepX), y: usable(config.stepY) };
}

export function coordinatePlaneGeometry(shape: CoordinatePlaneShape): CoordinatePlaneGeometry {
  const { origin: o, extentX, extentY, config } = shape;
  const four = config.mode === 'four-quadrant';
  const divisions = Math.max(1, Math.round(config.divisions));
  const minExtent = Math.min(extentX, extentY);
  const fontPx = clamp(minExtent * 0.09, 11, 18);
  const tick = clamp(minExtent * 0.03, 4, 9);

  const minX = four ? o.x - extentX : o.x;
  const maxX = o.x + extentX;
  const minY = o.y - extentY;
  const maxY = four ? o.y + extentY : o.y;

  const axes: Segment[] = [
    { a: { x: minX, y: o.y }, b: { x: maxX, y: o.y } },
    { a: { x: o.x, y: maxY }, b: { x: o.x, y: minY } },
  ];
  const arrows: ArrowMarker[] = [
    { tip: { x: maxX, y: o.y }, angle: 0 },
    { tip: { x: o.x, y: minY }, angle: -Math.PI / 2 },
  ];
  if (four) {
    arrows.push({ tip: { x: minX, y: o.y }, angle: Math.PI }, { tip: { x: o.x, y: maxY }, angle: Math.PI / 2 });
  }

  const ticks: Segment[] = [];
  const grid: Segment[] = [];
  const labels: TextLabel[] = [];
  const stepX = extentX / divisions;
  const stepY = extentY / divisions;
  // Pixels per cell above; what a cell is *worth* here. The two are
  // independent: changing the step renumbers the plane without redrawing it.
  const steps = axisSteps(config);

  for (let i = four ? -divisions : 1; i <= divisions; i++) {
    if (i === 0) continue;
    const x = o.x + i * stepX;
    const y = o.y - i * stepY;
    if (config.showGrid) {
      grid.push({ a: { x, y: minY }, b: { x, y: maxY } }, { a: { x: minX, y }, b: { x: maxX, y } });
    }
    // The outermost tick would sit under the arrowhead.
    if (Math.abs(i) === divisions) continue;
    ticks.push(
      { a: { x, y: o.y - tick }, b: { x, y: o.y + tick } },
      { a: { x: o.x - tick, y }, b: { x: o.x + tick, y } },
    );
    if (config.tickLabels) {
      labels.push(
        { text: formatTickValue(i, steps.x), x, y: o.y + tick + 2, align: 'center', baseline: 'top', italic: false },
        { text: formatTickValue(i, steps.y), x: o.x - tick - 3, y, align: 'right', baseline: 'middle', italic: false },
      );
    }
  }

  labels.push(
    { text: config.xLabel, x: maxX + fontPx * 0.5, y: o.y, align: 'left', baseline: 'middle', italic: true },
    { text: config.yLabel, x: o.x, y: minY - fontPx * 0.4, align: 'center', baseline: 'bottom', italic: true },
  );
  if (config.tickLabels) {
    labels.push({ text: '0', x: o.x - tick - 3, y: o.y + tick + 2, align: 'right', baseline: 'top', italic: false });
  }

  const frame: Point[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];

  return { axes, arrows, ticks, grid, labels, frame, fontPx };
}

// ---------------------------------------------------------------------------
// Flattening / bounds
// ---------------------------------------------------------------------------

export function shapeIsClosed(shape: Shape): boolean {
  return shape.type !== 'line' && shape.type !== 'polyline' && shape.type !== 'curve';
}

/** Straight-segment approximation of a shape, for hit tests and bounds. */
export function shapeToPolylines(shape: Shape): Point[][] {
  switch (shape.type) {
    case 'line':
      return [[shape.from, shape.to]];
    case 'polyline':
      return [[...shape.points]];
    case 'polygon':
      return [closeRing(shape.points)];
    case 'rectangle':
      return [closeRing(rectangleCorners(shape))];
    case 'ellipse':
      return [closeRing(ellipsePoints(shape))];
    case 'heart':
      return [closeRing(heartPoints(shape))];
    case 'curve':
      return [curvePoints(shape)];
    case 'coordinate-plane': {
      const g = coordinatePlaneGeometry(shape);
      return [...g.axes.map((s) => [s.a, s.b]), closeRing(g.frame)];
    }
  }
}

/** Bounds of a shape padded for line width, arrowheads and labels. */
export function shapeBBox(shape: Shape, style: StrokeStyle): BBox {
  let box: BBox = EMPTY_BBOX;
  for (const polyline of shapeToPolylines(shape)) {
    if (polyline.length > 0) box = bboxUnion(box, bboxFromPoints(polyline));
  }
  let pad = style.size / 2 + 2;
  if (shape.type === 'coordinate-plane') {
    const g = coordinatePlaneGeometry(shape);
    pad += Math.max(arrowheadLength(style.size), g.fontPx * 3);
  } else if (!shapeIsClosed(shape) && style.arrowheads !== 'none') {
    pad += arrowheadLength(style.size);
  }
  return expandBBox(box, pad);
}

export interface GeometricStrokeInit {
  readonly tool: GeometricTool;
  readonly shape: Shape;
  readonly style: StrokeStyle;
  readonly pointerType: InkPointerType;
  readonly createdAt?: number;
  readonly id?: string;
}

export function createGeometricStroke(init: GeometricStrokeInit): GeometricStroke {
  return {
    kind: 'geometric',
    id: init.id ?? createStrokeId(),
    tool: init.tool,
    shape: init.shape,
    style: init.style,
    bbox: shapeBBox(init.shape, init.style),
    pointerType: init.pointerType,
    createdAt: init.createdAt ?? performance.now(),
  };
}

/** Which ends of an open shape get arrowheads under `mode`. */
export function arrowheadEnds(mode: ArrowheadMode): { start: boolean; end: boolean } {
  return { start: mode === 'both', end: mode !== 'none' };
}

// ---------------------------------------------------------------------------
// Editing a committed curve
// ---------------------------------------------------------------------------

/**
 * What the lasso toolbar can change about an already-drawn line or curve.
 * Every field is optional: the toolbar sends only what the user touched.
 */
export interface CurveEdit {
  readonly curve?: 'straight' | CurveKind;
  /** Depth as a fraction of the chord, as the drag tool expresses it. */
  readonly amplitudeRatio?: number;
  readonly cycles?: number;
  readonly flip?: boolean;
}

/**
 * The parameters a shape was built from, recovered from the shape itself.
 *
 * Nothing extra is stored to make this work: a curve keeps its endpoints,
 * its signed amplitude and its cycle count, and depth is just the amplitude
 * measured against the chord. So a curve committed at any point in the past
 * can be taken apart and rebuilt.
 */
export function curveParams(shape: LineShape | CurveShape): Required<CurveEdit> {
  if (shape.type === 'line') {
    return { curve: 'straight', amplitudeRatio: DEFAULT_CURVE_AMPLITUDE, cycles: DEFAULT_CURVE_CYCLES, flip: false };
  }
  const length = Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y);
  return {
    curve: shape.kind,
    amplitudeRatio: length > 0 ? Math.abs(shape.amplitude) / length : DEFAULT_CURVE_AMPLITUDE,
    cycles: shape.cycles,
    flip: shape.amplitude < 0,
  };
}

/** True for the shapes the curve editor can act on. */
export function isEditableCurve(shape: Shape): shape is LineShape | CurveShape {
  return shape.type === 'line' || shape.type === 'curve';
}

/**
 * Rebuild a line or curve with some of its parameters changed, keeping its
 * endpoints. Straight and curved are the same edit in both directions: a
 * straight line has no depth of its own, so it borrows the defaults until
 * the user moves the sliders.
 */
export function reshapeCurve(shape: LineShape | CurveShape, edit: CurveEdit): LineShape | CurveShape {
  const current = curveParams(shape);
  const next = { ...current, ...edit };
  if (next.curve === 'straight') return { type: 'line', from: shape.from, to: shape.to };
  const length = Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y);
  return {
    type: 'curve',
    kind: next.curve,
    from: shape.from,
    to: shape.to,
    amplitude: length * next.amplitudeRatio * (next.flip ? -1 : 1),
    cycles: Math.max(1, Math.round(next.cycles)),
  };
}
