import { describe, expect, it } from 'vitest';
import { MAX_STROKE_SIZE, MIN_STROKE_SIZE, STROKE_SIZE_STEPS, sizeToStep, stepToSize } from '../constants';
import { brushStyle, fineStreamline } from '../engine/brushes';
import { StrokeBuilder } from '../engine/strokeBuilder';
import { getStrokeOutline, outlineScale } from '../engine/strokeOutline';
import type { InkPoint } from '../types';

describe('fine pens, for writing small with the page zoomed in', () => {
  it('go down to a quarter of a pixel, with the slider notches finer below one', () => {
    expect(MIN_STROKE_SIZE).toBe(0.25);
    expect(STROKE_SIZE_STEPS[0]).toBe(MIN_STROKE_SIZE);
    expect(STROKE_SIZE_STEPS[STROKE_SIZE_STEPS.length - 1]).toBe(MAX_STROKE_SIZE);
    expect(STROKE_SIZE_STEPS.filter((s) => s < 1).length).toBeGreaterThanOrEqual(4);
    for (const size of STROKE_SIZE_STEPS) expect(stepToSize(sizeToStep(size))).toBe(size);
    // A width saved before these notches lands on the nearest one.
    expect(stepToSize(sizeToStep(11))).toBe(10);
    expect(stepToSize(-3)).toBe(MIN_STROKE_SIZE);
    expect(stepToSize(999)).toBe(MAX_STROKE_SIZE);
  });

  it('are not widened back to half a pixel by the pen', () => {
    const style = brushStyle('ballpoint', { color: '#000', size: 0.25, pattern: 'solid', arrowheads: 'none' }, 'pen');
    expect(style.size).toBeLessThan(0.5);
  });

  it('smooth less the finer they are, and ordinary pens as before', () => {
    expect(fineStreamline(0.5, 2)).toBe(0.5);
    expect(fineStreamline(0.5, MIN_STROKE_SIZE)).toBeCloseTo(0.2);
    expect(fineStreamline(0.5, 1)).toBeGreaterThan(fineStreamline(0.5, 0.5));
    expect(fineStreamline(0.5, 1)).toBeLessThan(0.5);
  });

  it('keep samples closer together than coarse ones', () => {
    const fine = new StrokeBuilder('pen', brushStyle('ballpoint', { color: '#000', size: 0.25, pattern: 'solid', arrowheads: 'none' }, 'pen'), 'pen');
    const coarse = new StrokeBuilder('pen', brushStyle('ballpoint', { color: '#000', size: 3, pattern: 'solid', arrowheads: 'none' }, 'pen'), 'pen');
    for (let i = 0; i < 20; i++) {
      const p = { x: i * 0.2, y: 0, pressure: 0.5 };
      fine.add(p);
      coarse.add(p);
    }
    expect(fine.points.length).toBeGreaterThan(coarse.points.length);
  });

  it('keep the shape of the end of a stroke: perfect-freehand skips its last 3 units, a line and a half once scaled', () => {
    // Along, then a flick up and back down, 2.8 px in all: the tail of a small letter.
    const points: InkPoint[] = [];
    for (let i = 0; i <= 20; i++) points.push({ x: i * 0.2, y: 0, pressure: 0.5 });
    for (let i = 1; i <= 7; i++) points.push({ x: 4, y: -i * 0.2, pressure: 0.5 });
    for (let i = 6; i >= 0; i--) points.push({ x: 4.05, y: -i * 0.2, pressure: 0.5 });
    const style = brushStyle('ballpoint', { color: '#000', size: 0.25, pattern: 'solid', arrowheads: 'none' }, 'pen');
    expect(outlineScale(style.size)).toBe(8);
    expect(outlineScale(4)).toBe(1);
    const outline = getStrokeOutline(points, style, true);
    const top = Math.min(...outline.map(([, y]) => y));
    // The flick goes up to y = -1.4; unscaled, the outline cut straight across it.
    expect(top).toBeLessThan(-1);
  });
});
