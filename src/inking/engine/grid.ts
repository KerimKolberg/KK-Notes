/**
 * Snapping a point to a page's grid.
 *
 * The grid is the one the page's template draws: lines at every multiple of the
 * template's spacing from the top-left corner. A page with no grid (blank, a PDF)
 * still has somewhere to snap to, a fixed one, so the option does something on
 * every page rather than only some.
 */
import type { Point } from '../types';

/** The grid a page with no grid of its own snaps to, in page units. */
export const DEFAULT_SNAP_GRID = 24;

/** The grid cell to snap to on a page whose template has this spacing, or none of its own. */
export function snapSpacing(templateSpacing: number | undefined, hasGrid: boolean): number {
  return hasGrid && templateSpacing !== undefined && Number.isFinite(templateSpacing) && templateSpacing >= 2
    ? templateSpacing
    : DEFAULT_SNAP_GRID;
}

/** The nearest grid point to `p`. */
export function snapToGrid<P extends Point>(p: P, spacing: number): P {
  if (!(spacing > 0)) return p;
  return { ...p, x: Math.round(p.x / spacing) * spacing, y: Math.round(p.y / spacing) * spacing };
}
