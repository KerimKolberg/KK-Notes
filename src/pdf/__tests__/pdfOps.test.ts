import { describe, expect, it } from 'vitest';
import { curvePoints } from '../../inking/engine/shapes';
import type { CurveKind, FreehandStroke, GeometricStroke, StrokeStyle } from '../../inking/types';
import {
  cssColorToPdf,
  fmt,
  freehandOutlinePath,
  isValidPdfSvgPath,
  pointsToSvgPath,
  strokeToPdfOps,
  type PdfProjection,
} from '../pdfOps';

const style: StrokeStyle = {
  color: '#1f1f24',
  size: 4,
  opacity: 1,
  compositeOperation: 'source-over',
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false,
  taperStart: 0,
  taperEnd: 0,
  pattern: 'solid',
  arrowheads: 'none',
};

const freehand: FreehandStroke = {
  kind: 'freehand',
  id: 'f',
  tool: 'pen',
  points: Array.from({ length: 12 }, (_, i) => ({ x: 100 + i * 10, y: 200 + Math.sin(i / 2) * 8, pressure: 0.5 })),
  style,
  bbox: { minX: 90, minY: 180, maxX: 220, maxY: 220 },
  pointerType: 'pen',
  createdAt: 0,
};

/** Template-page projection: 794 px wide page, 72/96 points per px, y flipped. */
const k = 0.75;
const H = 1123 * k;
const flat: PdfProjection = { toPdf: (p) => ({ x: p.x * k, y: H - p.y * k }), scale: k, pageRotation: 0 };
const rotated: PdfProjection = { ...flat, pageRotation: 90 };

describe('path syntax', () => {
  it('formats numbers compactly and never emits -0', () => {
    expect(fmt(1.23456)).toBe('1.235');
    expect(fmt(-0.0001)).toBe('0');
    expect(fmt(10)).toBe('10');
    expect(fmt(Number.NaN)).toBe('0');
  });

  it('builds M/L/Z paths that pdf-lib can parse', () => {
    const d = pointsToSvgPath([{ x: 0, y: 0 }, { x: 10.5, y: -2 }, { x: 3, y: 4 }], true);
    expect(d).toBe('M 0 0 L 10.5 -2 L 3 4 Z');
    expect(isValidPdfSvgPath(d)).toBe(true);
    expect(isValidPdfSvgPath(pointsToSvgPath([{ x: 1, y: 1 }, { x: 2, y: 2 }], false))).toBe(true);
    expect(isValidPdfSvgPath('M 1 1 C 2 2')).toBe(false);
    expect(isValidPdfSvgPath('L 1 1')).toBe(false);
    expect(pointsToSvgPath([], true)).toBe('');
  });

  it('freehand outlines become closed polygons', () => {
    const d = freehandOutlinePath(freehand);
    expect(d.startsWith('M ')).toBe(true);
    expect(d.endsWith(' Z')).toBe(true);
    expect(isValidPdfSvgPath(d)).toBe(true);
    expect((d.match(/ L /g) ?? []).length).toBeGreaterThan(10);
  });
});

describe('colours', () => {
  it('parses hex and rgba into 0..1 channels with alpha', () => {
    expect(cssColorToPdf('#ff0000')).toEqual({ r: 1, g: 0, b: 0, alpha: 1 });
    const c = cssColorToPdf('rgba(30, 41, 59, 0.22)');
    expect(c.r).toBeCloseTo(30 / 255);
    expect(c.alpha).toBe(0.22);
    expect(cssColorToPdf('nonsense')).toEqual({ r: 0, g: 0, b: 0, alpha: 1 });
  });
});

