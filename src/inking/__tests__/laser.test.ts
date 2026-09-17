import { describe, expect, it } from 'vitest';
import { LASER_FADE_OUT_MS, LASER_HOLD_MS, LASER_RAINBOW_PERIOD_MS } from '../constants';
import {
  EMPTY_LASER_TRAIL,
  appendLaserPoint,
  laserAlpha,
  laserPointFrom,
  laserRuns,
  laserTrailAlpha,
  laserTrailExpired,
  laserWidth,
  MAX_LASER_POINTS,
  rainbowColor,
  type LaserStyle,
  type LaserTrail,
} from '../engine/laser';
import { EPHEMERAL_TOOLS, isEphemeralTool } from '../engine/pointerPolicy';
import type { InkPoint, ToolType } from '../types';

const STYLE: LaserStyle = { color: '#ef4444', size: 6, rainbow: false };
const RAINBOW: LaserStyle = { ...STYLE, rainbow: true };

const sample = (x: number, y: number, pressure = 0.5): InkPoint => ({ x, y, pressure });

/** A straight trail of `count` samples, one every `stepMs`, ending at `endT`. */
function trail(count: number, endT: number, stepMs = 10, style: LaserStyle = STYLE): LaserTrail {
  let current = EMPTY_LASER_TRAIL;
  for (let i = 0; i < count; i++) {
    const t = endT - (count - 1 - i) * stepMs;
    current = appendLaserPoint(current, sample(i * 10, 0), t, style, i === 0);
  }
  return current;
}

describe('laser fade', () => {
  it('holds at full strength for the whole hold window, then fades out', () => {
    expect(laserAlpha(0)).toBe(1);
    expect(laserAlpha(LASER_HOLD_MS / 2)).toBe(1);
    expect(laserAlpha(LASER_HOLD_MS)).toBe(1);
    expect(laserAlpha(LASER_HOLD_MS + LASER_FADE_OUT_MS / 2)).toBeCloseTo(0.5);
    expect(laserAlpha(LASER_HOLD_MS + LASER_FADE_OUT_MS)).toBe(0);
    expect(laserAlpha(LASER_HOLD_MS + LASER_FADE_OUT_MS * 3)).toBe(0);
  });

  it('fades the whole trail together rather than sample by sample', () => {
    // Samples spread over 4 s — far longer than the hold window, which the old
    // per-sample fade would have dissolved from the tail up.
    const now = 50_000;
    const points = trail(400, now, 10);
    const runs = laserRuns(points, now);
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run.alpha).toBe(1);

    // Mid fade-out every run dims by the same amount, still as one mark.
    const dim = laserRuns(points, now + LASER_HOLD_MS + LASER_FADE_OUT_MS / 2);
    expect(dim).toHaveLength(runs.length);
    for (const run of dim) expect(run.alpha).toBeCloseTo(0.5);
  });

  it('is gone a hold plus a fade-out after the last pointer event', () => {
    const release = 10_000;
    const points = trail(20, release);
    expect(laserTrailExpired(points, release)).toBe(false);
    expect(laserTrailExpired(points, release + LASER_HOLD_MS)).toBe(false);
    expect(laserTrailExpired(points, release + LASER_HOLD_MS + LASER_FADE_OUT_MS - 1)).toBe(false);
    expect(laserTrailExpired(points, release + LASER_HOLD_MS + LASER_FADE_OUT_MS)).toBe(true);
    expect(laserRuns(points, release + LASER_HOLD_MS + LASER_FADE_OUT_MS)).toEqual([]);
  });

  it('keeps everything drawn while the pointer keeps moving', () => {
    // A stroke drawn over 10 s, well past the hold: nothing is dropped, because
    // every sample pushed the activity timestamp forward.
    const points = trail(1000, 10_000, 10);
    expect(points.points).toHaveLength(1000);
    expect(laserTrailAlpha(points, 10_000)).toBe(1);
  });

  it('restarts the timer on a sample that is too close to be recorded', () => {
    // Resting the pen on one spot is still pointing at it.
    let points = trail(5, 1_000);
    const held = appendLaserPoint(points, sample(points.points[4]!.x, 0), 3_000, STYLE);
    expect(held.points).toBe(points.points);
    expect(held.activeAt).toBe(3_000);
    expect(laserTrailAlpha(held, 3_000 + LASER_HOLD_MS)).toBe(1);
    // …whereas the trail it grew from would already be fading by then.
    points = { ...points, activeAt: 1_000 };
    expect(laserTrailAlpha(points, 3_000 + LASER_HOLD_MS)).toBeLessThan(1);
  });

  it('has nothing to show for an empty trail', () => {
    expect(laserTrailAlpha(EMPTY_LASER_TRAIL, 0)).toBe(0);
    expect(laserTrailExpired(EMPTY_LASER_TRAIL, 0)).toBe(true);
    expect(laserRuns(EMPTY_LASER_TRAIL, 0)).toEqual([]);
  });
});

