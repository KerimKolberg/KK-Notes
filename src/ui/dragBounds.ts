import { NO_INSETS, type Insets } from './safeArea';

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
 * Clamp a position so the whole panel stays inside the container, clear of
 * the margin and of any safe-area insets (Android's gesture pill, a notch).
 * A panel larger than the container is pinned to the top-left corner instead
 * of being pushed out of view.
 */
export function clampPanelPosition(
  position: Position,
  panel: Size,
  container: Size,
  margin = PANEL_MARGIN,
  insets: Insets = NO_INSETS,
): Position {
  const minX = margin + insets.left;
  const minY = margin + insets.top;
  const maxX = container.width - panel.width - margin - insets.right;
  const maxY = container.height - panel.height - margin - insets.bottom;
  return {
    x: Math.round(Math.min(Math.max(position.x, minX), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(position.y, minY), Math.max(minY, maxY))),
  };
}

/** Starting spot for the palette: centred horizontally, near the bottom edge. */
export function defaultPanelPosition(panel: Size, container: Size, margin = PANEL_MARGIN, insets: Insets = NO_INSETS): Position {
  return clampPanelPosition(
    { x: (container.width - panel.width) / 2, y: container.height - panel.height - margin * 2 - insets.bottom },
    panel,
    container,
    margin,
    insets,
  );
}

/** True when the panel no longer fits where it is (after a resize or a rotation). */
export function isOutOfBounds(position: Position, panel: Size, container: Size, margin = PANEL_MARGIN, insets: Insets = NO_INSETS): boolean {
  const clamped = clampPanelPosition(position, panel, container, margin, insets);
  return clamped.x !== Math.round(position.x) || clamped.y !== Math.round(position.y);
}
