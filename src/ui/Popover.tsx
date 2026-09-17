import { useEffect, type ReactNode } from 'react';
import { useViewportShift } from './useViewportShift';

export type PopoverSide = 'top' | 'bottom';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Names the panel for assistive tech. */
  label: string;
  side?: PopoverSide;
  /** Horizontal alignment relative to the trigger. */
  align?: 'start' | 'center' | 'end';
  children: ReactNode;
}

const SIDE: Record<PopoverSide, string> = {
  top: 'bottom-full mb-2',
  bottom: 'top-full mt-2',
};

/**
 * Alignment is positioning only: the centring translate lives in the inline
 * transform instead, so the viewport correction can be added to it rather
 * than overriding it.
 */
const ALIGN = {
  start: 'left-0',
  center: 'left-1/2',
  end: 'right-0',
};

/**
 * Small anchored panel used by the palette's flyouts. Closes on Escape, on a
 * pointer press outside it, and whenever the trigger asks. The caller wraps
 * trigger + popover in a `relative` element.
 */
export function Popover({ open, onClose, label, side = 'top', align = 'center', children }: PopoverProps) {
  // On a phone a flyout centred on a button near the edge would hang off it.
  const { ref, shift } = useViewportShift<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const el = ref.current;
      if (!el || !(e.target instanceof Node)) return;
      // The trigger is a sibling; let it handle its own toggle.
      if (el.contains(e.target) || el.parentElement?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      data-popover={label}
      className={`absolute z-40 w-max max-w-[calc(100vw-1rem)] rounded-2xl border border-zinc-200 bg-white/95 p-2 shadow-2xl backdrop-blur-md dark:border-zinc-700 dark:bg-zinc-900/95 ${SIDE[side]} ${ALIGN[align]}`}
      style={{ transform: align === 'center' ? `translateX(calc(-50% + ${shift}px))` : `translateX(${shift}px)` }}
    >
      {children}
    </div>
  );
}