describe('laser trail sampling', () => {
  it('ignores samples that barely moved, but always keeps a stroke start', () => {
    let points = appendLaserPoint(EMPTY_LASER_TRAIL, sample(0, 0), 0, STYLE, true);
    points = appendLaserPoint(points, sample(0.1, 0), 5, STYLE);
    expect(points.points).toHaveLength(1);
    points = appendLaserPoint(points, sample(4, 0), 10, STYLE);
    expect(points.points).toHaveLength(2);
    // A new stroke records its first point even on top of the previous one.
    points = appendLaserPoint(points, sample(4, 0), 15, STYLE, true);
    expect(points.points).toHaveLength(3);
    expect(points.points[2]?.startsStroke).toBe(true);
  });

  it('caps the retained samples and re-heads the survivors', () => {
    let points = EMPTY_LASER_TRAIL;
    for (let i = 0; i < MAX_LASER_POINTS + 50; i++) points = appendLaserPoint(points, sample(i * 5, 0), i, STYLE);
    expect(points.points).toHaveLength(MAX_LASER_POINTS);
    expect(points.points[points.points.length - 1]?.x).toBe((MAX_LASER_POINTS + 49) * 5);
    // Nothing is drawn into a point whose predecessor was dropped.
    expect(points.points[0]?.startsStroke).toBe(true);
  });

  it('widens with pressure around the chosen size', () => {
    expect(laserWidth(0, 6)).toBeLessThan(laserWidth(0.5, 6));
    expect(laserWidth(0.5, 6)).toBeLessThan(laserWidth(1, 6));
    expect(laserWidth(1, 6)).toBeCloseTo(6 * 1.45);
    expect(laserWidth(Number.NaN, 6)).toBeCloseTo(6);
    expect(laserWidth(0, 0.1)).toBeGreaterThanOrEqual(1);
  });

  it('freezes each sample’s colour, so a trail ignores later toolbar changes', () => {
    const point = laserPointFrom(sample(0, 0), 0, STYLE, true);
    expect(point.color).toBe('#ef4444');
    const other = laserPointFrom(sample(0, 0), 0, { ...STYLE, color: '#00ff00' }, true);
    expect(other.color).toBe('#00ff00');
  });

  it('cycles the hue over time in rainbow mode', () => {
    expect(rainbowColor(0)).toBe('hsl(0, 100%, 58%)');
    expect(rainbowColor(LASER_RAINBOW_PERIOD_MS / 2)).toBe('hsl(180, 100%, 58%)');
    expect(rainbowColor(LASER_RAINBOW_PERIOD_MS)).toBe('hsl(0, 100%, 58%)');
    const colors = new Set(trail(12, 5_000, 120, RAINBOW).points.map((p) => p.color));
    expect(colors.size).toBeGreaterThan(4);
  });
});

describe('laser runs', () => {
  it('batches a single-colour stroke into one polyline', () => {
    const now = 20_000;
    const runs = laserRuns(trail(200, now, 10), now);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.points).toHaveLength(200);
    expect(runs[0]?.color).toBe('#ef4444');
    expect(runs[0]?.width).toBeGreaterThan(0);
  });

  it('never bridges two strokes', () => {
    const now = 10_000;
    let points = trail(3, now - 1000, 500);
    points = appendLaserPoint(points, sample(500, 500), now, STYLE, true);
    const runs = laserRuns(points, now);
    // The second stroke is a lone vertex, so it contributes no polyline.
    expect(runs).toHaveLength(1);
    expect(runs[0]?.points).toHaveLength(3);
  });

  it('splits on a hue change but repeats the shared vertex, so no gap opens', () => {
    const now = 3_000;
    const points = trail(20, now, 100, RAINBOW);
    const runs = laserRuns(points, now);
    expect(new Set(runs.map((r) => r.color)).size).toBeGreaterThan(3);
    // Consecutive runs meet: each one starts where the previous one ended.
    for (let i = 1; i < runs.length; i++) {
      const end = runs[i - 1]!.points[runs[i - 1]!.points.length - 1];
      expect(runs[i]!.points[0]).toEqual(end);
    }
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
