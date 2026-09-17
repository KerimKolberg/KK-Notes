import { describe, expect, it } from 'vitest';
import { PANEL_MARGIN, clampPanelPosition, defaultPanelPosition, isOutOfBounds } from '../dragBounds';

const panel = { width: 560, height: 110 };
const container = { width: 1280, height: 800 };

describe('floating palette bounds', () => {
  it('keeps the panel inside the container on every edge', () => {
    expect(clampPanelPosition({ x: -500, y: -500 }, panel, container)).toEqual({ x: PANEL_MARGIN, y: PANEL_MARGIN });
    expect(clampPanelPosition({ x: 9999, y: 9999 }, panel, container)).toEqual({
      x: container.width - panel.width - PANEL_MARGIN,
      y: container.height - panel.height - PANEL_MARGIN,
    });
    // A position that already fits is returned unchanged (bar rounding).
    expect(clampPanelPosition({ x: 300.4, y: 200.6 }, panel, container)).toEqual({ x: 300, y: 201 });
  });

  it('pins an oversized panel to the top-left instead of pushing it out of view', () => {
    const huge = { width: 2000, height: 1200 };
    expect(clampPanelPosition({ x: 500, y: 500 }, huge, container)).toEqual({ x: PANEL_MARGIN, y: PANEL_MARGIN });
    expect(clampPanelPosition({ x: -80, y: -80 }, huge, container)).toEqual({ x: PANEL_MARGIN, y: PANEL_MARGIN });
  });

  it('honours a custom margin', () => {
    expect(clampPanelPosition({ x: 0, y: 0 }, panel, container, 40)).toEqual({ x: 40, y: 40 });
    expect(clampPanelPosition({ x: 5000, y: 0 }, panel, container, 40)).toEqual({ x: 1280 - 560 - 40, y: 40 });
  });

  it('starts centred near the bottom edge, still inside the container', () => {
    const start = defaultPanelPosition(panel, container);
    expect(start.x).toBe(Math.round((container.width - panel.width) / 2));
    expect(start.y).toBe(container.height - panel.height - PANEL_MARGIN * 2);
    expect(clampPanelPosition(start, panel, container)).toEqual(start);
  });

  it('detects a position that a resize has pushed out of view', () => {
    const start = defaultPanelPosition(panel, container);
    expect(isOutOfBounds(start, panel, container)).toBe(false);
    // The window shrinks to a phone-sized viewport: the palette must move.
    const small = { width: 420, height: 380 };
    expect(isOutOfBounds(start, panel, small)).toBe(true);
    const fixed = clampPanelPosition(start, panel, small);
    expect(isOutOfBounds(fixed, panel, small)).toBe(false);
    // Too wide for the viewport, so x is pinned; y still fits, so it only rises.
    expect(fixed).toEqual({ x: PANEL_MARGIN, y: small.height - panel.height - PANEL_MARGIN });
  });
});
