import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /** The text shown in the bubble. Also what the trigger is named for assistive tech. */
  label: ReactNode;
  side?: TooltipSide;
  /** Hover delay in ms. */
  delay?: number;
  /** Extra line under the label (e.g. a shortcut or the current value). */
  hint?: ReactNode;
  /** Suppress the bubble, e.g. while this control's own popover is open. */
  disabled?: boolean;
  children: ReactElement<Record<string, unknown>>;
}

/** Hover delay, long enough not to flash while the pointer crosses the palette. */
export const TOOLTIP_DELAY_MS = 300;
/** Touch and pen: a press this long opens the tooltip instead of activating. */
export const TOOLTIP_LONG_PRESS_MS = 500;

const SIDE_CLASSES: Record<TooltipSide, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
};

/**
 * Tooltip for icon-only controls.
 *
 * A mouse opens it after `delay`; a keyboard focus opens it immediately; a
 * touch or pen press opens it after a long press, since those pointers have
 * no hover. The trigger keeps its own `aria-label`, so the bubble is purely
 * visual and is hidden from assistive tech.
 */
export function Tooltip({ label, side = 'top', delay = TOOLTIP_DELAY_MS, hint, disabled = false, children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const openAfter = useCallback(
    (ms: number) => {
      cancel();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setOpen(true);
      }, ms);
    },
    [cancel],
  );

  const close = useCallback(() => {
    cancel();
    setOpen(false);
  }, [cancel]);

  useEffect(() => cancel, [cancel]);

  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const trigger = cloneElement(children, {
    'aria-describedby': open ? id : undefined,
    onPointerEnter: (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse') openAfter(delay);
      (children.props.onPointerEnter as ((e: ReactPointerEvent) => void) | undefined)?.(e);
    },
    onPointerLeave: (e: ReactPointerEvent) => {
      close();
      (children.props.onPointerLeave as ((e: ReactPointerEvent) => void) | undefined)?.(e);
    },
    onPointerDown: (e: ReactPointerEvent) => {
      // Touch and pen have no hover: a long press stands in for it.
      if (e.pointerType === 'mouse') close();
      else openAfter(TOOLTIP_LONG_PRESS_MS);
      (children.props.onPointerDown as ((e: ReactPointerEvent) => void) | undefined)?.(e);
    },
    onPointerUp: (e: ReactPointerEvent) => {
      if (e.pointerType !== 'mouse') cancel();
      (children.props.onPointerUp as ((e: ReactPointerEvent) => void) | undefined)?.(e);
    },
    onPointerCancel: close,
    onFocus: (e: unknown) => {
      setOpen(true);
      (children.props.onFocus as ((e: unknown) => void) | undefined)?.(e);
    },
    onBlur: (e: unknown) => {
      close();
      (children.props.onBlur as ((e: unknown) => void) | undefined)?.(e);
    },
  });

  return (
    <span className="relative inline-flex">
      {trigger}
      {open && !disabled && (
        <span
          id={id}
          role="tooltip"
          aria-hidden="true"
          data-tooltip
          className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white shadow-lg ring-1 ring-black/10 dark:bg-zinc-100 dark:text-zinc-900 ${SIDE_CLASSES[side]}`}
        >
          {label}
          {hint && <span className="ml-1.5 opacity-60">{hint}</span>}
        </span>
      )}
    </span>
  );
}
