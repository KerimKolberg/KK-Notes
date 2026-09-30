import { describe, expect, it } from 'vitest';
import { DOCK_ZONE_PX, dockedPosition, isVerticalDock, snapDock, verticalCapacity } from '../dock';

/**
 * Docking, as arithmetic. A 1280 × 720 stage, a 900 × 110 horizontal bar and a
 * 120 × 640 vertical one — the shapes the real toolbar takes on a 2-in-1.
 */
const container = { width: 1280, height: 720 };
const bar = { width: 900, height: 110 };
const column = { width: 120, height: 640 };

describe('which edge a drag docks to', () => {
  it('docks to each edge the pointer is pushed against', () => {
    expect(snapDock({ x: 640, y: 700 }, container)).toBe('bottom');
    expect(snapDock({ x: 640, y: 10 }, container)).toBe('top');
    expect(snapDock({ x: 8, y: 360 }, container)).toBe('left');
    expect(snapDock({ x: 1270, y: 360 }, container)).toBe('right');
  });

  it('stays free in the middle of the stage', () => {
    expect(snapDock({ x: 640, y: 360 }, container)).toBe('free');
    expect(snapDock({ x: 300, y: 300 }, container)).toBe('free');
  });

  it('uses a zone wide enough for a finger', () => {
    expect(snapDock({ x: 640, y: 720 - DOCK_ZONE_PX }, container)).toBe('bottom');
    expect(snapDock({ x: 640, y: 720 - DOCK_ZONE_PX - 1 }, container)).toBe('free');
  });

  it('judges by the pointer, not by the size of the toolbar', () => {
    // A wide bar dragged along the bottom is close to both side edges by its own
    // box. What matters is where the finger is: mid-bottom, so bottom.
    expect(snapDock({ x: 640, y: 690 }, container)).toBe('bottom');
    expect(bar.width).toBeGreaterThan(container.width / 2);
  });

  it('takes the nearer edge in a corner', () => {
    expect(snapDock({ x: 10, y: 40 }, container)).toBe('left'); // 10 from left, 40 from top
    expect(snapDock({ x: 40, y: 10 }, container)).toBe('top'); //  40 from left, 10 from top
  });

  it('breaks an exact tie towards top or bottom', () => {
    // Where the toolbar has always lived, so the ambiguous case is not a surprise.
    expect(snapDock({ x: 20, y: 700 }, container)).toBe('bottom'); // 20 and 20
    expect(snapDock({ x: 20, y: 20 }, container)).toBe('top');
    expect(snapDock({ x: 1260, y: 700 }, container)).toBe('bottom');
  });
});

describe('where a docked toolbar sits', () => {
  it('centres along the edge and keeps a margin from it', () => {
    expect(dockedPosition('bottom', bar, container, 12)).toEqual({ x: 190, y: 720 - 110 - 12 });
    expect(dockedPosition('top', bar, container, 12)).toEqual({ x: 190, y: 12 });
    expect(dockedPosition('left', column, container, 12)).toEqual({ x: 12, y: 40 });
    expect(dockedPosition('right', column, container, 12)).toEqual({ x: 1280 - 120 - 12, y: 40 });
  });

  it('has no place of its own when free', () => {
    expect(dockedPosition('free', bar, container)).toBeNull();
  });

  it('stays clear of the safe-area insets', () => {
    const insets = { top: 24, bottom: 34, left: 0, right: 0 };
    expect(dockedPosition('top', bar, container, 12, insets)?.y).toBe(36);
    expect(dockedPosition('bottom', bar, container, 12, insets)?.y).toBe(720 - 110 - 12 - 34);
  });

  it('pins a toolbar that is bigger than the room to the corner instead of off-screen', () => {
    const huge = { width: 2000, height: 900 };
    const at = dockedPosition('left', huge, container, 12);
    expect(at).toEqual({ x: 12, y: 12 });
  });
});

describe('orientation', () => {
  it('stands the toolbar on end only on the sides', () => {
    expect(isVerticalDock('left')).toBe(true);
    expect(isVerticalDock('right')).toBe(true);
    for (const dock of ['top', 'bottom', 'free'] as const) expect(isVerticalDock(dock)).toBe(false);
  });

  it('caps a standing toolbar at the height of the stage so it wraps rather than overflows', () => {
    expect(verticalCapacity(container, 12, undefined, 16)).toBe(720 - 24 - 16);
    // And never to nothing, however small the window gets.
    expect(verticalCapacity({ width: 300, height: 50 })).toBe(120);
  });
});
