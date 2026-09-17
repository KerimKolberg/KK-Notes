import { describe, expect, it } from 'vitest';
import { LASER_FADE_MS, LASER_RAINBOW_PERIOD_MS } from '../constants';
import {
  appendLaserPoint,
  laserAlpha,
  laserPointFrom,
  laserRuns,
  laserSegments,
  laserTrailIsEmpty,
  laserWidth,
  MAX_LASER_POINTS,
  pruneLaserTrail,
  rainbowColor,
  type LaserPoint,
  type LaserStyle,
} from '../engine/laser';
import { EPHEMERAL_TOOLS, isEphemeralTool } from '../engine/pointerPolicy';
import type { InkPoint, ToolType } from '../types';

const STYLE: LaserStyle = { color: '#ef4444', size: 6, rainbow: false };
const RAINBOW: LaserStyle = { ...STYLE, rainbow: true };

const sample = (x: number, y: number, pressure = 0.5): InkPoint => ({ x, y, pressure });

/** A straight trail of `count` samples, one every `stepMs`, ending at `endT`. */
function trail(count: number, endT: number, stepMs = 10, style: LaserStyle = STYLE): LaserPoint[] {
  let points: LaserPoint[] = [];
  for (let i = 0; i < count; i++) {
    const t = endT - (count - 1 - i) * stepMs;
    points = appendLaserPoint(points, sample(i * 10, 0), t, style, i === 0);
  }
  return points;
}