describe('strokeToPdfOps', () => {
  it('solid pen → one filled path in flipped user space', () => {
    const ops = strokeToPdfOps(freehand, flat);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    if (op?.kind !== 'path') throw new Error('kind');
    expect(op.fill).toBeDefined();
    expect(op.stroke).toBeUndefined();
    expect(op.blend).toBe('normal');
    expect(isValidPdfSvgPath(op.d)).toBe(true);
    // Flipped space: y coordinates are negative (PDF y up, emitted as -y). The
    // outline starts a pen-radius away from the centreline, hence the tolerance.
    const firstY = Number(op.d.split(' ')[2]);
    expect(firstY).toBeLessThan(0);
    expect(Math.abs(-firstY - (H - 200 * k))).toBeLessThan(10);
  });

  it('dashed pen → stroked centreline with a scaled dash array', () => {
    const dashed: FreehandStroke = { ...freehand, style: { ...style, pattern: 'dashed' } };
    const [op] = strokeToPdfOps(dashed, flat);
    if (op?.kind !== 'path') throw new Error('kind');
    expect(op.fill).toBeUndefined();
    expect(op.stroke).toBeDefined();
    expect(op.lineWidth).toBeCloseTo(4 * k);
    expect(op.dash).toEqual([12 * k, 8 * k]);
  });

  it('highlighter → multiply blend with its opacity', () => {
    const hl: FreehandStroke = { ...freehand, tool: 'highlighter', style: { ...style, compositeOperation: 'multiply', opacity: 0.35, thinning: 0 } };
    const [op] = strokeToPdfOps(hl, flat);
    if (op?.kind !== 'path') throw new Error('kind');
    expect(op.blend).toBe('multiply');
    expect(op.opacity).toBeCloseTo(0.35);
  });

  it('pixel eraser is not exported', () => {
    const eraser: FreehandStroke = { ...freehand, tool: 'eraser-pixel', style: { ...style, compositeOperation: 'destination-out' } };
    expect(strokeToPdfOps(eraser, flat)).toEqual([]);
  });

  it('arrowed dashed line → drawLine op plus a filled arrowhead path', () => {
    const line: GeometricStroke = {
      kind: 'geometric',
      id: 'g',
      tool: 'line',
      shape: { type: 'line', from: { x: 100, y: 600 }, to: { x: 300, y: 600 } },
      style: { ...style, pattern: 'dotted', arrowheads: 'end' },
      bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      pointerType: 'pen',
      createdAt: 0,
    };
    const ops = strokeToPdfOps(line, flat);
    expect(ops.map((o) => o.kind)).toEqual(['line', 'path']);
    const [seg, head] = ops;
    if (seg?.kind !== 'line' || head?.kind !== 'path') throw new Error('kinds');
    expect(seg.start).toEqual({ x: 100 * k, y: H - 600 * k });
    // The shaft is trimmed under the arrowhead.
    expect(seg.end.x).toBeLessThan(300 * k);
    expect(seg.dash?.[1]).toBeCloseTo(8 * k);
    expect(head.fill).toBeDefined();
    expect(isValidPdfSvgPath(head.d)).toBe(true);
  });

  it('rectangle → drawRectangle with rotation about its centre; ellipse → drawEllipse', () => {
    const rect: GeometricStroke = {
      kind: 'geometric',
      id: 'r',
      tool: 'pen',
      shape: { type: 'rectangle', center: { x: 200, y: 300 }, width: 100, height: 50, rotation: Math.PI / 6 },
      style,
      bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      pointerType: 'pen',
      createdAt: 0,
    };
    const [op] = strokeToPdfOps(rect, flat);
    if (op?.kind !== 'rectangle') throw new Error('kind');
    expect(op.width).toBeCloseTo(75);
    expect(op.height).toBeCloseTo(37.5);
    expect(op.rotateDeg).toBeCloseTo(-30);
    // Bottom-left corner rotated about the centre by -30° (PDF ccw) stays centre-distance away.
    const c = flat.toPdf({ x: 200, y: 300 });
    expect(Math.hypot(op.x - c.x, op.y - c.y)).toBeCloseTo(Math.hypot(37.5, 18.75), 6);

    const ellipse: GeometricStroke = { ...rect, id: 'e', shape: { type: 'ellipse', center: { x: 200, y: 300 }, radiusX: 40, radiusY: 20, rotation: 0 } };
    const [el] = strokeToPdfOps(ellipse, flat);
    if (el?.kind !== 'ellipse') throw new Error('kind');
    expect(el.rx).toBeCloseTo(30);
    expect(el.ry).toBeCloseTo(15);
    // On a rotated source page the primitive falls back to a path so nothing depends on pdf-lib's rotation semantics.
    expect(strokeToPdfOps(ellipse, rotated)[0]?.kind).toBe('path');
    expect(strokeToPdfOps(rect, rotated)[0]?.kind).toBe('path');
  });

  it('coordinate plane → axis lines, arrowheads and labels', () => {
    const plane: GeometricStroke = {
      kind: 'geometric',
      id: 'p',
      tool: 'coordinate-plane',
      shape: {
        type: 'coordinate-plane',
        origin: { x: 300, y: 500 },
        extentX: 150,
        extentY: 100,
        config: { mode: 'four-quadrant', divisions: 4, showGrid: false, tickLabels: false, xLabel: 'x', yLabel: 'y' },
      },
      style,
      bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      pointerType: 'pen',
      createdAt: 0,
    };
    const ops = strokeToPdfOps(plane, flat);
    const kinds = ops.map((o) => o.kind);
    expect(kinds.filter((k2) => k2 === 'line').length).toBeGreaterThanOrEqual(2 + 6);
    expect(kinds.filter((k2) => k2 === 'path')).toHaveLength(4);
    expect(ops.filter((o) => o.kind === 'text').map((o) => (o.kind === 'text' ? o.text : ''))).toEqual(['x', 'y']);
  });

  /** A wave and a zigzag drawn left to right across a page. */
  const procedural = (kind: CurveKind, over: Partial<StrokeStyle> = {}): GeometricStroke => ({
    kind: 'geometric',
    id: `c-${kind}`,
    tool: 'line',
    shape: { type: 'curve', kind, from: { x: 100, y: 400 }, to: { x: 300, y: 400 }, amplitude: 30, cycles: 3 },
    style: { ...style, ...over },
    bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    pointerType: 'pen',
    createdAt: 0,
  });

  it('wave → one stroked vector path pdf-lib can parse', () => {
    const ops = strokeToPdfOps(procedural('wave'), flat);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    if (op?.kind !== 'path') throw new Error('kind');
    // Stroked, not filled: a curve is a centreline, like any other open shape.
    expect(op.stroke).toBeDefined();
    expect(op.fill).toBeUndefined();
    expect(op.lineWidth).toBeCloseTo(4 * k);
    expect(isValidPdfSvgPath(op.d)).toBe(true);
    // The wave really is in the path, not flattened to its chord: the vertices
    // span the full amplitude either side of y = 400.
    // `M x y L x y …` in flipped space: emitted y = pageY·k − H, so undo that.
    const numbers = (op.d.match(/-?[\d.]+/g) ?? []).map(Number);
    const ys = numbers.filter((_, i) => i % 2 === 1).map((y) => (y + H) / k);
    expect(Math.min(...ys)).toBeCloseTo(370);
    expect(Math.max(...ys)).toBeCloseTo(430);
    expect(ys.length).toBeGreaterThan(40);
  });

  it('zigzag → the same corners the canvas draws, and no more', () => {
    const stroke = procedural('zigzag');
    const [op] = strokeToPdfOps(stroke, flat);
    if (op?.kind !== 'path') throw new Error('kind');
    if (stroke.shape.type !== 'curve') throw new Error('shape');
    // 3 cycles → 6 peaks + 2 endpoints, as vertices of an open M/L path.
    const expected = curvePoints(stroke.shape);
    expect(expected).toHaveLength(8);
    expect(op.d).toBe(pointsToSvgPath(expected.map((pt) => ({ x: pt.x * k, y: -(H - pt.y * k) })), false));
    expect(op.d.endsWith(' Z')).toBe(false);
  });

  it('curves carry the dash pattern and the arrowheads', () => {
    const dotted = strokeToPdfOps(procedural('wave', { pattern: 'dotted' }), flat);
    const [body] = dotted;
    if (body?.kind !== 'path') throw new Error('kind');
    expect(body.dash).toEqual([0.01, 8 * k]);

    const arrowed = strokeToPdfOps(procedural('parabola', { arrowheads: 'both' }), flat);
    expect(arrowed.map((o) => o.kind)).toEqual(['path', 'path', 'path']);
    const [shaft, ...heads] = arrowed;
    if (shaft?.kind !== 'path') throw new Error('kind');
    expect(shaft.stroke).toBeDefined();
    for (const head of heads) {
      if (head.kind !== 'path') throw new Error('kind');
      // Arrowheads are filled triangles, and closed.
      expect(head.fill).toBeDefined();
      expect(head.d.endsWith(' Z')).toBe(true);
      expect(isValidPdfSvgPath(head.d)).toBe(true);
    }
  });

  it('exports a curve on a rotated source page like any other path', () => {
    const [op] = strokeToPdfOps(procedural('zigzag'), rotated);
    if (op?.kind !== 'path') throw new Error('kind');
    expect(isValidPdfSvgPath(op.d)).toBe(true);
  });
});

