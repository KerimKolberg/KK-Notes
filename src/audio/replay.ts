/**
 * Showing writing as it was at a moment of a recording: while the player is open, ink begun later than the
 * playback position is faded, so what was written while something was being said stands out as it is heard.
 *
 * Only the strokes shown are changed (copies with less opacity, made once per stroke); the note's own strokes, and
 * everything that edits them, are untouched. With the player shut the page gets its own stroke list back, the same
 * array, so nothing is redrawn and nothing costs anything.
 */
import { useMemo } from 'react';
import type { Stroke } from '../inking/types';
import { strokeHitBySegment } from '../inking/engine/hitTest';
import { usePlayerStore } from './player';

/** How much of its opacity ink not yet written keeps. */
export const LATER_OPACITY = 0.2;

const faded = new WeakMap<Stroke, Stroke>();

function fade(stroke: Stroke): Stroke {
  let copy = faded.get(stroke);
  if (!copy) {
    copy = { ...stroke, style: { ...stroke.style, opacity: stroke.style.opacity * LATER_OPACITY } } as Stroke;
    faded.set(stroke, copy);
  }
  return copy;
}

/** How many of these strokes were begun later than `time` into the recording. */
export function laterCount(strokes: readonly Stroke[], markTimes: ReadonlyMap<string, number>, time: number): number {
  let n = 0;
  for (const stroke of strokes) {
    const t = markTimes.get(stroke.id);
    if (t !== undefined && t > time) n += 1;
  }
  return n;
}

/** The strokes with those begun later than `time` faded. */
export function withLaterFaded(strokes: readonly Stroke[], markTimes: ReadonlyMap<string, number>, time: number): Stroke[] {
  return strokes.map((stroke) => {
    const t = markTimes.get(stroke.id);
    return t !== undefined && t > time ? fade(stroke) : stroke;
  });
}

/**
 * A page's strokes as the replay shows them. Re-made only when the number of strokes still to come changes: for a
 * given list of strokes and a recording, that number decides which ones they are.
 */
export function useReplayStrokes(strokes: readonly Stroke[]): readonly Stroke[] {
  const markTimes = usePlayerStore((s) => (s.open ? s.markTimes : null));
  const later = usePlayerStore((s) => (s.open && s.markTimes ? laterCount(strokes, s.markTimes, s.time) : 0));
  return useMemo(
    () => (later === 0 || !markTimes ? strokes : withLaterFaded(strokes, markTimes, usePlayerStore.getState().time)),
    [strokes, later, markTimes],
  );
}

/**
 * When the ink at a point was written: the earliest time among the recorded strokes within `radius` of it (page
 * units), or `null` when none is.
 */
export function markAt(
  strokes: readonly Stroke[],
  markTimes: ReadonlyMap<string, number>,
  x: number,
  y: number,
  radius: number,
): number | null {
  let best: number | null = null;
  for (const stroke of strokes) {
    const t = markTimes.get(stroke.id);
    if (t === undefined) continue;
    if (best !== null && t >= best) continue;
    if (strokeHitBySegment(stroke, x, y, x, y, radius)) best = t;
  }
  return best;
}
