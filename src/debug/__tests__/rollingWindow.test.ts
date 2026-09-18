import { describe, expect, it } from 'vitest';
import { RollingWindow } from '../rollingWindow';

/** The mean of a list, computed the slow obvious way, for comparison. */
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

describe('RollingWindow', () => {
  it('reads as empty before anything is pushed', () => {
    const w = new RollingWindow(4);
    expect(w.count).toBe(0);
    expect(w.full).toBe(false);
    expect(w.average).toBe(0);
    expect(w.latest).toBe(0);
    expect(w.max).toBe(0);
    expect(w.percentile(0.95)).toBe(0);
    expect(w.values()).toEqual([]);
  });

  it('averages what it has while still filling up', () => {
    const w = new RollingWindow(4);
    w.push(10);
    expect(w.average).toBe(10);
    w.push(20);
    expect(w.average).toBe(15);
    w.push(30);
    expect(w.average).toBe(20);
    expect(w.count).toBe(3);
    expect(w.full).toBe(false);
  });

  it('drops the oldest sample once it is full', () => {
    const w = new RollingWindow(3);
    for (const v of [1, 2, 3]) w.push(v);
    expect(w.full).toBe(true);
    expect(w.average).toBeCloseTo(2);
    // 1 falls out, 4 comes in.
    w.push(4);
    expect(w.count).toBe(3);
    expect(w.values()).toEqual([2, 3, 4]);
    expect(w.average).toBeCloseTo(3);
    w.push(5);
    expect(w.values()).toEqual([3, 4, 5]);
    expect(w.average).toBeCloseTo(4);
  });

  it('keeps the samples in order, oldest first, across the wrap', () => {
    const w = new RollingWindow(3);
    for (const v of [1, 2, 3, 4, 5, 6, 7]) w.push(v);
    expect(w.values()).toEqual([5, 6, 7]);
    expect(w.latest).toBe(7);
  });

  it('ignores anything that is not a finite number', () => {
    const w = new RollingWindow(4);
    w.push(10);
    w.push(Number.NaN);
    w.push(Number.POSITIVE_INFINITY);
    w.push(Number.NEGATIVE_INFINITY);
    expect(w.count).toBe(1);
    expect(w.average).toBe(10);
  });

  it('matches a plain recomputed mean at every step', () => {
    const capacity = 16;
    const w = new RollingWindow(capacity);
    const seen: number[] = [];
    // Deterministic pseudo-random ms-scale latencies.
    let seed = 7;
    for (let i = 0; i < 500; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const value = (seed / 0x7fffffff) * 40;
      w.push(value);
      seen.push(value);
      if (seen.length > capacity) seen.shift();
      expect(w.average).toBeCloseTo(mean(seen), 9);
    }
  });

  it('does not drift over a long run of awkward values', () => {
    // A running sum that is only added to and subtracted from accumulates
    // rounding error; the window re-sums on each wrap so it cannot.
    const w = new RollingWindow(8);
    for (let i = 0; i < 100_000; i++) w.push(i % 2 === 0 ? 0.1 : 1e7);
    expect(w.average).toBeCloseTo(mean(w.values()), 6);
    // And the sum has not gone anywhere near a nonsense value.
    expect(w.average).toBeGreaterThan(0);
    expect(w.average).toBeLessThan(1e7);
  });

  it('reports the worst sample in the window, not the worst ever seen', () => {
    const w = new RollingWindow(3);
    w.push(100);
    w.push(1);
    w.push(2);
    expect(w.max).toBe(100);
    w.push(3); // the 100 falls out
    expect(w.max).toBe(3);
  });

  it('takes percentiles by nearest rank', () => {
    const w = new RollingWindow(10);
    for (let i = 1; i <= 10; i++) w.push(i);
    expect(w.percentile(0)).toBe(1);
    expect(w.percentile(0.5)).toBe(5);
    expect(w.percentile(0.95)).toBe(10);
    expect(w.percentile(1)).toBe(10);
    // Out-of-range fractions clamp rather than reading off the end.
    expect(w.percentile(-1)).toBe(1);
    expect(w.percentile(2)).toBe(10);
  });

  it('shows the tail the mean hides', () => {
    // Ninety-nine fast frames and one long stall: the mean barely moves, the
    // p95 and the max are what say something went wrong.
    const w = new RollingWindow(100);
    for (let i = 0; i < 99; i++) w.push(8);
    w.push(400);
    expect(w.average).toBeCloseTo(11.92);
    expect(w.max).toBe(400);
    expect(w.percentile(0.95)).toBe(8);
    expect(w.percentile(1)).toBe(400);
  });

  it('empties completely on clear', () => {
    const w = new RollingWindow(3);
    for (const v of [5, 6, 7]) w.push(v);
    w.clear();
    expect(w.count).toBe(0);
    expect(w.average).toBe(0);
    expect(w.values()).toEqual([]);
    w.push(9);
    expect(w.average).toBe(9);
  });

  it('degenerates safely to a window of one', () => {
    const w = new RollingWindow(1);
    w.push(3);
    w.push(4);
    expect(w.count).toBe(1);
    expect(w.average).toBe(4);
    expect(w.values()).toEqual([4]);
  });

  it('never accepts a capacity below one', () => {
    for (const capacity of [0, -5, 0.4]) {
      const w = new RollingWindow(capacity);
      w.push(2);
      expect(w.count).toBe(1);
      expect(w.average).toBe(2);
    }
  });
});
