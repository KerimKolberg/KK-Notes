import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_SETTINGS } from '../constants';
import {
  BRUSHES,
  DEFAULT_BRUSH,
  GRAIN_TILE,
  brushById,
  brushEasing,
  brushPadding,
  brushStyle,
  chunkRanges,
  endSpeed,
  grainNoise,
  grainTileData,
  isBrushId,
  meanPressureTilt,
  pencilAlpha,
  pencilPressure,
  pencilWidthScale,
  streamlinePoints,
  strokeBrush,
  strokeTapers,
  tiltMagnitude,
} from '../engine/brushes';
import { freehandSamples, toFreehandOptions } from '../engine/strokeOutline';
import { styleForTool } from '../engine/toolStyles';
import type { BrushId, InkPoint } from '../types';

const ALL: readonly BrushId[] = ['ballpoint', 'fountain', 'pencil', 'marker', 'brush'];
const settings = { ...DEFAULT_TOOL_SETTINGS };

const line = (count: number, step: number, pressure = 0.5, tilt?: number): InkPoint[] =>
  Array.from({ length: count }, (_, i) => ({ x: i * step, y: 0, pressure, ...(tilt === undefined ? {} : { tilt }) }));

describe('brush catalogue', () => {
  it('exposes the five presets and resolves ids safely', () => {
    expect(BRUSHES.map((b) => b.id)).toEqual(ALL);
    for (const id of ALL) expect(brushById(id).id).toBe(id);
    expect(brushById(undefined).id).toBe(DEFAULT_BRUSH);
    expect(isBrushId('pencil')).toBe(true);
    expect(isBrushId('crayon')).toBe(false);
  });

  it('gives each preset the character it promises', () => {
    const ballpoint = brushById('ballpoint');
    expect(ballpoint.thinning).toBeLessThan(0.15); // near-constant width
    expect(ballpoint.smoothOutline).toBe(false); // hard edges

    const fountain = brushById('fountain');
    expect(fountain.thinning).toBeGreaterThan(0.7); // high pressure variance
    expect(fountain.velocityTaper).toBeGreaterThan(0); // velocity-dependent taper
    expect(fountain.smoothOutline).toBe(true);

    const pencil = brushById('pencil');
    expect(pencil.texture).toBe('pencil');
    expect(pencil.tiltResponse).toBeGreaterThan(0);

    const marker = brushById('marker');
    expect(marker.composite).toBe('multiply');
    expect(marker.opacity).toBeLessThan(1);
    expect(marker.cap).toBe('flat');
    expect(marker.bleed).toBeGreaterThan(0);
    expect(marker.sizeScale).toBeGreaterThan(2);

    const brush = brushById('brush');
    expect(brush.smoothing).toBeGreaterThan(0.8);
    expect(brush.thinning).toBeGreaterThan(0.8);
    expect(brush.cap).toBe('round');
    expect(brush.bleed).toBeGreaterThan(0);
  });

  it('eases the pressure response per brush', () => {
    for (const name of ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const) {
      const ease = brushEasing(name);
      expect(ease(0)).toBeCloseTo(0);
      expect(ease(1)).toBeCloseTo(1);
    }
    expect(brushEasing('ease-in')(0.5)).toBeLessThan(0.5);
    expect(brushEasing('ease-out')(0.5)).toBeGreaterThan(0.5);
  });
});

