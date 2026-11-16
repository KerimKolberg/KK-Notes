/**
 * Driving the barrel button's click/hold gesture against the tool store.
 *
 * The state machine itself is pure (`inking/engine/barrelButton.ts`); this is
 * the one place that holds its state and acts on it. Module-level rather than
 * per-surface on purpose: the pen can cross from one page's canvas to the
 * next mid-hold, and a per-page copy would lose the gesture — and the borrowed
 * tool with it — halfway through.
 */
import {
  BARREL_CLICK_MS,
  IDLE_BARREL,
  barrelCancel,
  barrelConsume,
  barrelDown,
  barrelTick,
  barrelUp,
  toggleTool,
  type BarrelAction,
  type BarrelState,
} from '../inking/engine/barrelButton';
import { handBackTool } from './toolBorrow';
import { useToolStore } from './toolStore';

let state: BarrelState = IDLE_BARREL;
let holdTimer: ReturnType<typeof setTimeout> | null = null;

function clearHoldTimer(): void {
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
}

function apply(action: BarrelAction): void {
  const store = useToolStore.getState();
  switch (action.kind) {
    case 'none':
      return;
    case 'click':
      store.update({ tool: toggleTool(store.settings.tool, store.settings.stylus.clickToggle) });
      return;
    case 'hold-start':
      store.update({ tool: action.tool });
      return;
    case 'hold-end':
      // What the hold borrowed is the tool now; a lasso is kept while it has a
      // selection to show (see `toolBorrow.ts`), anything else goes straight back.
      handBackTool(store.settings.tool, action.tool);
      return;
  }
}

/**
 * Promote a pending press to a hold once the threshold passes.
 *
 * A timer, because a button held perfectly still produces no pointer events
 * at all — the same reason hold-to-snap needs one. Without it the borrowed
 * tool would only appear when the button was released, which is exactly when
 * it stops being wanted.
 */
function armHoldTimer(): void {
  clearHoldTimer();
  holdTimer = setTimeout(() => {
    holdTimer = null;
    const store = useToolStore.getState();
    const step = barrelTick(state, performance.now(), store.settings.stylus.holdTool, store.settings.tool);
    state = step.state;
    apply(step.action);
  }, BARREL_CLICK_MS);
}

/** The barrel button went down or came up. Idempotent for repeated states. */
export function noteBarrelButton(pressed: boolean): void {
  const now = performance.now();
  if (pressed) {
    if (state.phase !== 'idle') return;
    state = barrelDown(state, now).state;
    armHoldTimer();
    return;
  }
  clearHoldTimer();
  const step = barrelUp(state, now);
  state = step.state;
  apply(step.action);
}

/**
 * The pen touched the page with the button down, so this press is a stroke and not
 * a click (see `barrelConsume`). Cancels the timer that would have promoted it to
 * a hold, too: nothing is being borrowed for a stroke whose tool is already chosen.
 */
export function consumeBarrelButton(): void {
  const next = barrelConsume(state);
  if (next === state) return;
  state = next;
  clearHoldTimer();
}

/**
 * The gesture was abandoned: the pen left range, a touch gesture took over,
 * the window lost focus. Anything borrowed goes back, and a press we never
 * saw end does not become a click.
 */
export function cancelBarrelButton(): void {
  clearHoldTimer();
  const step = barrelCancel(state);
  state = step.state;
  apply(step.action);
}

/** Test seam: forget any gesture in flight. */
export function resetBarrelButton(): void {
  clearHoldTimer();
  state = IDLE_BARREL;
}

/**
 * Follow the pen's first (barrel) button wherever the pen is, for the life of the app.
 *
 * It used to be followed only by the drawing surface of a page, which on the Flow Z13 made both of its gestures
 * unreliable: pressed over a page's margin, the gap between pages or the toolbar, it was never seen (no click, no
 * hold); a hold was cancelled, and the borrowed tool handed back, as soon as the pen left the page it began on, even
 * for the next page; and a hold that borrowed Select took the surface out from under the pen, which counted as
 * leaving, so the hold ended, began again and flickered. On the window it sees every pen event, and it lets go only
 * when the pen really goes: out of range or out of the window, or the window losing focus.
 */
export function installBarrelTracking(): () => void {
  if (typeof window === 'undefined') return () => {};
  let pressed = false;
  const blurred = (): void => {
    if (!pressed) return;
    pressed = false;
    cancelBarrelButton();
  };
  const seen = (e: PointerEvent): void => {
    if (e.pointerType !== 'pen') return;
    // The browser took the pointer: what the button did meanwhile is not known, so it is no click.
    if (e.type === 'pointercancel') {
      blurred();
      return;
    }
    const now = (e.buttons & BARREL_BIT) !== 0;
    if (now !== pressed) {
      pressed = now;
      // A release is acted on once the event has been everywhere it goes: the window hears it first, and a lasso
      // loop drawn with the button held is closed by the page after, which is what decides whether the lasso stays.
      if (now) noteBarrelButton(true);
      else setTimeout(() => noteBarrelButton(false), 0);
    }
    // The tip came down with the button held: a stroke with the button, not a click of it.
    if (e.type === 'pointerdown' && pressed && (e.buttons & TIP_BIT) !== 0) consumeBarrelButton();
  };
  const gone = (e: PointerEvent): void => {
    // No element the pen went to: it left the window, or went out of range.
    if (e.pointerType !== 'pen' || e.relatedTarget !== null || !pressed) return;
    pressed = false;
    cancelBarrelButton();
  };
  const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const;
  for (const type of types) window.addEventListener(type, seen, true);
  window.addEventListener('pointerout', gone, true);
  window.addEventListener('blur', blurred);
  return () => {
    for (const type of types) window.removeEventListener(type, seen, true);
    window.removeEventListener('pointerout', gone, true);
    window.removeEventListener('blur', blurred);
    blurred();
  };
}

/** `buttons` bits: the pen's tip touching, and its barrel button. */
const TIP_BIT = 1;
const BARREL_BIT = 2;
