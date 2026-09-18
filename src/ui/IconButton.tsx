import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip, type TooltipSide } from './Tooltip';

export type IconButtonSize = 'sm' | 'md' | 'lg';
export type IconButtonTone = 'default' | 'danger';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  icon: LucideIcon;
  /** Names the control for assistive tech *and* labels the tooltip. */
  label: string;
  /** Second line in the tooltip: the current value, a shortcut, a mode. */
  hint?: string | undefined;
  active?: boolean;
  size?: IconButtonSize;
  tone?: IconButtonTone;
  tooltipSide?: TooltipSide;
  /** Small marker in the corner, e.g. the eraser's current mode. */
  badge?: ReactNode | undefined;
  /** Set for buttons that open a popover (adds a caret). */
  hasPopover?: boolean;
  /** Hide the tooltip, e.g. while this button's popover is open. */
  tooltipDisabled?: boolean;
}

const SIZES: Record<IconButtonSize, { button: string; icon: number }> = {
  // Touch targets stay at least 36–44 px square: this is a tablet-first palette.
  sm: { button: 'h-9 w-9 rounded-lg', icon: 17 },
  md: { button: 'h-11 w-11 rounded-xl', icon: 20 },
  lg: { button: 'h-12 w-12 rounded-xl', icon: 22 },
};

const BASE =
  // `touch-manipulation` takes the double-tap gesture off these buttons, so an
  // Android WebView dispatches the click on lift instead of holding it back to
  // see whether a second tap is coming. Panning is already forbidden by the
  // palette's own `touch-action: none`, and an ancestor that forbids it wins,
  // so this cannot hand a drag-to-reorder gesture back to the browser.
  'relative inline-flex shrink-0 touch-manipulation items-center justify-center transition-colors select-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ' +
  'disabled:opacity-35 disabled:pointer-events-none';

const IDLE =
  'text-zinc-600 hover:bg-zinc-200/80 hover:text-zinc-900 ' +
  'dark:text-zinc-300 dark:hover:bg-zinc-700/70 dark:hover:text-zinc-50';

/**
 * Active state is deliberately loud: on a tablet there is no hover to fall
 * back on, so the selected tool carries a filled background *and* a ring.
 */
const ACTIVE =
  'bg-blue-600 text-white ring-2 ring-blue-400/70 hover:bg-blue-600 ' +
  'dark:bg-blue-500 dark:text-white dark:ring-blue-300/60';

const DANGER = 'text-rose-600 hover:bg-rose-100 dark:text-rose-300 dark:hover:bg-rose-950/60';

/** Icon-only button: tooltip, accessible name and a strong active state. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, hint, active = false, size = 'md', tone = 'default', tooltipSide = 'top', badge, hasPopover, tooltipDisabled, className = '', ...rest },
  ref,
) {
  const sizing = SIZES[size];
  const tint = active ? ACTIVE : tone === 'danger' ? DANGER : IDLE;
  return (
    <Tooltip
      label={label}
      {...(hint ? { hint } : {})}
      side={tooltipSide}
      disabled={tooltipDisabled ?? rest['aria-expanded'] === true}
    >
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={rest['aria-haspopup'] ? undefined : active}
        title={undefined}
        className={`${BASE} ${sizing.button} ${tint} ${className}`}
        {...rest}
      >
        <Icon size={sizing.icon} strokeWidth={active ? 2.25 : 1.9} aria-hidden="true" />
        {badge !== undefined && (
          <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 rounded px-0.5 text-[9px] font-bold leading-tight">
            {badge}
          </span>
        )}
        {hasPopover && (
          <span
            className={`pointer-events-none absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ${
              active ? 'bg-white/90' : 'bg-zinc-400 dark:bg-zinc-500'
            }`}
            aria-hidden="true"
          />
        )}
      </button>
    </Tooltip>
  );
});