describe('brush styles', () => {
  it('bakes the preset into the stroke style and records its id', () => {
    for (const id of ALL) {
      const style = brushStyle(id, settings, 'pen');
      const brush = brushById(id);
      expect(style.brush).toBe(id);
      expect(style.size).toBeCloseTo(settings.size * brush.sizeScale);
      expect(style.opacity).toBe(brush.opacity);
      expect(style.compositeOperation).toBe(brush.composite);
      expect(style.thinning).toBe(brush.thinning);
      expect(style.color).toBe(settings.color);
      expect(strokeBrush(style)?.id).toBe(id);
    }
  });

  it('is what the pen tool paints with', () => {
    const style = styleForTool('pen', { ...settings, brush: 'marker' }, 'pen');
    expect(style.brush).toBe('marker');
    expect(style.compositeOperation).toBe('multiply');
    // Other tools keep their own presets and no brush id.
    expect(styleForTool('highlighter', settings, 'pen').brush).toBeUndefined();
    expect(styleForTool('eraser-pixel', settings, 'pen').brush).toBeUndefined();
  });

  it('only simulates pressure for pressure-sensitive brushes on a device without it', () => {
    expect(brushStyle('fountain', settings, 'mouse').simulatePressure).toBe(true);
    expect(brushStyle('marker', settings, 'mouse').simulatePressure).toBe(false);
    expect(brushStyle('fountain', settings, 'pen').simulatePressure).toBe(false);
  });

  it('pads the bounding box for brushes that bleed', () => {
    expect(brushPadding(brushStyle('ballpoint', settings, 'pen'))).toBe(0);
    expect(brushPadding(brushStyle('marker', settings, 'pen'))).toBeGreaterThan(0);
  });
});

describe('tilt', () => {
  it('normalises the two tilt axes into a single lean', () => {
    expect(tiltMagnitude(0, 0)).toBe(0);
    expect(tiltMagnitude(35, 0)).toBeCloseTo(0.5);
    expect(tiltMagnitude(0, -35)).toBeCloseTo(0.5);
    expect(tiltMagnitude(70, 0)).toBe(1);
    expect(tiltMagnitude(80, 80)).toBe(1); // clamped
    expect(tiltMagnitude(Number.NaN, 10)).toBeCloseTo(tiltMagnitude(0, 10));
  });

  it('broadens and lightens a leaning pencil', () => {
    expect(pencilPressure(0.5, 0, 1)).toBeCloseTo(0.5);
    expect(pencilPressure(0.5, 1, 1)).toBeGreaterThan(0.5);
    expect(pencilPressure(0.5, 1, 0)).toBeCloseTo(0.5); // brushes that ignore tilt
    expect(pencilAlpha(0.5, 1, 1)).toBeLessThan(pencilAlpha(0.5, 0, 1));
    expect(pencilAlpha(1, 0, 1)).toBeGreaterThan(pencilAlpha(0.2, 0, 1));
    expect(pencilAlpha(0, 1, 1)).toBeGreaterThanOrEqual(0.15);
    // Pressure alone barely widens a mark, so the lean scales the nib as well.
    expect(pencilWidthScale(0, 1)).toBe(1);
    expect(pencilWidthScale(1, 1)).toBeCloseTo(1.9);
    expect(pencilWidthScale(1, 0)).toBe(1);
    expect(pencilWidthScale(0.5, 1)).toBeCloseTo(1.45);
  });

  it('feeds tilt into the outline only for brushes that respond to it', () => {
    const points = line(5, 10, 0.5, 1);
    const pencil = brushStyle('pencil', settings, 'pen');
    const ballpoint = brushStyle('ballpoint', settings, 'pen');
    expect(freehandSamples(points, ballpoint)).toBe(points);
    const mapped = freehandSamples(points, pencil);
    expect(mapped).not.toBe(points);
    expect(mapped[0]?.pressure).toBeGreaterThan(0.5);
    // No tilt reported → the samples are passed straight through.
    expect(freehandSamples(line(5, 10, 0.5), pencil)).toHaveLength(5);
  });

  it('averages pressure and tilt over a run of samples', () => {
    expect(meanPressureTilt([])).toEqual({ pressure: 0.5, tilt: 0 });
    const mean = meanPressureTilt([
      { x: 0, y: 0, pressure: 0.2 },
      { x: 1, y: 0, pressure: 0.8, tilt: 0.5 },
    ]);
    expect(mean.pressure).toBeCloseTo(0.5);
    expect(mean.tilt).toBeCloseTo(0.25);
  });
});

