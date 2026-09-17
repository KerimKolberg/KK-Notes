/**
 * Hold-to-snap dwell tracking.
 *
 * Holding the pen still at the end of a stroke replaces it with the geometric
 * primitive it was approximating. Deciding when that dwell has been broken is
 * the whole difficulty, and it is asymmetric:
 *
 * - *Before* a shape is recognised, the pen must be genuinely still, so the
 *   smallest drift restarts the wait. Being strict costs nothing — the user is
 *   only waiting longer for a preview they have not seen yet.
 * - *After* it is recognised, the shape is **locked**. A stylus slides several
 *   pixels as it comes off the glass, and in a strict reading that is movement;
 *   treating it as such threw away the recognised shape at the exact moment the
 *   user was accepting it, and left a messy freehand stroke behind. So a locked
 *   shape is given up only for movement far past anything a lift produces —
 *   i.e. a deliberate decision to carry on drawing.
 *
 * The timer lives in the pointer hook (a perfectly still pen produces no events
 * at all, so only a timer can notice the dwell completing); the state machine
 * is here, where it can be tested without one.
 */
import { SNAP_JITTER_PX, SNAP_RELEASE_PX } from '../constants';
import type { Point, Shape } from '../types';
import type { AngleArc } from './angleHud';

export interface DwellState {
  /** Where the pointer came to rest. */
  anchor: Point;
  /** When it came to rest. */
  since: number;
  /** Recognised shape currently replacing the raw preview, if any. */
  shape: Shape | null;
  hud: readonly AngleArc[];
}

export function beginDwell(anchor: Point, now: number): DwellState {
  return { anchor, since: now, shape: null, hud: [] };
}

/** How far the pointer may drift before this dwell counts as broken. */
export function dwellTolerance(state: DwellState, jitterPx = SNAP_JITTER_PX, releasePx = SNAP_RELEASE_PX): number {
  return state.shape ? releasePx : jitterPx;
}

/**
 * Fold a pointer sample into the dwell. Returns true when the dwell restarted,
 * which is the caller's cue to re-arm its timer — and the only path on which a
 * locked shape is discarded.
 */
export function noteDwellMovement(
  state: DwellState,
  point: Point,
  now: number,
  jitterPx = SNAP_JITTER_PX,
  releasePx = SNAP_RELEASE_PX,
): boolean {
  const moved = Math.hypot(point.x - state.anchor.x, point.y - state.anchor.y);
  if (moved <= dwellTolerance(state, jitterPx, releasePx)) return false;
  state.anchor = point;
  state.since = now;
  state.shape = null;
  state.hud = [];
  return true;
}

/** Record a recognised shape, locking the dwell around it. */
export function lockDwell(state: DwellState, shape: Shape, hud: readonly AngleArc[]): void {
  state.shape = shape;
  state.hud = hud;
}
