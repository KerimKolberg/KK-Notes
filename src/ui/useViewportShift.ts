import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { VIEWPORT_MARGIN, horizontalShift } from './viewportClamp';

export interface ViewportShift<T extends HTMLElement> {
  /** Attach to the panel being kept on screen. */
  readonly ref: RefObject<T | null>;
  /** Horizontal correction in **screen** px to add to the panel's transform. */
  readonly shift: number;
}

/**
 * The horizontal correction that keeps an anchored panel inside the viewport.
 *
 * The measurement subtracts the shift already applied, so what is fed to
 * `horizontalShift` is always the panel's *uncorrected* rect — the answer
 * therefore does not depend on the current shift and settles after one extra
 * render instead of chasing itself. Measuring runs after every render because
 * an anchor can move without either the panel or the window resizing (the
 * selection box travels under the pointer while it is dragged).
 */
export function useViewportShift<T extends HTMLElement>(enabled: boolean, margin = VIEWPORT_MARGIN): ViewportShift<T> {
  const ref = useRef<T>(null);
  const [shift, setShift] = useState(0);

  useLayoutEffect(() => {
    if (!enabled) {
      setShift(0);
      return;
    }
    const measure = (): void => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setShift((current) => {
        const next = horizontalShift(rect.left - current, rect.right - current, window.innerWidth, margin);
        return Math.abs(next - current) < 0.5 ? current : next;
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });

  return { ref, shift };
}
