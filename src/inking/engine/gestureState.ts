/**
 * Process-wide input state shared by every ink surface and the viewer:
 *
 * - a "two-finger gesture in progress" flag, so navigation gestures suppress
 *   touch inking on every page at once, and
 * - pen presence, so a resting palm or a second finger never pans or zooms
 *   while the stylus is writing.
 */
import { PALM_REJECTION_GRACE_MS, PEN_PROXIMITY_TIMEOUT_MS } from '../constants';

type GestureListener = (active: boolean) => void;

let gestureActive = false;
const listeners = new Set<GestureListener>();

export function beginTouchGesture(): void {
  if (gestureActive) return;
  gestureActive = true;
  for (const listener of listeners) listener(true);
}

export function endTouchGesture(): void {
  if (!gestureActive) return;
  gestureActive = false;
  for (const listener of listeners) listener(false);
}

export function isTouchGestureActive(): boolean {
  return gestureActive;
}

export function subscribeTouchGesture(listener: GestureListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let penLastSeen = Number.NEGATIVE_INFINITY;
let penInProximity = false;

/** A pen event (hover, contact, move) was observed. */
export function notePenPresence(now: number = performance.now()): void {
  penLastSeen = now;
  penInProximity = true;
}

/** The pen left hover range. */
export function notePenLeft(now: number = performance.now()): void {
  penInProximity = false;
  penLastSeen = now;
}

/**
 * True while a pen was seen recently or is still flagged as hovering (the
 * flag goes stale after `PEN_PROXIMITY_TIMEOUT_MS` in case `pointerleave`
 * never arrives). Mirrors the palm-rejection rule used for touch inking.
 */
export function isPenNearby(now: number = performance.now()): boolean {
  const since = now - penLastSeen;
  if (since < PALM_REJECTION_GRACE_MS) return true;
  return penInProximity && since < PEN_PROXIMITY_TIMEOUT_MS;
}

export function penPresence(now: number = performance.now()): { inProximity: boolean; msSincePen: number } {
  return { inProximity: penInProximity, msSincePen: now - penLastSeen };
}

/** Test hook: forget any pen. */
export function resetPenPresence(): void {
  penLastSeen = Number.NEGATIVE_INFINITY;
  penInProximity = false;
}
