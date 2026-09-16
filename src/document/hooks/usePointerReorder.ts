import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export interface ReorderDragState {
  readonly from: number;
  readonly over: number;
}

export interface UsePointerReorderOptions {
  readonly count: number;
  readonly onMove: (from: number, to: number) => void;
  readonly onSelect: (index: number) => void;
  /** Movement needed before a press becomes a drag (CSS px). */
  readonly threshold?: number;
  /** Touch must be held this long before it can drag (so short swipes still scroll). */
  readonly touchHoldMs?: number;
}

export interface ReorderItemProps {
  ref: (el: HTMLElement | null) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
}

interface Press {
  index: number;
  pointerId: number;
  startX: number;
  startY: number;
  armed: boolean;
  dragging: boolean;
  holdTimer: ReturnType<typeof setTimeout> | null;
  rects: DOMRect[];
}

/**
 * Pointer-based drag-to-reorder for a grid of items. Works for pen, mouse and
 * touch alike (no HTML5 DnD, which touch lacks). A press that never exceeds
 * the threshold is a selection. Alt+Arrow keys move the focused item.
 */
export function usePointerReorder({
  count,
  onMove,
  onSelect,
  threshold = 6,
  touchHoldMs = 250,
}: UsePointerReorderOptions): { drag: ReorderDragState | null; getItemProps: (index: number) => ReorderItemProps } {
  const [drag, setDrag] = useState<ReorderDragState | null>(null);
  const pressRef = useRef<Press | null>(null);
  /** Clicks before this timestamp are the tail of a drag, not a selection. */
  const suppressClickUntilRef = useRef(0);
  const elements = useRef<Array<HTMLElement | null>>([]);

  const indexAt = useCallback((rects: DOMRect[], x: number, y: number, fallback: number): number => {
    let best = fallback;
    let bestDistance = Number.POSITIVE_INFINITY;
    rects.forEach((r, i) => {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        best = i;
        bestDistance = -1;
        return;
      }
      if (bestDistance === -1) return;
      const dx = x - (r.left + r.width / 2);
      const dy = y - (r.top + r.height / 2);
      const d = dx * dx + dy * dy;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    });
    return best;
  }, []);

  const endPress = useCallback(() => {
    const press = pressRef.current;
    if (press?.holdTimer) clearTimeout(press.holdTimer);
    pressRef.current = null;
    setDrag(null);
  }, []);

  const getItemProps = useCallback(
    (index: number): ReorderItemProps => ({
      ref: (el) => {
        elements.current[index] = el;
      },
      onPointerDown: (e) => {
        if (e.button !== 0 || pressRef.current) return;
        const isTouch = e.pointerType === 'touch';
        const press: Press = {
          index,
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          armed: !isTouch,
          dragging: false,
          holdTimer: null,
          rects: [],
        };
        if (isTouch) {
          press.holdTimer = setTimeout(() => {
            press.armed = true;
            press.holdTimer = null;
          }, touchHoldMs);
        }
        pressRef.current = press;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointer */
        }
      },
      onPointerMove: (e) => {
        const press = pressRef.current;
        if (!press || press.pointerId !== e.pointerId) return;
        const dx = e.clientX - press.startX;
        const dy = e.clientY - press.startY;
        if (!press.dragging) {
          if (Math.hypot(dx, dy) < threshold) return;
          if (!press.armed) {
            // Touch moved before the hold elapsed: let the browser scroll instead.
            endPress();
            return;
          }
          press.dragging = true;
          press.rects = elements.current.slice(0, count).map((el) => el?.getBoundingClientRect() ?? new DOMRect());
          setDrag({ from: press.index, over: press.index });
          return;
        }
        const over = indexAt(press.rects, e.clientX, e.clientY, press.index);
        setDrag((d) => (d && d.over === over ? d : { from: press.index, over }));
      },
      onPointerUp: (e) => {
        const press = pressRef.current;
        if (!press || press.pointerId !== e.pointerId) return;
        if (press.dragging) {
          const over = indexAt(press.rects, e.clientX, e.clientY, press.index);
          if (over !== press.index) onMove(press.index, over);
          suppressClickUntilRef.current = performance.now() + 300;
        }
        endPress();
      },
      onPointerCancel: (e) => {
        const press = pressRef.current;
        if (press && press.pointerId === e.pointerId) endPress();
      },
      onClick: () => {
        if (performance.now() < suppressClickUntilRef.current) return;
        onSelect(index);
      },
      onKeyDown: (e) => {
        if (!e.altKey) return;
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault();
          if (index > 0) onMove(index, index - 1);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault();
          if (index < count - 1) onMove(index, index + 1);
        }
      },
    }),
    [count, endPress, indexAt, onMove, onSelect, threshold, touchHoldMs],
  );

  return useMemo(() => ({ drag, getItemProps }), [drag, getItemProps]);
}
