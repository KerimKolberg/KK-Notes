/**
 * Stroke → PDF drawing operations, independent of pdf-lib so the conversion
 * can be unit-tested. `export.ts` executes the ops.
 *
 * Coordinates: `project.toPdf` maps page-local px to PDF user space. SVG
 * paths are emitted in "flipped user space" (`x`, `-y`) so pdf-lib's
 * `drawSvgPath` at origin (0, 0) — which inverts y — lands them exactly.
 */
import { arrowheadEnds, arrowheadTriangle, coordinatePlaneGeometry, ellipsePoints, heartPoints, rectangleCorners, type Segment } from '../inking/engine/shapes';
import { freehandCentreline, dashArray, trimForArrowheads } from '../inking/engine/renderer';
import { endTangent, startTangent } from '../inking/engine/simplify';
import { getStrokeOutline } from '../inking/engine/strokeOutline';
import type { FreehandStroke, GeometricStroke, Point, Shape, Stroke, StrokeStyle } from '../inking/types';
import { parseColor } from '../document/templates';

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface PdfColor extends RgbColor {
  /** 0..1 */
  readonly alpha: number;
}

export type PdfBlend = 'normal' | 'multiply';

export interface PathOp {
  readonly kind: 'path';
  /** SVG path in flipped user space. */
  readonly d: string;
  readonly fill?: RgbColor;
  readonly stroke?: RgbColor;
  /** Points. */
  readonly lineWidth?: number;
  readonly dash?: readonly number[];
  readonly opacity: number;
  readonly blend: PdfBlend;
}

export interface LineOp {
  readonly kind: 'line';
  readonly start: Point;
  readonly end: Point;
  readonly thickness: number;
  readonly color: RgbColor;
  readonly dash?: readonly number[];
  readonly opacity: number;
  readonly blend: PdfBlend;
}

export interface RectangleOp {
  readonly kind: 'rectangle';
  /** Bottom-left corner after rotation, user space. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Degrees, counter-clockwise (PDF convention). */
  readonly rotateDeg: number;
  readonly borderColor: RgbColor;
  readonly borderWidth: number;
  readonly dash?: readonly number[];
  readonly opacity: number;
  readonly blend: PdfBlend;
}

export interface EllipseOp {
  readonly kind: 'ellipse';
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
  readonly rotateDeg: number;
  readonly borderColor: RgbColor;
  readonly borderWidth: number;
  readonly dash?: readonly number[];
  readonly opacity: number;
  readonly blend: PdfBlend;
}

export interface TextOp {
  readonly kind: 'text';
  readonly text: string;
  /** Baseline-left, user space. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: RgbColor;
  readonly italic: boolean;
  readonly opacity: number;
}

export type PdfOp = PathOp | LineOp | RectangleOp | EllipseOp | TextOp;

export interface PdfProjection {
  /** Page-local px → PDF user space. */
  readonly toPdf: (p: Point) => Point;
  /** Points per page px. */
  readonly scale: number;
  /** Display rotation of the target page (0 unless it is an imported, rotated PDF page). */
  readonly pageRotation: number;
}

// ---------------------------------------------------------------------------
// Numbers, colours, paths
// ---------------------------------------------------------------------------

/** Compact, sign-safe number formatting for path data. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 1000) / 1000;
  const text = rounded.toFixed(3).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
}

/** CSS colour → PDF rgb (0..1) + alpha. Unknown colours become black. */
export function cssColorToPdf(color: string): PdfColor {
  const rgb = parseColor(color);
  let alpha = 1;
  const m = color.trim().match(/^rgba?\(\s*\d+[\s,]+\d+[\s,]+\d+[\s,/]+([\d.]+)\s*\)$/i);
  if (m?.[1] !== undefined) alpha = Math.min(1, Math.max(0, Number(m[1])));
  if (!rgb) return { r: 0, g: 0, b: 0, alpha };
  return { r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255, alpha };
}

