import { describe, expect, it } from 'vitest';
import { DEFAULT_CURVE_AMPLITUDE, DEFAULT_CURVE_CYCLES } from '../constants';
import { reshapeStrokes, selectionCurveParams } from '../engine/lasso';
import { curveParams, isEditableCurve, reshapeCurve } from '../engine/shapes';
import type { CurveShape, GeometricStroke, LineShape, Point } from '../types';
import { PEN_STYLE, makeGeometric, makeLine, makeStroke } from './testUtils';

const from: Point = { x: 0, y: 0 };
const to: Point = { x: 100, y: 0 };

const wave = (over: Partial<CurveShape> = {}): CurveShape => ({
  type: 'curve',
  kind: 'wave',
  from,
  to,
  amplitude: 20,
  cycles: 3,
  ...over,
});

describe('recovering a committed curve’s settings', () => {
  it('reads depth back as the fraction of the chord it was drawn at', () => {
    const params = curveParams(wave());
    expect(params.curve).toBe('wave');
    expect(params.amplitudeRatio).toBeCloseTo(0.2);
    expect(params.cycles).toBe(3);
    expect(params.flip).toBe(false);
  });

  it('reads a negative amplitude as a flipped curve, not a negative depth', () => {
    const params = curveParams(wave({ amplitude: -20 }));
    expect(params.amplitudeRatio).toBeCloseTo(0.2);
    expect(params.flip).toBe(true);
  });

  it('lends a straight line the defaults it never had', () => {
    const params = curveParams({ type: 'line', from, to });
    expect(params.curve).toBe('straight');
    expect(params.amplitudeRatio).toBe(DEFAULT_CURVE_AMPLITUDE);
    expect(params.cycles).toBe(DEFAULT_CURVE_CYCLES);
  });

  it('only offers to edit lines and curves', () => {
    expect(isEditableCurve({ type: 'line', from, to })).toBe(true);
    expect(isEditableCurve(wave())).toBe(true);
    expect(isEditableCurve({ type: 'ellipse', center: from, radiusX: 10, radiusY: 10, rotation: 0 })).toBe(false);
  });
});

describe('rebuilding a curve from new settings', () => {
  it('keeps the ends exactly where they were', () => {
    const next = reshapeCurve(wave(), { curve: 'zigzag', cycles: 7 });
    expect(next.from).toEqual(from);
    expect(next.to).toEqual(to);
    expect(next.type).toBe('curve');
    expect((next as CurveShape).kind).toBe('zigzag');
    expect((next as CurveShape).cycles).toBe(7);
  });

  it('changes nothing it was not asked to change', () => {
    const next = reshapeCurve(wave(), { cycles: 5 }) as CurveShape;
    expect(next.amplitude).toBeCloseTo(20);
    expect(next.kind).toBe('wave');
  });

  it('flips by the sign of the amplitude, and back again', () => {
    const flipped = reshapeCurve(wave(), { flip: true }) as CurveShape;
    expect(flipped.amplitude).toBeCloseTo(-20);
    const back = reshapeCurve(flipped, { flip: false }) as CurveShape;
    expect(back.amplitude).toBeCloseTo(20);
  });

  it('straightens to a plain line, and curves back out of one', () => {
    const line = reshapeCurve(wave(), { curve: 'straight' }) as LineShape;
    expect(line.type).toBe('line');
    expect(line.from).toEqual(from);
    expect(line.to).toEqual(to);

    const curved = reshapeCurve(line, { curve: 'parabola' }) as CurveShape;
    expect(curved.type).toBe('curve');
    // Straight carried no depth of its own, so it borrows the default.
    expect(curved.amplitude).toBeCloseTo(100 * DEFAULT_CURVE_AMPLITUDE);
  });

  it('rounds and floors the cycle count rather than producing a degenerate curve', () => {
    expect((reshapeCurve(wave(), { cycles: 2.6 }) as CurveShape).cycles).toBe(3);
    expect((reshapeCurve(wave(), { cycles: -4 }) as CurveShape).cycles).toBe(1);
  });

  it('survives a zero-length drag without dividing by it', () => {
    const degenerate = wave({ to: from });
    expect(curveParams(degenerate).amplitudeRatio).toBe(DEFAULT_CURVE_AMPLITUDE);
    expect((reshapeCurve(degenerate, { amplitudeRatio: 0.5 }) as CurveShape).amplitude).toBe(0);
  });
});

describe('reshaping a selection', () => {
  const geometric = (shape: CurveShape | LineShape): GeometricStroke => makeGeometric(shape, PEN_STYLE);

  it('keeps the ids, so the selection survives the edit', () => {
    const stroke = geometric(wave());
    const [next] = reshapeStrokes([stroke], new Set([stroke.id]), { curve: 'zigzag' });
    expect(next?.id).toBe(stroke.id);
    expect(next).not.toBe(stroke);
  });

  it('recomputes the bounds, so the selection box follows the new shape', () => {
    const stroke = geometric(wave({ amplitude: 5 }));
    const [next] = reshapeStrokes([stroke], new Set([stroke.id]), { amplitudeRatio: 0.5 });
    expect(next?.bbox.maxY).toBeGreaterThan(stroke.bbox.maxY);
  });

  it('passes over freehand strokes and anything outside the selection', () => {
    const ink = makeStroke([
      [0, 0],
      [10, 10],
    ]);
    const other = makeLine(from, to);
    const target = geometric(wave());
    const next = reshapeStrokes([ink, other, target], new Set([ink.id, target.id]), { curve: 'straight' });
    expect(next[0]).toBe(ink);
    expect(next[1]).toBe(other);
    expect(next[2]).not.toBe(target);
  });

  it('reports the settings of the first editable shape, and nothing for a selection with none', () => {
    const ink = makeStroke([
      [0, 0],
      [10, 10],
    ]);
    expect(selectionCurveParams([ink])).toBeNull();
    expect(selectionCurveParams([])).toBeNull();
    const params = selectionCurveParams([ink, geometric(wave({ amplitude: -30 }))]);
    expect(params?.curve).toBe('wave');
    expect(params?.amplitudeRatio).toBeCloseTo(0.3);
    expect(params?.flip).toBe(true);
  });
});
