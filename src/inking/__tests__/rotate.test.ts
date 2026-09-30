import { describe, expect, it } from 'vitest';
import {
  boundsCentre,
  normalizeAngle,
  rotationFromPointer,
  selectionBounds,
  snapRotation,
  transformBBox,
  transformPoint,
  transformStroke,
  transformStrokes,
  type StrokeTransform,
} from '../engine/lasso';
import { coordinatePlaneGeometry, heartPoints, rectangleCorners, shapeToPolylines } from '../engine/shapes';
import { DEFAULT_COORDINATE_PLANE } from '../constants';
import type { GeometricStroke, Point } from '../types';
import { makeGeometric, makeLine, makeStroke } from './testUtils';

const QUARTER = Math.PI / 2;
const deg = (d: number): number => (d * Math.PI) / 180;
const turn = (origin: Point, angle: number): StrokeTransform => ({ kind: 'rotate', origin, angle });
const near = (a: number, b: number, digits = 6): void => expect(a).toBeCloseTo(b, digits);

describe('rotating points', () => {
  it('turns a quarter clockwise as the page shows it (y points down)', () => {
    // East of the pivot goes to south of it.
    const p = transformPoint({ x: 10, y: 0 }, turn({ x: 0, y: 0 }, QUARTER));
    near(p.x, 0);
    near(p.y, 10);
  });

  it('turns about the pivot, not the origin', () => {
    const p = transformPoint({ x: 30, y: 20 }, turn({ x: 20, y: 20 }, Math.PI));
    near(p.x, 10);
    near(p.y, 20);
  });

  it('keeps everything else about the point, pressure included', () => {
    const p = transformPoint({ x: 1, y: 0, pressure: 0.7 }, turn({ x: 0, y: 0 }, QUARTER));
    expect(p.pressure).toBe(0.7);
  });

  it('leaves the pivot where it is and a full turn where it started', () => {
    const home = transformPoint({ x: 7, y: 3 }, turn({ x: 2, y: 9 }, Math.PI * 2));
    near(home.x, 7);
    near(home.y, 3);
    const pivot = transformPoint({ x: 2, y: 9 }, turn({ x: 2, y: 9 }, 1.234));
    near(pivot.x, 2);
    near(pivot.y, 9);
  });
});

describe('rotating a box', () => {
  it('follows all four corners, not two', () => {
    // A 100 x 20 box turned 45° about its middle is about 85 across, both ways.
    const box = { minX: 0, minY: 0, maxX: 100, maxY: 20 };
    const turned = transformBBox(box, turn(boundsCentre(box), deg(45)));
    const span = (100 + 20) / Math.SQRT2;
    near(turned.maxX - turned.minX, span, 4);
    near(turned.maxY - turned.minY, span, 4);
    near((turned.minX + turned.maxX) / 2, 50, 4);
  });

  it('swaps the sides on a quarter turn', () => {
    const box = { minX: 0, minY: 0, maxX: 100, maxY: 20 };
    const turned = transformBBox(box, turn(boundsCentre(box), QUARTER));
    near(turned.maxX - turned.minX, 20, 4);
    near(turned.maxY - turned.minY, 100, 4);
  });
});

