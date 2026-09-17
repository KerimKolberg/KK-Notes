import { useEffect, useRef, type ReactNode } from 'react';

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

const ALIGN = {
  start: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  end: 'right-0',
};

/**
 * Small anchored panel used by the palette's flyouts. Closes on Escape, on a
 * pointer press outside it, and whenever the trigger asks. The caller wraps
 * trigger + popover in a `relative` element.
 */
export function Popover({ open, onClose, label, side = 'top', align = 'center', children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

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
      className={`absolute z-40 min-w-max rounded-2xl border border-zinc-200 bg-white/95 p-2 shadow-2xl backdrop-blur-md dark:border-zinc-700 dark:bg-zinc-900/95 ${SIDE[side]} ${ALIGN[align]}`}
    >
      {children}
    </div>
  );
}
