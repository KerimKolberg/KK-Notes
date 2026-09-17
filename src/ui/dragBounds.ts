/**
 * Geometry for the draggable tool palette. Pure so the clamping rules can be
 * unit-tested without a DOM: a panel may never be dragged off-screen, and it
 * stays put (re-clamped, not re-centred) when the window resizes.
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Position {
  readonly x: number;
  readonly y: number;
}

/** Gap kept between the panel and the edges of its container. */
export const PANEL_MARGIN = 12;

/**
 * Clamp a position so the whole panel stays inside the container. A panel
 * larger than the container is pinned to the top-left corner instead of being
 * pushed out of view.
 */
export function clampPanelPosition(position: Position, panel: Size, container: Size, margin = PANEL_MARGIN): Position {
  const maxX = container.width - panel.width - margin;
  const maxY = container.height - panel.height - margin;
  return {
    x: Math.round(Math.min(Math.max(position.x, margin), Math.max(margin, maxX))),
    y: Math.round(Math.min(Math.max(position.y, margin), Math.max(margin, maxY))),
  };
}

/** Starting spot for the palette: centred horizontally, near the bottom edge. */
export function defaultPanelPosition(panel: Size, container: Size, margin = PANEL_MARGIN): Position {
  return clampPanelPosition(
    { x: (container.width - panel.width) / 2, y: container.height - panel.height - margin * 2 },
    panel,
    container,
    margin,
  );
}

/** True when the panel no longer fits where it is (after a resize). */
export function isOutOfBounds(position: Position, panel: Size, container: Size, margin = PANEL_MARGIN): boolean {
  const clamped = clampPanelPosition(position, panel, container, margin);
  return clamped.x !== Math.round(position.x) || clamped.y !== Math.round(position.y);
}
