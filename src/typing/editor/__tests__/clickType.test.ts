import { describe, expect, it } from 'vitest';
import { emptyLineStep, linesDown, placementAcross } from '../clickType';

describe('a click under page text', () => {
  const step = emptyLineStep(16);

  it('counts an empty line as a line and the space after a paragraph', () => {
    // 1.35 lines and 0.4 of the size after, at 16 px.
    expect(step).toBeCloseTo(16 * 1.75);
  });

  it('adds no line for a click on the last paragraph or in the space after it', () => {
    expect(linesDown(-1, step)).toBe(0);
    expect(linesDown(-20, step)).toBe(0);
  });

  it('adds the line just under the text for a click on it, and one more for every line further down', () => {
    expect(linesDown(0, step)).toBe(1);
    expect(linesDown(step - 1, step)).toBe(1);
    expect(linesDown(step, step)).toBe(2);
    expect(linesDown(step * 9.5, step)).toBe(10);
  });
});

describe('where across the page a click is', () => {
  const width = 700;
  const indent = 1.6 * 16;

  it('is an ordinary line just inside the margin', () => {
    expect(placementAcross(5, width, indent)).toEqual({ align: null, indent: 0 });
    expect(placementAcross(indent - 1, width, indent)).toEqual({ align: null, indent: 0 });
  });

  it('indents the line as far as whole steps reach towards the click, up to the deepest indent', () => {
    expect(placementAcross(indent * 2.5, width, indent)).toEqual({ align: null, indent: 2 });
    expect(placementAcross(width * 0.3, width, indent)).toEqual({ align: null, indent: 6 });
  });

  it('centres a line clicked in the middle, and sets one clicked near the right edge right', () => {
    expect(placementAcross(width / 2, width, indent)).toEqual({ align: 'center', indent: 0 });
    expect(placementAcross(width * 0.95, width, indent)).toEqual({ align: 'right', indent: 0 });
  });

  it('is an ordinary line for text with no width yet', () => {
    expect(placementAcross(50, 0, indent)).toEqual({ align: null, indent: 0 });
  });
});
