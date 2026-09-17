/**
 * Safe-area insets as numbers.
 *
 * CSS can use `var(--safe-top)` directly, but the floating palette has to
 * *measure* the insets: its position is computed in JavaScript, and a panel
 * dropped under Android's gesture pill would be unreachable. Custom
 * properties are substituted lazily, so reading them off `:root` hands back
 * the literal `max(...)` expression; a hidden probe element whose padding is
 * set from those variables resolves them to pixels instead.
 */

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Parse the four resolved padding values of the probe element. */
export function parseInsets(style: { paddingTop: string; paddingRight: string; paddingBottom: string; paddingLeft: string }): Insets {
  const px = (value: string): number => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    top: px(style.paddingTop),
    right: px(style.paddingRight),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
  };
}

export function insetsEqual(a: Insets, b: Insets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/** Style that makes an element's padding mirror the safe-area variables. */
export const PROBE_STYLE =
  'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
  'padding-top:var(--safe-top);padding-right:var(--safe-right);' +
  'padding-bottom:var(--safe-bottom);padding-left:var(--safe-left);';
