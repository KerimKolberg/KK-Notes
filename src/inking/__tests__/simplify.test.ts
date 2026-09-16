import { describe, expect, it } from 'vitest';
import {
  endTangent,
  perpendicularDistance,
  polylineLength,
  resamplePolyline,
  simplifyRdp,
} from '../engine/simplify';

describe('perpendicularDistance', () => {
  it('measures distance to the infinite line, not the segment', () => {
    expect(perpendicularDistance({ x: 20, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(perpendicularDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('simplifyRdp', () => {
  it('keeps the endpoints and drops collinear interior points', () => {
    const pts = Array.from({ length: 11 }, (_, i) => ({ x: i * 10, y: 0 }));
    const out = simplifyRdp(pts, 1);
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });

  it('keeps a corner that deviates more than epsilon', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 50, y: 0.4 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 100, y: 100 },
    ];
    expect(simplifyRdp(pts, 1)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]);
  });

  it('is monotone in epsilon', () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({
      x: i,
      y: Math.sin(i / 10) * 20 + ((i * 7919) % 5) * 0.4,
    }));
    const fine = simplifyRdp(pts, 0.5).length;
    const coarse = simplifyRdp(pts, 5).length;
    expect(fine).toBeGreaterThan(coarse);
    expect(coarse).toBeGreaterThanOrEqual(2);
  });

  it('preserves the original point objects and order', () => {
    const pts = [
      { x: 0, y: 0, pressure: 0.1 },
      { x: 5, y: 9, pressure: 0.2 },
      { x: 10, y: 0, pressure: 0.3 },
    ];
    const out = simplifyRdp(pts, 1);
    expect(out[0]).toBe(pts[0]);
    expect(out[1]).toBe(pts[1]);
    expect(out[2]).toBe(pts[2]);
  });

  it('passes through inputs with fewer than three points', () => {
    expect(simplifyRdp([{ x: 1, y: 1 }], 1)).toEqual([{ x: 1, y: 1 }]);
    expect(simplifyRdp([], 1)).toEqual([]);
  });
});

describe('resamplePolyline', () => {
  it('produces equidistant points including both endpoints', () => {
    const out = resamplePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], 2.5);
    expect(out.map((p) => p.x)).toEqual([0, 2.5, 5, 7.5, 10]);
  });

  it('carries the remainder across vertices', () => {
    // Two 3px segments, spacing 2 → samples at 2, 4 then the endpoint at 6.
    const out = resamplePolyline([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 6, y: 0 }], 2);
    expect(out.map((p) => p.x)).toEqual([0, 2, 4, 6]);
  });

  it('keeps arc-length spacing on a curve within a small tolerance', () => {
    const circle = Array.from({ length: 200 }, (_, i) => ({
      x: Math.cos((i / 200) * Math.PI * 2) * 50,
      y: Math.sin((i / 200) * Math.PI * 2) * 50,
    }));
    const out = resamplePolyline(circle, 5);
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1];
      const b = out[i];
      if (!a || !b) continue;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(5, 1);
    }
  });
});

describe('polylineLength / endTangent', () => {
  it('sums segment lengths', () => {
    expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }])).toBe(11);
  });

  it('estimates the trailing direction over a window', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 20, y: 20 }];
    expect(endTangent(pts, 15)).toBeCloseTo(Math.PI / 2, 6);
    expect(endTangent([{ x: 0, y: 0 }], 10)).toBeNull();
  });
});
