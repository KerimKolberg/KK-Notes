import { describe, expect, it } from 'vitest';
import {
  arrangeOffsets,
  arrangeStrokes,
  arrangeUnits,
  canAlign,
  canDistribute,
  canGroup,
  expandToGroups,
  groupStrokes,
  hasGroup,
  pastedCopies,
  regroup,
  ungroupStrokes,
} from '../engine/arrange';
import { duplicateStrokes, transformBBox, transformPoint, transformStroke } from '../engine/lasso';
import { curvePoints, heartPoints, rectangleCorners } from '../engine/shapes';
import { DEFAULT_COORDINATE_PLANE } from '../constants';
import type { GeometricStroke, Stroke } from '../types';
import { makeGeometric, makeLine, makeStroke } from './testUtils';

const near = (a: number, b: number, digits = 6): void => expect(a).toBeCloseTo(b, digits);
const box = (s: Stroke) => s.bbox;
const origin = { x: 0, y: 0 };

/** A stroke that is a short horizontal bar at `x`, `y`, `w` wide. */
const bar = (x: number, y: number, w = 20): Stroke =>
  makeStroke([
    [x, y],
    [x + w, y],
  ]);

describe('flipping', () => {
  it('mirrors a point across the line through the pivot', () => {
    const h = transformPoint({ x: 30, y: 7 }, { kind: 'flip', origin: { x: 10, y: 0 }, axis: 'horizontal' });
    near(h.x, -10);
    near(h.y, 7);
    const v = transformPoint({ x: 30, y: 7 }, { kind: 'flip', origin: { x: 10, y: 2 }, axis: 'vertical' });
    near(v.x, 30);
    near(v.y, -3);
  });

  it('is its own opposite', () => {
    const t = { kind: 'flip', origin: { x: 4, y: 9 }, axis: 'horizontal' } as const;
    const p = { x: 12, y: -3, pressure: 0.4 };
    const back = transformPoint(transformPoint(p, t), t);
    near(back.x, p.x);
    near(back.y, p.y);
    expect(back.pressure).toBe(0.4);
  });

  it('keeps a mirrored box a box', () => {
    const b = transformBBox({ minX: 0, minY: 0, maxX: 10, maxY: 4 }, { kind: 'flip', origin: { x: 20, y: 0 }, axis: 'horizontal' });
    expect(b).toEqual({ minX: 30, minY: 0, maxX: 40, maxY: 4 });
  });

  it('reverses a freehand stroke left to right, keeping its identity and group', () => {
    const s = { ...makeStroke([[0, 0], [10, 5], [30, 0]]), groupId: 'g1' } as Stroke;
    const f = transformStroke(s, { kind: 'flip', origin: { x: 15, y: 0 }, axis: 'horizontal' });
    if (f.kind !== 'freehand' || s.kind !== 'freehand') throw new Error('freehand');
    expect(f.id).toBe(s.id);
    expect(f.groupId).toBe('g1');
    near(f.points[0]!.x, 30);
    near(f.points[2]!.x, 0);
    near(f.points[1]!.y, 5);
    expect(f.bbox.minX).toBeLessThan(f.bbox.maxX);
  });

  it('turns a rectangle\'s tilt the other way and moves its centre', () => {
    const r = makeGeometric({ type: 'rectangle', center: { x: 20, y: 5 }, width: 30, height: 10, rotation: 0.4 });
    const f = transformStroke(r, { kind: 'flip', origin: origin, axis: 'horizontal' }) as GeometricStroke;
    if (f.shape.type !== 'rectangle') throw new Error('rectangle');
    near(f.shape.rotation, -0.4);
    near(f.shape.center.x, -20);
    // Its corners are the mirror image of the old ones, as a set.
    const before = rectangleCorners(r.shape as never).map((c) => Math.round(-c.x * 1e4) / 1e4).sort((a, b) => a - b);
    const after = rectangleCorners(f.shape).map((c) => Math.round(c.x * 1e4) / 1e4).sort((a, b) => a - b);
    expect(after).toEqual(before);
  });

  it('flips an ellipse the same way, and a vertical flip tilts it the same way a horizontal one does', () => {
    const e = makeGeometric({ type: 'ellipse', center: { x: 5, y: 5 }, radiusX: 30, radiusY: 10, rotation: 0.5 });
    const h = transformStroke(e, { kind: 'flip', origin: origin, axis: 'horizontal' }) as GeometricStroke;
    const v = transformStroke(e, { kind: 'flip', origin: origin, axis: 'vertical' }) as GeometricStroke;
    if (h.shape.type !== 'ellipse' || v.shape.type !== 'ellipse') throw new Error('ellipse');
    near(h.shape.rotation, -0.5);
    near(v.shape.rotation, -0.5);
  });

  it('turns a heart upside down when flipped top to bottom, and leaves it the right way up left to right', () => {
    const heart = makeGeometric({ type: 'heart', center: { x: 0, y: 0 }, width: 100, height: 90 });
    const upright = heartPoints(heart.shape as never);
    const h = transformStroke(heart, { kind: 'flip', origin: origin, axis: 'horizontal' }) as GeometricStroke;
    const v = transformStroke(heart, { kind: 'flip', origin: origin, axis: 'vertical' }) as GeometricStroke;
    if (h.shape.type !== 'heart' || v.shape.type !== 'heart') throw new Error('heart');
    // The left-right mirror of a heart is the same heart: same points as a set of (|x|, y).
    const a = upright.map((p) => `${Math.round(Math.abs(p.x))},${Math.round(p.y)}`).sort();
    const b = heartPoints(h.shape).map((p) => `${Math.round(Math.abs(p.x))},${Math.round(p.y)}`).sort();
    expect(b).toEqual(a);
    // Upside down: every point is where the vertical mirror of the original put it.
    const flipped = heartPoints(v.shape);
    for (const p of upright) {
      const target = { x: p.x, y: -p.y };
      const hit = flipped.some((q) => Math.hypot(q.x - target.x, q.y - target.y) < 1e-6);
      expect(hit).toBe(true);
    }
  });

  it('turns a curve\'s bow round with it', () => {
    const curve = makeGeometric({ type: 'curve', kind: 'parabola', from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, amplitude: 20, cycles: 1 });
    const f = transformStroke(curve, { kind: 'flip', origin: { x: 50, y: 0 }, axis: 'horizontal' }) as GeometricStroke;
    if (f.shape.type !== 'curve') throw new Error('curve');
    near(f.shape.from.x, 100);
    near(f.shape.to.x, 0);
    // Bowed downwards before (positive amplitude, left to right); now running right to left
    // with the bow still downwards on the page, which is the opposite sign against its chord.
    near(f.shape.amplitude, -20);
    // And flipping back is what it was.
    const back = transformStroke(f, { kind: 'flip', origin: { x: 50, y: 0 }, axis: 'horizontal' }) as GeometricStroke;
    if (back.shape.type !== 'curve') throw new Error('curve');
    near(back.shape.amplitude, 20);
  });

  it('draws the mirror image of every kind of curve, point for point', () => {
    for (const kind of ['parabola', 'wave', 'zigzag'] as const) {
      for (const axis of ['horizontal', 'vertical'] as const) {
        const curve = makeGeometric({ type: 'curve', kind, from: { x: 10, y: 20 }, to: { x: 110, y: 60 }, amplitude: 18, cycles: 2 });
        const t = { kind: 'flip', origin: { x: 50, y: 40 }, axis } as const;
        const flipped = transformStroke(curve, t) as GeometricStroke;
        if (flipped.shape.type !== 'curve' || curve.shape.type !== 'curve') throw new Error('curve');
        const mirrored = curvePoints(curve.shape).map((p) => transformPoint(p, t));
        const drawn = curvePoints(flipped.shape);
        for (const m of mirrored) {
          const nearest = Math.min(...drawn.map((d) => Math.hypot(d.x - m.x, d.y - m.y)));
          expect(nearest).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('moves a coordinate plane\'s origin and leaves the plane the way up it was', () => {
    const plane = makeGeometric({ type: 'coordinate-plane', origin: { x: 100, y: 200 }, extentX: 50, extentY: 40, config: DEFAULT_COORDINATE_PLANE });
    const f = transformStroke(plane, { kind: 'flip', origin: { x: 0, y: 0 }, axis: 'horizontal' }) as GeometricStroke;
    if (f.shape.type !== 'coordinate-plane') throw new Error('plane');
    near(f.shape.origin.x, -100);
    near(f.shape.origin.y, 200);
    expect('rotation' in f.shape).toBe(false);
  });

  it('turns a line\'s ends round, arrowheads with them', () => {
    const line = makeLine({ x: 0, y: 0 }, { x: 10, y: 4 });
    const f = transformStroke(line, { kind: 'flip', origin: { x: 5, y: 0 }, axis: 'horizontal' }) as GeometricStroke;
    if (f.shape.type !== 'line') throw new Error('line');
    near(f.shape.from.x, 10);
    near(f.shape.to.x, 0);
    near(f.shape.to.y, 4);
  });
});

describe('groups', () => {
  const a = bar(0, 0);
  const b = bar(0, 50);
  const c = bar(0, 100);

  it('group the strokes they are given and nothing else', () => {
    const out = groupStrokes([a, b, c], new Set([a.id, b.id]), 'g1');
    expect(out[0]!.groupId).toBe('g1');
    expect(out[1]!.groupId).toBe('g1');
    expect(out[2]).toBe(c);
  });

  it('are undone by ungrouping, which leaves no trace on the stroke', () => {
    const grouped = groupStrokes([a, b], new Set([a.id, b.id]), 'g1');
    const out = ungroupStrokes(grouped, new Set([a.id, b.id]));
    expect(out.every((s) => !('groupId' in s))).toBe(true);
    expect(out[0]).toMatchObject({ id: a.id });
    // Strokes that were never grouped come back as the same objects.
    expect(ungroupStrokes([a, b], new Set([a.id]))[0]).toBe(a);
  });

  it('say when grouping would do something', () => {
    expect(canGroup([a])).toBe(false);
    expect(canGroup([a, b])).toBe(true);
    const grouped = groupStrokes([a, b], new Set([a.id, b.id]), 'g1');
    expect(canGroup(grouped)).toBe(false);
    expect(canGroup([...grouped, c])).toBe(true);
    expect(hasGroup(grouped)).toBe(true);
    expect(hasGroup([a, b])).toBe(false);
  });

  it('are selected whole when any member is', () => {
    const strokes = groupStrokes([a, b, c], new Set([a.id, b.id]), 'g1');
    expect(expandToGroups(strokes, [a.id])).toEqual([a.id, b.id]);
    expect(expandToGroups(strokes, [c.id])).toEqual([c.id]);
    expect(expandToGroups(strokes, [b.id, c.id])).toEqual([a.id, b.id, c.id]);
    // Nothing to expand: the ids come back as given.
    expect(expandToGroups([a, b, c], [c.id, a.id])).toEqual([c.id, a.id]);
  });

  it('get a group of their own in a copy', () => {
    const grouped = groupStrokes([a, b], new Set([a.id, b.id]), 'g1');
    const { strokes, ids } = duplicateStrokes(grouped, new Set([a.id, b.id]));
    const copies = strokes.filter((s) => ids.includes(s.id));
    expect(copies).toHaveLength(2);
    expect(copies[0]!.groupId).toBeDefined();
    expect(copies[0]!.groupId).toBe(copies[1]!.groupId);
    expect(copies[0]!.groupId).not.toBe('g1');
    // The originals are still together.
    expect(strokes[0]!.groupId).toBe('g1');
    expect(regroup(grouped)[0]!.groupId).not.toBe('g1');
  });
});

describe('lining up', () => {
  const a = bar(10, 0, 20);
  const b = bar(40, 50, 60);
  const c = bar(100, 100, 40);
  const selected = [a, b, c];

  it('counts a group as one thing', () => {
    const grouped = groupStrokes(selected, new Set([a.id, b.id]), 'g1');
    const units = arrangeUnits(grouped);
    expect(units).toHaveLength(2);
    expect(units[0]!.ids).toEqual([a.id, b.id]);
    expect(units[0]!.bounds.minX).toBeLessThanOrEqual(box(a).minX);
    expect(units[0]!.bounds.maxX).toBeGreaterThanOrEqual(box(b).maxX);
  });

  it('needs two to align and three to spread', () => {
    expect(canAlign(arrangeUnits([a]))).toBe(false);
    expect(canAlign(arrangeUnits([a, b]))).toBe(true);
    expect(canDistribute(arrangeUnits([a, b]))).toBe(false);
    expect(canDistribute(arrangeUnits(selected))).toBe(true);
  });

  it('lines left edges up with the leftmost', () => {
    const offsets = arrangeOffsets(arrangeUnits(selected), { kind: 'align', mode: 'left' });
    const left = Math.min(...selected.map((s) => box(s).minX));
    selected.forEach((s, i) => near(box(s).minX + offsets[i]!.x, left, 4));
    offsets.forEach((o) => near(o.y, 0));
  });

  it('lines right edges, tops and bottoms up', () => {
    const right = arrangeOffsets(arrangeUnits(selected), { kind: 'align', mode: 'right' });
    const maxRight = Math.max(...selected.map((s) => box(s).maxX));
    selected.forEach((s, i) => near(box(s).maxX + right[i]!.x, maxRight, 4));
    const top = arrangeOffsets(arrangeUnits(selected), { kind: 'align', mode: 'top' });
    const minTop = Math.min(...selected.map((s) => box(s).minY));
    selected.forEach((s, i) => near(box(s).minY + top[i]!.y, minTop, 4));
    const bottom = arrangeOffsets(arrangeUnits(selected), { kind: 'align', mode: 'bottom' });
    const maxBottom = Math.max(...selected.map((s) => box(s).maxY));
    selected.forEach((s, i) => near(box(s).maxY + bottom[i]!.y, maxBottom, 4));
  });

  it('centres across and down on the middle of the whole selection', () => {
    const union = { minX: Math.min(...selected.map((s) => box(s).minX)), maxX: Math.max(...selected.map((s) => box(s).maxX)), minY: Math.min(...selected.map((s) => box(s).minY)), maxY: Math.max(...selected.map((s) => box(s).maxY)) };
    const across = arrangeOffsets(arrangeUnits(selected), { kind: 'align', mode: 'centre' });
    selected.forEach((s, i) => near((box(s).minX + box(s).maxX) / 2 + across[i]!.x, (union.minX + union.maxX) / 2, 4));
    const down = arrangeOffsets(arrangeUnits(selected), { kind: 'align', mode: 'middle' });
    selected.forEach((s, i) => near((box(s).minY + box(s).maxY) / 2 + down[i]!.y, (union.minY + union.maxY) / 2, 4));
  });

  it('moves nothing when there is one thing to line up', () => {
    const offsets = arrangeOffsets(arrangeUnits([a]), { kind: 'align', mode: 'left' });
    expect(offsets).toEqual([{ x: 0, y: 0 }]);
    const out = arrangeStrokes([a], new Set([a.id]), { kind: 'align', mode: 'left' });
    expect(out[0]).toBe(a);
  });

  it('spreads three things so the gaps between them are equal, the outer two staying put', () => {
    const one = bar(0, 0, 10);
    const two = bar(20, 0, 50); // crowding the left
    const three = bar(200, 0, 30);
    const out = arrangeStrokes([one, two, three], new Set([one.id, two.id, three.id]), { kind: 'distribute', axis: 'horizontal' });
    const [p, q, r] = out.map(box) as [ReturnType<typeof box>, ReturnType<typeof box>, ReturnType<typeof box>];
    near(p.minX, box(one).minX, 4);
    near(r.maxX, box(three).maxX, 4);
    near(q.minX - p.maxX, r.minX - q.maxX, 4);
    expect(out[0]).toBe(one);
    expect(out[2]).toBe(three);
  });

  it('spreads down the page the same way, whatever order the strokes are in the list', () => {
    const top = bar(0, 0, 10);
    const mid = bar(0, 30, 10);
    const bottom = bar(0, 300, 10);
    const out = arrangeStrokes([bottom, top, mid], new Set([top.id, mid.id, bottom.id]), { kind: 'distribute', axis: 'vertical' });
    const byId = new Map(out.map((s) => [s.id, s]));
    const t = box(byId.get(top.id)!);
    const m = box(byId.get(mid.id)!);
    const b = box(byId.get(bottom.id)!);
    near(m.minY - t.maxY, b.minY - m.maxY, 4);
  });

  it('moves a group\'s strokes together, keeping them where they were relative to each other', () => {
    const p = bar(0, 0, 10);
    const q = bar(0, 20, 10);
    const r = bar(100, 0, 10);
    const grouped = groupStrokes([p, q, r], new Set([p.id, q.id]), 'g1');
    const out = arrangeStrokes(grouped, new Set([p.id, q.id, r.id]), { kind: 'align', mode: 'right' });
    const gapBefore = box(q).minY - box(p).minY;
    const gapAfter = box(out[1]!).minY - box(out[0]!).minY;
    near(gapAfter, gapBefore, 6);
    near(box(out[0]!).maxX, box(out[2]!).maxX, 4);
  });
});

describe('pasting', () => {
  const page = { width: 400, height: 300 };

  it('makes new strokes: new ids, same ink', () => {
    const s = bar(10, 10);
    const [copy] = pastedCopies([s], { x: 0, y: 0 }, page);
    expect(copy!.id).not.toBe(s.id);
    if (copy!.kind !== 'freehand' || s.kind !== 'freehand') throw new Error('freehand');
    expect(copy!.points.map((p) => p.x)).toEqual(s.points.map((p) => p.x));
    expect(copy!.style).toBe(s.style);
  });

  it('moves them by the offset', () => {
    const s = bar(10, 10);
    const [copy] = pastedCopies([s], { x: 16, y: 32 }, page);
    if (copy!.kind !== 'freehand' || s.kind !== 'freehand') throw new Error('freehand');
    near(copy!.points[0]!.x, s.points[0]!.x + 16);
    near(copy!.points[0]!.y, s.points[0]!.y + 32);
  });

  it('brings them back inside a page smaller than where they came from', () => {
    const far = bar(800, 700, 40);
    const [copy] = pastedCopies([far], { x: 0, y: 0 }, page);
    expect(copy!.bbox.maxX).toBeLessThanOrEqual(page.width + 1e-6);
    expect(copy!.bbox.maxY).toBeLessThanOrEqual(page.height + 1e-6);
    expect(copy!.bbox.minX).toBeGreaterThanOrEqual(0);
  });

  it('keeps a selection together when it has to be brought back in', () => {
    const p = bar(700, 10, 20);
    const q = bar(740, 10, 20);
    const gap = box(q).minX - box(p).minX;
    const copies = pastedCopies([p, q], { x: 0, y: 0 }, page);
    near(box(copies[1]!).minX - box(copies[0]!).minX, gap, 4);
  });

  it('keeps a selection bigger than the page against the top-left rather than losing it', () => {
    const wide = bar(0, 0, 900);
    const [copy] = pastedCopies([wide], { x: 0, y: 0 }, page);
    expect(copy!.bbox.minX).toBeGreaterThanOrEqual(0);
  });

  it('puts a pasted group in a group of its own', () => {
    const p = bar(0, 0);
    const q = bar(0, 20);
    const grouped = groupStrokes([p, q], new Set([p.id, q.id]), 'g1');
    const copies = pastedCopies(grouped, { x: 10, y: 10 }, page);
    expect(copies[0]!.groupId).toBe(copies[1]!.groupId);
    expect(copies[0]!.groupId).not.toBe('g1');
  });

  it('pastes nothing from nothing', () => {
    expect(pastedCopies([], { x: 0, y: 0 }, page)).toEqual([]);
  });
});
