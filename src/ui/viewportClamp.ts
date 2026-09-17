/**
 * Keeping anchored panels on screen.
 *
 * A popover or a selection toolbar is positioned against its trigger, which
 * says nothing about whether the result fits: on a phone a panel centred on
 * something near the right edge hangs off it. These pick the horizontal
 * correction that brings the panel back, and are pure so the rules can be
 * tested without a layout engine.
 */

/** Gap kept between an anchored panel and the edges of the viewport. */
export const VIEWPORT_MARGIN = 8;

/**
 * Horizontal shift in px that brings `[left, right]` inside
 * `[margin, viewportWidth - margin]`. A panel wider than that is pinned to
 * the left edge, where its beginning is at least readable.
 */
export function horizontalShift(left: number, right: number, viewportWidth: number, margin = VIEWPORT_MARGIN): number {
  const min = margin;
  const max = viewportWidth - margin;
  if (right - left >= max - min) return min - left;
  if (right > max) return max - right;
  if (left < min) return min - left;
  return 0;
}
