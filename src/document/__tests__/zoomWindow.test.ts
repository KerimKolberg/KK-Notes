import { beforeEach, describe, expect, it } from 'vitest';
import { useZoomWindowStore, zoomRegion } from '../zoomWindow';

const store = useZoomWindowStore;
const page = { id: 'p1', dimensions: { width: 794, height: 1123 } };

describe('the zoom window', () => {
  beforeEach(() => {
    store.getState().close();
    store.setState({ width: 1200, height: 240, mag: 3 });
  });

  it('starts closed', () => {
    expect(store.getState().open).toBe(false);
  });

  it('opens on a page at its left edge, centred on what was being looked at', () => {
    store.getState().toggle(page, { x: 400, y: 600 });
    const s = store.getState();
    expect(s.open).toBe(true);
    expect(s.pageId).toBe('p1');
    expect(s.origin.x).toBe(0);
    // 240 px at 3x is 80 page units tall.
    expect(s.origin.y).toBeCloseTo(560);
    expect(s.anchorX).toBe(0);
  });

  it('closes when toggled again on the same page, and moves to another page when called there', () => {
    store.getState().toggle(page, { x: 0, y: 500 });
    store.getState().toggle({ id: 'p2', dimensions: { width: 600, height: 800 } }, { x: 0, y: 300 });
    expect(store.getState().pageId).toBe('p2');
    expect(store.getState().open).toBe(true);
    store.getState().toggle({ id: 'p2', dimensions: { width: 600, height: 800 } }, { x: 0, y: 300 });
    expect(store.getState().open).toBe(false);
  });

  it('shows a region the size of the drawing area over the magnification', () => {
    expect(zoomRegion({ width: 1200, height: 240, mag: 3 })).toEqual({ w: 400, h: 80 });
    store.getState().setMag(4, page.dimensions);
    expect(zoomRegion(store.getState())).toEqual({ w: 300, h: 60 });
  });

  it('keeps the region on the page when the magnification, size or width change', () => {
    store.getState().toggle(page, { x: 0, y: 1100 });
    expect(store.getState().origin.y).toBe(1123 - 80);
    store.getState().setMag(2, page.dimensions);
    expect(store.getState().origin.y).toBe(1123 - 120);
    store.getState().setHeight(360, page.dimensions);
    expect(store.getState().origin.y).toBe(1123 - 180);
    store.getState().setMag(3, page.dimensions);
    store.getState().moveTo({ x: 500, y: 10 }, page.dimensions);
    expect(store.getState().origin.x).toBe(794 - 1200 / 3 / 1); // 400 wide at 3x
    store.getState().setWidth(1800, page.dimensions);
    // A wider window shows more of the page, so the far edge has moved in to stay on it.
    expect(store.getState().origin.x).toBeLessThanOrEqual(794 - 1800 / 3);
  });

  it('steps sideways and down, stopping at the page, and sideways steps set where the next line starts', () => {
    store.getState().toggle(page, { x: 0, y: 300 });
    store.getState().step('right', page.dimensions);
    expect(store.getState().origin.x).toBeCloseTo(240);
    expect(store.getState().anchorX).toBeCloseTo(240);
    const y = store.getState().origin.y;
    store.getState().step('down', page.dimensions);
    expect(store.getState().origin.y).toBeGreaterThan(y);
    expect(store.getState().anchorX).toBeCloseTo(240);
    for (let i = 0; i < 12; i++) store.getState().step('right', page.dimensions);
    expect(store.getState().origin.x).toBe(794 - 400);
  });

  it('goes to the next line: back to where the last began, and down', () => {
    store.getState().toggle(page, { x: 0, y: 300 });
    store.getState().moveTo({ x: 50, y: 300 }, page.dimensions);
    store.getState().follow({ x: 350, y: 300 }, page.dimensions);
    expect(store.getState().anchorX).toBe(50);
    store.getState().nextLine(page.dimensions);
    expect(store.getState().origin.x).toBe(50);
    expect(store.getState().origin.y).toBeCloseTo(300 + 80 * 0.7);
  });

  it('follows the writing without moving where the next line starts', () => {
    store.getState().toggle(page, { x: 0, y: 300 });
    store.getState().follow({ x: 200, y: 300 }, page.dimensions);
    expect(store.getState().origin.x).toBe(200);
    expect(store.getState().anchorX).toBe(0);
  });

  it('ignores a width that has not changed, so a measurement does not start a loop', () => {
    const before = store.getState();
    store.getState().setWidth(1200.4, page.dimensions);
    expect(store.getState()).toBe(before);
  });
});
