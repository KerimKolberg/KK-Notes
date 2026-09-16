import { describe, expect, it } from 'vitest';
import { canvasAngleToMathDegrees, angleOf, toRadians } from '../engine/angles';
import {
  RECOGNITION,
  detectCorners,
  fitEllipse,
  isHeart,
  isRectangle,
  radialVariance,
  recognizeShape,
} from '../engine/shapeRecognition';
import { heartPoints } from '../engine/shapes';
import type { Point } from '../types';
import { sampleCurve, samplePolygon } from './testUtils';

const TAU = Math.PI * 2;

function circle(cx: number, cy: number, r: number, jitter: number): Point[] {
  return sampleCurve((t) => ({ x: cx + Math.cos(t * TAU) * r, y: cy + Math.sin(t * TAU) * r }), 96, jitter);
}

describe('radialVariance', () => {
  it('is ~0 for a perfect circle and grows with noise', () => {
    const clean = radialVariance(circle(0, 0, 50, 0), { x: 0, y: 0 }, 50, 50);
    expect(clean.mean).toBeCloseTo(1, 6);
    expect(clean.cv).toBeLessThan(1e-6);

    const noisy = radialVariance(circle(0, 0, 50, 6), { x: 0, y: 0 }, 50, 50);
    expect(noisy.cv).toBeGreaterThan(clean.cv);
    expect(noisy.cv).toBeLessThan(RECOGNITION.ELLIPSE_MAX_RADIAL_CV);
  });

  it('exceeds the ellipse threshold for a square', () => {
    const square = samplePolygon(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
      25,
    );
    const { cv } = radialVariance(square, { x: 50, y: 50 }, 50, 50);
    expect(cv).toBeGreaterThan(RECOGNITION.ELLIPSE_MAX_RADIAL_CV);
  });
});

describe('fitEllipse', () => {
  it('recovers the rotation and radii of a tilted ellipse', () => {
    const rot = toRadians(30);
    const pts = sampleCurve((t) => {
      const px = Math.cos(t * TAU) * 100;
      const py = Math.sin(t * TAU) * 40;
      return { x: 300 + px * Math.cos(rot) - py * Math.sin(rot), y: 300 + px * Math.sin(rot) + py * Math.cos(rot) };
    }, 128);
    const e = fitEllipse(pts);
    expect(e).not.toBeNull();
    if (!e) return;
    expect(e.center.x).toBeCloseTo(300, 0);
    expect(e.center.y).toBeCloseTo(300, 0);
    expect(Math.max(e.radiusX, e.radiusY)).toBeCloseTo(100, 0);
    expect(Math.min(e.radiusX, e.radiusY)).toBeCloseTo(40, 0);
    const folded = ((e.rotation % Math.PI) + Math.PI) % Math.PI;
    expect(Math.min(Math.abs(folded - rot), Math.abs(folded - rot - Math.PI / 2))).toBeLessThan(toRadians(2));
  });
});

describe('isRectangle / detectCorners', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it('accepts four ~90° corners and rejects a parallelogram', () => {
    expect(isRectangle(square)).toBe(true);
    const skewed = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 130, y: 60 },
      { x: 30, y: 60 },
    ];
    expect(isRectangle(skewed)).toBe(false);
    expect(isRectangle(square.slice(0, 3))).toBe(false);
  });

  it('finds four corners on a jittered square ring', () => {
    const ring = samplePolygon(square, 30, 2);
    const corners = detectCorners(ring, Math.hypot(100, 100));
    expect(corners).toHaveLength(4);
    for (const c of corners) {
      const nearest = Math.min(...square.map((s) => Math.hypot(s.x - c.x, s.y - c.y)));
      expect(nearest).toBeLessThan(10);
    }
  });

  it('finds three corners on a triangle ring', () => {
    const tri = [
      { x: 0, y: 100 },
      { x: 120, y: 100 },
      { x: 60, y: 0 },
    ];
    expect(detectCorners(samplePolygon(tri, 30, 1.5), Math.hypot(120, 100))).toHaveLength(3);
  });
});

