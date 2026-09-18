import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_SETTINGS } from '../constants';
import { TAPE_PATTERNS, TAPE_TILE, tapePath, tapeSamples, tileMarksOver, tilePattern } from '../engine/tape';
import { styleForTool } from '../engine/toolStyles';
import type { InkPoint, StrokeStyle } from '../types';

const style = (over: Partial<StrokeStyle> = {}): StrokeStyle => ({
  ...styleForTool('washi-tape', DEFAULT_TOOL_SETTINGS, 'pen'),
  ...over,
});

/** A wobbly horizontal drag: a straight run with a few px of hand shake on it. */
const wobbly: InkPoint[] = Array.from({ length: 60 }, (_, i) => ({
  x: i * 5,
  y: Math.sin(i / 2) * 2,
  pressure: 0.4 + (i % 5) * 0.1,
}));

describe('the tape style', () => {
  it('is a wide, translucent band carrying its pattern', () => {
    const s = styleForTool('washi-tape', { ...DEFAULT_TOOL_SETTINGS, washiWidth: 40, washiOpacity: 0.6 }, 'pen');
    expect(s.size).toBe(40);
    expect(s.opacity).toBe(0.6);
    // Constant width: a strip is the width of the strip, whatever the pressure.
    expect(s.thinning).toBe(0);
    expect(s.simulatePressure).toBe(false);
    expect(s.tape).toEqual({
      pattern: DEFAULT_TOOL_SETTINGS.washiPattern,
      accent: DEFAULT_TOOL_SETTINGS.washiAccent,
      straighten: DEFAULT_TOOL_SETTINGS.washiStraighten,
    });
  });

  it('is the only tool that carries one', () => {
    expect(styleForTool('pen', DEFAULT_TOOL_SETTINGS, 'pen').tape).toBeUndefined();
    expect(styleForTool('highlighter', DEFAULT_TOOL_SETTINGS, 'pen').tape).toBeUndefined();
  });
});

describe('straightening', () => {
  it('collapses hand shake into a few long segments', () => {
    const straight = tapePath(wobbly, style({ tape: { pattern: 'solid', accent: '#fff', straighten: true } }));
    expect(straight.length).toBeLessThan(wobbly.length / 4);
    // RDP keeps a subset of the original samples, ends included, so the strip
    // still begins and ends exactly where the pen did.
    expect(straight[0]).toBe(wobbly[0]);
    expect(straight[straight.length - 1]).toBe(wobbly[wobbly.length - 1]);
  });

  it('leaves the path alone when it is turned off', () => {
    const asDrawn = tapePath(wobbly, style({ tape: { pattern: 'solid', accent: '#fff', straighten: false } }));
    expect(asDrawn).toBe(wobbly);
  });

  it('never straightens a stroke down to nothing', () => {
    const tiny: InkPoint[] = [{ x: 0, y: 0, pressure: 0.5 }, { x: 1, y: 0, pressure: 0.5 }];
    expect(tapePath(tiny, style()).length).toBeGreaterThanOrEqual(2);
  });

  it('flattens pressure, so the band does not taper like a pen stroke', () => {
    const samples = tapeSamples(wobbly, style());
    expect(new Set(samples.map((p) => p.pressure))).toEqual(new Set([0.5]));
  });
});

describe('pattern tiles', () => {
  it('offers the four patterns the flyout shows', () => {
    expect(TAPE_PATTERNS.map((p) => p.id)).toEqual(['solid', 'stripes', 'checker', 'dots']);
  });

  it('gives solid tape no accent marks at all', () => {
    expect(tilePattern('solid')).toEqual([]);
  });

  it('builds each pattern out of marks inside the tile', () => {
    for (const { id } of TAPE_PATTERNS) {
      for (const mark of tilePattern(id)) {
        expect(mark.x).toBeGreaterThanOrEqual(0);
        expect(mark.y).toBeGreaterThanOrEqual(0);
        expect(mark.x + mark.width).toBeLessThanOrEqual(TAPE_TILE);
        expect(mark.y + mark.height).toBeLessThanOrEqual(TAPE_TILE);
      }
    }
    expect(tilePattern('checker')).toHaveLength(2);
    expect(tilePattern('dots')[0]?.round).toBe(true);
  });
});

describe('laying the pattern out for export', () => {
  const bounds = { minX: 0, minY: 0, maxX: 64, maxY: 64 };

  it('repeats the tile across the bounds', () => {
    const marks = tileMarksOver('checker', bounds, () => true);
    // 4 × 4 tiles over a 64 px square, two marks each.
    expect(marks).toHaveLength(4 * 4 * 2);
  });

  it('drops any mark that would hang over the edge of the band', () => {
    // A band covering only the left half: nothing may be placed on the right.
    const marks = tileMarksOver('checker', bounds, (p) => p.x <= 32);
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) expect(mark.x + mark.width).toBeLessThanOrEqual(32);
  });

  it('places nothing at all for solid tape, or outside a band that rejects everything', () => {
    expect(tileMarksOver('solid', bounds, () => true)).toEqual([]);
    expect(tileMarksOver('dots', bounds, () => false)).toEqual([]);
  });
});