describe('gradient highlighter export', () => {
  const gradientStroke = (mode: 'rainbow' | 'dual'): FreehandStroke => ({
    ...freehand,
    tool: 'highlighter',
    style: { ...style, color: '#ff0000', opacity: 0.4, compositeOperation: 'multiply', gradient: { mode, to: '#0000ff' } },
  });

  it('chops a dual-colour stroke into flat pieces running from one colour to the other', () => {
    const ops = strokeToPdfOps(gradientStroke('dual'), flat);
    expect(ops.length).toBeGreaterThan(1);
    // Every piece is a stroked open path, not a filled outline: that is what
    // lets each one carry its own colour without seams.
    for (const op of ops) {
      expect(op.kind).toBe('path');
      if (op.kind !== 'path') continue;
      expect(op.fill).toBeUndefined();
      expect(op.stroke).toBeDefined();
      expect(isValidPdfSvgPath(op.d)).toBe(true);
      expect(op.opacity).toBeCloseTo(0.4);
      expect(op.blend).toBe('multiply');
    }
    const first = ops[0];
    const last = ops[ops.length - 1];
    if (first?.kind !== 'path' || last?.kind !== 'path') throw new Error('expected paths');
    // Red at the start, travelling towards blue by the end.
    expect(first.stroke!.r).toBeGreaterThan(first.stroke!.b);
    expect(last.stroke!.b).toBeGreaterThan(first.stroke!.b);
  });

  it('sweeps the hue for a rainbow stroke rather than repeating one colour', () => {
    const ops = strokeToPdfOps(gradientStroke('rainbow'), flat);
    const colors = ops.map((op) => (op.kind === 'path' ? op.stroke : undefined));
    const unique = new Set(colors.map((c) => (c ? `${c.r.toFixed(2)},${c.g.toFixed(2)},${c.b.toFixed(2)}` : '')));
    expect(unique.size).toBeGreaterThan(4);
  });

  it('leaves a plain highlighter as a single filled outline', () => {
    const ops = strokeToPdfOps({ ...freehand, tool: 'highlighter' }, flat);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.kind === 'path' && ops[0].fill).toBeDefined();
  });
});
