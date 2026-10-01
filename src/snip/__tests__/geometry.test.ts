import { describe, expect, it } from 'vitest';
import {
  MAX_RENDER_WIDTH,
  MIN_SNIP_PX,
  defaultCentre,
  dragRect,
  fitOnPage,
  isSnip,
  pageRegion,
  snipScale,
  topLeftFor,
} from '../geometry';
import { MAX_SNIPS, useSnipStore, type Snip } from '../snipStore';

const frame = { x: 100, y: 50, width: 400, height: 500 };
const A4 = { width: 800, height: 1000 };

describe('dragRect', () => {
  it('is the rectangle between two points, whichever way they were dragged', () => {
    expect(dragRect({ x: 150, y: 100 }, { x: 250, y: 200 }, frame)).toEqual({ x: 150, y: 100, width: 100, height: 100 });
    expect(dragRect({ x: 250, y: 200 }, { x: 150, y: 100 }, frame)).toEqual({ x: 150, y: 100, width: 100, height: 100 });
  });

  it('stays on the page, however far the pointer goes', () => {
    expect(dragRect({ x: 450, y: 500 }, { x: 900, y: 900 }, frame)).toEqual({ x: 450, y: 500, width: 50, height: 50 });
    expect(dragRect({ x: 150, y: 100 }, { x: -50, y: -50 }, frame)).toEqual({ x: 100, y: 50, width: 50, height: 50 });
  });
});

describe('isSnip', () => {
  it('is a drag, not a click', () => {
    expect(isSnip({ x: 0, y: 0, width: MIN_SNIP_PX, height: MIN_SNIP_PX })).toBe(true);
    expect(isSnip({ x: 0, y: 0, width: MIN_SNIP_PX - 1, height: 200 })).toBe(false);
    expect(isSnip({ x: 0, y: 0, width: 200, height: 3 })).toBe(false);
  });
});

describe('pageRegion', () => {
  it('turns a rectangle on screen into the region of the page under it, in page units', () => {
    // The page is 800 units across and shown 400 px wide: two units to the pixel.
    expect(pageRegion({ x: 150, y: 100, width: 100, height: 60 }, frame, A4)).toEqual({ x: 100, y: 100, width: 200, height: 120 });
  });

  it('follows the page at any zoom', () => {
    const big = { x: 0, y: 0, width: 1600, height: 2000 };
    expect(pageRegion({ x: 800, y: 1000, width: 400, height: 200 }, big, A4)).toEqual({ x: 400, y: 500, width: 200, height: 100 });
  });
});

describe('snipScale', () => {
  it('is at least twice the page unit, so it holds up when put on a page', () => {
    expect(snipScale(2000, 800)).toBe(2);
  });

  it('draws a small region sharper, but not past four times', () => {
    expect(snipScale(300, 800)).toBe(3);
    expect(snipScale(20, 800)).toBe(4);
  });

  it('never draws the page wider than it can afford', () => {
    expect(snipScale(100, 2000) * 2000).toBeLessThanOrEqual(MAX_RENDER_WIDTH);
    expect(snipScale(100, 800) * 800).toBeLessThanOrEqual(MAX_RENDER_WIDTH);
  });
});

describe('putting a snip on a page', () => {
  it('keeps its size when it fits, and shrinks to most of the page when it does not', () => {
    expect(fitOnPage({ width: 200, height: 100 }, A4)).toEqual({ width: 200, height: 100 });
    const big = fitOnPage({ width: 1600, height: 400 }, A4);
    expect(big.width).toBeCloseTo(720);
    expect(big.height).toBeCloseTo(180);
  });

  it('centres on the pointer, and is held on the page at an edge', () => {
    const size = { width: 200, height: 100 };
    expect(topLeftFor({ x: 400, y: 500 }, size, A4)).toEqual({ x: 300, y: 450 });
    expect(topLeftFor({ x: 10, y: 5 }, size, A4)).toEqual({ x: 0, y: 0 });
    expect(topLeftFor({ x: 790, y: 995 }, size, A4)).toEqual({ x: 600, y: 900 });
  });

  it('puts the first across the middle of the page, near the top, and each next one a little further on', () => {
    const size = { width: 200, height: 100 };
    const first = defaultCentre(size, A4, 0);
    const second = defaultCentre(size, A4, 1);
    expect(first).toEqual({ x: 400, y: 146 });
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.y).toBeGreaterThan(first.y);
    expect(defaultCentre(size, A4, 6)).toEqual(first);
  });
});

describe('the snips kept', () => {
  const snip = (n: number): Snip => ({ id: `s${n}`, src: 'data:image/png;base64,AA', width: 10, height: 10, unitsWidth: 5, unitsHeight: 5, from: 'Lecture' });

  it('has the newest first, and only so many', () => {
    const s = useSnipStore.getState();
    s.clear();
    for (let i = 0; i < MAX_SNIPS + 3; i++) s.add(snip(i));
    const kept = useSnipStore.getState().snips;
    expect(kept.length).toBe(MAX_SNIPS);
    expect(kept[0]!.id).toBe(`s${MAX_SNIPS + 2}`);
    s.remove(kept[0]!.id);
    expect(useSnipStore.getState().snips.length).toBe(MAX_SNIPS - 1);
    s.clear();
    expect(useSnipStore.getState().snips.length).toBe(0);
  });

  it('opens its tray when one is added, and toggles snipping', () => {
    const s = useSnipStore.getState();
    s.setTrayOpen(false);
    s.add(snip(1));
    expect(useSnipStore.getState().trayOpen).toBe(true);
    expect(useSnipStore.getState().mode).toBe(false);
    s.toggleMode();
    expect(useSnipStore.getState().mode).toBe(true);
    s.setMode(false);
    s.clear();
  });
});
