import { describe, expect, it } from 'vitest';
import { curveFromDrag, curvePoints, shapeBBox, shapeIsClosed, shapeToPolylines } from '../engine/shapes';
import { transformStroke } from '../engine/lasso';
import { createGeometricStroke } from '../engine/shapes';
import type { CurveKind, CurveShape, Point, StrokeStyle } from '../types';
import { PEN_STYLE } from './testUtils';

const from: Point = { x: 0, y: 0 };
const to: Point = { x: 100, y: 0 };

const curve = (kind: CurveKind, over: Partial<CurveShape> = {}): CurveShape => ({
  type: 'curve',
  kind,
  from,
  to,
  amplitude: 20,
  cycles: 4,
  ...over,
});

/** Signed distance off the chord, for a curve drawn along the +x axis. */
const offsets = (shape: CurveShape): number[] => curvePoints(shape).map((p) => p.y);

describe('building a curve from a drag', () => {
  it('scales the depth with the drag, so shape is independent of size', () => {
    const short = curveFromDrag(from, { x: 50, y: 0 }, 'parabola', 0.2, 4, false);
    const long = curveFromDrag(from, { x: 200, y: 0 }, 'parabola', 0.2, 4, false);
    expect(short.amplitude).toBeCloseTo(10);
    expect(long.amplitude).toBeCloseTo(40);
    // Same proportions: the apex sits at the same fraction of the span.
    expect(short.amplitude / 50).toBeCloseTo(long.amplitude / 200);
  });

  it('flips the curve onto the other side of the drag', () => {
    const normal = curveFromDrag(from, to, 'wave', 0.2, 4, false);
    const flipped = curveFromDrag(from, to, 'wave', 0.2, 4, true);
    expect(flipped.amplitude).toBeCloseTo(-normal.amplitude);
  });

  it('keeps the cycle count a whole number of at least one', () => {
    expect(curveFromDrag(from, to, 'zigzag', 0.2, 3.4, false).cycles).toBe(3);
    expect(curveFromDrag(from, to, 'zigzag', 0.2, 0, false).cycles).toBe(1);
  });

  it('honours angle snapping, exactly as a straight line does', () => {
    // 4.6° off horizontal snaps flat, keeping the drag's length as a line would.
    const drag = { x: 100, y: 8 };
    const snapped = curveFromDrag(from, drag, 'wave', 0.2, 4, false, 15);
    expect(snapped.to.y).toBeCloseTo(0);
    expect(snapped.to.x).toBeCloseTo(Math.hypot(drag.x, drag.y));
    // …and the depth is measured off the snapped chord, not the raw one.
    expect(snapped.amplitude).toBeCloseTo(Math.hypot(drag.x, drag.y) * 0.2);
  });
});

describe('parabola', () => {
  it('starts and ends on the drag, peaking at the amplitude in the middle', () => {
    const points = curvePoints(curve('parabola'));
    expect(points[0]).toEqual(from);
    expect(points[points.length - 1]!.x).toBeCloseTo(to.x);
    expect(points[points.length - 1]!.y).toBeCloseTo(to.y);
    // A quadratic Bézier reaches half way to its control point at t = 0.5, which
    // is what puts the apex on the amplitude rather than at twice it.
    const apex = points[points.length >> 1];
    expect(Math.abs(apex!.y)).toBeCloseTo(20, 1);
    expect(apex!.x).toBeCloseTo(50, 1);
  });

  it('bows to one side only, and the other way when flipped', () => {
    const ys = offsets(curve('parabola'));
    const flipped = offsets(curve('parabola', { amplitude: -20 }));
    expect(Math.min(...ys)).toBeCloseTo(-20, 1);
    expect(Math.max(...ys)).toBeCloseTo(0);
    expect(Math.max(...flipped)).toBeCloseTo(20, 1);
    expect(Math.min(...flipped)).toBeCloseTo(0);
  });
});

describe('wave', () => {
  it('returns to the chord at both ends and reaches the amplitude either side', () => {
    const ys = offsets(curve('wave'));
    expect(ys[0]).toBeCloseTo(0);
    expect(ys[ys.length - 1]).toBeCloseTo(0);
    expect(Math.max(...ys)).toBeCloseTo(20);
    expect(Math.min(...ys)).toBeCloseTo(-20);
  });

  it('fits exactly the requested number of cycles', () => {
    for (const cycles of [1, 3, 7]) {
      const ys = offsets(curve('wave', { cycles }));
      // Count sign changes: a full cycle crosses the chord twice.
      let crossings = 0;
      for (let i = 1; i < ys.length; i++) {
        if (Math.sign(ys[i]!) !== Math.sign(ys[i - 1]!) && ys[i] !== 0) crossings++;
      }
      expect(crossings).toBe(cycles * 2);
    }
  });

  it('is sampled densely enough to read as smooth', () => {
    const points = curvePoints(curve('wave', { cycles: 2 }));
    expect(points.length).toBeGreaterThan(40);
  });
});

describe('zigzag', () => {
  it('is corners only: two peaks per cycle plus the two endpoints', () => {
    for (const cycles of [1, 4]) {
      const points = curvePoints(curve('zigzag', { cycles }));
      expect(points).toHaveLength(cycles * 2 + 2);
    }
  });

  it('alternates its peaks at the full amplitude', () => {
    const ys = offsets(curve('zigzag', { cycles: 2 }));
    expect(ys[0]).toBeCloseTo(0);
    expect(ys[ys.length - 1]).toBeCloseTo(0);
    expect(ys.slice(1, -1)).toEqual([-20, 20, -20, 20]);
  });

  it('spaces the peaks evenly along the drag', () => {
    const xs = curvePoints(curve('zigzag', { cycles: 2 })).map((p) => p.x);
    expect(xs).toEqual([0, 12.5, 37.5, 62.5, 87.5, 100]);
  });
});

describe('curves in the rest of the engine', () => {
  it('is an open shape, so it keeps its ends and can take arrowheads', () => {
    expect(shapeIsClosed(curve('wave'))).toBe(false);
  });

  it('flattens to the polyline everything else measures it by', () => {
    const shape = curve('zigzag', { cycles: 1 });
    expect(shapeToPolylines(shape)).toEqual([curvePoints(shape)]);
  });

  it('bounds the whole excursion, not just the endpoints', () => {
    const box = shapeBBox(curve('wave'), PEN_STYLE);
    expect(box.minY).toBeLessThan(-20);
    expect(box.maxY).toBeGreaterThan(20);
  });

  it('draws nothing for a drag that went nowhere', () => {
    expect(curvePoints(curve('wave', { to: from }))).toEqual([from]);
  });

  it('follows a lasso transform, amplitude included', () => {
    const style: StrokeStyle = PEN_STYLE;
    const stroke = createGeometricStroke({ tool: 'line', shape: curve('wave'), style, pointerType: 'pen', createdAt: 0 });
    const moved = transformStroke(stroke, { kind: 'translate', dx: 10, dy: 5 });
    if (moved.kind !== 'geometric' || moved.shape.type !== 'curve') throw new Error('shape');
    expect(moved.shape.from).toEqual({ x: 10, y: 5 });
    expect(moved.shape.amplitude).toBeCloseTo(20);

    const scaled = transformStroke(stroke, { kind: 'scale', origin: from, sx: 2, sy: 2 });
    if (scaled.kind !== 'geometric' || scaled.shape.type !== 'curve') throw new Error('shape');
    // Doubling the selection doubles the wave's height too, not just its span.
    expect(scaled.shape.amplitude).toBeCloseTo(40);
    expect(scaled.shape.to.x).toBeCloseTo(200);
  });
});
