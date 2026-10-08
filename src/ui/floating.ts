/**
 * How popovers and tooltips are placed.
 *
 * `absolute` hangs them off the element that holds their trigger, which is all that is needed until that element
 * scrolls: a toolbar that slides clips everything inside it to its own box, so a flyout opened from it would be cut
 * off at its edge. Inside one they are `fixed` instead — put on the screen where their trigger is, and so drawn whole.
 */
import { createContext, useContext, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

export type FloatingMode = 'absolute' | 'fixed';

const FloatingContext = createContext<FloatingMode>('absolute');
export const FloatingProvider = FloatingContext.Provider;

export function useFloatingMode(): FloatingMode {
  return useContext(FloatingContext);
}

export type FloatingSide = 'top' | 'bottom' | 'left' | 'right';
export type FloatingAlign = 'start' | 'center' | 'end';

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where a fixed panel goes beside a trigger at `r` on the screen: on `side` of it, `gap` away, and lined up with it
 * by `align` — along the trigger's width above or below it, along its height beside it. Given as the edges to set;
 * centring is the caller's `translate(-50%)`, so a correction that keeps it on screen can be added to it.
 */
export function fixedPlacement(
  side: FloatingSide,
  align: FloatingAlign,
  r: Rect,
  viewport: { readonly width: number; readonly height: number },
  gap = 8,
): CSSProperties {
  const across =
    align === 'start' ? { left: r.left } : align === 'end' ? { right: viewport.width - r.right } : { left: r.left + r.width / 2 };
  const down =
    align === 'start' ? { top: r.top } : align === 'end' ? { bottom: viewport.height - r.bottom } : { top: r.top + r.height / 2 };
  switch (side) {
    case 'top':
      return { bottom: viewport.height - r.top + gap, ...across };
    case 'bottom':
      return { top: r.bottom + gap, ...across };
    case 'left':
      return { right: viewport.width - r.left + gap, ...down };
    case 'right':
      return { left: r.right + gap, ...down };
  }
}

export function viewportSize(): { width: number; height: number } {
  const root = document.documentElement;
  return { width: root.clientWidth || window.innerWidth, height: root.clientHeight || window.innerHeight };
}

/**
 * The box of the element a floating panel belongs to — `owner()` — on the screen, while `enabled`; followed as the
 * window resizes and as anything scrolls, the bar it is in above all.
 */
export function useAnchorRect(owner: RefObject<HTMLElement | null>, enabled: boolean, of: (el: HTMLElement) => HTMLElement | null = (el) => el): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    if (!enabled) {
      setRect(null);
      return;
    }
    const update = (): void => {
      const el = owner.current ? of(owner.current) : null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect((current) =>
        current && current.left === r.left && current.top === r.top && current.width === r.width && current.height === r.height
          ? current
          : { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      );
    };
    update();
    window.addEventListener('resize', update);
    // Capturing, so a scroll anywhere — the sliding bar's own — is heard: scroll events do not bubble.
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
    // `of` is a lookup, not something that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, enabled]);
  return rect;
}
