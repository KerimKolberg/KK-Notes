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
        { text: String(i), x, y: o.y + tick + 2, align: 'center', baseline: 'top', italic: false },
        { text: String(i), x: o.x - tick - 3, y, align: 'right', baseline: 'middle', italic: false },
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
  return shape.type !== 'line' && shape.type !== 'polyline';
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
