import { describe, expect, it } from 'vitest';
import { PANEL_MARGIN, clampPanelPosition, defaultPanelPosition, isOutOfBounds } from '../dragBounds';
import { NO_INSETS, PROBE_STYLE, insetsEqual, parseInsets } from '../safeArea';

const panel = { width: 560, height: 110 };
const container = { width: 1280, height: 800 };
/** A tablet in portrait: status bar on top, gesture pill at the bottom. */
const android = { top: 48, right: 0, bottom: 32, left: 0 };

describe('reading the safe-area insets', () => {
  it('parses the probe element’s resolved padding', () => {
    expect(
      parseInsets({ paddingTop: '48px', paddingRight: '0px', paddingBottom: '32.5px', paddingLeft: '0px' }),
    ).toEqual({ top: 48, right: 0, bottom: 32.5, left: 0 });
  });

  it('treats anything unresolved as no inset', () => {
    expect(parseInsets({ paddingTop: '', paddingRight: 'auto', paddingBottom: '-4px', paddingLeft: 'NaN' })).toEqual(NO_INSETS);
  });

  it('compares insets by value', () => {
    expect(insetsEqual(android, { ...android })).toBe(true);
    expect(insetsEqual(android, { ...android, bottom: 0 })).toBe(false);
  });

  it('drives the probe from the CSS variables the app defines', () => {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(PROBE_STYLE).toContain(`padding-${side}:var(--safe-${side})`);
    }
    // It must never be visible or clickable.
    expect(PROBE_STYLE).toContain('visibility:hidden');
    expect(PROBE_STYLE).toContain('pointer-events:none');
  });
});

describe('palette bounds with system bars', () => {
  it('keeps the panel clear of the status bar and the gesture pill', () => {
    const top = clampPanelPosition({ x: 100, y: 0 }, panel, container, PANEL_MARGIN, android);
    expect(top.y).toBe(PANEL_MARGIN + android.top);
    const bottom = clampPanelPosition({ x: 100, y: 9999 }, panel, container, PANEL_MARGIN, android);
    expect(bottom.y).toBe(container.height - panel.height - PANEL_MARGIN - android.bottom);
  });

  it('respects a cutout on the side in landscape', () => {
    const landscape = { top: 0, right: 44, bottom: 24, left: 44 };
    const left = clampPanelPosition({ x: -100, y: 200 }, panel, container, PANEL_MARGIN, landscape);
    expect(left.x).toBe(PANEL_MARGIN + landscape.left);
    const right = clampPanelPosition({ x: 9999, y: 200 }, panel, container, PANEL_MARGIN, landscape);
    expect(right.x).toBe(container.width - panel.width - PANEL_MARGIN - landscape.right);
  });

  it('opens above the gesture pill rather than under it', () => {
    const plain = defaultPanelPosition(panel, container);
    const withBars = defaultPanelPosition(panel, container, PANEL_MARGIN, android);
    expect(withBars.y).toBe(plain.y - android.bottom);
    expect(withBars.y + panel.height).toBeLessThanOrEqual(container.height - android.bottom);
  });

  it('notices when a rotation leaves the panel under a bar', () => {
    const resting = defaultPanelPosition(panel, container);
    expect(isOutOfBounds(resting, panel, container)).toBe(false);
    expect(isOutOfBounds(resting, panel, container, PANEL_MARGIN, android)).toBe(true);
    const fixed = clampPanelPosition(resting, panel, container, PANEL_MARGIN, android);
    expect(isOutOfBounds(fixed, panel, container, PANEL_MARGIN, android)).toBe(false);
  });

  it('still pins an oversized panel to the safe corner', () => {
    const huge = { width: 2000, height: 1200 };
    expect(clampPanelPosition({ x: 0, y: 0 }, huge, container, PANEL_MARGIN, android)).toEqual({
      x: PANEL_MARGIN,
      y: PANEL_MARGIN + android.top,
    });
  });
});