describe('laser fade', () => {
  it('decays linearly from full to nothing across the fade window', () => {
    expect(laserAlpha(0)).toBe(1);
    expect(laserAlpha(LASER_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(laserAlpha(LASER_FADE_MS - 1)).toBeGreaterThan(0);
    expect(laserAlpha(LASER_FADE_MS)).toBe(0);
    expect(laserAlpha(LASER_FADE_MS * 2)).toBe(0);
    expect(laserAlpha(-50)).toBe(1);
  });

  it('is gone exactly one fade window after the last sample (i.e. after pointerup)', () => {
    const release = 10_000;
    const points = trail(20, release);
    expect(laserTrailIsEmpty(points, release)).toBe(false);
    expect(laserTrailIsEmpty(points, release + LASER_FADE_MS - 1)).toBe(false);
    expect(laserTrailIsEmpty(points, release + LASER_FADE_MS)).toBe(true);
    expect(pruneLaserTrail(points, release + LASER_FADE_MS)).toHaveLength(0);
  });

  it('drops the tail that is a fade window behind the tip while drawing continues', () => {
    // 400 samples spaced 10 ms: the trail spans 3.99 s, longer than the window.
    const now = 50_000;
    const points = trail(400, now);
    const alive = pruneLaserTrail(points, now);
    expect(alive.length).toBeLessThan(points.length);
    // Everything kept is younger than the window, and the tip survived.
    for (const p of alive) expect(now - p.t).toBeLessThan(LASER_FADE_MS);
    expect(alive[alive.length - 1]?.t).toBe(now);
    // The surviving head becomes a stroke start, so no segment is drawn to a dropped point.
    expect(alive[0]?.startsStroke).toBe(true);
  });

  it('keeps the same array when nothing has expired yet', () => {
    const now = 1_000;
    const points = trail(5, now);
    expect(pruneLaserTrail(points, now)).toBe(points);
  });
});

describe('laser trail sampling', () => {
  it('ignores samples that barely moved, but always keeps a stroke start', () => {
    let points = appendLaserPoint([], sample(0, 0), 0, STYLE, true);
    points = appendLaserPoint(points, sample(0.1, 0), 5, STYLE);
    expect(points).toHaveLength(1);
    points = appendLaserPoint(points, sample(4, 0), 10, STYLE);
    expect(points).toHaveLength(2);
    // A new stroke records its first point even on top of the previous one.
    points = appendLaserPoint(points, sample(4, 0), 15, STYLE, true);
    expect(points).toHaveLength(3);
    expect(points[2]?.startsStroke).toBe(true);
  });

  it('caps the retained samples', () => {
    let points: LaserPoint[] = [];
    for (let i = 0; i < MAX_LASER_POINTS + 50; i++) points = appendLaserPoint(points, sample(i * 5, 0), i, STYLE);
    expect(points).toHaveLength(MAX_LASER_POINTS);
    expect(points[points.length - 1]?.x).toBe((MAX_LASER_POINTS + 49) * 5);
  });

  it('widens with pressure around the chosen size', () => {
    expect(laserWidth(0, 6)).toBeLessThan(laserWidth(0.5, 6));
    expect(laserWidth(0.5, 6)).toBeLessThan(laserWidth(1, 6));
    expect(laserWidth(1, 6)).toBeCloseTo(6 * 1.45);
    expect(laserWidth(Number.NaN, 6)).toBeCloseTo(6);
    expect(laserWidth(0, 0.1)).toBeGreaterThanOrEqual(1);
  });

  it('freezes each sample’s colour, so a fading trail ignores later toolbar changes', () => {
    const point = laserPointFrom(sample(0, 0), 0, STYLE, true);
    expect(point.color).toBe('#ef4444');
    const other = laserPointFrom(sample(0, 0), 0, { ...STYLE, color: '#00ff00' }, true);
    expect(other.color).toBe('#00ff00');
  });

  it('cycles the hue over time in rainbow mode', () => {
    expect(rainbowColor(0)).toBe('hsl(0, 100%, 58%)');
    expect(rainbowColor(LASER_RAINBOW_PERIOD_MS / 2)).toBe('hsl(180, 100%, 58%)');
    expect(rainbowColor(LASER_RAINBOW_PERIOD_MS)).toBe('hsl(0, 100%, 58%)');
    const colors = new Set(trail(12, 5_000, 120, RAINBOW).map((p) => p.color));
    expect(colors.size).toBeGreaterThan(4);
  });
});

describe('laser segments and runs', () => {
  it('fades and thins towards the tail, and never bridges two strokes', () => {
    const now = 10_000;
    let points = trail(3, now - 1000, 500);
    points = appendLaserPoint(points, sample(500, 500), now, STYLE, true); // a second stroke
    const segments = laserSegments(points, now);
    // 2 segments inside the first stroke; none into the new stroke's first point.
    expect(segments).toHaveLength(2);
    expect(segments[0]!.alpha).toBeLessThan(segments[1]!.alpha);
    expect(segments[0]!.width).toBeLessThan(segments[1]!.width);
    for (const s of segments) expect(s.color).toBe('#ef4444');
  });

  it('drops segments whose older endpoint has expired', () => {
    const now = 10_000;
    const points = trail(2, now, LASER_FADE_MS + 100);
    expect(laserSegments(points, now)).toHaveLength(0);
  });

  it('batches consecutive segments into a handful of polylines', () => {
    const now = 20_000;
    const points = trail(200, now, 10);
    const segments = laserSegments(points, now);
    const runs = laserRuns(points, now);
    expect(segments.length).toBeGreaterThan(100);
    expect(runs.length).toBeLessThanOrEqual(25);
    // Every segment is covered exactly once by the runs.
    const covered = runs.reduce((n, r) => n + r.points.length - 1, 0);
    expect(covered).toBe(segments.length);
    for (const run of runs) {
      expect(run.points.length).toBeGreaterThanOrEqual(2);
      expect(run.alpha).toBeGreaterThan(0);
      expect(run.width).toBeGreaterThan(0);
    }
  });

  it('starts a new run when the colour changes', () => {
    const now = 3_000;
    const points = trail(20, now, 100, RAINBOW);
    const runs = laserRuns(points, now);
    expect(new Set(runs.map((r) => r.color)).size).toBeGreaterThan(3);
  });

  it('has nothing to draw once the trail is empty', () => {
    expect(laserSegments([], 0)).toEqual([]);
    expect(laserRuns([], 0)).toEqual([]);
  });
});

describe('ephemeral tools', () => {
  const ALL_TOOLS: readonly ToolType[] = [
    'select',
    'lasso',
    'pen',
    'highlighter',
    'laser-pointer',
    'line',
    'coordinate-plane',
    'eraser-stroke',
    'eraser-pixel',
  ];

  it('marks the laser pointer, and only the laser pointer, as ephemeral', () => {
    expect(isEphemeralTool('laser-pointer')).toBe(true);
    for (const tool of ALL_TOOLS) {
      expect(isEphemeralTool(tool)).toBe(tool === 'laser-pointer');
    }
    expect([...EPHEMERAL_TOOLS]).toEqual(['laser-pointer']);
  });
});