describe('rotating strokes', () => {
  it('turns a freehand stroke point by point and recomputes its bounds', () => {
    const stroke = makeStroke([
      [0, 0],
      [100, 0],
    ]);
    const turned = transformStroke(stroke, turn({ x: 50, y: 0 }, QUARTER));
    if (turned.kind !== 'freehand') throw new Error('still freehand');
    near(turned.points[0]!.x, 50);
    near(turned.points[0]!.y, -50);
    near(turned.points[1]!.x, 50);
    near(turned.points[1]!.y, 50);
    // Tall now, and the padded box says so.
    expect(turned.bbox.maxY - turned.bbox.minY).toBeGreaterThan(turned.bbox.maxX - turned.bbox.minX);
  });

  it('does not change how thick a turned stroke is', () => {
    const stroke = makeStroke([
      [0, 0],
      [10, 10],
    ]);
    expect(transformStroke(stroke, turn({ x: 0, y: 0 }, 1)).style).toBe(stroke.style);
  });

  it('turns a line by its ends', () => {
    const line = makeLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const turned = transformStroke(line, turn({ x: 0, y: 0 }, QUARTER)) as GeometricStroke;
    if (turned.shape.type !== 'line') throw new Error('still a line');
    near(turned.shape.to.x, 0);
    near(turned.shape.to.y, 10);
  });

  it('turns a polygon by its corners and a curve by its ends, keeping the curve\'s bow', () => {
    const polygon = makeGeometric({
      type: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
    });
    const p = transformStroke(polygon, turn({ x: 0, y: 0 }, QUARTER)) as GeometricStroke;
    if (p.shape.type !== 'polygon') throw new Error('still a polygon');
    near(p.shape.points[1]!.x, 0);
    near(p.shape.points[1]!.y, 10);

    const curve = makeGeometric({
      type: 'curve',
      kind: 'parabola',
      from: { x: 0, y: 0 },
      to: { x: 100, y: 0 },
      amplitude: 20,
      cycles: 1,
    });
    const c = transformStroke(curve, turn({ x: 0, y: 0 }, QUARTER)) as GeometricStroke;
    if (c.shape.type !== 'curve') throw new Error('still a curve');
    near(c.shape.to.x, 0);
    near(c.shape.to.y, 100);
    expect(c.shape.amplitude).toBe(20);
  });

  it('adds the turn to a rectangle\'s own rotation and moves its centre', () => {
    const rect = makeGeometric({ type: 'rectangle', center: { x: 10, y: 0 }, width: 40, height: 20, rotation: deg(10) });
    const r = transformStroke(rect, turn({ x: 0, y: 0 }, QUARTER)) as GeometricStroke;
    if (r.shape.type !== 'rectangle') throw new Error('still a rectangle');
    near(r.shape.rotation, deg(10) + QUARTER);
    near(r.shape.center.x, 0);
    near(r.shape.center.y, 10);
    expect(r.shape.width).toBe(40);
    expect(r.shape.height).toBe(20);
    // Its corners agree with the turn applied to the old ones.
    const before = rectangleCorners(rect.shape as never);
    const after = rectangleCorners(r.shape);
    for (let i = 0; i < 4; i++) {
      const expected = transformPoint(before[i]!, turn({ x: 0, y: 0 }, QUARTER));
      near(after[i]!.x, expected.x, 4);
      near(after[i]!.y, expected.y, 4);
    }
  });

  it('turns an ellipse the same way', () => {
    const ellipse = makeGeometric({ type: 'ellipse', center: { x: 5, y: 5 }, radiusX: 30, radiusY: 10, rotation: 0 });
    const e = transformStroke(ellipse, turn({ x: 5, y: 5 }, QUARTER)) as GeometricStroke;
    if (e.shape.type !== 'ellipse') throw new Error('still an ellipse');
    near(e.shape.rotation, QUARTER);
    expect(e.shape.center).toEqual({ x: 5, y: 5 });
    // Wide became tall.
    expect(e.bbox.maxY - e.bbox.minY).toBeGreaterThan(e.bbox.maxX - e.bbox.minX);
  });

  it('gives a heart a rotation of its own, and leaves an unturned one without', () => {
    const heart = makeGeometric({ type: 'heart', center: { x: 0, y: 0 }, width: 100, height: 90 });
    const scaled = transformStroke(heart, { kind: 'scale', origin: { x: 0, y: 0 }, sx: 2, sy: 2 }) as GeometricStroke;
    if (scaled.shape.type !== 'heart') throw new Error('still a heart');
    expect('rotation' in scaled.shape).toBe(false);

    const h = transformStroke(heart, turn({ x: 0, y: 0 }, Math.PI)) as GeometricStroke;
    if (h.shape.type !== 'heart') throw new Error('still a heart');
    near(h.shape.rotation ?? 0, Math.PI);
    // Upside down: the cusp that was at the bottom is at the top.
    const flipped = heartPoints(h.shape);
    const upright = heartPoints(heart.shape as never);
    near(flipped[0]!.y, -upright[0]!.y, 4);
  });

  it('keeps ids and order when a selection is turned', () => {
    const a = makeStroke([
      [0, 0],
      [10, 0],
    ]);
    const b = makeStroke([
      [0, 5],
      [10, 5],
    ]);
    const out = transformStrokes([a, b], new Set([a.id]), turn({ x: 0, y: 0 }, 1));
    expect(out.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(out[1]).toBe(b);
    expect(out[0]).not.toBe(a);
  });

  it('comes back to where it started after a turn and its opposite', () => {
    const stroke = makeStroke([
      [3, 4],
      [50, 80],
      [12, 9],
    ]);
    const there = transformStroke(stroke, turn({ x: 20, y: 30 }, 0.9));
    const back = transformStroke(there, turn({ x: 20, y: 30 }, -0.9));
    if (back.kind !== 'freehand' || stroke.kind !== 'freehand') throw new Error('freehand');
    back.points.forEach((p, i) => {
      near(p.x, stroke.points[i]!.x, 6);
      near(p.y, stroke.points[i]!.y, 6);
    });
  });
});

describe('a turned coordinate plane', () => {
  const plane = (rotation?: number) => ({
    type: 'coordinate-plane' as const,
    origin: { x: 200, y: 200 },
    extentX: 100,
    extentY: 80,
    config: { ...DEFAULT_COORDINATE_PLANE, divisions: 4 },
    ...(rotation === undefined ? {} : { rotation }),
  });

  it('is unchanged by a rotation of nothing', () => {
    expect(coordinatePlaneGeometry(plane(0))).toEqual(coordinatePlaneGeometry(plane()));
  });

  it('lays the whole plane down turned about its origin', () => {
    const flat = coordinatePlaneGeometry(plane());
    const turned = coordinatePlaneGeometry(plane(QUARTER));
    const about = turn({ x: 200, y: 200 }, QUARTER);
    flat.axes.forEach((s, i) => {
      const a = transformPoint(s.a, about);
      near(turned.axes[i]!.a.x, a.x, 4);
      near(turned.axes[i]!.a.y, a.y, 4);
    });
    flat.ticks.forEach((s, i) => {
      const b = transformPoint(s.b, about);
      near(turned.ticks[i]!.b.x, b.x, 4);
      near(turned.ticks[i]!.b.y, b.y, 4);
    });
    // Arrowheads point the way the axes now run.
    flat.arrows.forEach((a, i) => near(turned.arrows[i]!.angle, a.angle + QUARTER));
    // Text stays upright: same size and alignment, anchored at the turned spot.
    expect(turned.labels.map((l) => l.text)).toEqual(flat.labels.map((l) => l.text));
    expect(turned.labels.every((l, i) => l.align === flat.labels[i]!.align && l.baseline === flat.labels[i]!.baseline)).toBe(true);
    expect(turned.fontPx).toBe(flat.fontPx);
  });

  it('turns when its stroke is turned, about the pivot it is given', () => {
    const stroke = makeGeometric(plane());
    const out = transformStroke(stroke, turn({ x: 0, y: 0 }, QUARTER)) as GeometricStroke;
    if (out.shape.type !== 'coordinate-plane') throw new Error('still a plane');
    near(out.shape.rotation ?? 0, QUARTER);
    near(out.shape.origin.x, -200);
    near(out.shape.origin.y, 200);
    // Its bounds follow what is drawn: the tall plane is now wide.
    const before = stroke.bbox;
    const flatWide = before.maxX - before.minX;
    const flatTall = before.maxY - before.minY;
    const wide = out.bbox.maxX - out.bbox.minX;
    const tall = out.bbox.maxY - out.bbox.minY;
    expect(Math.abs(wide - flatTall)).toBeLessThan(40);
    expect(Math.abs(tall - flatWide)).toBeLessThan(40);
    expect(shapeToPolylines(out.shape).length).toBeGreaterThan(0);
  });
});

describe('the angle of a drag', () => {
  it('normalises into (-180°, 180°]', () => {
    near(normalizeAngle(deg(190)), deg(-170));
    near(normalizeAngle(deg(-190)), deg(170));
    near(normalizeAngle(deg(720)), 0);
    near(normalizeAngle(Math.PI), Math.PI);
  });

  it('sticks to the multiples of 45° it passes close to, and leaves the rest alone', () => {
    near(snapRotation(deg(2), false), 0);
    near(snapRotation(deg(-2.5), false), 0);
    near(snapRotation(deg(88), false), deg(90));
    near(snapRotation(deg(43), false), deg(45));
    near(snapRotation(deg(20), false), deg(20));
    near(snapRotation(deg(35), false), deg(35));
  });

  it('goes in steps of 15° with Shift', () => {
    near(snapRotation(deg(20), true), deg(15));
    near(snapRotation(deg(23), true), deg(30));
    near(snapRotation(deg(-50), true), deg(-45));
  });

  it('measures the turn from where the pen took hold, not from zero', () => {
    const centre = { x: 100, y: 100 };
    // Grabbed due east, taken due south: a quarter turn clockwise.
    const t = rotationFromPointer(centre, { x: 180, y: 100 }, { x: 100, y: 180 }, false);
    expect(t.kind).toBe('rotate');
    if (t.kind !== 'rotate') return;
    near(t.angle, QUARTER);
    expect(t.origin).toEqual(centre);
    // Grabbed slightly off axis and not moved: no turn at all.
    const still = rotationFromPointer(centre, { x: 170, y: 120 }, { x: 170, y: 120 }, false);
    if (still.kind !== 'rotate') return;
    near(still.angle, 0);
  });

  it('takes the short way round the back of the pivot', () => {
    const centre = { x: 0, y: 0 };
    // From just above west to just below west: a small turn, not a near-full one.
    const t = rotationFromPointer(centre, { x: -10, y: -1 }, { x: -10, y: 1 }, false);
    if (t.kind !== 'rotate') return;
    expect(Math.abs(t.angle)).toBeLessThan(deg(15));
  });
});

describe('rotating what is selected', () => {
  it('turns about the middle of the selection\'s box', () => {
    const a = makeStroke([
      [0, 0],
      [100, 0],
    ]);
    const bounds = selectionBounds([a])!;
    const c = boundsCentre(bounds);
    const [turned] = transformStrokes([a], new Set([a.id]), turn(c, Math.PI));
    if (turned?.kind !== 'freehand' || a.kind !== 'freehand') throw new Error('freehand');
    // A half turn swaps the ends and leaves the middle.
    near(turned.points[0]!.x, a.points[1]!.x, 4);
    near(turned.points[1]!.x, a.points[0]!.x, 4);
    near(turned.points[0]!.y, a.points[0]!.y, 4);
  });
});
