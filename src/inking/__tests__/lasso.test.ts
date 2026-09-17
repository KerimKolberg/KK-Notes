import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_OFFSET,
  duplicateStrokes,
  isStrokeEnclosed,
  pointInPolygon,
  polygonBBox,
  removeStrokesById,
  restyleStrokes,
  SCALE_HANDLES,
  handleAxes,
  scaleAnchor,
  scaleFromHandle,
  selectStrokesInLasso,
  selectionBounds,
  strokeSamplePoints,
  transformBBox,
  transformStroke,
  transformStrokes,
} from '../engine/lasso';
import { DEFAULT_COORDINATE_PLANE } from '../constants';
import { EMPTY_BBOX } from '../engine/geometry';
import type { Point, Stroke } from '../types';
import { makeGeometric, makeLine, makeStroke, PEN_STYLE } from './testUtils';

const square = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/** A "C" shape: concave, with a notch on the right. */
const cShape: Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 30 },
  { x: 40, y: 30 },
  { x: 40, y: 70 },
  { x: 100, y: 70 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

describe('pointInPolygon (ray casting)', () => {
  it('classifies points against a convex polygon', () => {
    const poly = square(0, 0, 10, 10);
    expect(pointInPolygon({ x: 5, y: 5 }, poly)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, poly)).toBe(false);
    expect(pointInPolygon({ x: -1, y: 5 }, poly)).toBe(false);
    expect(pointInPolygon({ x: 5, y: 11 }, poly)).toBe(false);
  });

  it('handles concave polygons: the notch is outside', () => {
    expect(pointInPolygon({ x: 20, y: 50 }, cShape)).toBe(true); // spine
    expect(pointInPolygon({ x: 70, y: 15 }, cShape)).toBe(true); // upper arm
    expect(pointInPolygon({ x: 70, y: 50 }, cShape)).toBe(false); // notch
    expect(pointInPolygon({ x: 70, y: 85 }, cShape)).toBe(true); // lower arm
  });

  it('works with polygon winding in either direction', () => {
    const cw = square(0, 0, 10, 10);
    const ccw = [...cw].reverse();
    expect(pointInPolygon({ x: 3, y: 3 }, ccw)).toBe(true);
    expect(pointInPolygon({ x: 30, y: 3 }, ccw)).toBe(false);
  });

  it('is robust at vertex heights and horizontal edges', () => {
    const poly = square(0, 0, 10, 10);
    // Ray passes exactly through vertex y-levels.
    expect(pointInPolygon({ x: 5, y: 0 }, poly)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 10 }, poly)).toBe(false);
    expect(pointInPolygon({ x: 20, y: 0 }, poly)).toBe(false);
    // A self-touching bow-tie: even-odd rule.
    const bowtie: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 2, y: 5 }, bowtie)).toBe(true);
    expect(pointInPolygon({ x: 8, y: 5 }, bowtie)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 2 }, bowtie)).toBe(false);
  });

  it('rejects degenerate polygons', () => {
    expect(pointInPolygon({ x: 0, y: 0 }, [])).toBe(false);
    expect(pointInPolygon({ x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(false);
  });

  it('computes the polygon bbox', () => {
    expect(polygonBBox(cShape)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(polygonBBox([])).toEqual(EMPTY_BBOX);
  });
});

describe('strokeSamplePoints', () => {
  it('returns freehand samples, subsampled to the limit with endpoints kept', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 200; i++) pts.push([i, i * 2]);
    const stroke = makeStroke(pts);
    const samples = strokeSamplePoints(stroke, 32);
    expect(samples).toHaveLength(32);
    expect(samples[0]).toMatchObject({ x: 0, y: 0 });
    expect(samples[samples.length - 1]).toMatchObject({ x: 200, y: 400 });
    expect(strokeSamplePoints(makeStroke([[0, 0], [5, 5]]))).toHaveLength(2);
  });

  it('samples geometric outlines evenly by length', () => {
    // A long thin rectangle: samples must follow the perimeter, not cluster at corners.
    const rect = makeGeometric({ type: 'rectangle', center: { x: 0, y: 0 }, width: 200, height: 20, rotation: 0 });
    const samples = strokeSamplePoints(rect, 44);
    const onLongEdges = samples.filter((p) => Math.abs(Math.abs(p.y) - 10) < 1e-6).length;
    expect(onLongEdges / samples.length).toBeGreaterThan(0.8);
  });

  it('flattens geometric shapes into outline vertices', () => {
    const rect = makeGeometric({ type: 'rectangle', center: { x: 50, y: 50 }, width: 40, height: 20, rotation: 0 });
    const samples = strokeSamplePoints(rect);
    expect(samples.length).toBeGreaterThanOrEqual(4);
    for (const p of samples) {
      expect(p.x).toBeGreaterThanOrEqual(30 - 1e-9);
      expect(p.x).toBeLessThanOrEqual(70 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(40 - 1e-9);
      expect(p.y).toBeLessThanOrEqual(60 + 1e-9);
    }
    const ellipse = makeGeometric({ type: 'ellipse', center: { x: 0, y: 0 }, radiusX: 10, radiusY: 5, rotation: 0 });
    const es = strokeSamplePoints(ellipse);
    expect(es.length).toBeGreaterThan(8);
    // Samples lie on the flattened outline: on or just inside the true ellipse.
    for (const p of es) {
      const r = (p.x / 10) ** 2 + (p.y / 5) ** 2;
      expect(r).toBeGreaterThan(0.98);
      expect(r).toBeLessThan(1.0001);
    }
  });
});

describe('isStrokeEnclosed / selectStrokesInLasso', () => {
  const lasso = square(0, 0, 100, 100);
  const inside = makeStroke([[10, 10], [30, 20], [50, 40], [70, 60]]);
  const outside = makeStroke([[150, 150], [170, 160], [190, 180]]);
  const straddling = makeStroke([[60, 50], [80, 50], [100, 50], [120, 50], [140, 50], [160, 50]]);
  const mostlyIn = makeStroke([[10, 50], [30, 50], [50, 50], [70, 50], [90, 50], [110, 50]]);

  it('selects a freehand polyline fully inside the loop', () => {
    expect(isStrokeEnclosed(inside, lasso)).toBe(true);
  });

  it('rejects a freehand polyline outside the loop (bbox fast path)', () => {
    expect(isStrokeEnclosed(outside, lasso)).toBe(false);
  });

  it('uses the inside fraction for partially enclosed strokes', () => {
    expect(isStrokeEnclosed(straddling, lasso)).toBe(false); // 2 / 6 inside
    expect(isStrokeEnclosed(mostlyIn, lasso)).toBe(true); // 5 / 6 inside
    expect(isStrokeEnclosed(straddling, lasso, undefined, 0.3)).toBe(true);
  });

  it('selects geometric shapes by their outline vertices', () => {
    const rectIn = makeGeometric({ type: 'rectangle', center: { x: 50, y: 50 }, width: 40, height: 20, rotation: 0 });
    const rectOut = makeGeometric({ type: 'rectangle', center: { x: 200, y: 50 }, width: 40, height: 20, rotation: 0 });
    const rectMostlyOut = makeGeometric({ type: 'rectangle', center: { x: 120, y: 50 }, width: 80, height: 20, rotation: 0 });
    const ellipseIn = makeGeometric({ type: 'ellipse', center: { x: 50, y: 50 }, radiusX: 30, radiusY: 15, rotation: 0.3 });
    const lineIn = makeLine({ x: 10, y: 90 }, { x: 90, y: 10 });
    const lineOut = makeLine({ x: 10, y: 150 }, { x: 90, y: 150 });
    expect(isStrokeEnclosed(rectIn, lasso)).toBe(true);
    expect(isStrokeEnclosed(rectOut, lasso)).toBe(false);
    expect(isStrokeEnclosed(rectMostlyOut, lasso)).toBe(false); // only the left edge's corners are inside
    expect(isStrokeEnclosed(ellipseIn, lasso)).toBe(true);
    expect(isStrokeEnclosed(lineIn, lasso)).toBe(true);
    expect(isStrokeEnclosed(lineOut, lasso)).toBe(false);
  });

  it('respects concave lassos: strokes in the notch are not selected', () => {
    const inArm = makeStroke([[60, 10], [70, 12], [80, 15], [90, 20]]);
    const inNotch = makeStroke([[60, 45], [70, 50], [80, 52], [90, 55]]);
    expect(selectStrokesInLasso([inArm, inNotch], cShape)).toEqual([inArm.id]);
  });

  it('returns ids in document order and skips pixel-eraser strokes', () => {
    const eraser = makeStroke([[20, 20], [40, 40]], { tool: 'eraser-pixel' });
    const strokes: Stroke[] = [outside, inside, eraser, mostlyIn];
    expect(selectStrokesInLasso(strokes, lasso)).toEqual([inside.id, mostlyIn.id]);
    expect(selectStrokesInLasso(strokes, [])).toEqual([]);
  });

  it('computes the union bounds of a selection', () => {
    const a = makeStroke([[0, 0], [10, 10]]);
    const b = makeStroke([[50, 50], [60, 70]]);
    expect(selectionBounds([])).toBeNull();
    expect(selectionBounds([a, b])).toEqual({
      minX: a.bbox.minX,
      minY: a.bbox.minY,
      maxX: b.bbox.maxX,
      maxY: b.bbox.maxY,
    });
  });
});

describe('transforms', () => {
  it('translates a freehand stroke, keeping its id and shifting its bbox', () => {
    const s = makeStroke([[10, 10], [20, 30]]);
    const moved = transformStroke(s, { kind: 'translate', dx: 5, dy: -5 });
    expect(moved.id).toBe(s.id);
    expect(moved.kind).toBe('freehand');
    if (moved.kind === 'freehand') {
      expect(moved.points[0]).toMatchObject({ x: 15, y: 5, pressure: 0.5 });
      expect(moved.points[1]).toMatchObject({ x: 25, y: 25 });
    }
    expect(moved.bbox.minX).toBeCloseTo(s.bbox.minX + 5);
    expect(moved.bbox.maxY).toBeCloseTo(s.bbox.maxY - 5);
    expect(moved.style).toBe(s.style);
  });

  it('scales freehand points about the origin and the width uniformly', () => {
    const s = makeStroke([[0, 0], [10, 0], [10, 10]]);
    const scaled = transformStroke(s, { kind: 'scale', origin: { x: 0, y: 0 }, sx: 2, sy: 2 });
    if (scaled.kind === 'freehand') {
      expect(scaled.points.map((p) => [p.x, p.y])).toEqual([
        [0, 0],
        [20, 0],
        [20, 20],
      ]);
    }
    expect(scaled.style.size).toBeCloseTo(PEN_STYLE.size * 2);
    // Non-uniform scale: geometric mean of the axes.
    const stretched = transformStroke(s, { kind: 'scale', origin: { x: 0, y: 0 }, sx: 4, sy: 1 });
    expect(stretched.style.size).toBeCloseTo(PEN_STYLE.size * 2);
  });

  it('scales geometric shapes: rectangle, ellipse, line, polygon, coordinate plane', () => {
    const origin = { x: 0, y: 0 };
    const t = { kind: 'scale', origin, sx: 2, sy: 0.5 } as const;
    const rect = transformStroke(makeGeometric({ type: 'rectangle', center: { x: 10, y: 10 }, width: 4, height: 8, rotation: 0 }), t);
    const ellipse = transformStroke(makeGeometric({ type: 'ellipse', center: { x: 10, y: 10 }, radiusX: 4, radiusY: 8, rotation: 0 }), t);
    const line = transformStroke(makeLine({ x: 0, y: 0 }, { x: 10, y: 10 }), t);
    const poly = transformStroke(makeGeometric({ type: 'polygon', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }] }), t);
    const plane = transformStroke(
      makeGeometric({
        type: 'coordinate-plane',
        origin: { x: 10, y: 10 },
        extentX: 100,
        extentY: 50,
        config: { ...DEFAULT_COORDINATE_PLANE, mode: 'quadrant-1' },
      }),
      t,
    );
    expect(rect.kind === 'geometric' && rect.shape.type === 'rectangle' && rect.shape).toMatchObject({ center: { x: 20, y: 5 }, width: 8, height: 4 });
    expect(ellipse.kind === 'geometric' && ellipse.shape.type === 'ellipse' && ellipse.shape).toMatchObject({ center: { x: 20, y: 5 }, radiusX: 8, radiusY: 4 });
    expect(line.kind === 'geometric' && line.shape.type === 'line' && line.shape).toMatchObject({ from: { x: 0, y: 0 }, to: { x: 20, y: 5 } });
    expect(poly.kind === 'geometric' && poly.shape.type === 'polygon' && poly.shape.points).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 0, y: 5 },
    ]);
    expect(plane.kind === 'geometric' && plane.shape.type === 'coordinate-plane' && plane.shape).toMatchObject({
      origin: { x: 20, y: 5 },
      extentX: 200,
      extentY: 25,
    });
    // bboxes follow the new geometry
    expect(rect.bbox.minX).toBeLessThanOrEqual(16);
    expect(rect.bbox.maxX).toBeGreaterThanOrEqual(24);
  });

  it('transformBBox maps corners and re-normalises', () => {
    const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(transformBBox(box, { kind: 'translate', dx: 1, dy: 2 })).toEqual({ minX: 1, minY: 2, maxX: 11, maxY: 12 });
    expect(transformBBox(box, { kind: 'scale', origin: { x: 10, y: 10 }, sx: 2, sy: 2 })).toEqual({ minX: -10, minY: -10, maxX: 10, maxY: 10 });
  });

  it('transformStrokes only touches the selected ids and keeps order', () => {
    const a = makeStroke([[0, 0], [1, 1]]);
    const b = makeStroke([[5, 5], [6, 6]]);
    const c = makeLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    const out = transformStrokes([a, b, c], new Set([b.id, c.id]), { kind: 'translate', dx: 10, dy: 0 });
    expect(out.map((s) => s.id)).toEqual([a.id, b.id, c.id]);
    expect(out[0]).toBe(a);
    expect(out[1]?.bbox.minX).toBeCloseTo(b.bbox.minX + 10);
    expect(out[2]?.bbox.minX).toBeCloseTo(c.bbox.minX + 10);
  });
});

