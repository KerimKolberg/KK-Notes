import { describe, expect, it } from 'vitest';
import {
  PX_PER_CM,
  RULER_SNAP_DISTANCE,
  RULER_WIDTH,
  angleDegrees,
  edgeForStart,
  initialRuler,
  keepOnPage,
  lengthCm,
  projectToEdge,
  rulerEdges,
  rulerPoint,
  rulerTicks,
  type Ruler,
} from '../engine/ruler';

const near = (a: number, b: number, digits = 6): void => expect(a).toBeCloseTo(b, digits);
const flat: Ruler = { x: 400, y: 300, angle: 0, length: 500 };

describe('the ruler\'s edges', () => {
  it('lie along it, at either side of its middle', () => {
    const [upper, lower] = rulerEdges(flat);
    near(upper.from.x, 150);
    near(upper.to.x, 650);
    near(upper.from.y, 300 - RULER_WIDTH / 2);
    near(lower.from.y, 300 + RULER_WIDTH / 2);
    near(lower.to.y, lower.from.y);
  });

  it('turn with it about its centre', () => {
    const turned = { ...flat, angle: Math.PI / 2 };
    const [upper] = rulerEdges(turned);
    // A quarter turn clockwise stands it up: the ruler's left end is now at the top, and what was
    // its upper edge is on the page's right.
    near(upper.from.y, 300 - 250);
    near(upper.to.y, 300 + 250);
    near(upper.from.x, 400 + RULER_WIDTH / 2);
    near(upper.to.x, upper.from.x);
  });

  it('keep the same length and width whatever the angle', () => {
    for (const angle of [0.3, 1, 2.5, -1.2]) {
      const [a, b] = rulerEdges({ ...flat, angle });
      near(Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y), 500, 6);
      near(Math.hypot(b.from.x - a.from.x, b.from.y - a.from.y), RULER_WIDTH, 6);
    }
  });

  it('map a point in its own frame onto the page', () => {
    const p = rulerPoint({ ...flat, angle: Math.PI / 2 }, { x: 10, y: 0 });
    near(p.x, 400);
    near(p.y, 310);
  });
});

describe('projecting onto an edge', () => {
  const edge = { from: { x: 0, y: 0 }, to: { x: 100, y: 0 } };

  it('finds the nearest point and how far along it is', () => {
    const r = projectToEdge(edge, { x: 30, y: 12 });
    expect(r.point).toEqual({ x: 30, y: 0 });
    near(r.t, 0.3);
    near(r.distance, 12);
  });

  it('stops at either end', () => {
    expect(projectToEdge(edge, { x: -40, y: 5 }).point).toEqual({ x: 0, y: 0 });
    expect(projectToEdge(edge, { x: 160, y: 5 }).point).toEqual({ x: 100, y: 0 });
    expect(projectToEdge(edge, { x: 160, y: 5 }).t).toBe(1);
  });

  it('works on a slanted edge', () => {
    const slant = { from: { x: 0, y: 0 }, to: { x: 100, y: 100 } };
    const r = projectToEdge(slant, { x: 100, y: 0 });
    near(r.point.x, 50);
    near(r.point.y, 50);
  });

  it('copes with an edge that is a point', () => {
    const dot = { from: { x: 5, y: 5 }, to: { x: 5, y: 5 } };
    expect(projectToEdge(dot, { x: 9, y: 9 }).point).toEqual({ x: 5, y: 5 });
  });
});

