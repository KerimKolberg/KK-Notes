import { describe, expect, it } from 'vitest';
import {
  LASSO_ENCLOSE_FRACTION,
  closeLasso,
  isStrokeWhollyInside,
  pointInPolygon,
  selectStrokesInLasso,
} from '../engine/lasso';
import type { Point } from '../types';
import { makeStroke } from './testUtils';

const square = (x: number, y: number, size: number): Point[] => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
];

const loop = square(0, 0, 100);

/** A run of `count` samples, the first `outside` of which sit past the loop. */
const straddling = (count: number, outside: number) =>
  makeStroke(
    Array.from({ length: count }, (_, i) => [i < outside ? -20 - i : 20 + i, 50] as [number, number]),
  );

describe('the 85% enclosure threshold', () => {
  it('is what the rule says it is', () => {
    expect(LASSO_ENCLOSE_FRACTION).toBe(0.85);
  });

  it('takes a stroke that is entirely inside', () => {
    expect(isStrokeWhollyInside(makeStroke([[20, 20], [40, 40], [60, 30]]), loop)).toBe(true);
  });

  it('forgives a clipped descender', () => {
    // Nineteen of twenty samples in: 95%. This is the reported case — a word
    // lassoed cleanly, with two pixels of one letter's tail outside the loop.
    expect(isStrokeWhollyInside(straddling(20, 1), loop)).toBe(true);
  });

  it('holds the line exactly at the threshold', () => {
    // 17 of 20 is 85% and counts; 16 of 20 is 80% and does not.
    expect(isStrokeWhollyInside(straddling(20, 3), loop)).toBe(true);
    expect(isStrokeWhollyInside(straddling(20, 4), loop)).toBe(false);
  });

  it('still refuses a stroke merely straddling the edge', () => {
    // Half in, half out is not an enclosure by any reading, and this is what
    // separates the threshold from simply selecting whatever was touched.
    expect(isStrokeWhollyInside(straddling(20, 10), loop)).toBe(false);
    expect(isStrokeWhollyInside(straddling(20, 18), loop)).toBe(false);
  });

  it('refuses a stroke nowhere near the loop', () => {
    expect(isStrokeWhollyInside(makeStroke([[500, 500], [520, 520]]), loop)).toBe(false);
  });

  it('can be tightened back to a hard rule when a caller wants one', () => {
    const nearMiss = straddling(20, 1);
    expect(isStrokeWhollyInside(nearMiss, loop, undefined, 1)).toBe(false);
    expect(isStrokeWhollyInside(nearMiss, loop, undefined, 0.5)).toBe(true);
  });

  it('applies through the selection entry point, not just the predicate', () => {
    const clipped = straddling(20, 2);
    const half = straddling(20, 10);
    expect(selectStrokesInLasso([clipped, half], loop)).toEqual([clipped.id]);
  });
});

describe('a lasso that backtracks over itself', () => {
  it('closes the loop the user never drew', () => {
    // Someone lifting the pen leaves an open path; the edge from the last
    // point back to the first is the one that makes it a region at all.
    const open: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(pointInPolygon({ x: 50, y: 50 }, open)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, open)).toBe(false);
  });

  it('treats an already-closed path the same as an open one', () => {
    const closed: Point[] = [...square(0, 0, 100), { x: 0, y: 0 }];
    expect(closeLasso(closed)).toHaveLength(4);
    expect(pointInPolygon({ x: 50, y: 50 }, closed)).toBe(true);
    expect(pointInPolygon({ x: 50, y: 50 }, square(0, 0, 100))).toBe(true);
  });

  it('keeps the overlap enclosed when the stroke runs past its own start', () => {
    // The reported gesture: loop something, then carry on a little past where
    // you began. Under the even–odd rule the doubled-over sliver counts as
    // *outside* and whatever is in it is silently not selected; winding says
    // it is inside, which is what the person drawing it meant.
    const overlapping: Point[] = [
      { x: 50, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 90 },
      { x: 10, y: 90 },
      { x: 10, y: 10 },
      // …and on past the start, re-entering the loop.
      { x: 70, y: 10 },
      { x: 70, y: 30 },
      { x: 40, y: 30 },
      { x: 40, y: 5 },
    ];
    expect(pointInPolygon({ x: 60, y: 20 }, overlapping)).toBe(true);
    expect(pointInPolygon({ x: 50, y: 60 }, overlapping)).toBe(true);
    expect(pointInPolygon({ x: 200, y: 200 }, overlapping)).toBe(false);

    const inTheOverlap = makeStroke([[55, 18], [62, 22], [58, 25]]);
    expect(isStrokeWhollyInside(inTheOverlap, overlapping)).toBe(true);
  });

  it('agrees with the even–odd rule on a loop that does not cross itself', () => {
    // Winding only changes the self-intersecting case; a careful lasso — the
    // concave one included — behaves exactly as it always did.
    const cShape: Point[] = [
      { x: 50, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 50, y: 100 },
      { x: 50, y: 70 },
      { x: 80, y: 70 },
      { x: 80, y: 30 },
      { x: 50, y: 30 },
    ];
    expect(pointInPolygon({ x: 90, y: 50 }, cShape)).toBe(true);
    // The notch is a hole in the C, and stays one.
    expect(pointInPolygon({ x: 60, y: 50 }, cShape)).toBe(false);
  });

  it('is not fooled by a figure of eight', () => {
    // Both lobes are enclosed, and the point between them is not.
    const eight: Point[] = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
      { x: 0, y: 40 },
      { x: 0, y: 0 },
      { x: 0, y: -40 },
      { x: 40, y: -40 },
      { x: 40, y: 0 },
    ];
    expect(pointInPolygon({ x: 20, y: 20 }, eight)).toBe(true);
    expect(pointInPolygon({ x: 20, y: -20 }, eight)).toBe(true);
    expect(pointInPolygon({ x: 60, y: 0 }, eight)).toBe(false);
  });

  it('refuses a path too short to enclose anything', () => {
    expect(pointInPolygon({ x: 0, y: 0 }, [])).toBe(false);
    expect(pointInPolygon({ x: 0, y: 0 }, [{ x: 0, y: 0 }])).toBe(false);
    expect(pointInPolygon({ x: 1, y: 1 }, [{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBe(false);
    expect(closeLasso([{ x: 0, y: 0 }])).toHaveLength(1);
  });
});
