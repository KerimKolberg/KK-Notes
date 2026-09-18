import { describe, expect, it } from 'vitest';
import { DEFAULT_AXIS_STEP, DEFAULT_COORDINATE_PLANE } from '../constants';
import { axisSteps, coordinatePlaneGeometry, formatTickValue } from '../engine/shapes';
import type { CoordinatePlaneConfig, CoordinatePlaneShape } from '../types';

const plane = (config: Partial<CoordinatePlaneConfig>): CoordinatePlaneShape => ({
  type: 'coordinate-plane',
  origin: { x: 200, y: 200 },
  extentX: 150,
  extentY: 150,
  config: { ...DEFAULT_COORDINATE_PLANE, tickLabels: true, divisions: 4, ...config },
});

/** Every tick label on the plane, minus the axis names and the origin's 0. */
const tickTexts = (config: Partial<CoordinatePlaneConfig>): string[] =>
  coordinatePlaneGeometry(plane(config))
    .labels.filter((l) => !l.italic)
    .map((l) => l.text);

describe('formatTickValue', () => {
  it('counts whole cells by default', () => {
    expect(formatTickValue(3, 1)).toBe('3');
    expect(formatTickValue(-2, 1)).toBe('-2');
    expect(formatTickValue(0, 1)).toBe('0');
  });

  it('prints a fractional step without floating-point noise', () => {
    // 3 * 0.1 is 0.30000000000000004 in binary floating point, and 7 * 0.7 is
    // 4.8999999999999995. Neither may reach the page.
    expect(formatTickValue(3, 0.1)).toBe('0.3');
    expect(formatTickValue(7, 0.7)).toBe('4.9');
    expect(formatTickValue(3, 0.25)).toBe('0.75');
    expect(formatTickValue(6, 0.15)).toBe('0.9');
    expect(formatTickValue(29, 0.29)).toBe('8.41');
  });

  it('keeps the precision a step actually carries', () => {
    expect(formatTickValue(1, 0.0001)).toBe('0.0001');
    expect(formatTickValue(4, 0.25)).toBe('1');
    expect(formatTickValue(2, 2.5)).toBe('5');
    expect(formatTickValue(3, 1000)).toBe('3000');
  });

  it('never prints a rounding artefact for any step a person would type', () => {
    for (const step of [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.7, 1.1, 1.5, 2.5, 3.3]) {
      for (let i = -20; i <= 20; i++) {
        const text = formatTickValue(i, step);
        expect(text).not.toMatch(/\d{8}/);
        expect(text).not.toContain('e');
        // And it still means the right number.
        expect(Number(text)).toBeCloseTo(i * step, 10);
      }
    }
  });

  it('falls back to 0 rather than printing NaN or Infinity', () => {
    expect(formatTickValue(Number.NaN, 1)).toBe('0');
    expect(formatTickValue(1, Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('axisSteps', () => {
  it('treats a plane with no steps as whole cells', () => {
    // How a plane drawn before steps existed comes back off disk.
    const legacy: CoordinatePlaneConfig = { ...DEFAULT_COORDINATE_PLANE };
    delete (legacy as { stepX?: number }).stepX;
    delete (legacy as { stepY?: number }).stepY;
    expect(axisSteps(legacy)).toEqual({ x: DEFAULT_AXIS_STEP, y: DEFAULT_AXIS_STEP });
  });

  it('ignores a step that could not number anything', () => {
    expect(axisSteps({ ...DEFAULT_COORDINATE_PLANE, stepX: 0, stepY: -3 })).toEqual({ x: 1, y: 1 });
    expect(axisSteps({ ...DEFAULT_COORDINATE_PLANE, stepX: Number.NaN }).x).toBe(1);
  });

  it('keeps the axes independent', () => {
    expect(axisSteps({ ...DEFAULT_COORDINATE_PLANE, stepX: 0.5, stepY: 10 })).toEqual({ x: 0.5, y: 10 });
  });
});

describe('numbering a plane', () => {
  it('labels the ticks in whole cells by default', () => {
    // Four divisions each way, outermost tick suppressed under the arrowhead.
    expect(tickTexts({})).toEqual(['-3', '-3', '-2', '-2', '-1', '-1', '1', '1', '2', '2', '3', '3', '0']);
  });

  it('multiplies the division index by the step', () => {
    expect(tickTexts({ mode: 'quadrant-1', stepX: 0.25, stepY: 0.25 })).toEqual(['0.25', '0.25', '0.5', '0.5', '0.75', '0.75', '0']);
  });

  it('numbers each axis by its own step', () => {
    // x reads in tenths, y in hundreds; the pairs alternate x, y.
    expect(tickTexts({ mode: 'quadrant-1', stepX: 0.1, stepY: 100 })).toEqual(['0.1', '100', '0.2', '200', '0.3', '300', '0']);
  });

  it('changes nothing but the numbers', () => {
    const whole = coordinatePlaneGeometry(plane({}));
    const fractional = coordinatePlaneGeometry(plane({ stepX: 0.05, stepY: 0.05 }));
    expect(fractional.grid).toEqual(whole.grid);
    expect(fractional.ticks).toEqual(whole.ticks);
    expect(fractional.frame).toEqual(whole.frame);
  });
});
