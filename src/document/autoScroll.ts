/**
 * Scrolling the page area while something is dragged to its edge.
 *
 * Carrying a selection or a snip to a spot past the end of what is on screen needs the page to move under it: hold the
 * pointer near an edge and the area scrolls that way, faster the closer to the edge, in either direction (down a
 * vertical column of pages, along a horizontal row, or sideways over a page wider than the window). Pure arithmetic here;
 * the loop below drives it from animation frames while a drag lasts.
 */

/** How close to an edge, in CSS px, the pointer has to be for the area to start moving. */
export const EDGE_ZONE_PX = 56;
/**
 * The fastest it moves, in CSS px per *second*, with the pointer right at (or past) the edge. Per second and not per
 * frame: a display that refreshes at 180 Hz would otherwise scroll three times as fast as one at 60.
 */
export const MAX_SCROLL_PER_SECOND = 900;

/**
 * Scroll speed (px per second) along one axis for a pointer at `pos` over an area spanning `start`..`end`: negative towards `start`,
 * positive towards `end`, zero in the middle. It ramps up linearly over the edge zone, and stays at the top speed beyond
 * the edge, where a drag that has left the area is still asking for more.
 */
export function edgeVelocity(pos: number, start: number, end: number, zone = EDGE_ZONE_PX, max = MAX_SCROLL_PER_SECOND): number {
  // An area too small for two zones shares what it has, so the middle is never in both.
  const z = Math.max(1, Math.min(zone, (end - start) / 2));
  if (pos < start + z) return -max * Math.min(1, (start + z - pos) / z);
  if (pos > end - z) return max * Math.min(1, (pos - (end - z)) / z);
  return 0;
}

/** The element the pages scroll in. */
export function viewerElement(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('[data-viewer]');
}

export interface AutoScroll {
  stop: () => void;
}

/**
 * While a drag lasts, scroll the page area towards whichever edge the pointer is at. `pointer` is asked for each frame
 * (the drag keeps the latest position), and `onScrolled` is told how far the area moved, so the dragged thing can follow:
 * the pointer has not moved but the pages under it have.
 * `area` is what scrolls: the page area unless said otherwise (the reading pane scrolls on its own).
 */
export function startAutoScroll(
  pointer: () => { readonly x: number; readonly y: number } | null,
  onScrolled?: (dx: number, dy: number) => void,
  area: () => HTMLElement | null = viewerElement,
): AutoScroll {
  let frame = 0;
  let stopped = false;
  let last = performance.now();
  const tick = (now: number): void => {
    if (stopped) return;
    // Time, not frames, and never more than a few frames' worth after a stall.
    const seconds = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    const el = area();
    const p = pointer();
    if (el && p) {
      const rect = el.getBoundingClientRect();
      const vx = edgeVelocity(p.x, rect.left, rect.right);
      const vy = edgeVelocity(p.y, rect.top, rect.bottom);
      if (vx !== 0 || vy !== 0) {
        const beforeLeft = el.scrollLeft;
        const beforeTop = el.scrollTop;
        el.scrollLeft += vx * seconds;
        el.scrollTop += vy * seconds;
        const dx = el.scrollLeft - beforeLeft;
        const dy = el.scrollTop - beforeTop;
        if ((dx !== 0 || dy !== 0) && onScrolled) onScrolled(dx, dy);
      }
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(frame);
    },
  };
}