/** `M x y L x y … [Z]` through already-projected (flipped) points. */
export function pointsToSvgPath(points: readonly Point[], close: boolean): string {
  const first = points[0];
  if (!first) return '';
  let d = `M ${fmt(first.x)} ${fmt(first.y)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p) d += ` L ${fmt(p.x)} ${fmt(p.y)}`;
  }
  return close ? `${d} Z` : d;
}

/** Only absolute M/L/Z commands with finite numbers: what pdf-lib's parser needs. */
export function isValidPdfSvgPath(d: string): boolean {
  if (!/^M /.test(d)) return false;
  return /^(?:[MLZ](?: -?\d+(?:\.\d+)?){0,2} ?)+$/.test(d.replace(/\s+/g, ' ').trim());
}

/** Page-local px point → flipped PDF space for `drawSvgPath` at (0, 0). */
export function toSvgSpace(project: PdfProjection, p: Point): Point {
  const q = project.toPdf(p);
  return { x: q.x, y: -q.y };
}

function polylineToPath(project: PdfProjection, points: readonly Point[], close: boolean): string {
  return pointsToSvgPath(points.map((p) => toSvgSpace(project, p)), close);
}

/** perfect-freehand outline polygon of a freehand stroke as a closed SVG path (page-local units). */
export function freehandOutlinePath(stroke: FreehandStroke): string {
  const outline = getStrokeOutline(stroke.points, stroke.style, true).map(([x, y]) => ({ x, y }));
  return pointsToSvgPath(outline, true);
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function blendOf(style: StrokeStyle): PdfBlend {
  return style.compositeOperation === 'multiply' ? 'multiply' : 'normal';
}

function dashFor(style: StrokeStyle, scale: number): number[] | undefined {
  const dash = dashArray(style.pattern, style.size);
  return dash.length === 0 ? undefined : dash.map((v) => Math.max(0.01, v * scale));
}

function arrowPaths(points: readonly Point[], style: StrokeStyle, project: PdfProjection): PathOp[] {
  const { start, end } = arrowheadEnds(style.arrowheads);
  if (!start && !end) return [];
  const color = cssColorToPdf(style.color);
  const window = Math.max(12, style.size * 3);
  const ops: PathOp[] = [];
  const first = points[0];
  const last = points[points.length - 1];
  const push = (tip: Point, angle: number): void => {
    ops.push({
      kind: 'path',
      d: polylineToPath(project, arrowheadTriangle(tip, angle, style.size), true),
      fill: color,
      opacity: style.opacity * color.alpha,
      blend: blendOf(style),
    });
  };
  if (end && last) {
    const a = endTangent(points, window);
    if (a !== null) push(last, a);
  }
  if (start && first) {
    const a = startTangent(points, window);
    if (a !== null) push(first, a);
  }
  return ops;
}

function strokedPolyline(points: readonly Point[], style: StrokeStyle, project: PdfProjection, close: boolean): PathOp {
  const color = cssColorToPdf(style.color);
  const dash = dashFor(style, project.scale);
  return {
    kind: 'path',
    d: polylineToPath(project, points, close),
    stroke: color,
    lineWidth: style.size * project.scale,
    ...(dash ? { dash } : {}),
    opacity: style.opacity * color.alpha,
    blend: blendOf(style),
  };
}

// ---------------------------------------------------------------------------
// Strokes
// ---------------------------------------------------------------------------

export function freehandToPdfOps(stroke: FreehandStroke, project: PdfProjection): PdfOp[] {
  if (stroke.style.compositeOperation === 'destination-out') return []; // pixel eraser: not representable as vectors
  const style = stroke.style;
  const color = cssColorToPdf(style.color);
  const arrows = arrowPaths(stroke.points, style, project);
  if (style.pattern === 'solid') {
    const outline = getStrokeOutline(stroke.points, style, true).map(([x, y]) => ({ x, y }));
    const body: PathOp = {
      kind: 'path',
      d: polylineToPath(project, outline, true),
      fill: color,
      opacity: style.opacity * color.alpha,
      blend: blendOf(style),
    };
    return [body, ...arrows];
  }
  const line = trimForArrowheads(freehandCentreline(stroke.points, style), style);
  return line.length >= 2 ? [strokedPolyline(line, style, project, false), ...arrows] : arrows;
}

function rotateAbout(p: Point, c: Point, rad: number): Point {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

function shapeToPdfOps(shape: Shape, style: StrokeStyle, project: PdfProjection): PdfOp[] {
  const color = cssColorToPdf(style.color);
  const opacity = style.opacity * color.alpha;
  const dash = dashFor(style, project.scale);
  const blend = blendOf(style);
  const width = style.size * project.scale;
  const flat = project.pageRotation === 0;

  switch (shape.type) {
    case 'line': {
      const pts = trimForArrowheads([shape.from, shape.to], style);
      const a = pts[0];
      const b = pts[pts.length - 1];
      const ops: PdfOp[] = [];
      if (a && b && pts.length >= 2) {
        ops.push({
          kind: 'line',
          start: project.toPdf(a),
          end: project.toPdf(b),
          thickness: width,
          color,
          ...(dash ? { dash } : {}),
          opacity,
          blend,
        });
      }
      return [...ops, ...arrowPaths([shape.from, shape.to], style, project)];
    }
    case 'polyline': {
      const pts = trimForArrowheads(shape.points, style);
      return [...(pts.length >= 2 ? [strokedPolyline(pts, style, project, false)] : []), ...arrowPaths(shape.points, style, project)];
    }
    case 'polygon':
      return [strokedPolyline(shape.points, style, project, true)];
    case 'rectangle': {
      if (!flat) return [strokedPolyline(rectangleCorners(shape), style, project, true)];
      // pdf-lib rotates about the bottom-left corner; place that corner explicitly.
      const c = project.toPdf(shape.center);
      const w = shape.width * project.scale;
      const h = shape.height * project.scale;
      const rad = -shape.rotation; // css clockwise → pdf counter-clockwise
      const bl = rotateAbout({ x: c.x - w / 2, y: c.y - h / 2 }, c, rad);
      return [
        {
          kind: 'rectangle',
          x: bl.x,
          y: bl.y,
          width: w,
          height: h,
          rotateDeg: (rad * 180) / Math.PI,
          borderColor: color,
          borderWidth: width,
          ...(dash ? { dash } : {}),
          opacity,
          blend,
        },
      ];
    }
    case 'ellipse': {
      if (!flat) return [strokedPolyline(ellipsePoints(shape, 64), style, project, true)];
      const c = project.toPdf(shape.center);
      return [
        {
          kind: 'ellipse',
          cx: c.x,
          cy: c.y,
          rx: shape.radiusX * project.scale,
          ry: shape.radiusY * project.scale,
          rotateDeg: (-shape.rotation * 180) / Math.PI,
          borderColor: color,
          borderWidth: width,
          ...(dash ? { dash } : {}),
          opacity,
          blend,
        },
      ];
    }
    case 'heart':
      return [strokedPolyline(heartPoints(shape, 96), style, project, true)];
    case 'coordinate-plane': {
      const g = coordinatePlaneGeometry(shape);
      const seg = (s: Segment, thickness: number, alpha: number): LineOp => ({
        kind: 'line',
        start: project.toPdf(s.a),
        end: project.toPdf(s.b),
        thickness,
        color,
        opacity: alpha,
        blend,
      });
      const ops: PdfOp[] = [];
      for (const s of g.grid) ops.push(seg(s, Math.max(0.5, style.size * 0.3) * project.scale, opacity * 0.25));
      for (const s of g.axes) ops.push(seg(s, width, opacity));
      for (const s of g.ticks) ops.push(seg(s, Math.max(0.75, style.size * 0.6) * project.scale, opacity));
      for (const a of g.arrows) {
        ops.push({
          kind: 'path',
          d: polylineToPath(project, arrowheadTriangle(a.tip, a.angle, style.size), true),
          fill: color,
          opacity,
          blend,
        });
      }
      for (const label of g.labels) {
        // Approximate the canvas text anchor: shift by half the estimated width / height.
        const size = g.fontPx * project.scale;
        const estWidth = label.text.length * size * 0.55;
        const anchor = project.toPdf({ x: label.x, y: label.y });
        let x = anchor.x;
        if (label.align === 'center') x -= estWidth / 2;
        else if (label.align === 'right') x -= estWidth;
        let y = anchor.y;
        if (label.baseline === 'middle') y -= size * 0.35;
        else if (label.baseline === 'top') y -= size * 0.8;
        ops.push({ kind: 'text', text: label.text, x, y, size, color, italic: label.italic, opacity });
      }
      return ops;
    }
  }
}

export function geometricToPdfOps(stroke: GeometricStroke, project: PdfProjection): PdfOp[] {
  return shapeToPdfOps(stroke.shape, stroke.style, project);
}

export function strokeToPdfOps(stroke: Stroke, project: PdfProjection): PdfOp[] {
  return stroke.kind === 'freehand' ? freehandToPdfOps(stroke, project) : geometricToPdfOps(stroke, project);
}
