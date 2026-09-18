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
  barrelDown,
  barrelTick,
  barrelUp,
  toggleTool,
  type BarrelAction,
  type BarrelState,
} from '../inking/engine/barrelButton';
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
      store.update({ tool: action.tool });
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

export function barrelPhase(): BarrelState['phase'] {
  return state.phase;
}
