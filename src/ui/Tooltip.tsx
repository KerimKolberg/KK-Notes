import {
  cloneElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { fixedPlacement, useAnchorRect, useFloatingMode, viewportSize } from './floating';
import { horizontalShift } from './viewportClamp';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

/**
 * Which way tooltips open, for everything inside a provider.
 *
 * A toolbar docked to the top of the screen needs its tooltips below its buttons
 * and one on the left side needs them to the right, and threading a `side` through
 * every button of a toolbar of twenty is how one gets forgotten. An explicit
 * `side` on a tooltip still wins.
 */
const TooltipSideContext = createContext<TooltipSide>('top');
export const TooltipSideProvider = TooltipSideContext.Provider;
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
export function Tooltip({ label, side: sideProp, delay = TOOLTIP_DELAY_MS, hint, disabled = false, children }: TooltipProps) {
  const inherited = useContext(TooltipSideContext);
  const side = sideProp ?? inherited;
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  // In a toolbar that slides, placed on the screen beside its trigger, so the strip's edge cannot cut it off.
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const fixed = useFloatingMode() === 'fixed';
  const anchor = useAnchorRect(wrapperRef, open && !disabled && fixed);
  // …and kept on the screen: a button at the end of a toolbar on a phone is near its edge. Measured once it is
  // placed, and only then — there are dozens of these, and nearly all of them are closed.
  const across = side === 'top' || side === 'bottom';
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) {
      setShift(0);
      return;
    }
    const r = bubble.getBoundingClientRect();
    const screen = viewportSize();
    setShift((current) =>
      across
        ? horizontalShift(r.left - current, r.right - current, screen.width)
        : horizontalShift(r.top - current, r.bottom - current, screen.height),
    );
  }, [anchor, across]);

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
    <span ref={wrapperRef} className="relative inline-flex">
      {trigger}
      {open && !disabled && (!fixed || anchor) && (
        <span
          ref={bubbleRef}
          id={id}
          role="tooltip"
          aria-hidden="true"
          data-tooltip
          className={`pointer-events-none z-50 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white shadow-lg ring-1 ring-black/10 dark:bg-zinc-100 dark:text-zinc-900 ${
            fixed ? 'fixed' : `absolute ${SIDE_CLASSES[side]}`
          }`}
          style={
            fixed && anchor
              ? { ...fixedPlacement(side, 'center', anchor, viewportSize()), transform: across ? `translateX(calc(-50% + ${shift}px))` : `translateY(calc(-50% + ${shift}px))` }
              : undefined
          }
        >
          {label}
          {hint && <span className="ml-1.5 opacity-60">{hint}</span>}
        </span>
      )}
    </span>
  );
}
