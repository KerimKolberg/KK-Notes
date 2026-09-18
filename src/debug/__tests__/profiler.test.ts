import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLOW_COMMIT_MS,
  noteCommit,
  noteFramePainted,
  noteInput,
  profilingEnabled,
  resetProfiler,
  setProfilingEnabled,
  snapshot,
  subscribeProfiler,
} from '../profiler';

/**
 * One pointer sample at `inputAt` answered by a frame that starts drawing at
 * `paintFrom` and finishes at `paintTo` — the shape of every measurement the
 * profiler takes.
 */
const roundTrip = (inputAt: number, paintFrom: number, paintTo: number): void => {
  noteInput(inputAt);
  noteFramePainted(paintFrom, paintTo);
};

beforeEach(() => {
  setProfilingEnabled(true);
  resetProfiler();
});

afterEach(() => {
  setProfilingEnabled(false);
  vi.restoreAllMocks();
});

describe('latency measurement', () => {
  it('measures from the pointer timestamp to the end of the draw', () => {
    roundTrip(1000, 1005, 1012);
    expect(snapshot().latencyMs).toBeCloseTo(12);
    expect(snapshot().latencySamples).toBe(1);
  });

  it('averages over the samples it has', () => {
    roundTrip(0, 5, 10); // 10
    roundTrip(100, 100, 120); // 20
    roundTrip(200, 200, 230); // 30
    expect(snapshot().latencyMs).toBeCloseTo(20);
    expect(snapshot().worstLatencyMs).toBeCloseTo(30);
    expect(snapshot().latencySamples).toBe(3);
  });

  it('measures against the newest sample when several arrive before a frame', () => {
    // A 240 Hz pen delivers four coalesced samples per 60 Hz frame. The frame
    // shows where the pen is now, so the honest delta is to the last one;
    // counting the older samples would flatter the number.
    noteInput(100);
    noteInput(104);
    noteInput(108);
    noteInput(112);
    noteFramePainted(112, 120);
    expect(snapshot().latencyMs).toBeCloseTo(8);
    expect(snapshot().latencySamples).toBe(1);
  });

  it('ignores an out-of-order timestamp rather than going backwards', () => {
    noteInput(200);
    noteInput(100); // a stale coalesced sample
    noteFramePainted(200, 210);
    expect(snapshot().latencyMs).toBeCloseTo(10);
  });

  it('takes no measurement from a frame with no input behind it', () => {
    // A laser trail fading out repaints every frame with nothing to answer to.
    noteFramePainted(0, 4);
    noteFramePainted(16, 20);
    expect(snapshot().latencySamples).toBe(0);
    expect(snapshot().latencyMs).toBe(0);
    // But the draw time is still recorded.
    expect(snapshot().drawMs).toBeCloseTo(4);
  });

  it('answers each input once: the next frame starts a fresh measurement', () => {
    roundTrip(0, 0, 10);
    noteFramePainted(20, 26);
    expect(snapshot().latencySamples).toBe(1);
    expect(snapshot().latencyMs).toBeCloseTo(10);
  });

  it('discards a delta that cannot be a latency', () => {
    // A clock that does not share performance.now()'s origin reads as either
    // negative or implausibly large; neither may reach the average.
    roundTrip(500, 100, 100); // negative
    roundTrip(0, 0, 60_000); // a minute
    expect(snapshot().latencySamples).toBe(0);
    roundTrip(1000, 1000, 1009);
    expect(snapshot().latencyMs).toBeCloseTo(9);
  });

  it('ignores a timestamp that is not a number', () => {
    noteInput(Number.NaN);
    noteFramePainted(0, 5);
    expect(snapshot().latencySamples).toBe(0);
  });

  it('reports the tail as well as the mean', () => {
    // Nineteen good frames and one 200 ms stall. The mean is dragged more
    // than twice off the truth by that single sample, while the p95 — the
    // 19th of 20 by nearest rank — still reports what it is normally like.
    // Between them, the worst is what says a stall happened at all.
    for (let i = 0; i < 19; i++) roundTrip(i * 100, i * 100, i * 100 + 8);
    roundTrip(2000, 2000, 2200);
    const stats = snapshot();
    expect(stats.latencyMs).toBeCloseTo(17.6);
    expect(stats.latencyP95Ms).toBeCloseTo(8);
    expect(stats.worstLatencyMs).toBeCloseTo(200);
  });
});