describe('restyle / duplicate / remove', () => {
  it('recolours and resizes the selected strokes only', () => {
    const a = makeStroke([[0, 0], [10, 10]]);
    const b = makeLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const eraser = makeStroke([[0, 0], [5, 5]], { tool: 'eraser-pixel' });
    const out = restyleStrokes([a, b, eraser], new Set([a.id, b.id, eraser.id]), { color: '#ff0000', size: 12 });
    expect(out[0]?.style).toMatchObject({ color: '#ff0000', size: 12 });
    expect(out[1]?.style).toMatchObject({ color: '#ff0000', size: 12 });
    expect(out[2]?.style.color).toBe(PEN_STYLE.color); // eraser keeps its colour
    expect(out[2]?.style.size).toBe(12);
    // bbox padding grows with the width
    expect(out[0]!.bbox.maxX - out[0]!.bbox.minX).toBeGreaterThan(a.bbox.maxX - a.bbox.minX);
    const untouched = restyleStrokes([a, b], new Set([b.id]), { color: '#00ff00' });
    expect(untouched[0]).toBe(a);
  });

  it('duplicates with an offset and fresh ids', () => {
    const a = makeStroke([[0, 0], [10, 10]]);
    const b = makeLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const { strokes, ids } = duplicateStrokes([a, b], new Set([a.id]));
    expect(strokes).toHaveLength(3);
    expect(strokes[0]).toBe(a);
    expect(strokes[1]).toBe(b);
    expect(ids).toHaveLength(1);
    const copy = strokes[2]!;
    expect(copy.id).toBe(ids[0]);
    expect(copy.id).not.toBe(a.id);
    expect(copy.bbox.minX).toBeCloseTo(a.bbox.minX + DUPLICATE_OFFSET.x);
    expect(copy.bbox.minY).toBeCloseTo(a.bbox.minY + DUPLICATE_OFFSET.y);
    const custom = duplicateStrokes([a], new Set([a.id]), { x: -3, y: 7 });
    expect(custom.strokes[1]?.bbox.minX).toBeCloseTo(a.bbox.minX - 3);
  });

  it('removes by id', () => {
    const a = makeStroke([[0, 0], [1, 1]]);
    const b = makeStroke([[2, 2], [3, 3]]);
    expect(removeStrokesById([a, b], new Set([a.id]))).toEqual([b]);
  });
});

