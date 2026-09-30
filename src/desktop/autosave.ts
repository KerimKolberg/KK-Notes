/**
 * When an autosave should run, given whether the pen is on the page.
 *
 * A draft is written a moment after the last edit, and writing one is not free: it
 * serialises what changed and hands it across to the shell, which for a heavily
 * annotated document is a tenth of a second or more on the one thread that is also
 * following the pen. Run in the middle of a stroke, that is a stall the pen shows as a
 * hitch — and a burst of writing is exactly when a draft comes due, because each
 * stroke restarts the wait and the wait ends in the pause before the next.
 *
 * So a draft that comes due while the pen is still on the page (or hovering just above
 * it) is put off and looked at again shortly, and runs once the pen has gone quiet. The
 * put-off is bounded: a pen that never really leaves would otherwise mean no draft at
 * all, and a draft is what a crash restores from.
 */

/** Wait this long after the last edit before writing a draft. */
export const AUTOSAVE_DEBOUNCE_MS = 1500;
/** How often a put-off draft looks again. */
export const AUTOSAVE_RECHECK_MS = 750;
/** The longest a draft is put off for a pen that never leaves. */
export const AUTOSAVE_MAX_DEFER_MS = 20_000;

export interface AutosaveContext {
  /** A pen is on the page or hovering just above it (see `isPenNearby`). */
  readonly penNearby: boolean;
  /** How long this draft has already been put off, in ms. */
  readonly deferredMs: number;
}

export type AutosaveStep = 'save' | 'wait';

export function nextAutosaveStep({ penNearby, deferredMs }: AutosaveContext): AutosaveStep {
  if (!penNearby) return 'save';
  return deferredMs >= AUTOSAVE_MAX_DEFER_MS ? 'save' : 'wait';
}
