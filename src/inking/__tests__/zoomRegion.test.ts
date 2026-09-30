import { describe, expect, it } from 'vitest';
import {
  ADVANCE_THRESHOLD,
  ZOOM_MAGNIFICATIONS,
  clampOrigin,
  initialOrigin,
  nextLineOrigin,
  regionSize,
  shouldAdvance,
  stepOrigin,
  windowToPage,
} from '../engine/zoomRegion';

const page = { w: 794, h: 1123 };
const near = (a: number, b: number, digits = 6): void => expect(a).toBeCloseTo(b, digits);

describe('the region a window shows', () => {
  it('is the window divided by the magnification', () => {
    expect(regionSize({ width: 1200, height: 240 }, 3)).toEqual({ w: 400, h: 80 });
    expect(regionSize({ width: 1200, height: 240 }, 2)).toEqual({ w: 600, h: 120 });
    expect(regionSize({ width: 1200, height: 240 }, 4)).toEqual({ w: 300, h: 60 });
  });

  it('is never made from a magnification that is not one', () => {
    expect(regionSize({ width: 100, height: 50 }, 0)).toEqual({ w: 100, h: 50 });
    expect(regionSize({ width: 100, height: 50 }, -3)).toEqual({ w: 100, h: 50 });
  });

  it('offers 2, 3 and 4 times', () => {
    expect([...ZOOM_MAGNIFICATIONS]).toEqual([2, 3, 4]);
  });
});

describe('keeping the region on the page', () => {
  const region = { w: 400, h: 80 };

  it('leaves a region that is on the page where it is', () => {
    const o = { x: 100, y: 200 };
    expect(clampOrigin(o, region, page)).toBe(o);
  });

  it('pulls it back from every edge', () => {
    expect(clampOrigin({ x: -30, y: -5 }, region, page)).toEqual({ x: 0, y: 0 });
    expect(clampOrigin({ x: 9999, y: 9999 }, region, page)).toEqual({ x: 794 - 400, y: 1123 - 80 });
  });

  it('keeps a region bigger than the page at the top-left', () => {
    expect(clampOrigin({ x: 50, y: 50 }, { w: 2000, h: 3000 }, page)).toEqual({ x: 0, y: 0 });
  });
});

describe('moving the region', () => {
  const region = { w: 400, h: 80 };

  it('steps by a fraction of its own size, in each direction', () => {
    const o = { x: 150, y: 500 };
    expect(stepOrigin(o, region, page, 'right')).toEqual({ x: 150 + 240, y: 500 });
    expect(stepOrigin({ x: 300, y: 500 }, region, page, 'left')).toEqual({ x: 60, y: 500 });
    expect(stepOrigin(o, region, page, 'down')).toEqual({ x: 150, y: 548 });
    expect(stepOrigin(o, region, page, 'up')).toEqual({ x: 150, y: 452 });
  });

  it('stops at the page\'s edges', () => {
    expect(stepOrigin({ x: 390, y: 10 }, region, page, 'right')).toEqual({ x: 394, y: 10 });
    expect(stepOrigin({ x: 10, y: 10 }, region, page, 'up')).toEqual({ x: 10, y: 0 });
  });

  it('goes to the next line: back to where the last began, down most of the window', () => {
    const next = nextLineOrigin({ x: 394, y: 500 }, 0, region, page);
    expect(next).toEqual({ x: 0, y: 556 });
    // The last line just written is still partly in view: the step is less than the region's height.
    expect(next.y - 500).toBeLessThan(region.h);
  });

  it('does not go past the bottom of the page', () => {
    expect(nextLineOrigin({ x: 0, y: 1100 }, 0, region, page).y).toBe(1123 - 80);
  });
});

describe('when the window moves along by itself', () => {
  const region = { w: 400, h: 80 };
  const o = { x: 100, y: 300 };

  it('does, once the pen has got into the last of the region', () => {
    expect(shouldAdvance(o.x + region.w * ADVANCE_THRESHOLD + 5, o, region, page)).toBe(true);
  });

  it('does not, while there is plenty of room left', () => {
    expect(shouldAdvance(o.x + region.w * 0.5, o, region, page)).toBe(false);
    expect(shouldAdvance(o.x + 10, o, region, page)).toBe(false);
  });

  it('does not, when the region already reaches the page\'s right edge', () => {
    const last = { x: 794 - 400, y: 300 };
    expect(shouldAdvance(794 - 10, last, region, page)).toBe(false);
  });
});

describe('where a window opens', () => {
  it('is at the left of the page, centred on what was being looked at', () => {
    const region = { w: 400, h: 80 };
    const o = initialOrigin({ x: 500, y: 600 }, region, page);
    expect(o.x).toBe(0);
    near(o.y, 560);
  });

  it('is kept on the page near the top and the bottom', () => {
    const region = { w: 400, h: 80 };
    expect(initialOrigin({ x: 0, y: 10 }, region, page).y).toBe(0);
    expect(initialOrigin({ x: 0, y: 5000 }, region, page).y).toBe(1123 - 80);
  });
});

describe('a pointer in the window', () => {
  it('is a page point: the region\'s corner plus the distance from the window\'s, divided by the magnification', () => {
    const p = windowToPage(660, 480, { x: 60, y: 450 }, 3, { x: 100, y: 300 });
    expect(p).toEqual({ x: 300, y: 310 });
  });

  it('is the region\'s corner at the window\'s corner', () => {
    expect(windowToPage(60, 450, { x: 60, y: 450 }, 4, { x: 12, y: 34 })).toEqual({ x: 12, y: 34 });
  });
});