describe('selection-box geometry', () => {
  const bounds = { minX: 10, minY: 20, maxX: 110, maxY: 70 }; // 100 × 50

  it('anchors the scale at the opposite corner', () => {
    expect(scaleAnchor(bounds, 'se')).toEqual({ x: 10, y: 20 });
    expect(scaleAnchor(bounds, 'nw')).toEqual({ x: 110, y: 70 });
    expect(scaleAnchor(bounds, 'ne')).toEqual({ x: 10, y: 70 });
    expect(scaleAnchor(bounds, 'sw')).toEqual({ x: 110, y: 20 });
  });

  it('derives a uniform scale from the dominant axis by default', () => {
    // Drag the SE corner 100px right, 0 down → x wants 2×, y wants 1×; uniform picks 2×.
    const t = scaleFromHandle(bounds, 'se', { x: 210, y: 70 }, false);
    expect(t).toEqual({ kind: 'scale', origin: { x: 10, y: 20 }, sx: 2, sy: 2 });
  });

  it('allows free aspect scaling and clamps to a minimum size', () => {
    const free = scaleFromHandle(bounds, 'se', { x: 210, y: 45 }, true);
    expect(free).toMatchObject({ sx: 2, sy: 0.5 });
    const collapsed = scaleFromHandle(bounds, 'se', { x: 0, y: 0 }, true, 8);
    expect(collapsed).toMatchObject({ sx: 0.08, sy: 0.16 });
    // Dragging the NW corner up-left grows the box.
    const nw = scaleFromHandle(bounds, 'nw', { x: -90, y: 20 }, true);
    expect(nw).toMatchObject({ origin: { x: 110, y: 70 }, sx: 2, sy: 1 });
  });

  it('offers four corners and four edges', () => {
    expect([...SCALE_HANDLES].sort()).toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
    expect(handleAxes('se')).toEqual({ x: true, y: true });
    expect(handleAxes('n')).toEqual({ x: false, y: true });
    expect(handleAxes('s')).toEqual({ x: false, y: true });
    expect(handleAxes('e')).toEqual({ x: true, y: false });
    expect(handleAxes('w')).toEqual({ x: true, y: false });
  });

  it('anchors an edge handle on the edge opposite it', () => {
    expect(scaleAnchor(bounds, 'n').y).toBe(70); // bottom edge stays put
    expect(scaleAnchor(bounds, 's').y).toBe(20); // top edge stays put
    expect(scaleAnchor(bounds, 'e').x).toBe(10); // left edge stays put
    expect(scaleAnchor(bounds, 'w').x).toBe(110); // right edge stays put
  });

  it('stretches one axis only from an edge handle, uniform mode or not', () => {
    // 100 × 50 box. Drag the east edge out to 200 wide; the height must not move.
    for (const free of [false, true]) {
      expect(scaleFromHandle(bounds, 'e', { x: 210, y: 45 }, free)).toMatchObject({ sx: 2, sy: 1 });
      expect(scaleFromHandle(bounds, 's', { x: 60, y: 120 }, free)).toMatchObject({ sx: 1, sy: 2 });
    }
    // Squashing works the same way, and towards the anchor the sign flips.
    expect(scaleFromHandle(bounds, 'w', { x: 60, y: 45 }, false)).toMatchObject({ origin: { x: 110, y: 20 }, sx: 0.5, sy: 1 });
    expect(scaleFromHandle(bounds, 'n', { x: 60, y: 45 }, false)).toMatchObject({ origin: { x: 10, y: 70 }, sx: 1, sy: 0.5 });
  });

  it('never collapses an edge-scaled selection to nothing', () => {
    const squashed = scaleFromHandle(bounds, 'e', { x: -500, y: 45 }, false, 8);
    expect(squashed).toMatchObject({ sx: 0.08, sy: 1 });
  });
});
