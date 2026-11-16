import { describe, expect, it } from 'vitest';
import { recognizeArrow, recognizeStroke, smoothCurve } from '../engine/shapeRecognition';
import type { Point } from '../types';
import { sampleCurve } from './testUtils';

/** A pen path through `corners`, `perSide` samples a side, with a little hand wobble. */
function path(corners: readonly Point[], perSide = 24, jitter = 0.6): Point[] {
  let seed = 4242;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  const out: Point[] = [];
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1]!;
    const b = corners[i]!;
    for (let k = 0; k < perSide; k++) {
      const t = k / perSide;
      out.push({ x: a.x + (b.x - a.x) * t + rand() * 2 * jitter, y: a.y + (b.y - a.y) * t + rand() * 2 * jitter });
    }
  }
  out.push(corners[corners.length - 1]!);
  return out;
}

/** A bow from `from` to `to`, bulging `bulge` px to one side. */
function bow(from: Point, to: Point, bulge: number, count = 60): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  return sampleCurve((t) => {
    const s = 4 * t * (1 - t) * bulge;
    return { x: from.x + dx * t + nx * s, y: from.y + dy * t + ny * s };
  }, count, 0.5, false);
}

describe('arrows drawn in one stroke', () => {
  it('a straight shaft and a two-barb head (there and back) is a line with an arrowhead', () => {
    const stroke = path([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 180, y: -14 }, { x: 200, y: 0 }, { x: 180, y: 14 }], 30);
    const got = recognizeStroke(stroke);
    expect(got?.arrow).toBe(true);
    expect(got?.shape.type).toBe('line');
    if (got?.shape.type !== 'line') return;
    expect(got.shape.to.x).toBeGreaterThan(190);
    expect(Math.abs(got.shape.to.y)).toBeLessThan(5);
  });

  it('a shaft and one barb (a hook) is an arrow too', () => {
    const stroke = path([{ x: 0, y: 100 }, { x: 150, y: 0 }, { x: 125, y: 2 }], 30);
    expect(recognizeArrow(stroke)?.arrow).toBe(true);
  });

  it('a shaft and a little triangle round the tip is an arrow, not a triangle', () => {
    const stroke = path([{ x: 0, y: 0 }, { x: 0, y: 200 }, { x: -12, y: 182 }, { x: 12, y: 182 }, { x: 0, y: 200 }], 30);
    const got = recognizeStroke(stroke);
    expect(got?.arrow).toBe(true);
    expect(got?.shape.type).toBe('line');
  });

  it('a curved shaft keeps its curve, smoothed, with the arrowhead at its end', () => {
    const shaft = bow({ x: 0, y: 200 }, { x: 200, y: 0 }, 50, 80);
    const tip = shaft[shaft.length - 1]!;
    const stroke = [...shaft, ...path([tip, { x: tip.x - 18, y: tip.y + 4 }, tip, { x: tip.x - 4, y: tip.y + 18 }], 10, 0.3).slice(1)];
    const got = recognizeStroke(stroke);
    expect(got?.arrow).toBe(true);
    expect(got?.shape.type).toBe('polyline');
    if (got?.shape.type !== 'polyline') return;
    expect(got.shape.points.length).toBeGreaterThan(20);
    const end = got.shape.points[got.shape.points.length - 1]!;
    expect(Math.hypot(end.x - tip.x, end.y - tip.y)).toBeLessThan(8);
  });

  it('is not seen in a tick, a V, an N, or a plain line', () => {
    expect(recognizeArrow(path([{ x: 0, y: 0 }, { x: 20, y: 30 }, { x: 80, y: -60 }]))).toBeNull();
    expect(recognizeArrow(path([{ x: 0, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 0 }]))).toBeNull();
    expect(recognizeArrow(path([{ x: 0, y: 100 }, { x: 0, y: 0 }, { x: 80, y: 100 }, { x: 80, y: 0 }]))).toBeNull();
    expect(recognizeArrow(path([{ x: 0, y: 0 }, { x: 200, y: 50 }]))).toBeNull();
  });
});

describe('curves', () => {
  it('an open bow is a smooth curve, not a chain of segments', () => {
    const got = recognizeStroke(bow({ x: 0, y: 0 }, { x: 300, y: 0 }, 80, 90));
    expect(got?.arrow).toBe(false);
    expect(got?.shape.type).toBe('polyline');
    if (got?.shape.type !== 'polyline') return;
    expect(got.shape.points.length).toBeGreaterThan(20);
  });

  it('an S-curve, which the corner finder gave up on, is a curve too', () => {
    const s = sampleCurve((t) => ({ x: t * 400, y: Math.sin(t * Math.PI * 2) * 60 }), 120, 0.5, false);
    expect(recognizeStroke(s)?.shape.type).toBe('polyline');
  });

  it('a path with real corners still snaps to straight segments', () => {
    const z = path([{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 0, y: 120 }, { x: 150, y: 120 }]);
    const got = recognizeStroke(z);
    expect(got?.shape.type).toBe('polyline');
    if (got?.shape.type !== 'polyline') return;
    expect(got.shape.points.length).toBe(4);
  });

  it('smoothing takes the wobble out and keeps both ends', () => {
    const raw = bow({ x: 0, y: 0 }, { x: 200, y: 0 }, 40, 70);
    const smooth = smoothCurve(raw);
    expect(smooth[0]).toEqual({ x: raw[0]!.x, y: raw[0]!.y });
    expect(smooth[smooth.length - 1]).toEqual({ x: raw[raw.length - 1]!.x, y: raw[raw.length - 1]!.y });
  });
});