describe('where a stroke has to start to follow the ruler', () => {
  const [upper, lower] = rulerEdges(flat);

  it('takes the nearer edge from outside it', () => {
    const above = edgeForStart(flat, { x: 400, y: 300 - RULER_WIDTH / 2 - 10 });
    expect(above).toEqual(upper);
    const below = edgeForStart(flat, { x: 400, y: 300 + RULER_WIDTH / 2 + 10 });
    expect(below).toEqual(lower);
  });

  it('takes the edge from just inside it too', () => {
    expect(edgeForStart(flat, { x: 400, y: 300 - RULER_WIDTH / 2 + 10 })).toEqual(upper);
  });

  it('leaves the middle of the body alone, so it can still be written on', () => {
    expect(edgeForStart(flat, { x: 400, y: 300 })).toBeNull();
  });

  it('leaves everything further away than the snap distance alone', () => {
    expect(edgeForStart(flat, { x: 400, y: 300 - RULER_WIDTH / 2 - RULER_SNAP_DISTANCE - 2 })).toBeNull();
    expect(edgeForStart(flat, { x: 400, y: 300 - RULER_WIDTH / 2 - RULER_SNAP_DISTANCE + 2 })).toEqual(upper);
  });

  it('does not reach past the ends of the ruler', () => {
    expect(edgeForStart(flat, { x: 150 - 60, y: 300 - RULER_WIDTH / 2 })).toBeNull();
    expect(edgeForStart(flat, { x: 150 - 10, y: 300 - RULER_WIDTH / 2 })).toEqual(upper);
  });

  it('follows the ruler round when it is turned', () => {
    const turned = { ...flat, angle: Math.PI / 6 };
    const [u] = rulerEdges(turned);
    const mid = { x: (u.from.x + u.to.x) / 2, y: (u.from.y + u.to.y) / 2 };
    expect(edgeForStart(turned, { x: mid.x - 4, y: mid.y - 6 })).toEqual(u);
  });

  it('prefers the nearer of two edges on a ruler narrower than two snap distances', () => {
    const r = { ...flat };
    const p = { x: 400, y: 300 - RULER_WIDTH / 2 + 4 };
    expect(edgeForStart(r, p, RULER_WIDTH)).toEqual(upper);
  });
});

describe('reading the ruler', () => {
  it('measures in centimetres, true to a 96 dpi page', () => {
    near(lengthCm({ x: 0, y: 0 }, { x: PX_PER_CM, y: 0 }), 1);
    near(lengthCm({ x: 0, y: 0 }, { x: 3 * PX_PER_CM, y: 4 * PX_PER_CM }), 5);
    near(PX_PER_CM, 37.795, 2);
  });

  it('gives its angle in whole degrees, never negative', () => {
    expect(angleDegrees({ ...flat, angle: 0 })).toBe(0);
    expect(angleDegrees({ ...flat, angle: Math.PI / 4 })).toBe(45);
    expect(angleDegrees({ ...flat, angle: -Math.PI / 2 })).toBe(270);
    expect(angleDegrees({ ...flat, angle: Math.PI * 2 })).toBe(0);
  });

  it('marks every millimetre, with centimetres numbered and half centimetres set apart', () => {
    const ticks = rulerTicks(10 * PX_PER_CM);
    expect(ticks[0]).toEqual({ at: 0, kind: 'cm', label: 0 });
    expect(ticks.filter((t) => t.kind === 'cm').map((t) => t.label)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ticks.filter((t) => t.kind === 'half')).toHaveLength(10);
    expect(ticks.filter((t) => t.kind === 'mm')).toHaveLength(80);
    near(ticks[10]!.at, PX_PER_CM);
  });

  it('marks nothing past its own end', () => {
    const ticks = rulerTicks(100);
    expect(ticks.every((t) => t.at <= 100)).toBe(true);
  });
});

describe('placing it', () => {
  it('starts in the middle of the page, across the upper part', () => {
    const r = initialRuler({ width: 794, height: 1123 });
    near(r.x, 397);
    expect(r.y).toBeLessThan(1123 / 2);
    expect(r.angle).toBe(0);
  });

  it('is no longer than the page is wide', () => {
    expect(initialRuler({ width: 794, height: 1123 }).length).toBeLessThanOrEqual(794 - 100);
    expect(initialRuler({ width: 300, height: 400 }).length).toBeLessThan(300);
    expect(initialRuler({ width: 100, height: 100 }).length).toBeGreaterThan(0);
  });

  it('keeps its centre on the page', () => {
    const page = { width: 800, height: 600 };
    expect(keepOnPage({ ...flat, x: -50, y: 900 }, page)).toMatchObject({ x: 0, y: 600 });
    expect(keepOnPage(flat, page)).toBe(flat);
  });
});