describe('recognizeShape', () => {
  it('returns null for tiny or empty input', () => {
    expect(recognizeShape([])).toBeNull();
    expect(recognizeShape([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }])).toBeNull();
  });

  it('recognises a slightly wobbly straight line', () => {
    const pts = sampleCurve((t) => ({ x: 100 + t * 300, y: 200 + t * 100 }), 60, 3, false);
    const shape = recognizeShape(pts);
    expect(shape?.type).toBe('line');
    if (shape?.type !== 'line') return;
    expect(shape.from).toEqual(pts[0]);
    expect(shape.to).toEqual(pts[pts.length - 1]);
  });

  it('angle-snaps a recognised line when asked', () => {
    // ~38° above horizontal (canvas y down) → 45° after snapping.
    const pts = sampleCurve(
      (t) => ({ x: 100 + t * 200, y: 300 - t * 200 * Math.tan(toRadians(38)) }),
      40,
      1,
      false,
    );
    const shape = recognizeShape(pts, { angleSnapDeg: 15 });
    expect(shape?.type).toBe('line');
    if (shape?.type !== 'line') return;
    expect(canvasAngleToMathDegrees(angleOf(shape.from, shape.to))).toBeCloseTo(45, 5);
  });

  it('recognises a noisy circle as a circle (equal radii)', () => {
    const shape = recognizeShape(circle(400, 300, 80, 4));
    expect(shape?.type).toBe('ellipse');
    if (shape?.type !== 'ellipse') return;
    expect(shape.radiusX).toBe(shape.radiusY);
    expect(shape.radiusX).toBeCloseTo(80, -1);
    expect(shape.center.x).toBeCloseTo(400, -1);
    expect(shape.center.y).toBeCloseTo(300, -1);
  });

  it('recognises an axis-aligned ellipse with distinct radii', () => {
    const pts = sampleCurve((t) => ({ x: 200 + Math.cos(t * TAU) * 120, y: 200 + Math.sin(t * TAU) * 50 }), 96, 2);
    const shape = recognizeShape(pts);
    expect(shape?.type).toBe('ellipse');
    if (shape?.type !== 'ellipse') return;
    expect(shape.rotation).toBe(0);
    expect(shape.radiusX).toBeGreaterThan(shape.radiusY * 2);
  });

  it('recognises an axis-aligned rectangle and snaps it to the bounding box', () => {
    const pts = samplePolygon(
      [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
        { x: 300, y: 220 },
        { x: 100, y: 220 },
      ],
      30,
      2.5,
    );
    const shape = recognizeShape(pts);
    expect(shape?.type).toBe('rectangle');
    if (shape?.type !== 'rectangle') return;
    expect(shape.rotation).toBe(0);
    expect(shape.width).toBeCloseTo(200, -1);
    expect(shape.height).toBeCloseTo(120, -1);
    expect(shape.center.x).toBeCloseTo(200, 0);
    expect(shape.center.y).toBeCloseTo(160, 0);
  });

  it('recognises a rotated rectangle with its rotation', () => {
    const rot = toRadians(30);
    const c = { x: 300, y: 300 };
    const corner = (sx: number, sy: number): Point => ({
      x: c.x + sx * 100 * Math.cos(rot) - sy * 50 * Math.sin(rot),
      y: c.y + sx * 100 * Math.sin(rot) + sy * 50 * Math.cos(rot),
    });
    const pts = samplePolygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], 30, 1.5);
    const shape = recognizeShape(pts);
    expect(shape?.type).toBe('rectangle');
    if (shape?.type !== 'rectangle') return;
    expect(Math.abs(shape.rotation - rot)).toBeLessThan(toRadians(3));
    expect(Math.max(shape.width, shape.height)).toBeCloseTo(200, -1);
    expect(Math.min(shape.width, shape.height)).toBeCloseTo(100, -1);
  });

  it('recognises a triangle as a three-point polygon', () => {
    const pts = samplePolygon(
      [
        { x: 100, y: 300 },
        { x: 340, y: 300 },
        { x: 220, y: 100 },
      ],
      30,
      2,
    );
    const shape = recognizeShape(pts);
    expect(shape?.type).toBe('polygon');
    if (shape?.type !== 'polygon') return;
    expect(shape.points).toHaveLength(3);
  });

  it('keeps a skewed quadrilateral as a polygon, not a rectangle', () => {
    const pts = samplePolygon(
      [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
        { x: 360, y: 220 },
        { x: 160, y: 220 },
      ],
      30,
      1.5,
    );
    const shape = recognizeShape(pts);
    expect(shape?.type).toBe('polygon');
    if (shape?.type !== 'polygon') return;
    expect(shape.points).toHaveLength(4);
  });

  it('recognises a heart', () => {
    const ideal = heartPoints({ type: 'heart', center: { x: 300, y: 300 }, width: 200, height: 180 }, 96);
    const jittered = ideal.map((p, i) => ({ x: p.x + ((i % 3) - 1) * 1.5, y: p.y + ((i % 5) - 2) * 1.2 }));
    expect(isHeart(jittered)).toBe(true);
    const shape = recognizeShape([...jittered, jittered[0] ?? { x: 0, y: 0 }]);
    expect(shape?.type).toBe('heart');
    if (shape?.type !== 'heart') return;
    expect(shape.width).toBeCloseTo(200, -1);
    expect(shape.height).toBeCloseTo(180, -1);
  });

  it('does not mistake a circle or rectangle for a heart', () => {
    expect(isHeart(circle(0, 0, 50, 0))).toBe(false);
    expect(
      isHeart(
        samplePolygon(
          [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 60 },
            { x: 0, y: 60 },
          ],
          25,
        ),
      ),
    ).toBe(false);
  });

  it('recognises an open L as a polyline', () => {
    const pts = [
      ...sampleCurve((t) => ({ x: 100, y: 100 + t * 150 }), 30, 1.5, false),
      ...sampleCurve((t) => ({ x: 100 + t * 200, y: 250 }), 30, 1.5, false),
    ];
    const shape = recognizeShape(pts);
    expect(shape?.type).toBe('polyline');
    if (shape?.type !== 'polyline') return;
    expect(shape.points).toHaveLength(3);
  });

  it('returns null for a scribble', () => {
    const pts = sampleCurve(
      (t) => ({ x: 100 + t * 300 + Math.sin(t * 40) * 30, y: 200 + Math.cos(t * 23) * 60 + Math.sin(t * 61) * 25 }),
      160,
      0,
      false,
    );
    expect(recognizeShape(pts)).toBeNull();
  });
});
