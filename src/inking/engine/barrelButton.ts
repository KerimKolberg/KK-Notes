/**
 * The pen's barrel button as a click-or-hold gesture.
 *
 * One physical button, two meanings, told apart by how long it is down. A
 * quick press *toggles* between two tools and leaves them there; holding it
 * borrows a third tool only for as long as it is held. That is the split every
 * stylus driver worth using offers, and it is worth having because the two
 * gestures answer different needs: swapping to the eraser for the next minute
 * of work, versus reaching for the lasso for one drag.
 *
 * Everything here is pure. The threshold decision is fiddly enough — a press
 * that is released early, one that crosses the line while still held, one
 * interrupted by the pen leaving range — that it is worth being able to test
 * without a digitiser.
 */
import type { ToolType } from '../types';

/**
 * Below this, a press is a click; at or past it, a hold.
 *
 * 300 ms is comfortably longer than a deliberate click (most land under
 * 150 ms) and short enough that a hold engages while the hand is still
 * moving towards what it wants to do.
 */
export const BARREL_CLICK_MS = 300;

export type BarrelPhase =
  /** Not pressed. */
  | 'idle'
  /** Pressed, but not yet long enough to be a hold. */
  | 'pending'
  /** Held past the threshold; a tool is on loan. */
  | 'held';

export interface BarrelState {
  readonly phase: BarrelPhase;
  /** When the current press began (`performance.now()`-style). */
  readonly pressedAt: number;
  /** The tool to give back when a hold ends; `null` unless holding. */
  readonly borrowedFrom: ToolType | null;
}

export const IDLE_BARREL: BarrelState = { phase: 'idle', pressedAt: 0, borrowedFrom: null };

/** What the caller should do about a transition. */
export type BarrelAction =
  | { readonly kind: 'none' }
  /** A click: toggle between the configured pair. */
  | { readonly kind: 'click' }
  /** A hold began: switch to `tool`, remembering `restore`. */
  | { readonly kind: 'hold-start'; readonly tool: ToolType; readonly restore: ToolType }
  /** A hold ended: put `tool` back. */
  | { readonly kind: 'hold-end'; readonly tool: ToolType };

export interface BarrelStep {
  readonly state: BarrelState;
  readonly action: BarrelAction;
}

const NOTHING = { kind: 'none' } as const;

/** The button went down. */
export function barrelDown(state: BarrelState, now: number): BarrelStep {
  // A second down without an up (a driver dropping an event, or the pen
  // leaving and returning) restarts the press rather than stacking.
  if (state.phase === 'held') return { state, action: NOTHING };
  return { state: { phase: 'pending', pressedAt: now, borrowedFrom: null }, action: NOTHING };
}

/**
 * The button came up.
 *
 * Released before the threshold, it was a click. Released after — whether or
 * not a tick had already promoted it — it was a hold, and anything borrowed
 * goes back. A hold that was never promoted (no tick ran, because the caller
 * had no timer) still counts as a hold rather than a click: the user held it,
 * and treating a long press as a click would swap their tool when they meant
 * to borrow one.
 */
export function barrelUp(state: BarrelState, now: number, threshold = BARREL_CLICK_MS): BarrelStep {
  if (state.phase === 'idle') return { state, action: NOTHING };
  if (state.phase === 'held') {
    const restore = state.borrowedFrom;
    return { state: IDLE_BARREL, action: restore ? { kind: 'hold-end', tool: restore } : NOTHING };
  }
  const held = now - state.pressedAt;
  return { state: IDLE_BARREL, action: held < threshold ? { kind: 'click' } : NOTHING };
}

/**
 * Time passed with the button still down.
 *
 * Called from a timer, because a button held perfectly still produces no
 * events at all — the same reason hold-to-snap needs one. Promotes a pending
 * press to a hold once it crosses the threshold, so the borrowed tool appears
 * under the hand rather than only on release.
 */
export function barrelTick(
  state: BarrelState,
  now: number,
  holdTool: ToolType,
  currentTool: ToolType,
  threshold = BARREL_CLICK_MS,
): BarrelStep {
  if (state.phase !== 'pending') return { state, action: NOTHING };
  if (now - state.pressedAt < threshold) return { state, action: NOTHING };
  // Already using the tool the hold would borrow: hold it, but there is
  // nothing to switch to and nothing to give back.
  if (holdTool === currentTool) {
    return { state: { ...state, phase: 'held', borrowedFrom: null }, action: NOTHING };
  }
  return {
    state: { phase: 'held', pressedAt: state.pressedAt, borrowedFrom: currentTool },
    action: { kind: 'hold-start', tool: holdTool, restore: currentTool },
  };
}

/**
 * The gesture was abandoned — the pen left range, the window lost focus, a
 * touch gesture took over. Anything borrowed goes back; a pending press is
 * dropped without becoming a click, because we never saw it end.
 */
export function barrelCancel(state: BarrelState): BarrelStep {
  if (state.phase === 'held' && state.borrowedFrom) {
    return { state: IDLE_BARREL, action: { kind: 'hold-end', tool: state.borrowedFrom } };
  }
  return { state: IDLE_BARREL, action: NOTHING };
}

/**
 * Where a click takes you.
 *
 * A fixed pair, toggled. Landing on the pair from some third tool goes to
 * `b` — the pair's second slot is the one people configure as the thing they
 * reach for (the eraser, usually), so that is the useful direction — and the
 * click after brings you back to `a`.
 */
export function toggleTool(current: ToolType, pair: readonly [ToolType, ToolType]): ToolType {
  const [a, b] = pair;
  if (current === a) return b;
  if (current === b) return a;
  return b;
}
