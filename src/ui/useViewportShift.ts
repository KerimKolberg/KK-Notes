import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { VIEWPORT_MARGIN, horizontalShift } from './viewportClamp';

export interface ViewportShift<T extends HTMLElement> {
  /** Attach to the panel being kept on screen. */
  readonly ref: RefObject<T | null>;
  /** Correction in **screen** px, along the requested axis, to add to the panel's transform. */
  readonly shift: number;
}

/** Which way a panel is corrected: along the row (`x`) or down the column (`y`). */
export type ShiftAxis = 'x' | 'y';

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
export function useViewportShift<T extends HTMLElement>(
  enabled: boolean,
  margin = VIEWPORT_MARGIN,
  axis: ShiftAxis = 'x',
): ViewportShift<T> {
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
      // The same rule either way — it only needs a start, an end and an extent —
      // so a panel beside a standing toolbar is corrected down the screen by the
      // function that corrects one above a lying-down one across it.
      const start = axis === 'x' ? rect.left : rect.top;
      const end = axis === 'x' ? rect.right : rect.bottom;
      const extent = axis === 'x' ? window.innerWidth : window.innerHeight;
      setShift((current) => {
        const next = horizontalShift(start - current, end - current, extent, margin);
        return Math.abs(next - current) < 0.5 ? current : next;
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });

  return { ref, shift };
}