describe('draw timing', () => {
  it('times the paint itself, separately from the latency', () => {
    roundTrip(0, 90, 100);
    expect(snapshot().drawMs).toBeCloseTo(10);
    expect(snapshot().latencyMs).toBeCloseTo(100);
    expect(snapshot().worstDrawMs).toBeCloseTo(10);
  });
});

describe('React commits', () => {
  it('counts commits and averages their duration per boundary', () => {
    noteCommit('InkSurface', 2);
    noteCommit('InkSurface', 4);
    noteCommit('DocumentViewer', 1);
    const byId = Object.fromEntries(snapshot().commits.map((c) => [c.id, c]));
    expect(byId.InkSurface?.commits).toBe(2);
    expect(byId.InkSurface?.averageMs).toBeCloseTo(3);
    expect(byId.InkSurface?.lastMs).toBeCloseTo(4);
    expect(byId.DocumentViewer?.commits).toBe(1);
  });

  it('flags and logs only the commits that blocked a frame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteCommit('InkSurface', SLOW_COMMIT_MS - 0.1);
    expect(warn).not.toHaveBeenCalled();
    noteCommit('InkSurface', SLOW_COMMIT_MS + 0.1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('InkSurface');
    const [stat] = snapshot().commits;
    expect(stat?.slow).toBe(1);
    expect(stat?.commits).toBe(2);
  });

  it('remembers the worst commit even after it leaves the average window', () => {
    noteCommit('InkSurface', 50);
    for (let i = 0; i < 500; i++) noteCommit('InkSurface', 1);
    const [stat] = snapshot().commits;
    expect(stat?.worstMs).toBeCloseTo(50);
    expect(stat?.averageMs).toBeCloseTo(1);
  });
});

describe('the off switch', () => {
  it('records nothing at all while disabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setProfilingEnabled(false);
    expect(profilingEnabled()).toBe(false);
    roundTrip(0, 0, 10);
    noteCommit('InkSurface', 100);
    expect(warn).not.toHaveBeenCalled();
    const stats = snapshot();
    expect(stats.enabled).toBe(false);
    expect(stats.latencySamples).toBe(0);
    expect(stats.drawMs).toBe(0);
    expect(stats.commits).toEqual([]);
  });

  it('starts from a clean slate when switched back on', () => {
    roundTrip(0, 0, 10);
    noteCommit('InkSurface', 3);
    expect(snapshot().latencySamples).toBe(1);
    setProfilingEnabled(false);
    setProfilingEnabled(true);
    const stats = snapshot();
    expect(stats.latencySamples).toBe(0);
    expect(stats.commits).toEqual([]);
  });

  it('drops a pending input when it is switched off, so the first frame after is not a wild reading', () => {
    noteInput(1000);
    setProfilingEnabled(false);
    setProfilingEnabled(true);
    noteFramePainted(9_000_000, 9_000_004);
    expect(snapshot().latencySamples).toBe(0);
  });
});

describe('subscribers', () => {
  it('hears the current state as soon as it subscribes, and stops on unsubscribe', () => {
    roundTrip(0, 0, 12);
    const seen: number[] = [];
    const unsubscribe = subscribeProfiler((s) => seen.push(s.latencyMs));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeCloseTo(12);
    unsubscribe();
    // Nothing further is pushed to a listener that has gone away.
    roundTrip(100, 100, 150);
    expect(seen).toHaveLength(1);
  });
});