describe('velocity taper', () => {
  it('measures the speed at either end', () => {
    const points = [...line(5, 2), ...line(5, 30).map((p) => ({ ...p, x: p.x + 100 }))];
    expect(endSpeed(points, true)).toBeLessThan(endSpeed(points, false));
    expect(endSpeed([], true)).toBe(0);
    expect(endSpeed([{ x: 0, y: 0, pressure: 1 }], false)).toBe(0);
  });

  it('lengthens a fountain pen’s taper when the nib is moving fast', () => {
    const slow = line(10, 1);
    const fast = line(10, 40);
    const style = brushStyle('fountain', settings, 'pen');
    expect(strokeTapers(fast, style).end).toBeGreaterThan(strokeTapers(slow, style).end);
    expect(strokeTapers(fast, style).end).toBeLessThanOrEqual(style.taperEnd + brushById('fountain').velocityTaperMax);
  });

  it('leaves brushes without a nib on their fixed taper', () => {
    const style = brushStyle('marker', settings, 'pen');
    expect(strokeTapers(line(10, 40), style)).toEqual({ start: style.taperStart, end: style.taperEnd });
  });

  it('chisels the marker’s ends flat and rounds the others', () => {
    const points = line(6, 10);
    expect(toFreehandOptions(brushStyle('marker', settings, 'pen'), true, points).start?.cap).toBe(false);
    expect(toFreehandOptions(brushStyle('brush', settings, 'pen'), true, points).start?.cap).toBe(true);
  });
});

describe('pencil texture', () => {
  it('splits a stroke into overlapping chunks that cover every segment', () => {
    expect(chunkRanges(0, 8)).toEqual([]);
    expect(chunkRanges(1, 8)).toEqual([[0, 1]]);
    expect(chunkRanges(5, 8)).toEqual([[0, 5]]); // too short to split
    const ranges = chunkRanges(100, 10);
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges[0]?.[0]).toBe(0);
    expect(ranges[ranges.length - 1]?.[1]).toBe(100);
    for (let i = 1; i < ranges.length; i++) {
      // Each chunk starts before the previous one ended, so the joins overlap.
      expect(ranges[i]![0]).toBeLessThan(ranges[i - 1]![1]);
    }
  });

  it('pre-smooths the samples so chunks share their boundaries exactly', () => {
    const points = line(6, 100);
    const smoothed = streamlinePoints(points, 0.4);
    expect(smoothed[0]).toEqual(points[0]); // the first sample never moves
    expect(smoothed).toHaveLength(points.length);
    // Each smoothed point lags towards its predecessor, so the path shortens.
    expect(smoothed[5]!.x).toBeLessThan(points[5]!.x);
    for (let i = 1; i < smoothed.length; i++) expect(smoothed[i]!.x).toBeGreaterThan(smoothed[i - 1]!.x);
    // No smoothing requested → the samples are handed back untouched.
    expect(streamlinePoints(points, 0)).toBe(points);
    expect(streamlinePoints([], 0.5)).toEqual([]);
    expect(streamlinePoints(points, 0.5)[3]?.pressure).toBe(points[3]?.pressure);
  });

  it('builds a deterministic grain tile with varying alpha', () => {
    const a = grainTileData();
    const b = grainTileData();
    expect(a).toEqual(b);
    expect(a).toHaveLength(GRAIN_TILE * GRAIN_TILE * 4);
    const alphas = new Set<number>();
    for (let i = 3; i < a.length; i += 4) alphas.add(a[i]!);
    expect(alphas.size).toBeGreaterThan(20); // actual noise, not a flat fill
    for (const value of alphas) expect(value).toBeGreaterThan(0);
    expect(grainTileData(GRAIN_TILE, 2)).not.toEqual(a); // seeded
    expect(grainNoise(3, 7)).toBeGreaterThanOrEqual(0);
    expect(grainNoise(3, 7)).toBeLessThan(1);
    expect(grainNoise(3, 7)).toBe(grainNoise(3, 7));
  });
});
