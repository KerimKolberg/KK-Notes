/**
 * Where a toolbar docks, as pure geometry.
 *
 * A docked toolbar sits against one edge of its container, centred along it. The
 * two sides lay it out vertically and the top and bottom horizontally, which
 * changes its size — so where it ends up depends on measuring it, and these
 * take the measurements as arguments rather than reading a DOM.
 */
import type { PaletteDock } from '../preferences/types';
import { PANEL_MARGIN, clampPanelPosition, type Position, type Size } from './dragBounds';
import { NO_INSETS, type Insets } from './safeArea';

/**
 * How close the *pointer* has to get to an edge to dock there, in px.
 *
 * Generous on purpose: on a tablet this is done with a finger or a pen tip, and a
 * target a few pixels wide is one nobody would ever hit. Wide enough that pushing
 * the toolbar towards an edge is the whole gesture.
 */
export const DOCK_ZONE_PX = 72;

/** True for the docks that stand the toolbar on end. */
export function isVerticalDock(dock: PaletteDock): boolean {
  return dock === 'left' || dock === 'right';
}

/**
 * Which edge a drag that ended at `pointer` docks to, or `free` if none.
 *
 * The *pointer*, not the toolbar's own box. A horizontal toolbar is most of the
 * width of the screen, so its box is always close to both side edges; judging by
 * it would dock a bar being dragged along the bottom to the left the moment it got
 * near a corner. Where the finger is answers the question the person is actually
 * asking. Near a corner the nearer edge wins, and a tie goes to top or bottom,
 * because that is where the toolbar has always lived.
 */
export function snapDock(pointer: Position, container: Size, zone = DOCK_ZONE_PX): PaletteDock {
  const distances: ReadonlyArray<readonly [PaletteDock, number]> = [
    ['bottom', container.height - pointer.y],
    ['top', pointer.y],
    ['left', pointer.x],
    ['right', container.width - pointer.x],
  ];
  let best: readonly [PaletteDock, number] | null = null;
  for (const candidate of distances) {
    if (candidate[1] > zone) continue;
    // Strictly less: the order above is the tie-break.
    if (best === null || candidate[1] < best[1]) best = candidate;
  }
  return best === null ? 'free' : best[0];
}

/**
 * Where a docked toolbar of this size sits: against its edge, centred along it.
 *
 * `free` has no place of its own — it is wherever it was dropped — so it returns
 * `null` and the caller keeps the position it has.
 */
export function dockedPosition(
  dock: PaletteDock,
  panel: Size,
  container: Size,
  margin = PANEL_MARGIN,
  insets: Insets = NO_INSETS,
): Position | null {
  if (dock === 'free') return null;
  const centreX = (container.width - panel.width) / 2;
  const centreY = (container.height - panel.height) / 2;
  const raw: Position =
    dock === 'left'
      ? { x: margin + insets.left, y: centreY }
      : dock === 'right'
        ? { x: container.width - panel.width - margin - insets.right, y: centreY }
        : dock === 'top'
          ? { x: centreX, y: margin + insets.top }
          : { x: centreX, y: container.height - panel.height - margin - insets.bottom };
  // Clamped as well, so a toolbar bigger than the room it is docked in is pinned
  // to the corner rather than placed off-screen.
  return clampPanelPosition(raw, panel, container, margin, insets);
}

/**
 * The tallest a vertically docked toolbar may be.
 *
 * Standing sixteen buttons on end is taller than a tablet in landscape, so the
 * tools column is given this as a cap and wraps into a second column instead of
 * running off the bottom of the screen.
 */
export function verticalCapacity(container: Size, margin = PANEL_MARGIN, insets: Insets = NO_INSETS, chrome = 16): number {
  return Math.max(120, container.height - margin * 2 - insets.top - insets.bottom - chrome);
}
